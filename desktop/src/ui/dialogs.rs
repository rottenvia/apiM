//! The dialogs that are not Settings or Plugins: the delete confirmation
//! (DeleteChatDialog.tsx), search across chats (SearchModal.tsx), the MCP console
//! (McpConsole.tsx) and the plain file preview.

use super::form::{self, Btn, Input};
use super::overlay::{self, Card};
use super::settings::part;
use super::theme::{self, W, alpha, p};
use super::{App, Dialog, icons, widgets};
use crate::mcp::{self, McpServerPublic, McpTool};
use crate::store::{self, SearchHit};
use eframe::egui::{self, Color32, CursorIcon, Rect, RichText, Sense, Stroke, StrokeKind, pos2, vec2};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub fn show(app: &mut App, ctx: &egui::Context) {
    let mut dialog = std::mem::replace(&mut app.dialog, Dialog::None);
    let keep = match &mut dialog {
        Dialog::None => return,
        Dialog::Settings => super::settings::show(app, ctx),
        Dialog::Plugins => super::plugin_modal::show(app, ctx),
        Dialog::Mcp => console(app, ctx),
        Dialog::Delete { ids, opened } => delete(app, ctx, ids, *opened),
        Dialog::Search => search(app, ctx),
        Dialog::Preview(path, text) => preview(ctx, path, text),
    };
    if keep && app.dialog == Dialog::None {
        app.dialog = dialog;
        return;
    }
    // Each opening starts clean, as a freshly mounted component does.
    match dialog {
        Dialog::Settings => app.settings_ui = Default::default(),
        Dialog::Plugins => app.plugin_ui = Default::default(),
        Dialog::Mcp => app.console = Default::default(),
        Dialog::Search => app.search = Default::default(),
        _ => {}
    }
}

/// A workspace file opened for reading.
// ponytail: stands in for the Workspace files slide-over until that panel is ported.
fn preview(ctx: &egui::Context, path: &str, text: &str) -> bool {
    let p = p();
    let screen = ctx.content_rect().size();
    let shown = Card::new("preview", 860.0, screen.y - 64.0).show(ctx, |ui, close| {
        let rect = ui.max_rect();
        let (head, body) = rect.split_top_bottom_at_y(rect.top() + 53.0);
        ui.painter().hline(head.x_range(), head.bottom() - 0.5, Stroke::new(1.0, p.border));
        part(ui, head, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 10)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        if overlay::head_btn(ui, icons::CLOSE, 32.0, 15.0, true, "Close (Esc)").clicked() {
                            *close = true;
                        }
                        if overlay::outline_btn(ui, icons::COPY_SMALL.stroke(1.7), "Copy", None).clicked() {
                            ui.ctx().copy_text(text.to_string());
                        }
                        ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                            ui.add(egui::Label::new(RichText::new(path).font(theme::mono(13.0)).color(p.text)).truncate().selectable(false));
                        });
                    });
                });
            });
        });
        part(ui, body, |ui| {
            egui::ScrollArea::both().id_salt("preview").auto_shrink(false).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 14)).show(ui, |ui| {
                    let mut job = egui::text::LayoutJob::simple(text.replace('\t', "  "), theme::mono(13.0), p.text, f32::INFINITY);
                    job.sections[0].format.line_height = Some(21.125);
                    ui.add(egui::Label::new(job).selectable(true).extend());
                });
            });
        });
    });
    shown == overlay::State::Open
}

// ------------------------------------------------------------------ delete

/// "Unlocking in 3s…": whole seconds left before Delete arms, counted the way the web's ticker does.
fn seconds_left(total: u32, elapsed: f32) -> u32 {
    (total as f32 - elapsed).ceil().max(0.0) as u32
}

