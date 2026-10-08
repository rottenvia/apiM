//! The command menu above the message box and what each command does:
//! src/components/SlashMenu.tsx, `executeSlash` in ChatArea.tsx and `runPageCommand` in page.tsx.
//! Which rows to show and what a typed line means is decided by `crate::slash`.

use super::composer::Popover;
use super::theme::{self, W, p};
use super::{App, Dialog, attachments, find_bar, widgets};
use crate::slash::{self, Cmd, Submit};
use crate::snapshots::{self, RestorePoint};
use crate::store::{self, Role};
use crate::{models, provider};
use eframe::egui::{self, Color32, Sense, pos2, vec2};
use std::time::{Duration, Instant};

/// What the button at the end of a notice does.
pub enum Act {
    /// Put the files back as they were before a rewind: the snapshot taken just before it.
    UndoFiles(String),
}

/// The line above the message box: what a command did, or why it did not run.
pub struct Notice {
    pub text: String,
    /// Shown in the error colour.
    pub error: bool,
    pub action: Option<(&'static str, Act)>,
    pub since: Instant,
}

#[derive(Default)]
pub struct State {
    /// The highlighted row.
    active: usize,
    /// The text Esc was pressed on: the menu stays shut until it changes.
    dismissed: Option<String>,
    /// The text the highlight belongs to: any edit moves it back to the top.
    seen: String,
    /// The highlight moved by keyboard, so it is scrolled into view.
    scroll: bool,
    /// Put the caret at the end of the message box, after a command wrote into it.
    caret_to_end: bool,
    pub notice: Option<Notice>,
}

/// Says something on the line above the message box.
pub fn say(app: &mut App, text: impl Into<String>, error: bool) {
    app.slash.notice = Some(Notice { text: text.into(), error, action: None, since: Instant::now() });
}

fn set_draft(app: &mut App, text: String) {
    app.draft = text;
    app.slash.caret_to_end = true;
    app.focus_composer = true;
}

/// Runs `f` with what the option commands choose between right now.
fn with_choices<R>(app: &App, f: impl FnOnce(&slash::Choices) -> R) -> R {
    let all = models::all(&app.settings.custom_models);
    let specs: Vec<String> = all.iter().map(|m| if provider::resolve_target(&m.id, &app.settings).is_ok() { m.specs.clone() } else { format!("{} · no key", m.specs) }).collect();
    let models: Vec<slash::Opt> = all.iter().zip(&specs).map(|(m, specs)| (m.id.as_str(), m.label.as_str(), specs.as_str())).collect();
    let mut themes: Vec<slash::Opt> = theme::THEMES.iter().map(|t| (t.id.as_str(), t.name.as_str(), "")).collect();
    themes.push((theme::CUSTOM_THEME, "Custom", ""));
    f(&slash::Choices { models: &models, themes: &themes, model: &app.settings.model, effort: &app.settings.effort, web: app.settings.web_mode(), theme: &app.settings.theme })
}

/// The rows for what is typed, with the menu's title. Empty while the menu is shut.
pub fn rows(app: &mut App) -> (&'static str, Vec<slash::MenuItem>) {
    if app.slash.dismissed.as_deref().is_some_and(|text| text != app.draft) {
        app.slash.dismissed = None;
    }
    if app.slash.dismissed.is_some() || app.dialog != Dialog::None || !app.draft.starts_with('/') {
        return ("", Vec::new());
    }
    let (title, rows) = with_choices(app, |choices| slash::menu(&app.draft, choices));
    if app.slash.seen != app.draft {
        app.slash.seen = app.draft.clone();
        app.slash.active = 0;
    }
    app.slash.active = app.slash.active.min(rows.len().saturating_sub(1));
    (title, rows)
}

/// The menu's keys, taken before the message box sees them: arrows move, Tab completes, Enter runs, Esc shuts it.
pub fn keys(app: &mut App, ctx: &egui::Context, rows: &[slash::MenuItem]) {
    if rows.is_empty() || !ctx.memory(|m| m.has_focus(egui::Id::new("composer-text"))) {
        return;
    }
    let pressed = |key| ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, key));
    let count = rows.len();
    if pressed(egui::Key::ArrowDown) {
        app.slash.active = (app.slash.active + 1) % count;
        app.slash.scroll = true;
    }
    if pressed(egui::Key::ArrowUp) {
        app.slash.active = (app.slash.active + count - 1) % count;
        app.slash.scroll = true;
    }
    let row = &rows[app.slash.active];
    if pressed(egui::Key::Tab) {
        pick(app, ctx, row, false);
    } else if ctx.input_mut(|i| !i.modifiers.shift && i.consume_key(egui::Modifiers::NONE, egui::Key::Enter)) {
        pick(app, ctx, row, slash::enter_runs(row, &app.draft));
    } else if pressed(egui::Key::Escape) {
        app.slash.dismissed = Some(app.draft.clone());
    }
}

