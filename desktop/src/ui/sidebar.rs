//! The chat list on the left: src/components/Sidebar.tsx, control for control.

use super::theme::{self, W, alpha, p};
use super::widgets::{self, fade, lerp};
use super::{App, Dialog, icons};
use crate::store::ChatMeta;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub const WIDTH: f32 = 288.0;
const FOOTER: f32 = 12.0 + 40.0 * 3.0 + 12.0 + 1.0;
const MENU_WIDTH: f32 = 192.0;

pub const EXPORT_FORMATS: [(&str, &str, &str); 4] = [("md", "Markdown", ".md"), ("json", "JSON", ".json"), ("txt", "Plain text", ".txt"), ("html", "Web page", ".html")];

#[derive(Default)]
pub struct State {
    /// The chat whose three-dot menu is open, and where its row sits.
    menu: Option<(String, Rect)>,
    export_open: bool,
    /// The chat being renamed in place.
    editing: Option<String>,
    draft: String,
    focus_draft: bool,
    pub show_archived: bool,
    selecting: bool,
    selected: HashSet<String>,
    /// Where the row of the chat on screen sits this frame, in the list's own coordinates, and whose it is.
    lit: Option<(f32, String)>,
    /// The chat the highlight was last on.
    lit_for: String,
    /// When the list on screen was put there (the chats came in, or the other tab was picked): its rows come in one after another.
    arrived: Option<Instant>,
    /// "Imported 3 chats", shown for a few seconds.
    pub note: Option<(String, Instant)>,
}