fn delete(app: &mut App, ctx: &egui::Context, ids: &[String], opened: Instant) -> bool {
    let p = p();
    let total = app.settings.delete_delay.clamp(1, 30);
    let remaining = seconds_left(total, opened.elapsed().as_secs_f32());
    let armed = remaining == 0;
    let chats: Vec<_> = ids.iter().filter_map(|id| app.chats.iter().find(|c| &c.id == id)).collect();
    let title_of = |i: usize| chats.get(i).map(|c| c.title.as_str()).filter(|t| !t.is_empty()).unwrap_or("Untitled chat");
    let n = ids.len();
    let mut confirm = false;

    let mut card = Card::new("delete-chat", 416.0, 640.0);
    (card.hug, card.secs, card.rise, card.grow, card.exit, card.border) = (true, 0.15, 0.0, 0.95, true, p.border);
    let shown = card.show(ctx, |ui, close| {
        egui::Frame::new().inner_margin(egui::Margin { left: 20, right: 20, top: 20, bottom: 0 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 12.0;
                let (cell, _) = ui.allocate_exact_size(vec2(36.0, 38.0), Sense::hover());
                ui.painter().circle_filled(cell.center() + vec2(0.0, 1.0), 18.0, alpha(p.danger, 12.0));
                icons::paint(ui, icons::WARNING, cell.center() + vec2(0.0, 1.0), 18.0, p.danger);
                ui.vertical(|ui| {
                    let (heading, what) = if n > 1 { (format!("Delete {n} chats?"), "these chats") } else { ("Are you sure?".to_string(), "this chat") };
                    form::para(ui, &heading, 15.0, 24.0, W::Semibold, p.text);
                    ui.add_space(4.0);
                    form::para(ui, &format!("You will lose all data of {what}. This cannot be undone."), 13.0, 20.0, W::Regular, p.text2);
                });
            });
            ui.add_space(14.0);
            form::boxed(ui, p.bg, p.border, 12, (12, 10), |ui| {
                form::line(ui, title_of(0), 13.0, 19.5, W::Medium, p.text).on_hover_text(title_of(0));
                if n > 1 {
                    ui.add_space(6.0);
                    widgets::rule(ui);
                    ui.add_space(6.0);
                    egui::ScrollArea::vertical().id_salt("also").max_height(106.0).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        for i in 1..n.min(41) {
                            form::line(ui, title_of(i), 12.0, 20.0, W::Regular, p.text2);
                        }
                        if n > 41 {
                            form::line(ui, &format!("and {} more…", n - 41), 12.0, 20.0, W::Regular, p.muted);
                        }
                    });
                }
                ui.add_space(4.0);
                let summary = match (n, chats.first().map(|c| c.message_count)) {
                    (2.., _) => format!("{n} chats, and every message in them, will be deleted."),
                    (_, None) => "Every message in it will be deleted.".to_string(),
                    (_, Some(count)) => format!("{count} message{} will be deleted.", if count == 1 { "" } else { "s" }),
                };
                form::para(ui, &summary, 12.0, 18.0, W::Regular, p.muted);
            });
        });
        ui.add_space(16.0);
        widgets::rule(ui);
        egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 14)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    let label = if !armed { format!("Delete ({remaining})") } else if n > 1 { format!("Delete {n}") } else { "Delete".to_string() };
                    let text = widgets::galley(ui, &label, theme::font(13.0, W::Medium), Color32::WHITE);
                    let (rect, response) = ui.allocate_exact_size(vec2(text.size().x + 24.0, 31.5), if armed { Sense::click() } else { Sense::hover() });
                    let response = response.on_hover_cursor(if armed { CursorIcon::PointingHand } else { CursorIcon::NotAllowed });
                    if armed {
                        let t = widgets::fade(ui, response.id, response.hovered());
                        ui.painter().rect_filled(rect, 8.0, widgets::lerp(alpha(p.danger, 90.0), p.danger, t));
                    } else {
                        ui.painter().rect_filled(rect, 8.0, alpha(p.danger, 25.0));
                        // The bar fills in whole steps, one per second.
                        let part = ((total - remaining) as f32 / total as f32 * 100.0).round() / 100.0;
                        let filled = ui.ctx().animate_value_with_time(response.id.with("fill"), part, 0.15);
                        ui.painter().with_clip_rect(Rect::from_min_size(rect.min, vec2(rect.width() * filled, rect.height()))).rect_filled(rect, 8.0, alpha(p.danger, 35.0));
                    }
                    widgets::text_at(ui, rect.left() + 12.0, rect.center().y, text);
                    let tip = if !armed { format!("Unlocks in {remaining}s") } else if n > 1 { format!("Delete these {n} chats") } else { "Delete this chat".to_string() };
                    if response.on_hover_text(tip).clicked() {
                        confirm = true;
                    }
                    let cancel = Btn::outline("Cancel").text(13.0, 19.5).pad(12.0, 6.0).show(ui);
                    // Focus starts on Cancel, so Enter never deletes.
                    if opened.elapsed() < Duration::from_millis(150) {
                        cancel.request_focus();
                    }
                    if cancel.clicked() {
                        *close = true;
                    }
                    ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                        let status = if armed { "You can delete it now.".to_string() } else { format!("Unlocking in {remaining}s…") };
                        form::line(ui, &status, 12.0, 16.0, W::Regular, p.muted);
                    });
                });
            });
        });
    });
    if !armed {
        ctx.request_repaint_after(Duration::from_millis(100));
    }
    if confirm {
        app.delete_chats(ids);
        return false;
    }
    shown == overlay::State::Open
}