/// Chooses a row: runs it, or only writes it into the message box.
fn pick(app: &mut App, ctx: &egui::Context, row: &slash::MenuItem, run: bool) {
    // A click took the focus from the message box; typing carries on there.
    app.focus_composer = true;
    if run {
        execute(app, ctx, &row.insert);
    } else {
        set_draft(app, row.insert.clone());
    }
    ctx.request_repaint();
}

/// After the message box was drawn: keeps Tab and Esc for the open menu, moves the caret where a
/// command asked, and drops the notice once typing resumes.
pub fn after_edit(app: &mut App, ui: &egui::Ui, edit: &egui::Response, open: bool) {
    if open && edit.has_focus() {
        // Otherwise egui moves the focus on Tab and drops it on Esc before the menu hears of them.
        ui.memory_mut(|m| m.set_focus_lock_filter(edit.id, egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
    }
    if std::mem::take(&mut app.slash.caret_to_end) {
        if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), edit.id) {
            state.cursor.set_char_range(Some(egui::text::CCursorRange::one(egui::text::CCursor::new(app.draft.chars().count()))));
            egui::TextEdit::store_state(ui.ctx(), edit.id, state);
        }
    }
    if edit.changed() {
        app.slash.notice = None;
    }
}

/// Where the first line of a laid-out text has its baseline, from the text's top.
fn baseline(galley: &egui::Galley) -> f32 {
    galley.rows.first().and_then(|row| row.row.glyphs.first().map(|glyph| row.pos.y + glyph.pos.y)).unwrap_or(galley.size().y * 0.8)
}