enum Action {
    Open(String),
    Rename(String, String),
    Archive(String, bool),
    Delete(Vec<String>),
    Export(String, &'static str),
}

/// Same rule as the web app: names match ignoring case and runs of spaces.
fn title_key(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let full = ui.max_rect();
    let mut action = None;

    // New chat: the only control in its row.
    ui.allocate_ui_with_layout(vec2(WIDTH, 56.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
        ui.add_space(12.0);
        ui.allocate_ui(vec2(WIDTH - 24.0, 38.0), |ui| {
            if widgets::new_chat_btn(ui).clicked() {
                app.new_chat();
            }
        });
    });

    if let Some((text, since)) = &app.side.note {
        if since.elapsed() > Duration::from_secs(4) {
            app.side.note = None;
        } else {
            ui.horizontal(|ui| {
                ui.add_space(12.0);
                ui.label(widgets::lines(text.as_str(), 11.0, 16.0, W::Regular, p.text2));
            });
            ui.add_space(4.0);
            ui.ctx().request_repaint_after(Duration::from_millis(500));
        }
    }

    let (active, archived): (Vec<&ChatMeta>, Vec<&ChatMeta>) = app.chats.iter().partition(|c| !c.archived);
    if !app.chats.is_empty() {
        ui.add_space(2.0);
        ui.horizontal(|ui| {
            ui.add_space(12.0);
            ui.allocate_ui(vec2(WIDTH - 24.0, 30.0), |ui| {
                let picked = widgets::segmented(ui, &[("Chats", active.len()), ("Archive", archived.len())], app.side.show_archived as usize);
                if let Some(i) = picked.filter(|i| (*i == 1) != app.side.show_archived) {
                    app.side.show_archived = i == 1;
                    app.side.selected.clear();
                    app.side.arrive();
                }
            });
        });
        ui.add_space(8.0);
    }
    let visible: Vec<ChatMeta> = if app.side.show_archived { archived } else { active }.into_iter().cloned().collect();
    // Selection only ever covers the tab on screen.
    let selected_here: Vec<String> = visible.iter().filter(|c| app.side.selected.contains(&c.id)).map(|c| c.id.clone()).collect();

    if app.side.selecting {
        selection_bar(app, ui, &visible, &selected_here, &mut action);
    }

    let list_height = (full.bottom() - ui.cursor().top() - FOOTER).max(40.0);
    ui.spacing_mut().item_spacing.y = 0.0;
    egui::ScrollArea::vertical().id_salt("chats").auto_shrink(false).max_height(list_height).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        // The highlight is one box that travels from the chat that was open to the one that is, drawn under
        // the rows: its place is known only once they are laid out, so it is kept room for here and drawn after.
        let (top, under) = (ui.cursor().top(), ui.painter().add(egui::Shape::Noop));
        app.side.lit = None;
        // Rows are 42 tall with 2 between them; the last 10 of the width is the scrollbar's.
        let since = app.side.arrived.map(|at| at.elapsed().as_secs_f32()).filter(|secs| *secs < 0.6);
        if since.is_some() {
            ui.ctx().request_repaint();
        }
        for (i, chat) in visible.iter().enumerate() {
            // A list just put there comes in row after row, each a moment behind the one above and from a little left of its place.
            let come = since.map_or(1.0, |secs| egui::emath::easing::cubic_out(((secs - i.min(14) as f32 * 0.02) / 0.22).clamp(0.0, 1.0)));
            ui.add_space(2.0);
            ui.horizontal(|ui| {
                ui.add_space(12.0 - 10.0 * (1.0 - come));
                ui.allocate_ui(vec2(WIDTH - 24.0 - 10.0, 42.0), |ui| {
                    ui.set_opacity(come);
                    row(app, ui, chat, top, &mut action)
                });
            });
        }
        let on = ui.ctx().animate_bool_with_time(egui::Id::new("chat-lit"), app.side.lit.is_some(), 0.15);
        if let Some((y, id)) = app.side.lit.take() {
            // It travels when another chat is opened. When its own chat moves (a reply put it first), it is just there.
            let another = std::mem::replace(&mut app.side.lit_for, id.clone()) != id;
            app.side.lit = Some((widgets::glide(ui.ctx(), egui::Id::new("chat-lit-y"), y, 0.2, another), id));
        }
        if let Some((y, _)) = app.side.lit.as_ref().filter(|_| on > 0.0) {
            let rect = Rect::from_min_size(pos2(full.left() + 12.0, top + y), vec2(WIDTH - 24.0 - 10.0, 42.0));
            ui.painter().set(under, egui::Shape::rect_filled(rect, 8.0, p.elevated.gamma_multiply(on)));
            ui.painter().rect_stroke(rect, 8.0, Stroke::new(1.0, alpha(p.accent, 40.0 * on)), StrokeKind::Inside);
        }
        ui.add_space(2.0);
        if visible.is_empty() {
            ui.add_space(64.0);
            ui.vertical_centered(|ui| {
                ui.set_width(WIDTH);
                ui.label(widgets::text(if app.side.show_archived { "Nothing archived" } else { "No conversations yet" }, 14.0, W::Regular, p.text2));
                ui.add_space(4.0);
                ui.label(widgets::lines(if app.side.show_archived { "Archived chats appear here" } else { "Start a new chat to begin" }, 12.0, 20.0, W::Regular, p.muted));
            });
        }
        ui.add_space(8.0);
    });

    // Footer: pinned to the bottom of the column.
    let footer = Rect::from_min_max(pos2(full.left(), full.bottom() - FOOTER), pos2(full.left() + WIDTH, full.bottom()));
    ui.painter().hline(footer.x_range(), footer.top() + 0.5, Stroke::new(1.0, p.border));
    ui.scope_builder(egui::UiBuilder::new().max_rect(footer.shrink2(vec2(12.0, 0.0)).with_min_y(footer.top() + 13.0)), |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        if widgets::side_link(ui, icons::IMPORT, "Import chats", "Import a chat from a JSON export").clicked() {
            app.import_chats();
        }
        if widgets::side_link(ui, icons::MCP, "MCP console", "Call an MCP server's tools by hand").clicked() {
            app.dialog = Dialog::Mcp;
        }
        if widgets::side_link(ui, icons::SETTINGS, "Settings", "").clicked() {
            app.dialog = Dialog::Settings;
        }
    });

    menu(app, ui.ctx(), &mut action);

    match action {
        Some(Action::Open(id)) => app.open_chat(&id),
        Some(Action::Rename(id, title)) => app.rename_chat(&id, &title),
        Some(Action::Archive(id, archived)) => app.archive_chat(&id, archived),
        Some(Action::Delete(ids)) => app.dialog = Dialog::Delete { ids, opened: Instant::now() },
        Some(Action::Export(id, format)) => app.export_chat(&id, format),
        None => {}
    }
}