// ------------------------------------------------------------------ search

#[derive(Default)]
pub struct Search {
    query: String,
    /// The row the arrow keys are on.
    active: usize,
    hits: Vec<SearchHit>,
    /// The text the hits belong to.
    shown_for: String,
    /// The text last typed, and when: a search starts 180 ms after typing stops.
    typed: Option<(String, Instant)>,
    waiting: Option<mpsc::Receiver<(String, Vec<SearchHit>)>>,
}

impl Search {
    /// The dialog with something already typed.
    pub fn asking(query: &str) -> Search {
        Search { query: query.to_string(), ..Default::default() }
    }
}

/// "5m ago" for a chat last touched at `then`.
fn time_ago(then_ms: u64, now_ms: u64) -> String {
    let secs = now_ms.saturating_sub(then_ms) / 1000;
    match secs {
        0..=59 => "just now".into(),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86_399 => format!("{}h ago", secs / 3600),
        86_400..=2_591_999 => format!("{}d ago", secs / 86_400),
        _ => chrono::DateTime::from_timestamp_millis(then_ms as i64).map_or(String::new(), |t| t.with_timezone(&chrono::Local).format("%-m/%-d/%Y").to_string()),
    }
}

/// `text` as a layout job with every occurrence of `needle` marked, whatever its case.
fn marked(text: &str, needle: &str, lead: Option<&str>, font: egui::FontId, line: f32, ink: Color32, wrap: f32, rows: usize) -> egui::text::LayoutJob {
    let p = p();
    let mut job = egui::text::LayoutJob::default();
    job.wrap = egui::text::TextWrapping { max_width: wrap, max_rows: rows, break_anywhere: rows == 1, overflow_character: Some('…') };
    let plain = egui::TextFormat { font_id: font.clone(), color: ink, line_height: Some(line), ..Default::default() };
    if let Some(lead) = lead {
        job.append(lead, 0.0, egui::TextFormat { font_id: theme::font(11.0, W::Regular), color: p.muted, line_height: Some(line), extra_letter_spacing: 0.275, ..Default::default() });
        job.append("", 4.0, plain.clone());
    }
    let hit = egui::TextFormat { color: p.text, background: alpha(p.accent, 25.0), ..plain.clone() };
    // Lower-casing can change a character's length, so matches are found on the characters, not the bytes.
    let (hay, find): (Vec<char>, Vec<char>) = (text.chars().collect(), needle.to_lowercase().chars().collect());
    let same = |a: char, b: char| a == b || a.to_lowercase().eq(std::iter::once(b));
    let (mut at, mut from) = (0, 0);
    while !find.is_empty() && at + find.len() <= hay.len() {
        if hay[at..at + find.len()].iter().zip(&find).all(|(a, b)| same(*a, *b)) {
            job.append(&hay[from..at].iter().collect::<String>(), 0.0, plain.clone());
            job.append(&hay[at..at + find.len()].iter().collect::<String>(), 0.0, hit.clone());
            at += find.len();
            from = at;
        } else {
            at += 1;
        }
    }
    job.append(&hay[from..].iter().collect::<String>(), 0.0, plain);
    job
}