/// The menu, hung above the message box at its width. Called every frame, so its fade starts from shut.
pub fn show(app: &mut App, ctx: &egui::Context, title: &str, rows: &[slash::MenuItem]) {
    let t = ctx.animate_bool_with_time(egui::Id::new("slash-menu-in"), !rows.is_empty(), 0.15);
    if rows.is_empty() {
        return;
    }
    let p = p();
    let anchor = app.composer_rect;
    let window = ctx.content_rect();
    let active = app.slash.active;
    let scroll = std::mem::take(&mut app.slash.scroll);
    let (mut hovered, mut picked) = (None, None);
    egui::Area::new(egui::Id::new("slash-menu")).order(egui::Order::Foreground).pivot(egui::Align2::LEFT_BOTTOM).fixed_pos(pos2(anchor.left(), anchor.top() - 8.0 + 6.0 * (1.0 - t))).show(ctx, |ui| {
        ui.set_opacity(t);
        widgets::popover_frame(16).show(ui, |ui| {
            ui.set_width(anchor.width() - 2.0);
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            egui::ScrollArea::vertical().max_height((window.height() * 0.5).min(352.0)).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                    // "Choose" and the section names: 11px on a 16.5 line, 10 in from the edge.
                    let caption = |ui: &mut egui::Ui, text: &str, weight: W, bottom: f32, spacing: f32| {
                        let mut job = egui::text::LayoutJob::simple_singleline(text.to_string(), theme::font(11.0, weight), p.muted);
                        job.sections[0].format.extra_letter_spacing = spacing;
                        let galley = ui.painter().layout_job(job);
                        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 2.0 + 16.5 + bottom), Sense::hover());
                        widgets::text_at(ui, rect.left() + 10.0, rect.top() + 2.0 + 8.25, galley);
                    };
                    if !title.is_empty() {
                        caption(ui, title, W::Medium, 4.0, 0.0);
                    }
                    for (i, row) in rows.iter().enumerate() {
                        if !row.header.is_empty() {
                            caption(ui, &row.header.to_uppercase(), W::Semibold, 2.0, 0.275);
                        }
                        let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 31.5), Sense::click());
                        let on = widgets::fade(ui, response.id, i == active);
                        ui.painter().rect_filled(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, p.hover, on));
                        let label = widgets::galley(ui, &row.label, theme::mono(13.0), if row.current { p.accent_light } else { p.text });
                        // Every cell sits on the label's baseline (`items-baseline`), in a 19.5 line 6 from the top.
                        let base = rect.top() + 6.0 + (19.5 - label.size().y) / 2.0 + baseline(&label);
                        let put = |ui: &egui::Ui, x: f32, galley: std::sync::Arc<egui::Galley>| {
                            let width = galley.size().x;
                            ui.painter().galley(pos2(x, base - baseline(&galley)), galley, Color32::PLACEHOLDER);
                            width
                        };
                        let mut x = rect.left() + 10.0;
                        x += put(ui, x, label) + 10.0;
                        if !row.hint.is_empty() {
                            x += put(ui, x, widgets::galley(ui, &row.hint, theme::mono(11.0), p.muted)) + 10.0;
                        }
                        let mut right = rect.right() - 10.0;
                        if row.current {
                            let tag = widgets::galley(ui, "current", theme::font(11.0, W::Regular), p.accent_light);
                            right -= tag.size().x;
                            put(ui, right, tag);
                            right -= 10.0;
                        }
                        if !row.description.is_empty() && right > x {
                            put(ui, x, widgets::clipped(ui, &row.description, theme::font(12.0, W::Regular), p.text2, right - x));
                        }
                        // Only a pointer that moves takes the highlight, or it would fight the arrow keys.
                        if response.hovered() && ui.input(|i| i.pointer.delta() != egui::Vec2::ZERO) {
                            hovered = Some(i);
                        }
                        if response.clicked() {
                            picked = Some(i);
                        }
                        if scroll && i == active {
                            ui.scroll_to_rect(rect, None);
                        }
                    }
                });
            });
            if window.width() >= 640.0 {
                widgets::rule(ui);
                let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 24.5), Sense::hover());
                let mut x = rect.right() - 12.0;
                for text in ["Esc close", "Enter run", "Tab complete", "↑↓ choose"] {
                    let galley = widgets::galley(ui, text, theme::font(11.0, W::Regular), p.muted);
                    x -= galley.size().x;
                    widgets::text_at(ui, x, rect.center().y, galley);
                    x -= 12.0;
                }
            }
        });
    });
    if let Some(i) = hovered {
        app.slash.active = i;
    }
    if let Some(i) = picked {
        pick(app, ctx, &rows[i], rows[i].run);
    }
}