fn selection_bar(app: &mut App, ui: &mut egui::Ui, visible: &[ChatMeta], selected_here: &[String], action: &mut Option<Action>) {
    let p = p();
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        egui::Frame::new().fill(p.bg3).stroke(Stroke::new(1.0, p.border)).corner_radius(12).inner_margin(egui::Margin::symmetric(10, 8)).show(ui, |ui| {
            ui.set_width(WIDTH - 24.0 - 22.0);
            ui.spacing_mut().item_spacing.x = 8.0;
            let all = !visible.is_empty() && selected_here.len() == visible.len();
            if check(ui, all, !selected_here.is_empty() && !all).clicked() {
                for chat in visible {
                    if all {
                        app.side.selected.remove(&chat.id);
                    } else {
                        app.side.selected.insert(chat.id.clone());
                    }
                }
            }
            let label = if selected_here.is_empty() { "Select all".to_string() } else { format!("{} selected", selected_here.len()) };
            ui.label(widgets::text(label, 13.0, W::Regular, p.text2));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if widgets::small_btn(ui, "Cancel", p.text2, Color32::TRANSPARENT, p.border).clicked() {
                    app.side.selecting = false;
                    app.side.selected.clear();
                }
                let ready = !selected_here.is_empty();
                let fill = if ready { alpha(p.danger, 90.0) } else { alpha(p.danger, 25.0) };
                if widgets::small_btn(ui, "Delete", Color32::WHITE, fill, Color32::TRANSPARENT).clicked() && ready {
                    *action = Some(Action::Delete(selected_here.to_vec()));
                }
            });
        });
    });
    ui.add_space(8.0);
}

/// A 16px checkbox in the accent colour, like the browser draws `accent-accent`.
fn check(ui: &mut egui::Ui, on: bool, partial: bool) -> egui::Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(16.0, 16.0), Sense::click());
    if on || partial {
        ui.painter().rect_filled(rect, 3.0, p.accent);
        if on {
            icons::paint(ui, icons::CHECK.stroke(3.0), rect.center(), 12.0, Color32::WHITE);
        } else {
            ui.painter().hline(rect.shrink(4.0).x_range(), rect.center().y, Stroke::new(2.0, Color32::WHITE));
        }
    } else {
        ui.painter().rect(rect, 3.0, p.bg, Stroke::new(1.0, p.muted), StrokeKind::Inside);
    }
    response.on_hover_cursor(CursorIcon::PointingHand)
}