fn search(app: &mut App, ctx: &egui::Context) -> bool {
    let p = p();
    let st = &mut app.search;
    let needle = st.query.trim().to_string();

    // Typing restarts the wait; once it has been quiet for 180 ms the search goes out.
    if st.typed.as_ref().map(|(text, _)| text.as_str()) != Some(needle.as_str()) {
        st.typed = Some((needle.clone(), Instant::now()));
    }
    if needle.chars().count() < 2 {
        st.hits.clear();
        st.shown_for.clear();
        st.waiting = None;
    } else if st.shown_for != needle && st.waiting.is_none() {
        let since = st.typed.as_ref().map_or(Duration::ZERO, |(_, at)| at.elapsed());
        if since >= Duration::from_millis(180) {
            let (tx, rx) = mpsc::channel();
            let (asked, wake) = (needle.clone(), ctx.clone());
            std::thread::spawn(move || {
                let hits = store::search_chats(&asked, 30);
                let _ = tx.send((asked, hits));
                wake.request_repaint();
            });
            st.waiting = Some(rx);
        } else {
            ctx.request_repaint_after(Duration::from_millis(180) - since);
        }
    }
    if let Some((asked, hits)) = st.waiting.as_ref().and_then(|rx| rx.try_recv().ok()) {
        st.waiting = None;
        // An answer to an older question is dropped; the newer one goes out next frame.
        if asked == needle {
            st.hits = hits;
            st.shown_for = asked;
            st.active = 0;
        }
    }
    let loading = st.waiting.is_some() || (needle.chars().count() >= 2 && st.shown_for != needle);

    let (down, up, enter) = ctx.input_mut(|i| (i.consume_key(egui::Modifiers::NONE, egui::Key::ArrowDown), i.consume_key(egui::Modifiers::NONE, egui::Key::ArrowUp), i.consume_key(egui::Modifiers::NONE, egui::Key::Enter)));
    if down {
        st.active = (st.active + 1).min(st.hits.len().saturating_sub(1));
    }
    if up {
        st.active = st.active.saturating_sub(1);
    }
    let mut open = enter.then(|| st.hits.get(st.active).map(|h| h.id.clone())).flatten();

    let screen = ctx.content_rect().size();
    let mut card = Card::new("search", 672.0, screen.y * 0.88 - 16.0);
    (card.hug, card.top, card.secs, card.rise, card.exit) = (true, Some(16.0 + screen.y * 0.12), 0.15, -8.0, true);
    let now = store::now_ms();
    let shown = card.show(ctx, |ui, close| {
        egui::Frame::new().inner_margin(egui::Margin::symmetric(14, 12)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                icons::show(ui, icons::SEARCH_SMALL.stroke(2.0), 16.0, p.muted);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let key = widgets::galley(ui, "Esc", theme::mono(11.0), p.muted);
                    let (cap, _) = ui.allocate_exact_size(vec2(key.size().x + 14.0, 22.5), Sense::hover());
                    ui.painter().rect(cap, 4.0, Color32::TRANSPARENT, Stroke::new(1.0, p.border), StrokeKind::Inside);
                    widgets::text_at(ui, cap.left() + 7.0, cap.center().y, key);
                    if loading {
                        ui.add(egui::Label::new(widgets::text("…", 11.0, W::Regular, p.muted)).selectable(false));
                    }
                    let field = ui.add(
                        egui::TextEdit::singleline(&mut st.query)
                            .hint_text(widgets::text("Search your chats…", 15.0, W::Regular, p.muted))
                            .font(theme::font(15.0, W::Regular))
                            .text_color(p.text)
                            .desired_width(f32::INFINITY)
                            .min_size(vec2(0.0, 22.5))
                            .vertical_align(egui::Align::Center)
                            .frame(egui::Frame::NONE)
                            .margin(egui::Margin::ZERO),
                    );
                    // The caret never leaves the box while the dialog is open.
                    field.request_focus();
                });
            });
        });
        widgets::rule(ui);
        egui::ScrollArea::vertical().id_salt("hits").max_height(screen.y * 0.52).show(ui, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                let empty = |ui: &mut egui::Ui, text: &str| {
                    ui.add_space(32.0);
                    ui.vertical_centered(|ui| form::para(ui, text, 13.0, 19.5, W::Regular, p.muted));
                    ui.add_space(32.0);
                };
                if needle.chars().count() < 2 {
                    return empty(ui, "Type at least 2 characters to search titles and messages");
                }
                if st.hits.is_empty() {
                    if !loading {
                        empty(ui, &format!("No matches for “{needle}”"));
                    }
                    return;
                }
                for (i, hit) in st.hits.iter().enumerate() {
                    let width = ui.available_width() - 24.0;
                    let when = widgets::galley(ui, &format!("{}{}", if hit.archived { "archived · " } else { "" }, time_ago(hit.updated_at, now)), theme::font(11.0, W::Regular), p.muted);
                    let title = ui.painter().layout_job(marked(&hit.title, &needle, None, theme::font(14.0, W::Medium), 20.0, p.text, width - when.size().x - 12.0, 1));
                    let snippets: Vec<_> = hit.snippets.iter().map(|(user, text)| ui.painter().layout_job(marked(text, &needle, Some(if *user { "YOU" } else { "AI" }), theme::font(12.0, W::Regular), 16.5, p.text2, width, 2))).collect();
                    let more = hit.match_count.saturating_sub(hit.snippets.len());
                    let height = 10.0 + 20.0 + snippets.iter().map(|s| 4.0 + s.size().y).sum::<f32>() + if more > 0 { 4.0 + 16.5 } else { 0.0 } + 10.0;
                    let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), height), Sense::click());
                    let response = response.on_hover_cursor(CursorIcon::PointingHand);
                    // The pointer and the arrow keys move the same highlight.
                    if response.hovered() && ui.input(|i| i.pointer.delta() != egui::Vec2::ZERO) {
                        st.active = i;
                    }
                    let t = widgets::fade(ui, response.id, st.active == i);
                    ui.painter().rect_filled(row, 12.0, widgets::lerp(Color32::TRANSPARENT, p.elevated, t));
                    let (left, mut y) = (row.left() + 12.0, row.top() + 10.0);
                    ui.painter().galley(pos2(left, y), title, p.text);
                    widgets::text_at(ui, row.right() - 12.0 - when.size().x, y + 11.0, when);
                    y += 20.0;
                    for snippet in snippets {
                        ui.painter().galley(pos2(left, y + 4.0), snippet.clone(), p.text2);
                        y += 4.0 + snippet.size().y;
                    }
                    if more > 0 {
                        widgets::text_at(ui, left, y + 4.0 + 8.25, widgets::galley(ui, &format!("+{more} more matches"), theme::font(11.0, W::Regular), p.muted));
                    }
                    if response.clicked() {
                        open = Some(hit.id.clone());
                    }
                }
            });
        });
        if !st.hits.is_empty() && needle.chars().count() >= 2 {
            widgets::rule(ui);
            egui::Frame::new().inner_margin(egui::Margin::symmetric(14, 8)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;
                    let small = |text: &str| egui::Label::new(widgets::lines(text, 11.0, 16.5, W::Regular, p.muted)).selectable(false);
                    ui.add(small("↑↓ navigate"));
                    ui.add(small("↵ open"));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let n = st.hits.len();
                        ui.add(small(&format!("{n} chat{}", if n == 1 { "" } else { "s" })));
                    });
                });
            });
        }
        if open.is_some() {
            *close = true;
        }
    });
    if let Some(id) = open {
        app.open_chat(&id);
        return false;
    }
    shown == overlay::State::Open
}

