//! "Copy files from another chat": pick one chat and its files are copied into
//! this chat's workspace, the conversation staying where it is
//! (src/components/ImportFilesDialog.tsx).

use super::overlay::{self, Card};
use super::settings::{close_btn, part};
use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use crate::snapshots;
use crate::store::Conversation;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::path::Path;
use std::sync::mpsc;

#[derive(Default)]
pub struct State {
    query: String,
    /// The chat ticked in the list.
    picked: Option<String>,
    /// A copy under way: whether it worked arrives here.
    busy: Option<mpsc::Receiver<bool>>,
    error: Option<String>,
    /// The search box has been given the keyboard.
    focused: bool,
    /// The copy went through: close on the next frame.
    done: bool,
}

/// The self-portrait's states for this dialog.
pub fn stage(app: &mut App, token: &str) {
    if matches!(token, "import-files" | "import-picked") {
        let picked = app.chats.iter().find(|chat| token == "import-picked" && chat.id != app.conv.id).map(|chat| chat.id.clone());
        app.ws.import = Some(State { picked, ..Default::default() });
    }
}

/// Copies every file of one workspace into another: (copied, left alone).
/// A name already there is kept, so copying twice, or into a chat that has started, loses nothing.
fn copy_workspace(from: &Path, to: &Path) -> (usize, usize) {
    let (mut copied, mut skipped) = (0, 0);
    for (rel, _, _) in snapshots::list_files(from) {
        let dest = to.join(&rel);
        // One file that cannot be read does not stop the rest.
        if !dest.exists() && std::fs::create_dir_all(dest.parent().unwrap_or(to)).is_ok() && std::fs::copy(from.join(&rel), &dest).is_ok() {
            copied += 1;
        } else {
            skipped += 1;
        }
    }
    (copied, skipped)
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let p = p();
    let App { ws, chats, conv, files_stale, .. } = &mut *app;
    let Some(st) = ws.import.as_mut() else { return };
    if let Some(Ok(worked)) = st.busy.as_ref().map(|result| result.try_recv()) {
        st.busy = None;
        *files_stale = true;
        (st.done, st.error) = (worked, (!worked).then(|| "Couldn't copy those files.".to_string()));
    }
    let mut run = false;
    let shown = Card::new("import-files", 672.0, (ctx.content_rect().height() * 0.86).min(512.0)).show(ctx, |ui, close| {
        *close |= st.done;
        let rect = ui.max_rect();
        let rule = Stroke::new(1.0, p.border);

        widgets::text_at(ui, rect.left() + 20.0, rect.top() + 26.0, widgets::galley(ui, "Copy files from another chat", theme::font(15.0, W::Semibold), p.text));
        widgets::text_at(ui, rect.left() + 20.0, rect.top() + 46.0, widgets::galley(ui, "Files only. The conversation stays where it is.", theme::font(11.0, W::Regular), p.muted));
        if part(ui, Rect::from_min_size(pos2(rect.right() - 54.0, rect.top() + 18.0), vec2(34.0, 34.0)), |ui| close_btn(ui, 34.0, 8.0, 18.0, "")).clicked() {
            *close = true;
        }
        ui.painter().hline(rect.x_range(), rect.top() + 70.5, rule);

        let search = Rect::from_min_size(pos2(rect.left() + 20.0, rect.top() + 81.0), vec2(rect.width() - 40.0, 19.5));
        let typed = part(ui, search, |ui| ui.add(egui::TextEdit::singleline(&mut st.query).hint_text(widgets::text("Search chats…", 13.0, W::Regular, p.muted)).font(theme::font(13.0, W::Regular)).text_color(p.text).desired_width(f32::INFINITY).frame(egui::Frame::NONE).margin(egui::Margin::ZERO)));
        if !std::mem::replace(&mut st.focused, true) {
            typed.request_focus();
        }
        ui.painter().hline(rect.x_range(), rect.top() + 111.0, rule);

        let foot = rect.with_min_y(rect.bottom() - 69.0);
        ui.painter().hline(rect.x_range(), foot.top() + 0.5, rule);
        let busy = st.busy.is_some();
        let ready = st.picked.is_some() && !busy;
        let copy = part(ui, Rect::from_min_max(pos2(foot.left() + 20.0, foot.top() + 15.0), pos2(foot.right() - 20.0, foot.bottom() - 14.0)), |ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // Dimmed and deaf until a chat is ticked, and while a copy runs.
                ui.set_opacity(if ready { 1.0 } else { 0.4 });
                widgets::btn_primary(ui, None, if busy { "Copying…" } else { "Copy files" })
            })
            .inner
        });
        run = copy.clicked() && ready;
        let (words, ink) = st.error.as_deref().map_or(("Files already here are kept, never overwritten.", p.muted), |why| (why, p.danger));
        widgets::text_at(ui, foot.left() + 20.0, foot.top() + 35.0, widgets::clipped(ui, words, theme::font(11.0, W::Regular), ink, copy.rect.left() - 12.0 - (foot.left() + 20.0)));

        // Copying a workspace into itself does nothing, so this chat is not offered.
        let query = st.query.trim().to_lowercase();
        let others = chats.iter().filter(|chat| chat.id != conv.id);
        let none_at_all = others.clone().next().is_none();
        let visible: Vec<_> = others.filter(|chat| chat.title.to_lowercase().contains(&query)).collect();
        part(ui, Rect::from_min_max(pos2(rect.left(), rect.top() + 111.5), pos2(rect.right(), foot.top())), |ui| {
            egui::ScrollArea::vertical().id_salt("import-files-list").auto_shrink(false).show(ui, |ui| {
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                let left = ui.max_rect().left() + 10.0;
                ui.add_space(10.0);
                if visible.is_empty() {
                    let words = widgets::galley(ui, if none_at_all { "No other chats yet." } else { "Nothing matches that." }, theme::font(12.0, W::Regular), p.muted);
                    widgets::text_at(ui, rect.center().x - words.size().x / 2.0, ui.cursor().top() + 49.0, words);
                    return;
                }
                for chat in visible {
                    // `.option-item`: a tick box and the title. The button below commits, so a row only holds the choice.
                    let row = Rect::from_min_size(pos2(left, ui.cursor().top()), vec2(rect.width() - 20.0, 39.5));
                    ui.advance_cursor_after_rect(row);
                    if !ui.is_rect_visible(row) {
                        continue;
                    }
                    let response = ui.interact(row, ui.id().with(("chat", &chat.id)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
                    let picked = st.picked.as_deref() == Some(chat.id.as_str());
                    let t = widgets::fade(ui, response.id, response.hovered());
                    ui.painter().rect_filled(row, 8.0, if picked { alpha(p.accent, 8.0) } else { p.hover.gamma_multiply(t) });
                    let tick = Rect::from_min_size(pos2(row.left() + 12.0, row.center().y - 8.0), vec2(16.0, 16.0));
                    ui.painter().rect(tick, 4.0, if picked { p.accent } else { Color32::TRANSPARENT }, Stroke::new(1.0, if picked { p.accent } else { p.border }), StrokeKind::Inside);
                    if picked {
                        icons::paint(ui, icons::CHECK.stroke(3.0), tick.center(), 10.0, Color32::WHITE);
                    }
                    widgets::text_at(ui, row.left() + 38.0, row.center().y, widgets::clipped(ui, &chat.title, theme::font(13.0, W::Regular), if picked { p.text } else { p.text2 }, row.width() - 50.0));
                    if response.clicked() {
                        st.picked = (!picked).then(|| chat.id.clone());
                    }
                }
                ui.add_space(10.0);
            });
        });
    });
    if run && let Some(from) = st.picked.clone() {
        // Off the window's thread: a workspace can hold gigabytes.
        let (to, done, ctx) = (conv.workspace(), mpsc::channel(), ctx.clone());
        st.busy = Some(done.1);
        st.error = None;
        std::thread::spawn(move || {
            let worked = Conversation::load(&from).map(|chat| copy_workspace(&chat.workspace(), &to)).is_some();
            let _ = done.0.send(worked);
            ctx.request_repaint();
        });
    }
    if shown == overlay::State::Gone {
        ws.import = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copying_another_chats_files_never_overwrites() {
        // Two throwaway workspaces: nothing here touches a real chat.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch").join(format!("import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (from, to) = (root.join("from"), root.join("to"));
        std::fs::create_dir_all(from.join("src")).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("src/a.txt"), "theirs").unwrap();
        std::fs::write(from.join("notes.md"), "theirs").unwrap();
        std::fs::write(to.join("notes.md"), "mine").unwrap();

        assert_eq!(copy_workspace(&from, &to), (1, 1));
        assert_eq!(std::fs::read_to_string(to.join("src/a.txt")).unwrap(), "theirs");
        assert_eq!(std::fs::read_to_string(to.join("notes.md")).unwrap(), "mine");
        // A second time finds everything already there.
        assert_eq!(copy_workspace(&from, &to), (0, 2));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