fn row(app: &mut App, ui: &mut egui::Ui, chat: &ChatMeta, list_top: f32, action: &mut Option<Action>) {
    let p = p();
    let editing = app.side.editing.as_deref() == Some(chat.id.as_str());
    if editing {
        rename_box(app, ui, chat, action);
        return;
    }
    let selecting = app.side.selecting;
    let menu_open = app.side.menu.as_ref().is_some_and(|(id, _)| *id == chat.id);
    let current = app.current_id() == chat.id;
    let running = app.run.as_ref().is_some_and(|r| r.conv_id == chat.id);

    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    // The dots sit on top of the row, so the row counts as hovered while they are.
    let dots = Rect::from_center_size(pos2(rect.right() - 12.0 - 12.0, rect.center().y), vec2(24.0, 24.0));
    let hovered = ui.rect_contains_pointer(rect);

    // Hover applies at once; only the fade-out is eased (see .conv-row).
    let t = if hovered { 1.0 } else { fade(ui, response.id.with("hover"), false) };
    if hovered {
        fade(ui, response.id.with("hover"), true);
    }
    // The chat on screen is lit by the box that travels (`show`); its name brightens as that arrives.
    let lit = fade(ui, response.id.with("lit"), current);
    if current {
        app.side.lit = Some((rect.top() - list_top, chat.id.clone()));
    }
    let (fill, border, fg) = (lerp(Color32::TRANSPARENT, p.bg3, t * (1.0 - lit)), lerp(Color32::TRANSPARENT, p.border, t * (1.0 - lit)), lerp(lerp(p.text2, p.text, t), p.text, lit));
    ui.painter().rect(rect, 8.0, fill, Stroke::new(1.0, border), StrokeKind::Inside);

    let mut x = rect.left() + 13.0;
    if selecting {
        let on = app.side.selected.contains(&chat.id);
        let box_rect = Rect::from_center_size(pos2(x + 8.0, rect.center().y), vec2(16.0, 16.0));
        if on {
            ui.painter().rect_filled(box_rect, 3.0, p.accent);
            icons::paint(ui, icons::CHECK.stroke(3.0), box_rect.center(), 12.0, Color32::WHITE);
        } else {
            ui.painter().rect(box_rect, 3.0, p.bg, Stroke::new(1.0, p.muted), StrokeKind::Inside);
        }
        x += 16.0 + 4.0;
    }
    let show_dots = !selecting && (hovered || menu_open);
    let right = rect.right() - 13.0 - if !selecting { 24.0 + 4.0 } else { 0.0 } - if running { 8.0 + 8.0 } else { 0.0 };
    widgets::text_at(ui, x, rect.center().y, widgets::clipped(ui, &chat.title, theme::font(14.0, W::Regular), fg, right - x));

    if running {
        // Still working in the background: a dot with a slow ping around it.
        let centre = pos2(right + 8.0 + 4.0, rect.center().y);
        let phase = (ui.input(|i| i.time) % 1.0) as f32;
        ui.painter().circle_filled(centre, 4.0 + 4.0 * phase, alpha(p.accent, 50.0 * (1.0 - phase)));
        ui.painter().circle_filled(centre, 3.0, p.accent);
        ui.ctx().request_repaint_after(Duration::from_millis(50));
    }

    if show_dots {
        let dots_response = ui.interact(dots, response.id.with("dots"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
        let over = dots_response.hovered();
        if over {
            ui.painter().rect_filled(dots, 8.0, p.hover);
        }
        icons::paint(ui, icons::DOTS, dots.center(), 14.0, if over { p.text } else { p.muted });
        if dots_response.clicked() {
            app.side.menu = if menu_open { None } else { Some((chat.id.clone(), rect)) };
            app.side.export_open = false;
            return;
        }
    }

    // A chat opens as the mouse button goes down on it, not when it comes up: the tenth of a second in between
    // was a wait for nothing. (A finger on a touch screen may be about to scroll the list, so that waits.)
    let pressed = response.is_pointer_button_down_on() && ui.input(|i| i.pointer.primary_pressed() && !i.any_touches());
    if response.double_clicked() && !selecting {
        start_rename(app, chat);
    } else if selecting {
        if response.clicked() && !app.side.selected.remove(&chat.id) {
            app.side.selected.insert(chat.id.clone());
        }
    } else if pressed || response.clicked() {
        *action = Some(Action::Open(chat.id.clone()));
    }
    let tip = if running { format!("{} — working in the background", chat.title) } else { chat.title.clone() };
    response.on_hover_text(tip);
}

fn start_rename(app: &mut App, chat: &ChatMeta) {
    app.side.editing = Some(chat.id.clone());
    app.side.draft = chat.title.clone();
    app.side.focus_draft = true;
    app.side.menu = None;
}

fn rename_box(app: &mut App, ui: &mut egui::Ui, chat: &ChatMeta, action: &mut Option<Action>) {
    let p = p();
    let key = title_key(&app.side.draft);
    let duplicate = !key.is_empty() && app.chats.iter().any(|c| c.id != chat.id && title_key(&c.title) == key);
    let mut done = false;
    let mut cancelled = false;
    ui.vertical(|ui| {
        ui.add_space(4.0);
        egui::Frame::new()
            .fill(p.bg)
            .stroke(Stroke::new(1.0, if duplicate { alpha(p.danger, 60.0) } else { alpha(p.accent, 40.0) }))
            .corner_radius(8)
            .inner_margin(egui::Margin::symmetric(6, 4))
            .show(ui, |ui| {
                let edit = ui.add(egui::TextEdit::singleline(&mut app.side.draft).font(theme::font(14.0, W::Regular)).desired_width(f32::INFINITY).frame(egui::Frame::NONE));
                if std::mem::take(&mut app.side.focus_draft) {
                    edit.request_focus();
                }
                if ui.input(|i| i.key_pressed(egui::Key::Escape)) {
                    cancelled = true;
                } else if edit.lost_focus() {
                    done = true;
                }
            });
        if duplicate {
            ui.add_space(4.0);
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                icons::show(ui, icons::ALERT_CIRCLE, 11.0, p.danger);
                ui.add(egui::Label::new(widgets::lines("Another chat is already called that. Every chat needs its own name — its files live in a folder named after it.", 11.0, 16.0, W::Regular, p.danger)).wrap());
            });
        }
        ui.add_space(4.0);
    });
    if cancelled {
        app.side.editing = None;
    } else if done {
        // Blank, unchanged or taken: close without saving.
        let next = app.side.draft.trim().to_string();
        if !next.is_empty() && !duplicate && next != chat.title {
            *action = Some(Action::Rename(chat.id.clone(), next));
        }
        app.side.editing = None;
    }
}