// ------------------------------------------------------------------ MCP console

#[derive(Default)]
pub struct Console {
    servers: Option<Vec<McpServerPublic>>,
    server: usize,
    tools: Listing,
    tool: usize,
    args: String,
    /// (worked, what came back)
    result: Option<(bool, String)>,
    calling: Option<mpsc::Receiver<Result<String, String>>>,
}

#[derive(Default)]
enum Listing {
    #[default]
    Idle,
    Loading(mpsc::Receiver<Result<Vec<McpTool>, String>>),
    Ready(Vec<McpTool>),
    Failed(String),
}

fn list_tools(app: &App, ctx: &egui::Context, server_id: String) -> Listing {
    let (tx, rx) = mpsc::channel();
    let wake = ctx.clone();
    app.rt.spawn(async move {
        let found = mcp::test(&crate::provider::client(), &store::data_dir(), &server_id, "", "").await;
        let _ = tx.send(found.map(|c| c.tools).map_err(|why| if why.is_empty() { "Could not reach the server.".to_string() } else { why }));
        wake.request_repaint();
    });
    Listing::Loading(rx)
}

fn console(app: &mut App, ctx: &egui::Context) -> bool {
    let p = p();
    if app.console.servers.is_none() {
        let servers = mcp::list(&store::data_dir());
        app.console.args = "{\n  \n}".into();
        if let Some(first) = servers.first() {
            app.console.tools = list_tools(app, ctx, first.id.clone());
        }
        app.console.servers = Some(servers);
    }
    if let Listing::Loading(rx) = &app.console.tools {
        if let Ok(found) = rx.try_recv() {
            app.console.tool = 0;
            app.console.tools = match found {
                Ok(tools) => Listing::Ready(tools),
                Err(why) => Listing::Failed(why),
            };
        }
    }
    if let Some(result) = app.console.calling.as_ref().and_then(|rx| rx.try_recv().ok()) {
        app.console.calling = None;
        app.console.result = Some(match result {
            Ok(text) => (true, text),
            Err(why) => (false, why),
        });
    }
    let servers = app.console.servers.clone().unwrap_or_default();
    let (mut relist, mut call) = (false, false);

    let mut card = Card::new("mcp-console", 672.0, ctx.content_rect().height() * 0.85);
    (card.hug, card.secs, card.rise, card.esc, card.border) = (true, 0.0, 0.0, false, p.border);
    let shown = card.show(ctx, |ui, close| {
        let st = &mut app.console;
        egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 16)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if Btn::ghost("✕").text(14.0, 20.0).pad(10.0, 6.0).ink(p.text2, p.text).fill(Color32::TRANSPARENT, p.hover).show(ui).clicked() {
                        *close = true;
                    }
                    ui.add_space(12.0);
                    ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                        form::line(ui, "MCP console", 15.0, 22.5, W::Semibold, p.text);
                        form::line(ui, "Call a server's tools by hand — no model round spent", 12.0, 16.0, W::Regular, p.muted);
                    });
                });
            });
        });
        widgets::rule(ui);
        egui::ScrollArea::vertical().id_salt("console").show(ui, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 16)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                if servers.is_empty() {
                    form::para(ui, "No MCP servers configured. Add one in Settings → MCP servers first.", 14.0, 20.0, W::Regular, p.muted);
                    return;
                }
                form::label(ui, "Server", "");
                ui.add_space(6.0);
                let names: Vec<String> = servers.iter().map(|s| format!("{} — {}", s.name, s.url)).collect();
                if form::select(ui, "console-server", &names, &mut st.server, 14.0, (16.0, 10.0), 12.0) {
                    st.result = None;
                    relist = true;
                }
                ui.add_space(12.0);
                let tools = match &st.tools {
                    Listing::Idle | Listing::Loading(_) => return drop(form::para(ui, "Listing tools…", 14.0, 20.0, W::Regular, p.muted)),
                    Listing::Failed(why) => return drop(form::para(ui, why, 13.0, 19.5, W::Regular, p.danger)),
                    Listing::Ready(tools) => tools,
                };
                form::label(ui, "Tool", "");
                ui.add_space(6.0);
                let tool_names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
                form::select(ui, "console-tool", &tool_names, &mut st.tool, 14.0, (16.0, 10.0), 12.0);
                let tool = tools.get(st.tool);
                if let Some(text) = tool.map(|t| t.description.as_str()).filter(|d| !d.is_empty()) {
                    ui.add_space(6.0);
                    form::para(ui, text, 12.0, 16.0, W::Regular, p.text2);
                }
                if let Some(schema) = tool.map(|t| &t.input_schema).filter(|s| !s.is_null()) {
                    ui.add_space(12.0);
                    form::boxed(ui, p.bg3, p.border, 12, (16, 10), |ui| {
                        form::details(ui, "console-schema", "Expected arguments", 13.0, p.text2, |ui| {
                            ui.add_space(8.0);
                            egui::ScrollArea::horizontal().id_salt("schema").show(ui, |ui| {
                                let shown = serde_json::to_string_pretty(schema).unwrap_or_default();
                                ui.add(egui::Label::new(RichText::new(shown).font(theme::mono(12.0)).color(p.text2).line_height(Some(18.0))).extend().selectable(true));
                            });
                        });
                    });
                }
                ui.add_space(12.0);
                form::label(ui, "Arguments (JSON)", "");
                ui.add_space(6.0);
                Input::new("").mono().rows(5).show(ui, "console-args", &mut st.args);
                ui.add_space(12.0);
                let busy = st.calling.is_some();
                call = Btn::accent(if busy { "Calling…" } else { "Call tool" }).text(14.0, 20.0).pad(20.0, 8.0).radius(12.0).enabled(!busy && tool.is_some()).show(ui).clicked();
                if let Some((ok, text)) = &st.result {
                    ui.add_space(12.0);
                    let (fill, border) = if *ok { (p.bg3, p.border) } else { (alpha(p.danger, 6.0), alpha(p.danger, 30.0)) };
                    form::boxed(ui, fill, border, 12, (16, 12), |ui| {
                        form::para(ui, if *ok { "Result" } else { "Failed" }, 13.0, 19.5, W::Medium, if *ok { p.text } else { p.danger });
                        ui.add_space(6.0);
                        egui::ScrollArea::vertical().id_salt("result").max_height(256.0).show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.add(egui::Label::new(RichText::new(text).font(theme::mono(12.0)).color(p.text2).line_height(Some(18.0))).wrap().selectable(true));
                        });
                    });
                }
            });
        });
    });
    if relist {
        if let Some(server) = servers.get(app.console.server) {
            app.console.tools = list_tools(app, ctx, server.id.clone());
        }
    }
    if call {
        let tool = match &app.console.tools {
            Listing::Ready(tools) => tools.get(app.console.tool).map(|t| t.name.clone()),
            _ => None,
        };
        if let (Some(server), Some(tool)) = (servers.get(app.console.server), tool) {
            let (tx, rx) = mpsc::channel();
            let (id, args, wake) = (server.id.clone(), app.console.args.clone(), ctx.clone());
            app.rt.spawn(async move {
                let _ = tx.send(mcp::call(&crate::provider::client(), &store::data_dir(), &id, &tool, &args).await);
                wake.request_repaint();
            });
            app.console.calling = Some(rx);
            app.console.result = None;
        }
    }
    shown == overlay::State::Open
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn countdown_and_ages() {
        // Shows the full count for the first second, then one less each second, and arms at zero.
        assert_eq!((seconds_left(5, 0.0), seconds_left(5, 0.9), seconds_left(5, 1.1), seconds_left(5, 4.99), seconds_left(5, 5.0)), (5, 5, 4, 1, 0));
        let now = 10_000_000_000;
        assert_eq!((time_ago(now - 30_000, now), time_ago(now - 90_000, now), time_ago(now - 7_200_000, now), time_ago(now - 3 * 86_400_000, now)), ("just now".into(), "1m ago".into(), "2h ago".into(), "3d ago".into()));
    }

    #[test]
    fn marks_every_match() {
        let job = marked("Rust and rust", "RUST", None, theme::font(12.0, W::Regular), 16.0, Color32::WHITE, 100.0, 1);
        let marks: Vec<&str> = job.sections.iter().filter(|s| s.format.background != Color32::TRANSPARENT).map(|s| &job.text[s.byte_range.start.0..s.byte_range.end.0]).collect();
        assert_eq!(marks, ["Rust", "rust"]);
    }
}