/// The notice line inside the message box, above the text.
pub fn notice(app: &mut App, ui: &mut egui::Ui) {
    let Some(notice) = &app.slash.notice else { return };
    // It leaves on its own: after 8 seconds, or 30 when it offers something to click.
    let life = Duration::from_secs(if notice.action.is_some() { 30 } else { 8 });
    let age = notice.since.elapsed();
    if age > life {
        app.slash.notice = None;
        return;
    }
    ui.ctx().request_repaint_after(life - age);
    let p = p();
    let mut clicked = false;
    egui::Frame::new().inner_margin(egui::Margin { left: 16, right: 16, top: 8, bottom: 0 }).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.add(egui::Label::new(widgets::lines(notice.text.as_str(), 11.0, 16.0, W::Regular, if notice.error { p.danger } else { p.text2 })).wrap().selectable(false));
            if let Some((label, _)) = &notice.action {
                ui.add_space(10.0);
                let button = ui.add(egui::Label::new(widgets::lines(*label, 11.0, 16.0, W::Medium, p.accent_light)).selectable(false).sense(Sense::click())).on_hover_cursor(egui::CursorIcon::PointingHand);
                if button.hovered() {
                    ui.painter().hline(button.rect.x_range(), button.rect.bottom() - 2.0, egui::Stroke::new(1.0, p.accent_light));
                }
                clicked = button.clicked();
            }
        });
    });
    if clicked {
        match app.slash.notice.take().and_then(|n| n.action) {
            Some((_, Act::UndoFiles(snapshot))) => {
                let done = snapshots::restore(&app.conv.workspace(), &snapshot, None);
                app.files_stale = true;
                match done {
                    Ok(_) => say(app, "The files are back as they were before the rewind.", false),
                    Err(_) => say(app, "Couldn't put the files back — use Restore points in the file panel.", true),
                }
            }
            None => {}
        }
    }
}

/// Enter or Send: runs the message box's text if it is a command. False when it is an ordinary message.
pub fn submit(app: &mut App, ctx: &egui::Context) -> bool {
    let text = app.draft.clone();
    execute(app, ctx, &text)
}

/// Runs `text` if it is a command. False when it is not one, and the caller sends it.
fn execute(app: &mut App, ctx: &egui::Context, text: &str) -> bool {
    let (running, compacting) = (app.running_here(), app.compacting());
    match with_choices(app, |choices| slash::submit(text, running, compacting, choices)) {
        Submit::Message => return false,
        Submit::Refused { notice, input } => {
            if let Some(input) = input {
                set_draft(app, input);
            }
            say(app, notice, true);
        }
        Submit::Reopen { input } => {
            set_draft(app, input);
            app.slash.notice = None;
        }
        Submit::Prompt { shown, .. } => prompt(app, ctx, shown),
        Submit::Pick { cmd, value, notice } => {
            app.draft.clear();
            match cmd {
                Cmd::Model => app.settings.model = value,
                Cmd::Effort => app.settings.effort = value,
                Cmd::Web => app.settings.set_web_mode(&value),
                Cmd::Theme => app.settings.theme = value,
                // Export: the file dialog takes it from here.
                _ => {
                    if app.conv.messages.is_empty() {
                        return say_true(app, "This chat hasn't been saved yet — send a message first.");
                    }
                    let id = app.conv.id.clone();
                    // ponytail: the line below is shown even if the save dialog is cancelled; have export_chat report back if that confuses anyone.
                    app.export_chat(&id, &value);
                }
            }
            if cmd != Cmd::Export {
                app.settings.save();
            }
            say(app, notice, false);
        }
        Submit::Run { cmd, arg } => {
            // A command that runs leaves the box empty; one that refuses keeps what was typed.
            let typed = std::mem::take(&mut app.draft);
            match perform(app, ctx, cmd, &arg) {
                Ok(Some(done)) => say(app, done, false),
                Ok(None) => {}
                Err(why) => {
                    app.draft = typed;
                    say(app, why, true);
                }
            }
        }
    }
    true
}

/// An error notice from a place that has to answer "it was a command".
fn say_true(app: &mut App, why: &str) -> bool {
    say(app, why, true);
    true
}