/// The three-dot menu, floating under its row.
fn menu(app: &mut App, ctx: &egui::Context, action: &mut Option<Action>) {
    let Some((id, row)) = app.side.menu.clone() else { return };
    let Some(chat) = app.chats.iter().find(|c| c.id == id).cloned() else {
        app.side.menu = None;
        return;
    };
    let p = p();
    let mut close = ctx.input(|i| i.key_pressed(egui::Key::Escape));
    let area = egui::Area::new(egui::Id::new("chat-menu")).order(egui::Order::Foreground).fixed_pos(pos2(row.right() - 4.0 - MENU_WIDTH, row.bottom() + 4.0)).constrain(true).show(ctx, |ui| {
        widgets::popover_frame(12).inner_margin(egui::Margin::same(4)).show(ui, |ui| {
            ui.set_width(MENU_WIDTH - 10.0);
            ui.spacing_mut().item_spacing.y = 0.0;
            if widgets::menu_item(ui, icons::RENAME, "Rename", false).clicked() {
                start_rename(app, &chat);
            }
            if widgets::menu_item(ui, icons::SELECT, "Select several", false).clicked() {
                app.side.selecting = true;
                app.side.selected = HashSet::from([chat.id.clone()]);
                close = true;
            }
            let download = widgets::menu_item(ui, icons::DOWNLOAD, "Download", false);
            let chevron = if app.side.export_open { icons::CHEVRON_DOWN } else { icons::CHEVRON_RIGHT };
            icons::paint(ui, chevron, pos2(download.rect.right() - 10.0 - 6.0, download.rect.center().y), 12.0, p.text2);
            if download.clicked() {
                app.side.export_open = !app.side.export_open;
            }
            if app.side.export_open {
                let top = ui.cursor().top();
                ui.horizontal(|ui| {
                    ui.add_space(8.0 + 1.0 + 6.0);
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 2.0;
                        for (format, label, ext) in EXPORT_FORMATS {
                            let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::click());
                            let response = response.on_hover_cursor(CursorIcon::PointingHand);
                            let t = fade(ui, response.id, response.hovered());
                            ui.painter().rect_filled(rect, 8.0, lerp(Color32::TRANSPARENT, p.hover, t));
                            widgets::text_at(ui, rect.left() + 10.0, rect.center().y, widgets::galley(ui, label, theme::font(12.0, W::Regular), lerp(p.text2, p.text, t)));
                            let suffix = widgets::galley(ui, ext, theme::mono(11.0), p.muted);
                            widgets::text_at(ui, rect.right() - 10.0 - suffix.size().x, rect.center().y, suffix);
                            if response.clicked() {
                                *action = Some(Action::Export(chat.id.clone(), format));
                                close = true;
                            }
                        }
                    });
                });
                ui.painter().vline(ui.min_rect().left() + 8.5, top..=ui.cursor().top(), Stroke::new(1.0, p.border));
                ui.add_space(2.0);
            }
            if widgets::menu_item(ui, icons::ARCHIVE, if chat.archived { "Unarchive" } else { "Archive" }, false).clicked() {
                *action = Some(Action::Archive(chat.id.clone(), !chat.archived));
                close = true;
            }
            ui.add_space(4.0);
            widgets::rule(ui);
            ui.add_space(4.0);
            if widgets::menu_item(ui, icons::TRASH, "Delete", true).clicked() {
                *action = Some(Action::Delete(vec![chat.id.clone()]));
                close = true;
            }
        });
    });
    // A click anywhere else closes it. The dots button toggles it itself.
    let dots = Rect::from_center_size(pos2(row.right() - 24.0, row.center().y), vec2(24.0, 24.0));
    let outside = ctx.input(|i| i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|at| !area.response.rect.contains(at) && !dots.contains(at)));
    if close || outside || app.side.editing.is_some() {
        app.side.menu = None;
        app.side.export_open = false;
    }
}

impl State {
    /// Forget ticks for chats that no longer exist, and leave selection mode when none are left.
    pub fn prune(&mut self, chats: &[ChatMeta]) {
        self.selected.retain(|id| chats.iter().any(|c| &c.id == id));
        if self.selecting && chats.is_empty() {
            self.selecting = false;
        }
    }

    /// The list on screen is another one from now: its rows come in.
    pub fn arrive(&mut self) {
        self.arrived = Some(Instant::now());
    }

    pub fn finish_selecting(&mut self) {
        self.selecting = false;
        self.selected.clear();
    }
}