/// A prompt shortcut ("/review auth"): sent as a message that shows as typed; the agent gets the full instruction (`slash::wire`).
fn prompt(app: &mut App, ctx: &egui::Context, shown: String) {
    if provider::resolve_target(&app.settings.model, &app.settings).is_err() {
        let provider = match models::resolve(&app.settings.model, &app.settings.custom_models).provider {
            models::ProviderId::Openrouter => "OpenRouter",
            models::ProviderId::Local => "local server",
            models::ProviderId::Deepseek => "DeepSeek",
        };
        return say(app, format!("Add your {provider} key in Settings first."), true);
    }
    if app.run.is_some() {
        return say(app, "Another chat is still being answered. Stop it or wait for it to finish.", true);
    }
    if let Some(why) = attachments::waiting(&app.attachments) {
        return say(app, why, false);
    }
    let (wire, attached) = attachments::message(&shown, std::mem::take(&mut app.attachments), attachments::model_vision(&app.settings));
    app.draft.clear();
    app.send(ctx, wire, attached);
}

/// The system's own OK / Cancel box, as `window.confirm` is on the web.
fn confirm(question: &str) -> bool {
    let answer = rfd::MessageDialog::new().set_level(rfd::MessageLevel::Warning).set_title("apiM").set_description(question).set_buttons(rfd::MessageButtons::OkCancel).show();
    matches!(answer, rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes)
}

/// Does what a command asks. `Ok(Some(line))` is said in the plain colour, `Err(line)` in the error colour.
fn perform(app: &mut App, ctx: &egui::Context, cmd: Cmd, arg: &str) -> Result<Option<String>, String> {
    let id = app.conv.id.clone();
    let saved = |app: &App| if app.conv.messages.is_empty() { Err("This chat hasn't been saved yet — send a message first.".to_string()) } else { Ok(()) };
    match cmd {
        Cmd::Compact => {
            app.popover = Popover::Context;
            app.compact(ctx, arg.to_string());
        }
        Cmd::Context | Cmd::Cost => app.popover = Popover::Context,
        Cmd::New => app.new_chat(),
        Cmd::Retry => {
            if app.conv.messages.last().is_none_or(|m| m.role != Role::Assistant) {
                return Err("There is no reply to retry yet.".into());
            }
            app.retry(ctx);
        }
        Cmd::Rewind => return rewind(app),
        Cmd::Resume => app.resume(ctx, arg.trim().to_string())?,
        Cmd::Stop => {
            if !app.running_here() {
                return Ok(Some("Nothing is running.".into()));
            }
            app.stop();
        }
        Cmd::Btw => {
            if !app.running_here() {
                return Err("Nothing is running — send it as a normal message.".into());
            }
            app.pass_note(arg.to_string());
        }
        Cmd::Copy => {
            // The reply still being written does not count.
            let live = usize::from(app.running_here());
            let Some(text) = app.conv.messages.iter().rev().skip(live).find(|m| m.role == Role::Assistant).map(|m| m.text()).filter(|t| !t.trim().is_empty()) else {
                return Err("There is no reply to copy yet.".into());
            };
            ctx.copy_text(text);
            return Ok(Some("Copied the last reply.".into()));
        }
        Cmd::Rename => {
            saved(app)?;
            let title: String = arg.chars().take(200).collect();
            app.rename_chat(&id, &title);
            return Ok(Some(format!("Renamed to \"{title}\".")));
        }
        Cmd::Archive => {
            saved(app)?;
            app.archive_chat(&id, true);
            app.new_chat();
        }
        Cmd::Delete => {
            saved(app)?;
            if !confirm(&format!("Delete \"{}\" and its workspace? This can't be undone.", app.conv.title)) {
                return Ok(Some("Kept the chat.".into()));
            }
            app.delete_chats(&[id]);
        }
        Cmd::Find => find_bar::open(app, (!arg.is_empty()).then(|| arg.to_string())),
        Cmd::Search => app.dialog = Dialog::Search,
        Cmd::Budget => {
            let (limit, ok, line) = slash::budget(arg, app.settings.budget_usd);
            if !ok {
                return Err(line);
            }
            if limit != app.settings.budget_usd {
                app.settings.budget_usd = limit;
                app.settings.save();
            }
            return Ok(Some(line));
        }
        // ponytail: the full file browser is being built on another branch; until it lands /files opens the side rail.
        Cmd::Files => {
            app.settings.workspace_open = true;
            app.files_stale = true;
            app.settings.save();
        }
        Cmd::Panel => {
            app.settings.workspace_open = !app.settings.workspace_open;
            app.files_stale = true;
            app.settings.save();
        }
        Cmd::Settings => app.dialog = Dialog::Settings,
        Cmd::Plugins => app.dialog = Dialog::Plugins,
        Cmd::Mcp => app.dialog = Dialog::Mcp,
        // ponytail: there is no sandbox in the desktop app yet; say so rather than open nothing.
        Cmd::Sandbox => return Err("The Linux sandbox is not in the desktop app yet.".into()),
        Cmd::Sidebar => {
            app.settings.sidebar_open = !app.settings.sidebar_open;
            app.settings.save();
        }
        // /help and the option and prompt commands never get here: `slash::submit` settles them.
        _ => {}
    }
    Ok(None)
}

/// `/rewind`: back to before the last question, chat and files, once the user agrees.
fn rewind(app: &mut App) -> Result<Option<String>, String> {
    let Some(at) = app.conv.messages.iter().rposition(|m| m.role == Role::User && !m.note) else {
        return Err("There is no message to rewind to yet.".into());
    };
    let asked = &app.conv.messages[at];
    let question = asked.text();
    let workspace = app.conv.workspace();
    let point = snapshots::find_restore_point(&workspace, asked.other.get("restorePoint"), &question, asked.created_at, None);
    let removed = app.conv.messages.len() - at;
    // ponytail: the web also names the restore point's clock time in the first line; add it if anyone misses it.
    let files = match &point {
        RestorePoint::Snapshot(_) => "Files go back to how they were before this message. The current files are saved first, so that can be undone.",
        RestorePoint::Empty => "There were no files before this message, so rewinding the files removes them all. They are saved first, so that can be undone.",
        RestorePoint::Missing => "This message's file restore point has been pruned (only the newest are kept) — only the chat can rewind.",
        RestorePoint::None => "No file restore point was taken for this message — only the chat can rewind.",
    };
    let (short, later) = rewind_words(&question, removed);
    if !confirm(&format!("Rewind to before \"{short}\"?\n\nRemoves that message{later}; its text goes back in the box.\n{files}")) {
        return Ok(None);
    }
    // The same cut the Rewind button on a question makes; a failure comes back as its error.
    let files = matches!(point, RestorePoint::Snapshot(_) | RestorePoint::Empty);
    app.rewind = Some(super::rewind::Preview { id: app.conv.messages[at].id.clone(), removed, point, error: String::new() });
    app.rewind_run(Some(files));
    app.slash.caret_to_end = true;
    app.rewind.take().map_or(Ok(None), |failed| Err(failed.error))
}

/// The words of the rewind question: the message cut to 80 characters on one line, and what goes with it.
fn rewind_words(question: &str, removed: usize) -> (String, String) {
    let quoted = question.split_whitespace().collect::<Vec<_>>().join(" ");
    let short = if quoted.chars().count() > 80 { format!("{}…", quoted.chars().take(80).collect::<String>()) } else { quoted };
    let later = match removed.saturating_sub(1) {
        0 => String::new(),
        1 => " and the reply after it".to_string(),
        n => format!(" and the {n} messages after it"),
    };
    (short, later)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewind_question_words() {
        assert_eq!(rewind_words("fix  the\nlogin", 1), ("fix the login".into(), String::new()));
        assert_eq!(rewind_words("x", 2).1, " and the reply after it");
        assert_eq!(rewind_words("x", 5).1, " and the 4 messages after it");
        let (short, _) = rewind_words(&"é".repeat(90), 1);
        assert_eq!((short.chars().count(), short.ends_with('…')), (81, true));
    }
}
