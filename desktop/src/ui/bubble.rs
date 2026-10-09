//! One message of the transcript: src/components/MessageBubble.tsx,
//! MessageTimeline.tsx and ToolActivity.tsx, measure for measure.

use super::icons::{self, Icon};
use super::lazy;
use super::markdown::{self, Click};
use super::theme::{self, W, alpha, p};
use super::{chat, widgets};
use crate::models;
use crate::refusal::{self, RefusalSource};
use crate::store::{Message, Part, Role, Settings, ToolEvent};
use eframe::egui::{self, Color32, CornerRadius, Rect, Response, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use std::borrow::Cow;
use std::path::Path;
use std::sync::Arc;

pub enum Action {
    /// Answer the last question again.
    Retry,
    /// Carry on the last reply from where it stopped.
    Resume,
    Copy(String),
    Link(String),
    /// A long code block was clicked: (title, language, code).
    OpenCode(String, String, String),
    /// A picture was clicked: (name, where egui loads it from).
    Image(String, String),
    /// A workspace file a step wrote.
    OpenFile(String),
    /// Remove the question this message belongs to, and its reply.
    Delete(String),
    /// Send message `id` again with new text.
    Edit(String, String),
    /// Show reply `id` next to its earlier versions.
    Compare(String),
    /// Open the rewind popover on question `id`.
    RewindOpen(String),
    /// The popover's answer; None closes it.
    Rewind(Option<bool>),
    /// Blocked plan steps go back to "todo".
    PlanUnblock,
    PlanClear,
}

/// What a bubble needs to know about its surroundings.
pub struct Env<'a, 'm> {
    pub settings: &'a Settings,
    pub workspace: &'a Path,
    /// This reply is being written right now.
    pub live: bool,
    /// The newest message of the chat.
    pub newest: bool,
    /// A reply is running in this chat, so nothing may be edited or removed.
    pub busy: bool,
    /// Bubbles are capped at 85% of the column on a narrow window, 75% otherwise.
    pub cap: f32,
    /// Seconds the model has been thinking in this stretch, while it does.
    pub thinking_secs: Option<u64>,
    /// The user message being edited in place: (id, draft).
    pub editing: &'a mut Option<(String, String)>,
    pub action: &'a mut Option<Action>,
    /// The question whose rewind popover is open.
    pub rewind: Option<&'a super::rewind::Preview>,
    /// The chat's plan, drawn in the newest reply.
    pub plan: Option<&'a crate::store::Plan>,
    /// Find in this chat: the query to mark in this message, when it has matches.
    pub marks: Option<markdown::Marks<'m>>,
    /// Heights of the rows inside replies: a row that does not show is not laid out.
    pub rows: &'a mut lazy::Rows,
}

pub fn show(ui: &mut Ui, msg: &Message, env: &mut Env) {
    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
    match msg.role {
        Role::User if msg.note => note(ui, msg),
        Role::User => user(ui, msg, env),
        Role::Assistant => assistant(ui, msg, env),
    }
}

fn plain(ui: &mut Ui, text: egui::RichText) -> Response {
    ui.add(egui::Label::new(text).selectable(false))
}

/// Three dots that bounce in turn (`<Dots>`).
pub fn dots(ui: &mut Ui, size: f32, colour: Color32) {
    let (rect, _) = ui.allocate_exact_size(vec2(size * 3.0 + 6.0, size * 1.5), Sense::hover());
    let time = ui.input(|i| i.time);
    for i in 0..3 {
        let phase = (time - i as f64 * 0.15).rem_euclid(1.0);
        // Lifted a quarter of its height at the ends of each second, resting in the middle.
        let lift = ((0.5 - phase).abs() * 2.0) as f32;
        ui.painter().circle_filled(pos2(rect.left() + size / 2.0 + i as f32 * (size + 3.0), rect.bottom() - size / 2.0 - lift * size * 0.25), size / 2.0, colour);
    }
    ui.ctx().request_repaint();
}

// ------------------------------------------------------------------ user

/// A "btw" passed to a running reply: a quiet centred line, not a bubble.
fn note(ui: &mut Ui, msg: &Message) {
    let p = p();
    let text = msg.text();
    let long = text.chars().count() > 140;
    let id = ui.id().with("note-open");
    let mut open: bool = ui.data(|d| d.get_temp(id)).unwrap_or(false);
    ui.vertical_centered(|ui| {
        ui.set_max_width(ui.available_width() * 0.9);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(8.0, 2.0);
            let chip = widgets::galley(ui, "NOTE", theme::font(11.0, W::Semibold), p.search);
            let (rect, _) = ui.allocate_exact_size(vec2(chip.size().x + 13.0, 20.5), Sense::hover());
            ui.painter().rect_filled(rect, 8.0, alpha(p.search, 20.0));
            widgets::text_at(ui, rect.left() + 6.0, rect.center().y, chip);
            plain(ui, widgets::lines("passed while the task was running", 11.0, 16.5, W::Regular, p.muted));
            let shown = if long && !open { format!("{}…", text.chars().take(140).collect::<String>().trim_end()) } else { text.clone() };
            let body = ui.add(egui::Label::new(widgets::lines(shown, 12.0, 20.0, W::Regular, p.text2)).wrap().sense(if long { Sense::click() } else { Sense::hover() }));
            if long {
                let more = ui.add(egui::Label::new(widgets::text(if open { "show less" } else { "more" }, 11.0, W::Regular, p.muted)).selectable(false).sense(Sense::click()));
                if body.on_hover_text(if open { "Collapse" } else { "Expand" }).clicked() || more.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                    open = !open;
                    ui.data_mut(|d| d.insert_temp(id, open));
                }
            }
            // What was attached to the note, by name.
            for file in &msg.attachments {
                let name = widgets::galley(ui, &file.name, theme::font(11.0, W::Regular), p.text2);
                let (rect, _) = ui.allocate_exact_size(vec2(name.size().x + 14.0, 22.5), Sense::hover());
                ui.painter().rect(rect, 8.0, alpha(p.bg2, 60.0), Stroke::new(1.0, p.border), StrokeKind::Inside);
                widgets::text_at(ui, rect.left() + 7.0, rect.center().y, name);
            }
        });
    });
}

/// Bytes of a `data:image/png;base64,…` URL.
fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let (_, data) = url.split_once(";base64,")?;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

/// A question longer than this (in bytes) shows only its start.
const FOLD_OVER: usize = 6_000;
/// What it shows folded, and the most it shows unfolded: laying out more than that stalls the window.
const FOLDED: usize = 1_200;
const UNFOLDED: usize = 100_000;

/// The part of a long question that is shown: its start, up to a line end when one is near.
fn fold(text: &str, unfolded: bool) -> &str {
    if text.len() <= FOLD_OVER {
        return text;
    }
    let Some((at, _)) = text.char_indices().nth(if unfolded { UNFOLDED } else { FOLDED }) else { return text };
    let cut = &text[..at];
    if unfolded { cut } else { cut.rfind('\n').filter(|line_end| *line_end > at / 2).map_or(cut, |line_end| &cut[..line_end]) }
}

/// A text action under a bubble: 24 high, 11px, an 11px icon.
/// True when the text holds a Markdown table: a row of cells with a row of dashes under it.
fn has_table(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    lines.windows(2).any(|pair| pair[0].contains('|') && pair[1].contains('-') && pair[1].contains('|') && pair[1].chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t')))
}

/// "Compare 3" in the reply's action row: accent text, and the count in grey.
fn compare_btn(ui: &mut Ui, versions: usize) -> Response {
    let p = p();
    let label = widgets::galley(ui, "Compare", theme::font(11.0, W::Medium), p.accent_light);
    let count = widgets::galley(ui, &versions.to_string(), theme::font(11.0, W::Medium), p.muted);
    let (rect, response) = ui.allocate_exact_size(vec2(8.0 + 12.0 + 6.0 + label.size().x + 6.0 + count.size().x + 8.0, 28.0), Sense::click());
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text("Compare with the previous reply");
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, 8.0, alpha(p.accent, 12.0 * t));
    icons::paint(ui, icons::COMPARE, pos2(rect.left() + 8.0 + 6.0, rect.center().y), 12.0, p.accent_light);
    let x = rect.left() + 26.0;
    let label_width = widgets::text_at(ui, x, rect.center().y, label);
    widgets::text_at(ui, x + label_width + 6.0, rect.center().y, count);
    response
}

fn action_btn(ui: &mut Ui, icon: Icon, label: &str, tip: &str, height: f32, danger: bool, tint: Option<Color32>) -> Response {
    let p = p();
    let icon_size = if height > 24.0 { 12.0 } else { 11.0 };
    let (gap, pad) = if height > 24.0 { (6.0, 8.0) } else { (4.0, 6.0) };
    let text = widgets::galley(ui, label, theme::font(11.0, W::Medium), Color32::WHITE);
    let (rect, response) = ui.allocate_exact_size(vec2(pad + icon_size + gap + text.size().x + pad, height), Sense::click());
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    let (fill, fg) = if danger { (alpha(p.danger, 12.0), p.danger) } else { (p.hover, p.text) };
    ui.painter().rect_filled(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, fill, t));
    let colour = tint.unwrap_or_else(|| widgets::lerp(p.muted, fg, t));
    icons::paint(ui, icon, pos2(rect.left() + pad + icon_size / 2.0, rect.center().y), icon_size, colour);
    ui.painter().galley_with_override_text_color(pos2(rect.left() + pad + icon_size + gap, (rect.center().y - text.size().y / 2.0).round()), text, colour);
    if tip.is_empty() { response } else { response.on_hover_text(tip) }
}

fn user(ui: &mut Ui, msg: &Message, env: &mut Env) {
    let p = p();
    const PAD: egui::Vec2 = vec2(16.0, 10.0);
    let column = ui.max_rect();
    let room = (env.cap - PAD.x * 2.0).max(80.0);
    let editing = env.editing.as_ref().is_some_and(|(id, _)| *id == msg.id);
    // Blank lines around a question are not part of it (older chats kept two in front of one sent with a picture).
    let whole = msg.text();
    let body = whole.trim_matches(['\n', '\r']);

    let font = theme::font(15.0, W::Regular);
    let job_of = |text: &str| {
        let mut job = egui::text::LayoutJob::simple(text.to_string(), font.clone(), p.text, room);
        job.sections.iter_mut().for_each(|s| s.format.line_height = Some(24.0));
        job
    };
    let layout = |ui: &Ui, text: &str| ui.painter().layout_job(job_of(text));
    // A pasted log can run to hundreds of thousands of characters: it shows its start until asked for the rest,
    // and a search opens it so its matches can be marked.
    let all_id = ui.id().with("all");
    let unfolded = env.marks.is_some() || ui.data(|d| d.get_temp::<bool>(all_id)).unwrap_or(false);
    let shown = fold(body, unfolded);
    let folded = shown.len() < body.len();
    // Find in this chat marks its matches in a question as it does in a reply.
    let mut body_job = job_of(shown);
    let hits = env.marks.as_mut().filter(|_| !editing).map_or(Vec::new(), |marks| marks.apply(&mut body_job));
    let galley = ui.painter().layout_job(body_job);

    // Thumbnails are 96 tall and as wide as the picture wants, up to 192.
    let pictures: Vec<(String, egui::Vec2, &str)> = msg
        .attachments
        .iter()
        .enumerate()
        .filter_map(|(i, a)| {
            let url = a.data_url.as_deref().filter(|_| a.kind == "image")?;
            let uri = format!("bytes://{}-{i}", msg.id);
            // Decoded once: egui keeps the bytes under this address.
            if ui.ctx().try_load_bytes(&uri).is_err() {
                ui.ctx().include_bytes(uri.clone(), decode_data_url(url)?);
            }
            let size = egui::Image::new(uri.clone()).load_and_calc_size(ui, vec2(192.0, 96.0)).map_or(vec2(96.0, 96.0), |s| vec2((s.x * 96.0 / s.y.max(1.0)).min(192.0), 96.0));
            Some((uri, size, a.name.as_str()))
        })
        .collect();
    let files: Vec<&str> = msg.attachments.iter().filter(|a| a.data_url.is_none() || a.kind != "image").map(|a| a.name.as_str()).collect();
    let file_chips: Vec<_> = files.iter().map(|name| widgets::galley(ui, name, theme::font(12.0, W::Regular), p.text2)).collect();
    let attached: f32 = pictures.iter().map(|(_, s, _)| s.x + 2.0 + 6.0).sum::<f32>() + file_chips.iter().map(|g| g.size().x + 8.0 + 12.0 + 6.0 + 8.0 + 2.0 + 6.0).sum::<f32>();
    let has_attachments = !pictures.is_empty() || !files.is_empty();

    let draft_galley = env.editing.as_ref().filter(|_| editing).map(|(_, draft)| layout(ui, if draft.is_empty() || draft.ends_with('\n') { "x" } else { draft }));
    let text_width = draft_galley.as_ref().map_or(galley.size().x, |g| g.size().x.max(galley.size().x));
    let inner = text_width.max((attached - 6.0).min(room)).max(8.0);
    let left = column.right() - inner - PAD.x * 2.0;
    let top = ui.cursor().top();

    let id = ui.id().with("user");
    let hovered: bool = ui.data(|d| d.get_temp(id)).unwrap_or(false);
    let t = widgets::fade(ui, id, hovered);
    let frame = egui::Frame::new().fill(widgets::lerp(p.elevated, p.hover, t)).corner_radius(16).inner_margin(egui::Margin::symmetric(PAD.x as i8, PAD.y as i8));
    let frame = if editing { frame.stroke(Stroke::new(1.0, alpha(p.accent, 50.0))) } else { frame };
    let mut send = None;
    let mut cancel = false;
    let bubble = ui
        .scope_builder(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(left, top), pos2(column.right(), f32::INFINITY))), |ui| {
            frame
                .show(ui, |ui| {
                    ui.set_width(inner);
                    let mut first = true;
                    if has_attachments {
                        first = false;
                        ui.horizontal_wrapped(|ui| {
                            ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
                            for (uri, size, name) in &pictures {
                                let (rect, response) = ui.allocate_exact_size(*size + vec2(2.0, 2.0), Sense::click());
                                egui::Image::new(uri.clone()).corner_radius(7).paint_at(ui, rect.shrink(1.0));
                                ui.painter().rect_stroke(rect, 8.0, Stroke::new(1.0, p.border), StrokeKind::Inside);
                                if response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(format!("{name} — click to enlarge")).clicked() {
                                    *env.action = Some(Action::Image(name.to_string(), uri.clone()));
                                }
                            }
                            for (name, chip) in files.iter().zip(&file_chips) {
                                let (rect, _) = ui.allocate_exact_size(vec2(8.0 + 12.0 + 6.0 + chip.size().x + 8.0 + 2.0, 26.0), Sense::hover());
                                ui.painter().rect(rect, 8.0, alpha(p.bg2, 60.0), Stroke::new(1.0, p.border), StrokeKind::Inside);
                                icons::paint(ui, if name.ends_with('/') { icons::FOLDER } else { icons::FILE_SMALL }, pos2(rect.left() + 9.0 + 6.0, rect.center().y), 12.0, p.text2);
                                widgets::text_at(ui, rect.left() + 9.0 + 12.0 + 6.0, rect.center().y, chip.clone());
                            }
                        });
                    }
                    if let Some((_, draft)) = env.editing.as_mut().filter(|_| editing) {
                        if !first {
                            ui.add_space(8.0);
                        }
                        let mut layouter = |ui: &Ui, text: &dyn egui::TextBuffer, _wrap: f32| layout(ui, text.as_str());
                        let edit = ui.add(egui::TextEdit::multiline(draft).desired_rows(1).desired_width(inner).frame(egui::Frame::NONE).margin(egui::Margin::ZERO).return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, egui::Key::Enter)).layouter(&mut layouter));
                        if !edit.has_focus() && !edit.lost_focus() {
                            edit.request_focus();
                        }
                        if ui.input(|i| i.key_pressed(egui::Key::Escape)) {
                            cancel = true;
                        } else if ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift) && !draft.trim().is_empty() {
                            send = Some(draft.trim().to_string());
                        }
                    } else if !body.is_empty() {
                        if !first {
                            ui.add_space(8.0);
                        }
                        let under = ui.painter().add(egui::Shape::Noop);
                        let label = ui.add(egui::Label::new(galley.clone()).selectable(true));
                        if let Some(marks) = env.marks.as_mut().filter(|_| !hits.is_empty()) {
                            marks.paint(ui, under, &galley, &hits, label.rect.min.to_vec2());
                        }
                        if folded || (unfolded && body.len() > FOLD_OVER) {
                            ui.add_space(6.0);
                            let words = if !unfolded { format!("Show all · {} characters", chat::thousands(body.chars().count() as u64)) } else if folded { format!("Show less · the first {} characters are shown", chat::thousands(UNFOLDED as u64)) } else { "Show less".to_string() };
                            let toggle = ui.add(egui::Label::new(widgets::lines(words, 12.0, 18.0, W::Medium, p.accent_light)).selectable(false).sense(Sense::click()));
                            if toggle.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                                ui.data_mut(|d| d.insert_temp(all_id, !unfolded));
                            }
                        }
                    }
                })
                .response
                .rect
        })
        .inner;
    ui.advance_cursor_after_rect(Rect::from_min_max(pos2(column.left(), top), pos2(column.right(), bubble.bottom())));

    // The row under the bubble floats: it takes no room, so the next message does not move.
    let row = Rect::from_min_max(pos2(column.left(), bubble.bottom() + 4.0), pos2(bubble.right(), bubble.bottom() + 28.0));
    let over = ui.rect_contains_pointer(bubble.union(row).expand2(vec2(0.0, 2.0)));
    ui.data_mut(|d| d.insert_temp(id, over));
    if editing {
        let mut actions = ui.new_child(egui::UiBuilder::new().max_rect(row).layout(egui::Layout::right_to_left(egui::Align::Center)));
        let ui = &mut actions;
        ui.spacing_mut().item_spacing.x = 6.0;
        let draft = env.editing.as_ref().map_or("", |(_, d)| d.as_str()).trim().to_string();
        let can_send = !draft.is_empty() && !env.busy;
        let label = widgets::galley(ui, "Send", theme::font(11.0, W::Medium), Color32::WHITE);
        let (rect, response) = ui.allocate_exact_size(vec2(label.size().x + 20.0, 24.5), Sense::click());
        let response = if env.busy { response.on_hover_text("Available once this reply finishes") } else { response.on_hover_cursor(egui::CursorIcon::PointingHand) };
        let fill = if response.hovered() && can_send { p.accent_light } else { p.accent };
        ui.painter().rect_filled(rect, 8.0, if can_send { fill } else { alpha(fill, 40.0) });
        widgets::text_at(ui, rect.left() + 10.0, rect.center().y, label);
        if response.clicked() && can_send {
            send = Some(draft);
        }
        let label = widgets::galley(ui, "Cancel", theme::font(11.0, W::Regular), p.muted);
        let (rect, response) = ui.allocate_exact_size(vec2(label.size().x + 16.0, 24.5), Sense::click());
        let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
        if response.hovered() {
            ui.painter().rect_filled(rect, 8.0, p.hover);
        }
        ui.painter().galley_with_override_text_color(pos2(rect.left() + 8.0, (rect.center().y - label.size().y / 2.0).round()), label, if response.hovered() { p.text } else { p.muted });
        cancel |= response.clicked();
        if ui.ctx().content_rect().width() >= 640.0 {
            ui.add_space(4.0);
            plain(ui, widgets::text("Enter to send · Esc to cancel", 11.0, W::Regular, p.muted));
        }
    } else if !body.is_empty() {
        let shown = widgets::fade(ui, id.with("actions"), over);
        if shown > 0.0 {
            let lifted = row.translate(vec2(0.0, -3.0 * (1.0 - shown)));
            let mut actions = ui.new_child(egui::UiBuilder::new().max_rect(lifted).layout(egui::Layout::right_to_left(egui::Align::Center)));
            let ui = &mut actions;
            ui.set_opacity(shown);
            ui.spacing_mut().item_spacing.x = 4.0;
            // Laid out right to left, so the list reads Copy, Edit, Delete on screen.
            if !env.busy && action_btn(ui, icons::TRASH_SMALL, "Delete", "Delete this question and the reply — both forget it", 24.0, true, None).clicked() {
                *env.action = Some(Action::Delete(msg.id.clone()));
            }
            if !env.busy && action_btn(ui, icons::REWIND, "Rewind", "Go back to before this message — the chat, and the files if you want", 24.0, false, None).clicked() {
                *env.action = Some(Action::RewindOpen(msg.id.clone()));
            }
            if !env.busy && action_btn(ui, icons::RENAME.stroke(1.9), "Edit", "Edit and resend", 24.0, false, None).clicked() {
                *env.editing = Some((msg.id.clone(), body.to_string()));
            }
            let copied_id = id.with("copied");
            let done = ui.data(|d| d.get_temp::<f64>(copied_id)).is_some_and(|at| ui.input(|i| i.time) - at < 1.2);
            if action_btn(ui, if done { icons::CHECK_THIN.stroke(1.9) } else { icons::COPY_USER }, if done { "Copied" } else { "Copy" }, "Copy message text", 24.0, false, None).clicked() {
                let now = ui.input(|i| i.time);
                ui.data_mut(|d| d.insert_temp(copied_id, now));
                *env.action = Some(Action::Copy(body.to_string()));
            }
        }
    }
    if let Some(preview) = env.rewind.filter(|r| r.id == msg.id) {
        match super::rewind::show(ui, bubble, preview) {
            Some(super::rewind::Choice::ChatAndFiles) => *env.action = Some(Action::Rewind(Some(true))),
            Some(super::rewind::Choice::ChatOnly) => *env.action = Some(Action::Rewind(Some(false))),
            Some(super::rewind::Choice::Cancel) => *env.action = Some(Action::Rewind(None)),
            None => {}
        }
    }
    if cancel {
        *env.editing = None;
    } else if let Some(text) = send {
        *env.editing = None;
        *env.action = Some(Action::Edit(msg.id.clone(), text));
    }
}

// ------------------------------------------------------------------ tool steps

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Read,
    Write,
    Delete,
    Search,
    Run,
    Web,
    Plan,
    Git,
    Note,
    Ask,
    Image,
    Done,
    Other,
}

struct Display {
    kind: Kind,
    running: String,
    done: String,
    target: Option<String>,
    /// Paths, commands and URLs are set in mono and cut at the head.
    mono: bool,
}

/// src/lib/tool-display.ts: the words for a step and what it acted on.
fn describe(name: &str, args: &str) -> Display {
    use Kind::*;
    let (kind, running, done) = match name {
        "read_file" | "read_files" | "read_symbol" | "read_document" => (Read, "Reading", "Read"),
        "find_references" => (Search, "Finding uses of", "Found uses of"),
        "query_data" => (Read, "Querying", "Queried"),
        "extract_archive" => (Write, "Unpacking", "Unpacked"),
        "delegate" => (Search, "Delegating", "Delegated"),
        "list_files" => (Read, "Listing files", "Listed files"),
        "verify_file" => (Read, "Checking", "Checked"),
        "inspect_binary" => (Read, "Inspecting", "Inspected"),
        "analyze_log" => (Read, "Analyzing", "Analyzed"),
        "write_file" | "write_files" => (Write, "Writing", "Created"),
        "edit_file" | "edit_files" => (Write, "Editing", "Edited"),
        "apply_patch" => (Write, "Patching", "Patched"),
        "replace_in_files" => (Write, "Replacing in", "Replaced in"),
        "move_file" => (Write, "Moving", "Moved"),
        "undo_file" => (Write, "Undoing", "Undid"),
        "restore_snapshot" => (Write, "Restoring", "Restored"),
        "delete_file" => (Delete, "Deleting", "Deleted"),
        "search_files" => (Search, "Searching", "Searched"),
        "search_conversation" => (Search, "Recalling", "Recalled"),
        "list_snapshots" => (Search, "Listing snapshots", "Listed snapshots"),
        "run_command" => (Run, "Running", "Ran"),
        "run_tests" => (Run, "Running tests", "Ran tests"),
        "build_project" => (Run, "Building", "Built"),
        "start_process" => (Run, "Starting", "Started"),
        "stop_process" => (Run, "Stopping", "Stopped"),
        "read_process" => (Run, "Reading output", "Read output"),
        "write_process" => (Run, "Sending input", "Sent input"),
        "wait_for_output" => (Run, "Waiting for output", "Got output"),
        "list_processes" => (Run, "Listing processes", "Listed processes"),
        "web_search" => (Web, "Searching the web", "Searched the web"),
        "fetch_url" => (Web, "Fetching", "Fetched"),
        "browse" => (Web, "Opening", "Opened"),
        "inspect_page" => (Web, "Inspecting", "Inspected"),
        "http_request" => (Web, "Requesting", "Requested"),
        "download_file" => (Web, "Downloading", "Downloaded"),
        "make_plan" => (Plan, "Planning", "Planned"),
        "update_plan" => (Plan, "Updating plan", "Updated plan"),
        "note_finding" | "note_binary" => (Note, "Noting", "Noted"),
        "ask_user" => (Ask, "Asking", "Asked"),
        "view_image" => (Image, "Viewing", "Viewed"),
        "screenshot_window" => (Image, "Capturing", "Captured"),
        "show_image" => (Image, "Showing", "Showed"),
        "sandbox_run" => (Run, "Running in sandbox", "Ran in sandbox"),
        "sandbox_screenshot" => (Image, "Capturing sandbox", "Captured sandbox"),
        "finish" => (Done, "Finishing", "Finished"),
        "github_push" => (Git, "Pushing", "Pushed"),
        "github_create_pr" => (Git, "Opening pull request", "Opened pull request"),
        "github_pr_status" => (Git, "Checking pull request", "Checked pull request"),
        "git_status" => (Git, "Checking status", "Checked status"),
        "git_diff" => (Git, "Diffing", "Diffed"),
        "git_log" => (Git, "Reading history", "Read history"),
        "git_commit" => (Git, "Committing", "Committed"),
        "git_branch" => (Git, "Branching", "Branched"),
        "git_pull_base" => (Git, "Syncing with base", "Synced with base"),
        _ => (Other, "", ""),
    };
    let (running, done) = if kind == Other {
        // "mcp__server__tool" reads "MCP tool"; anything else gets its name spelled out.
        let label = match name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
            Some((_, tool)) => format!("MCP {tool}"),
            None => {
                let words = name.replace(['_', '-'], " ");
                let mut chars = words.trim().chars();
                chars.next().map_or(String::new(), |c| c.to_uppercase().chain(chars).collect())
            }
        };
        (label.clone(), label)
    } else {
        (running.to_string(), done.to_string())
    };
    let (target, mono) = target_of(name, args);
    Display { kind, running, done, target, mono }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn target_of(name: &str, args: &str) -> (Option<String>, bool) {
    let Ok(a) = serde_json::from_str::<serde_json::Value>(args) else {
        // Still streaming: take whatever the first recognisable field holds so far.
        static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#""(path|command|query|url)"\s*:\s*"([^"]*)"#).unwrap());
        return RE.captures(args).map_or((None, false), |c| (Some(c[2].to_string()), matches!(&c[1], "path" | "command")));
    };
    let s = |key: &str| a[key].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let path = s("path").or_else(|| s("file"));
    if let Some(paths) = a["paths"].as_array() {
        let strings: Vec<&str> = paths.iter().filter_map(|v| v.as_str()).collect();
        return if strings.len() == 1 { (Some(strings[0].to_string()), true) } else { (Some(plural(strings.len(), "file")), false) };
    }
    if let Some(files) = a["files"].as_array() {
        return (Some(plural(files.len(), "file")), false);
    }
    if let Some(edits) = a["edits"].as_array() {
        return (Some(plural(edits.len(), "edit")), false);
    }
    if let Some(steps) = a["steps"].as_array().filter(|_| name == "make_plan").or_else(|| a["updates"].as_array().filter(|_| name == "update_plan")) {
        return (Some(plural(steps.len(), "step")), false);
    }
    if let Some(command) = a["command"].as_str() {
        let rest = a["args"].as_array().into_iter().flatten().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string));
        return (Some(std::iter::once(command.to_string()).chain(rest).collect::<Vec<_>>().join(" ")), true);
    }
    if let Some(symbol) = s("name").filter(|_| matches!(name, "find_references" | "read_symbol")) {
        return (Some(path.map_or(symbol.clone(), |p| format!("{symbol} in {p}"))), true);
    }
    if let Some(task) = s("task").filter(|_| name == "delegate") {
        let line = task.lines().next().unwrap_or("");
        return (Some(if line.chars().count() > 90 { format!("{}…", line.chars().take(89).collect::<String>()) } else { line.to_string() }), false);
    }
    if path.is_some() {
        return (path, true);
    }
    if let Some(query) = s("query").or_else(|| s("pattern")).or_else(|| s("question")) {
        return (Some(query), name == "search_files");
    }
    if let Some(url) = s("url") {
        return (Some(url.trim_start_matches("https://").trim_start_matches("http://").to_string()), true);
    }
    (s("message").or_else(|| s("title")).or_else(|| s("claim")).or_else(|| s("reason")), false)
}

/// What the detail pane under a step shows: the command, or the text it wrote or searched for.
fn step_body(args: &str) -> Option<String> {
    let a: serde_json::Value = serde_json::from_str(args).ok()?;
    if let Some(command) = a["command"].as_str() {
        let quote = |v: &serde_json::Value| {
            let text = v.as_str().map_or_else(|| v.to_string(), str::to_string);
            if text.contains(char::is_whitespace) { serde_json::Value::String(text).to_string() } else { text }
        };
        return Some(std::iter::once(command.to_string()).chain(a["args"].as_array().into_iter().flatten().map(quote)).collect::<Vec<_>>().join(" "));
    }
    ["content", "new_text", "replacement", "code", "script", "query"].iter().find_map(|k| a[*k].as_str()).map(str::to_string)
}

/// One line, cut at the head so the end of a path stays readable (CSS `dir="rtl"` truncation).
fn clip_head(ui: &Ui, text: &str, font: egui::FontId, colour: Color32, width: f32) -> std::sync::Arc<egui::Galley> {
    let whole = widgets::galley(ui, text, font.clone(), colour);
    if whole.size().x <= width {
        return whole;
    }
    let chars: Vec<char> = text.chars().collect();
    // Longest tail that still fits behind the ellipsis.
    let (mut lo, mut hi) = (0, chars.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        let tail: String = std::iter::once('…').chain(chars[chars.len() - mid..].iter().copied()).collect();
        if widgets::galley(ui, &tail, font.clone(), colour).size().x <= width { lo = mid } else { hi = mid - 1 }
    }
    let tail: String = std::iter::once('…').chain(chars[chars.len() - lo..].iter().copied()).collect();
    widgets::galley(ui, &tail, font, colour)
}

/// What a step row shows and what its detail pane holds, read from the step's arguments once and kept while the
/// row is on screen: the arguments of a written file are that file, and parsing them every frame is slow.
#[derive(Default)]
struct Described;

impl egui::cache::ComputerMut<(&str, &str), Arc<(Display, Option<String>)>> for Described {
    fn compute(&mut self, (name, args): (&str, &str)) -> Arc<(Display, Option<String>)> {
        Arc::new((describe(name, args), step_body(args)))
    }
}

/// Why a step failed, in the words worth reading: without "Failed:" and without the command the row already names.
/// None when that leaves nothing to say.
fn failure_reason(summary: &str, target: &str) -> Option<String> {
    let mut why = summary.trim();
    for lead in ["Failed:", "Error:", "Failed to start:"] {
        why = why.strip_prefix(lead).unwrap_or(why).trim_start();
    }
    if !target.is_empty() {
        why = why.strip_prefix(target).unwrap_or(why).trim_start_matches([':', ' ', '—', '-']);
    }
    (!why.is_empty()).then(|| why.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The rows of steps under a stretch of text. `open` holds the id of the one whose detail is showing.
fn steps(ui: &mut Ui, tools: &[&ToolEvent], env: &mut Env, open: &mut Option<String>) {
    for (i, tool) in tools.iter().enumerate() {
        if i > 0 {
            ui.add_space(2.0);
        }
        ui.push_id(&tool.id, |ui| step(ui, tool, env, open));
    }
    ui.add_space(4.0);
}

fn step(ui: &mut Ui, tool: &ToolEvent, env: &mut Env, open: &mut Option<String>) {
    let p = p();
    let described = ui.memory_mut(|m| m.caches.cache::<egui::cache::FrameCache<Arc<(Display, Option<String>)>, Described>>().get((tool.name.as_str(), tool.args.as_str())).clone());
    let d = &described.0;
    let running = tool.ok.is_none();
    let failed = tool.ok == Some(false);
    let target = tool.changed_path.clone().or(d.target.clone());
    let mono = d.mono && !(tool.changed_path.is_some() && d.target.is_none());
    let body = described.1.as_deref().filter(|b| !b.trim().is_empty() && !running && Some(b.trim()) != d.target.as_deref());
    let expandable = body.is_some();
    let is_open = expandable && open.as_deref() == Some(tool.id.as_str());
    let changed = tool.changed_path.is_some() || d.kind == Kind::Write;
    let can_open = !running && !failed && changed && target.is_some();

    let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 29.0), if expandable { Sense::click() } else { Sense::hover() });
    let hovered = ui.rect_contains_pointer(row);
    let t = if expandable { widgets::fade(ui, response.id, response.hovered()) } else { 0.0 };
    if expandable {
        ui.painter().rect_filled(row, 8.0, alpha(p.hover, 60.0 * t));
    }
    let base = if failed { Color32::from_rgb(0xff, 0xa2, 0xa2) } else { widgets::lerp(p.text2, p.text, t) };

    // The glyph: what kind of step, and how it went.
    let glyph = Rect::from_min_size(pos2(row.left() + 6.0, row.center().y - 10.0), vec2(20.0, 20.0));
    let pulse = if running {
        ui.ctx().request_repaint();
        0.75 + 0.25 * (ui.input(|i| i.time) / 1.5 * std::f64::consts::TAU).sin() as f32
    } else {
        1.0
    };
    let (fill, ink) = if failed {
        (Color32::from_rgba_unmultiplied(251, 44, 54, 26), base)
    } else if running {
        (alpha(p.accent, 15.0 * pulse), p.accent_light.gamma_multiply(pulse))
    } else {
        (alpha(p.hover, 70.0), p.muted)
    };
    ui.painter().rect_filled(glyph, 8.0, fill);
    let icon = if failed {
        icons::TOOL_FAILED
    } else {
        match d.kind {
            Kind::Read => icons::TOOL_READ,
            Kind::Write => icons::TOOL_WRITE,
            Kind::Delete => icons::TOOL_DELETE,
            Kind::Search => icons::TOOL_SEARCH,
            Kind::Run => icons::TOOL_RUN,
            Kind::Web => icons::TOOL_WEB,
            Kind::Plan => icons::TOOL_PLAN,
            Kind::Git => icons::TOOL_GIT,
            Kind::Note => icons::TOOL_NOTE,
            Kind::Ask => icons::TOOL_ASK,
            Kind::Image => icons::TOOL_IMAGE,
            Kind::Done => icons::TOOL_DONE,
            Kind::Other => icons::TOOL_OTHER,
        }
    };
    icons::paint(ui, icon, glyph.center(), 13.0, ink);

    // Room for "Open" on every row that unfolds, so the arrows of a run of steps stand in one column.
    let open_width = if can_open || expandable { 46.0 } else { 0.0 };
    let right = row.right() - 6.0 - open_width - if expandable { 20.0 } else { 0.0 };
    let mut x = glyph.right() + 8.0;
    let previewed = tool.summary.starts_with("Preview");
    let verb = if running { d.running.as_str() } else if previewed { "Previewed" } else { d.done.as_str() };
    if running {
        let mut job = chat::shimmer(ui, verb, 13.0);
        job.sections.iter_mut().for_each(|s| s.format.font_id = theme::font(13.0, W::Medium));
        x += widgets::text_at(ui, x, row.center().y, ui.painter().layout_job(job));
    } else {
        x += widgets::text_at(ui, x, row.center().y, widgets::galley(ui, verb, theme::font(13.0, W::Medium), base));
    }

    // The trailing remark: what came of it. Why a step failed is told under the row, where it has room.
    let target_text = target.as_deref().unwrap_or("");
    let wide = ui.ctx().content_rect().width() >= 640.0;
    let reason = if failed { failure_reason(&tool.summary, target_text) } else { None };
    let remark = if running && !tool.summary.is_empty() {
        // A helper's progress: "round 2 · 5 tool calls · read_file, search_files".
        Some((format!("· {}", tool.summary), p.muted, 0.45))
    } else if !running && !failed && wide && !tool.summary.is_empty() && (target_text.is_empty() || !tool.summary.contains(target_text)) && tool.summary != d.done {
        Some((format!("· {}", tool.summary), p.muted, 0.45))
    } else {
        None
    };
    let room = (right - x - 6.0).max(0.0);
    let remark = remark.map(|(text, colour, share)| widgets::clipped(ui, text.lines().next().unwrap_or(""), theme::font(12.0, W::Regular), colour, room * share));
    let remark_width = remark.as_ref().map_or(0.0, |g| g.size().x + 8.0);
    if !target_text.is_empty() {
        x += 6.0;
        let width = (room - remark_width).max(0.0);
        let colour = base.gamma_multiply(0.75);
        let one_line = target_text.lines().next().unwrap_or("");
        let galley = if mono { clip_head(ui, one_line, theme::mono(12.0), colour, width) } else { widgets::clipped(ui, one_line, theme::font(13.0, W::Regular), colour, width) };
        x += widgets::text_at(ui, x, row.center().y, galley);
    }
    if let Some(remark) = remark {
        widgets::text_at(ui, x + 8.0, row.center().y, remark);
    }
    if expandable {
        let spot = pos2(row.right() - 6.0 - open_width - 6.0, row.center().y);
        icons::paint(ui, if is_open { icons::CHEVRON_UP } else { icons::CHEVRON_DOWN }, spot, 12.0, base.gamma_multiply(if response.hovered() { 0.7 } else { 0.4 }));
    }
    if can_open && hovered {
        let rect = Rect::from_min_max(pos2(row.right() - open_width, row.top()), row.max);
        let link = ui.interact(rect, ui.id().with("open"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text("Open in workspace");
        let label = widgets::galley(ui, "Open", theme::font(12.0, W::Regular), if link.hovered() { p.accent_light } else { p.muted });
        widgets::text_at(ui, rect.left() + 8.0, rect.center().y, label);
        if link.clicked() {
            *env.action = Some(Action::OpenFile(target_text.to_string()));
        }
    }
    if expandable {
        if response.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
            *open = if is_open { None } else { Some(tool.id.clone()) };
        }
    }

    if let Some(reason) = reason {
        markdown::indented(ui, 34.0, |ui| {
            let mut job = egui::text::LayoutJob::simple(reason, theme::font(12.0, W::Regular), base.gamma_multiply(0.8), ui.available_width() - 8.0);
            job.sections[0].format.line_height = Some(18.0);
            // Three lines say what went wrong; the rest is in the step's detail and the model's own account.
            job.wrap = egui::text::TextWrapping { max_width: ui.available_width() - 8.0, max_rows: 3, break_anywhere: false, overflow_character: Some('…') };
            ui.add(egui::Label::new(job).selectable(true));
        });
        ui.add_space(4.0);
    }

    if let Some(body) = body.filter(|_| is_open) {
        ui.add_space(4.0);
        markdown::indented(ui, 32.0, |ui| {
            egui::Frame::new().fill(p.bg).stroke(Stroke::new(1.0, p.border)).corner_radius(8).inner_margin(egui::Margin::same(12)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                egui::ScrollArea::both().id_salt("detail").max_height(264.0).show(ui, |ui| {
                    let shown: String = body.chars().take(40_000).collect();
                    let mut job = egui::text::LayoutJob::simple(shown, theme::mono(12.0), p.text2, f32::INFINITY);
                    job.sections[0].format.line_height = Some(19.5);
                    ui.add(egui::Label::new(job).selectable(true).extend());
                });
            });
        });
        ui.add_space(4.0);
    }

    // A picture the step showed the user. A capture or a look is for the model: only `show_image` puts one in the chat.
    if let Some(path) = tool.image.as_ref().filter(|_| tool.ok == Some(true) && tool.name == "show_image") {
        let full = if path.is_absolute() { path.clone() } else { env.workspace.join(path) };
        let name = path.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned());
        ui.add_space(6.0);
        markdown::indented(ui, 32.0, |ui| {
            if !full.is_file() {
                plain(ui, widgets::lines(format!("{name} is no longer in the workspace."), 12.0, 18.0, W::Regular, p.muted));
                return;
            }
            let uri = super::file_uri(&full);
            let max = vec2(ui.available_width().min(560.0), 360.0);
            let picture = egui::Image::new(uri.clone()).corner_radius(12).sense(Sense::click());
            let picture = match super::trim::of(ui.ctx(), &full) {
                // Its size is not known yet, and a guess would make the chat jump when it is.
                super::trim::Look::Pending => return,
                super::trim::Look::Unreadable => picture.max_size(max),
                // Only the part with something in it, at its own size: never blown up, shrunk to fit when it must be.
                super::trim::Look::Ready(trim) => {
                    let fit = (max.x / trim.size.x).min(max.y / trim.size.y).min(1.0);
                    picture.uv(trim.uv).maintain_aspect_ratio(false).fit_to_exact_size((trim.size * fit).max(vec2(1.0, 1.0)))
                }
            };
            let shown = ui.add(picture).on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text("Open full size");
            ui.painter().rect_stroke(shown.rect, 12.0, Stroke::new(1.0, if shown.hovered() { alpha(p.accent_light, 60.0) } else { p.border }), StrokeKind::Inside);
            if shown.clicked() {
                *env.action = Some(Action::Image(name.clone(), uri));
            }
            ui.add_space(4.0);
            let caption = if tool.caption.is_empty() { name.clone() } else { format!("{} · {name}", tool.caption) };
            ui.add(egui::Label::new(widgets::lines(caption, 12.0, 18.0, W::Regular, p.muted)).truncate().selectable(false));
        });
        ui.add_space(8.0);
    }
}

// ------------------------------------------------------------------ thinking

fn tokens_of_chars(chars: usize, floor: u64) -> String {
    let n = chars as f64 / 4.0;
    if n >= 1000.0 { format!("{:.1}k", n / 1000.0) } else { format!("{}", (n.round() as u64).max(floor)) }
}

/// "42s", "3m 04s".
fn thought_time(ms: u64) -> String {
    let total = ((ms as f64 / 1000.0).round() as u64).max(1);
    if total < 60 { format!("{total}s") } else { format!("{}m {:02}s", total / 60, total % 60) }
}

/// The body of a thinking box: the text, scrolling once it is taller than `max_height`.
fn thought_body(ui: &mut Ui, text: &str, live: bool, max_height: f32, margin: egui::Margin) {
    let p = p();
    egui::Frame::new().inner_margin(margin).show(ui, |ui| {
        ui.set_width(ui.available_width());
        egui::ScrollArea::vertical().id_salt("thought").max_height(max_height).stick_to_bottom(live).show(ui, |ui| {
            ui.set_width(ui.available_width());
            let shown = text.trim_start();
            // A long live stream only draws its tail: laying out megabytes every frame would stall the window.
            let tail = if live && shown.chars().count() > 12_000 { shown.char_indices().rev().nth(11_999).map_or(shown, |(i, _)| &shown[i..]) } else { shown };
            ui.add(egui::Label::new(widgets::lines(tail, 13.0, 20.0, W::Regular, p.muted)).wrap().selectable(true));
        });
    });
}

/// The box at the top of a reply that has no steps (`.thinking-shell`).
fn thinking_panel(ui: &mut Ui, text: &str, ms: u64, live: bool, env: &mut Env, usage_reasoning: u64) {
    let p = p();
    let id = ui.id().with("thinking");
    // A reply watched live opens on its own; one from history starts closed.
    let mut open: bool = ui.data(|d| d.get_temp(id)).unwrap_or(live);
    if live && text.trim().is_empty() {
        return;
    }
    let (border, fill) = if live {
        (alpha(p.thinking, 32.0), alpha(p.thinking, 8.0))
    } else if open {
        (p.border_light, alpha(p.bg3, 72.0))
    } else {
        (p.border, alpha(p.bg2, 55.0))
    };
    egui::Frame::new().fill(fill).stroke(Stroke::new(1.0, border)).corner_radius(8).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 36.0), Sense::click());
        let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
        let t = widgets::fade(ui, response.id, response.hovered());
        let colour = if live { widgets::lerp(p.thinking, theme::mix(p.thinking, 80.0, Color32::WHITE), t) } else { widgets::lerp(p.muted, p.text2, t) };
        icons::paint(ui, if open { icons::CHEVRON_DOWN.stroke(2.2) } else { icons::CHEVRON_RIGHT.stroke(2.2) }, pos2(row.left() + 12.0 + 6.5, row.center().y), 13.0, colour);
        let x = row.left() + 12.0 + 13.0 + 6.0;
        let chars = text.chars().count();
        if live {
            let label = format!("Thinking · {}s{}", env.thinking_secs.unwrap_or(0), if chars > 0 { format!(" · {} tok", tokens_of_chars(chars, 0)) } else { String::new() });
            let mut job = chat::shimmer(ui, &label, 13.0);
            job.sections.iter_mut().for_each(|s| s.format.font_id = theme::font(13.0, W::Medium));
            let w = widgets::text_at(ui, x, row.center().y, ui.painter().layout_job(job));
            let mut spot = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_size(pos2(x + w + 6.0, row.center().y - 1.0), vec2(20.0, 6.0))));
            dots(&mut spot, 3.0, p.thinking);
        } else {
            let label = if ms > 1 {
                let rate = if usage_reasoning > 0 { format!(" · {} tok/s", { let n = usage_reasoning as f64 / (ms as f64 / 1000.0); if n >= 1000.0 { format!("{:.1}k", n / 1000.0) } else { format!("{}", n.round().max(0.0)) } }) } else { String::new() };
                format!("Thought for {}{rate}", thought_time(ms))
            } else {
                "Thinking".to_string()
            };
            widgets::text_at(ui, x, row.center().y, widgets::galley(ui, &label, theme::font(13.0, W::Medium), colour));
        }
        if response.clicked() {
            open = !open;
            ui.data_mut(|d| d.insert_temp(id, open));
        }
        if open {
            if text.trim().is_empty() {
                egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 0, bottom: 10 }).show(ui, |ui| {
                    plain(ui, widgets::lines("Thinking was enabled, but no reasoning text was received for this reply.", 13.0, 20.0, W::Regular, p.muted.gamma_multiply(0.6)));
                });
            } else {
                thought_body(ui, text, live, 320.0, egui::Margin { left: 12, right: 12, top: 0, bottom: 10 });
            }
        }
    });
}

/// One stretch of thinking between steps (`ThinkRow`).
fn think_row(ui: &mut Ui, text: &str, live: bool, env: &mut Env) {
    let p = p();
    if text.trim().is_empty() && !live {
        return;
    }
    let id = ui.id().with("think");
    let toggled: Option<bool> = ui.data(|d| d.get_temp(id));
    let open = toggled.unwrap_or(live);
    let (border, fill) = if live {
        (alpha(p.thinking, 32.0), alpha(p.thinking, 8.0))
    } else if open {
        (p.border, alpha(p.bg2, 55.0))
    } else {
        (Color32::TRANSPARENT, Color32::TRANSPARENT)
    };
    egui::Frame::new().fill(fill).stroke(Stroke::new(1.0, border)).corner_radius(8).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), Sense::click());
        let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
        let t = widgets::fade(ui, response.id, response.hovered());
        if !live {
            ui.painter().rect_filled(row, 8.0, alpha(p.hover, 60.0 * t));
        }
        let colour = if live { p.thinking } else { widgets::lerp(p.muted, p.text2, t) };
        let glyph = Rect::from_min_size(pos2(row.left() + 6.0, row.center().y - 10.0), vec2(20.0, 20.0));
        ui.painter().rect_filled(glyph, 8.0, if live { alpha(p.thinking, 12.0) } else { alpha(p.hover, 70.0) });
        icons::paint(ui, icons::THINK, glyph.center(), 13.0, colour);
        let mut x = glyph.right() + 8.0;
        let amount = tokens_of_chars(text.chars().count(), 1);
        if live {
            let label = format!("Thinking · {}s · {amount} tok", env.thinking_secs.unwrap_or(0));
            let mut job = chat::shimmer(ui, &label, 13.0);
            job.sections.iter_mut().for_each(|s| s.format.font_id = theme::font(13.0, W::Medium));
            x += widgets::text_at(ui, x, row.center().y, ui.painter().layout_job(job));
        } else {
            x += widgets::text_at(ui, x, row.center().y, widgets::galley(ui, "Thought", theme::font(13.0, W::Medium), colour));
            x += widgets::text_at(ui, x, row.center().y, widgets::galley(ui, &format!(" · {amount} tok"), theme::font(13.0, W::Regular), colour.gamma_multiply(0.7)));
        }
        icons::paint(ui, if open { icons::CHEVRON_UP } else { icons::CHEVRON_DOWN }, pos2(x + 8.0 + 6.0, row.center().y), 12.0, colour.gamma_multiply(if response.hovered() { 0.7 } else { 0.4 }));
        if response.clicked() {
            ui.data_mut(|d| d.insert_temp(id, !open));
        }
        if open {
            thought_body(ui, text, live, 288.0, egui::Margin { left: 36, right: 12, top: 0, bottom: 10 });
        }
    });
}

// ------------------------------------------------------------------ assistant

/// A small rounded label in the row above a reply: effort, sources.
fn pill(ui: &mut Ui, icon: Icon, text: &str, colour: Color32, chevron: Option<bool>) -> Response {
    let label = widgets::galley(ui, text, theme::font(11.0, W::Medium), colour);
    let width = 7.0 + 9.0 + 4.0 + label.size().x + chevron.map_or(0.0, |_| 12.0) + 7.0;
    let (rect, response) = ui.allocate_exact_size(vec2(width, 22.5), if chevron.is_some() { Sense::click() } else { Sense::hover() });
    let t = if chevron.is_some() { widgets::fade(ui, response.id, response.hovered()) } else { 0.0 };
    ui.painter().rect(rect, 8.0, alpha(colour, 10.0 + 10.0 * t), Stroke::new(1.0, alpha(colour, 25.0)), StrokeKind::Inside);
    icons::paint(ui, icon, pos2(rect.left() + 7.0 + 4.5, rect.center().y), 9.0, colour);
    let end = rect.left() + 20.0 + widgets::text_at(ui, rect.left() + 20.0, rect.center().y, label);
    if let Some(open) = chevron {
        icons::paint(ui, if open { icons::CHEVRON_UP.stroke(3.0) } else { icons::CHEVRON_DOWN.stroke(3.0) }, pos2(end + 8.0, rect.center().y), 8.0, colour);
    }
    response
}

fn small(text: impl Into<String>, weight: W) -> egui::RichText {
    widgets::lines(text, 11.0, 16.5, weight, p().muted)
}

/// Tokens, cost, time: the line of small print above a reply.
fn meta_row(ui: &mut Ui, msg: &Message, env: &Env, sources_open: &mut bool) -> bool {
    let p = p();
    let effort = msg.effort.as_deref().filter(|e| !e.is_empty() && *e != "none");
    let used = msg.usage.prompt + msg.usage.completion;
    if effort.is_none() && used == 0 && msg.duration_ms == 0 && msg.search_results.is_empty() {
        return false;
    }
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(6.0, 4.0);
        ui.set_row_height(22.5);
        if let Some(effort) = effort {
            pill(ui, icons::SPARKLE, effort, p.thinking, None);
        }
        let sources = msg.search_results.len();
        if sources > 0 && pill(ui, icons::SEARCH_SMALL, &plural(sources, "source"), p.search, Some(*sources_open)).on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
            *sources_open = !*sources_open;
        }
        if used > 0 {
            let u = &msg.usage;
            let mut tip = format!("{} in · {} out", chat::thousands(u.prompt), chat::thousands(u.completion));
            if u.reasoning > 0 {
                tip += &format!("\n{} of the output was thinking, billed at the output rate", chat::thousands(u.reasoning));
            }
            let cached = msg.raw_usage.as_ref().and_then(|raw| raw["prompt_cache_hit_tokens"].as_u64()).unwrap_or(u.cache_hit);
            if cached > 0 {
                tip += &format!("\n{} of the input was cached, billed at 1/120th the rate", chat::thousands(cached));
            }
            plain(ui, small(format!("{} tokens", chat::thousands(used)), W::Regular)).on_hover_text(tip);
        }
        // The reply's cost is the model's plus what its web searches cost (the web's `searchUsd`), the search on its own tooltip line.
        let model = msg.usage.shown_cost(&msg.model, &env.settings.custom_models, crate::provider::deepseek_off_peak()).filter(|_| used > 0);
        let search = msg.search_usd;
        if let Some(cost) = model.map(|c| c + search).or((search > 0.0).then_some(search)) {
            let tip = if search > 0.0 {
                format!("Model: {}\nWeb search: {}\nEstimated from published rates", chat::format_cost(model.unwrap_or(0.0)), chat::format_cost(search))
            } else {
                format!("Model: {}\nEstimated from published rates", chat::format_cost(cost))
            };
            plain(ui, small(chat::format_cost(cost), W::Medium)).on_hover_text(tip);
        }
        let with_icon = |ui: &mut Ui, icon: Icon, text: String, tip: String| {
            // One piece as tall as its text. A row of its own stands taller than the line, and sat low on it.
            let label = widgets::galley(ui, &text, theme::font(11.0, W::Regular), p.muted);
            let (rect, response) = ui.allocate_exact_size(vec2(13.0 + label.size().x, 16.5), Sense::hover());
            icons::paint(ui, icon, pos2(rect.left() + 4.5, rect.center().y), 9.0, p.muted);
            widgets::text_at(ui, rect.left() + 13.0, rect.center().y, label);
            response.on_hover_text(tip);
        };
        if msg.duration_ms > 0 {
            with_icon(ui, icons::CLOCK, chat::format_duration(msg.duration_ms), "Time from sending to the last token".into());
        }
        let context: u64 = msg.other.get("contextChars").and_then(|v| v.as_u64()).unwrap_or_else(|| msg.context_breakdown.iter().map(|b| b.chars).sum());
        if context > 0 {
            let k = |n: u64| if n >= 1000 { format!("{:.0}k", n as f64 / 1000.0) } else { n.to_string() };
            let mut tip = "Context sent with the final request".to_string();
            if !msg.context_breakdown.is_empty() {
                tip += ":";
                msg.context_breakdown.iter().for_each(|b| tip += &format!("\n{} {}", b.label, k(b.chars)));
            }
            with_icon(ui, icons::LINES, if context >= 1000 { format!("~{} ctx", k(context)) } else { format!("{context} ctx") }, tip);
        }
        let ending = msg.raw_ending.as_ref();
        let count = |key: &str| ending.and_then(|e| e[key].as_u64()).unwrap_or(0);
        let (continued, stalls) = (count("continuedOutput") + count("continuedConnection"), count("thinkOnlyStalls"));
        if msg.finish.is_some() || continued > 0 || stalls >= 2 {
            let mut text = format!("· {}", msg.finish.as_deref().unwrap_or("cut"));
            if continued > 0 {
                text += &format!(" +{continued} cont");
            }
            if stalls >= 2 {
                text += &format!(" · thought {stalls}×, empty");
            }
            plain(ui, small(text, W::Regular)).on_hover_text(format!(
                "Final finish_reason: {}\nOutput-limit continuations: {}\nConnection-cut continuations: {}",
                msg.finish.as_deref().unwrap_or("none (stream ended mid-content)"),
                count("continuedOutput"),
                count("continuedConnection")
            ));
        }
    });
    true
}

fn sources(ui: &mut Ui, msg: &Message, env: &mut Env) {
    let p = p();
    egui::Frame::new().fill(alpha(p.bg2, 60.0)).stroke(Stroke::new(1.0, alpha(p.search, 20.0))).corner_radius(12).inner_margin(egui::Margin::same(6)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        for (i, source) in msg.search_results.iter().enumerate() {
            if i > 0 {
                ui.add_space(2.0);
            }
            let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 44.5), Sense::click());
            let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
            let t = widgets::fade(ui, response.id, response.hovered());
            ui.painter().rect_filled(row, 8.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t));
            let badge = Rect::from_min_size(pos2(row.left() + 8.0, row.center().y - 8.0), vec2(16.0, 16.0));
            ui.painter().rect_filled(badge, 4.0, alpha(p.search, 15.0));
            let number = widgets::galley(ui, &(i + 1).to_string(), theme::font(9.0, W::Bold), p.search);
            let number_width = number.size().x;
            widgets::text_at(ui, badge.center().x - number_width / 2.0, badge.center().y, number);
            let x = badge.right() + 10.0;
            let room = row.right() - 8.0 - 11.0 - 10.0 - x;
            let domain = if source.domain.is_empty() { source.url.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("") } else { &source.domain };
            widgets::text_at(ui, x, row.top() + 6.0 + 8.0, widgets::clipped(ui, &source.title, theme::font(12.0, W::Regular), widgets::lerp(p.text, p.search, t), room));
            widgets::text_at(ui, x, row.top() + 6.0 + 16.0 + 8.25, widgets::clipped(ui, domain, theme::font(11.0, W::Regular), p.muted, room));
            icons::paint(ui, icons::EXTERNAL, pos2(row.right() - 8.0 - 5.5, row.center().y), 11.0, p.muted.gamma_multiply(t));
            if response.clicked() {
                *env.action = Some(Action::Link(source.url.clone()));
            }
        }
    });
}

/// "This reply stopped before it finished", with the way out.
fn interrupted(ui: &mut Ui, msg: &Message, env: &mut Env) {
    let p = p();
    // Anything that arrived can be carried on: text, thinking or a step.
    let can_resume = msg.parts.iter().any(|part| !matches!(part, Part::Notice(_)));
    egui::Frame::new().fill(alpha(p.warning, 7.0)).stroke(Stroke::new(1.0, alpha(p.warning, 30.0))).corner_radius(12).show(ui, |ui| {
        ui.set_width(ui.available_width());
        egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                ui.vertical(|ui| {
                    ui.add_space(2.0);
                    icons::show(ui, icons::WARNING.stroke(1.9), 15.0, p.warning);
                });
                ui.vertical(|ui| {
                    ui.add(egui::Label::new(widgets::lines("This reply stopped before it finished", 13.0, 17.875, W::Medium, p.warning)).wrap().selectable(false));
                    ui.add_space(2.0);
                    let why = if can_resume { "Everything it did is saved — the files it wrote, what it read, and its reasoning. Resuming carries on from there and only pays for what is left." } else { "Nothing arrived, so there is nothing to resume — Try again re-sends the turn." };
                    ui.add(egui::Label::new(widgets::lines(why, 12.0, 19.5, W::Regular, p.text2)).wrap().selectable(false));
                });
            });
        });
        if env.newest && !env.busy {
            let (line, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
            ui.painter().rect_filled(line, 0.0, alpha(p.warning, 20.0));
            // Resume dominates because it is nearly always right; starting over buys the same work twice, so it stays reachable but quiet.
            // ponytail: the web's Resume is a split button that can also pick another model; here the model is the one chosen in the composer.
            egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let over = widgets::galley(ui, "Start over", theme::font(13.0, W::Medium), p.warning);
                    let over_width = over.size().x + 24.0;
                    let main_width = ui.available_width() - if can_resume { over_width + 6.0 } else { 0.0 };
                    let (rect, response) = ui.allocate_exact_size(vec2(main_width, 35.5), Sense::click());
                    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(if can_resume { "Carry on from where it stopped, keeping the work already done" } else { "Answer again from the beginning" });
                    ui.painter().rect_filled(rect, 8.0, if response.hovered() { theme::mix(p.warning, 90.0, Color32::WHITE) } else { p.warning });
                    let label = widgets::galley(ui, if can_resume { "Resume" } else { "Try again" }, theme::font(13.0, if can_resume { W::Semibold } else { W::Medium }), p.bg);
                    let label_width = label.size().x;
                    widgets::text_at(ui, rect.center().x - label_width / 2.0, rect.center().y, label);
                    if response.clicked() {
                        *env.action = Some(if can_resume { Action::Resume } else { Action::Retry });
                    }
                    if can_resume {
                        let (rect, response) = ui.allocate_exact_size(vec2(over_width, 35.5), Sense::click());
                        let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text("Discard what was done and answer again from scratch");
                        if response.hovered() {
                            ui.painter().rect_filled(rect, 8.0, alpha(p.warning, 15.0));
                        }
                        widgets::text_at(ui, rect.center().x - (over_width - 24.0) / 2.0, rect.center().y, over);
                        if response.clicked() {
                            *env.action = Some(Action::Retry);
                        }
                    }
                });
            });
        }
    });
}

/// What went wrong and the small print behind it: the first sentence of an error, and the rest.
fn split_error(error: &str) -> (String, String) {
    let text = error.trim();
    // The sentence ends at its first full stop or line break, or where a provider's raw reply starts.
    let end = [". ", "\n", ": {", " {\""].iter().filter_map(|mark| text.find(mark).map(|at| at + usize::from(*mark == ". "))).min().unwrap_or(text.len());
    let (head, rest) = text.split_at(end);
    if head.chars().count() > 220 {
        let cut = head.char_indices().nth(200).map_or(head.len(), |(at, _)| at);
        return (format!("{}…", &text[..cut]), text[cut..].trim().to_string());
    }
    (head.trim().to_string(), rest.trim_start_matches([':', ' ', '\n']).trim().to_string())
}

/// A reply that ended in an error: what went wrong in plain sight, the provider's small print behind "Details".
fn error_card(ui: &mut Ui, error: &str) {
    let p = p();
    let (what, details) = split_error(error);
    let id = ui.id().with("error-details");
    let mut open: bool = ui.data(|d| d.get_temp(id)).unwrap_or(false);
    egui::Frame::new().fill(alpha(p.danger, 7.0)).stroke(Stroke::new(1.0, alpha(p.danger, 30.0))).corner_radius(12).inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            ui.vertical(|ui| {
                ui.add_space(2.0);
                icons::show(ui, icons::WARNING.stroke(1.9), 15.0, p.danger);
            });
            ui.vertical(|ui| {
                ui.set_width(ui.available_width());
                ui.add(egui::Label::new(widgets::lines(what, 13.0, 19.5, W::Medium, p.danger)).wrap().selectable(true));
                if details.is_empty() {
                    return;
                }
                ui.add_space(4.0);
                let toggle = ui.add(egui::Label::new(widgets::lines(if open { "Hide details" } else { "Details" }, 11.0, 16.5, W::Medium, p.muted)).selectable(false).sense(Sense::click()));
                if toggle.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                    open = !open;
                    ui.data_mut(|d| d.insert_temp(id, open));
                }
                if open {
                    ui.add_space(6.0);
                    egui::Frame::new().fill(p.bg).stroke(Stroke::new(1.0, p.border)).corner_radius(8).inner_margin(egui::Margin::same(10)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        egui::ScrollArea::vertical().id_salt("error").max_height(180.0).show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            let shown: String = details.chars().take(8_000).collect();
                            let mut job = egui::text::LayoutJob::simple(shown, theme::mono(11.5), p.text2, ui.available_width());
                            job.sections[0].format.line_height = Some(18.0);
                            // A provider's reply is often one unbroken line: it wraps wherever it must.
                            job.wrap.break_anywhere = true;
                            ui.add(egui::Label::new(job).selectable(true));
                        });
                    });
                }
            });
        });
    });
}

/// Splits a reply still being written at a code fence that has not closed yet.
/// Returns the text before it, and the language and line count of the open block.
fn pending_fence(text: &str) -> Option<(&str, &str, usize)> {
    let fences: Vec<usize> = text.match_indices("```").filter(|(i, _)| *i == 0 || text.as_bytes()[i - 1] == b'\n').map(|(i, _)| i).collect();
    if fences.len() % 2 == 0 {
        return None;
    }
    let start = *fences.last()?;
    let open = &text[start + 3..];
    let lang = open.lines().next().unwrap_or("").trim();
    Some((text[..start].trim_end(), lang, open.lines().count().saturating_sub(1)))
}

fn pending_code(ui: &mut Ui, lang: &str, lines: usize) {
    let p = p();
    egui::Frame::new().fill(p.bg2).stroke(Stroke::new(1.0, p.border)).corner_radius(12).inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 12.0;
            let (tile, _) = ui.allocate_exact_size(vec2(36.0, 36.0), Sense::hover());
            ui.painter().rect_filled(tile, 8.0, p.elevated);
            let pulse = 0.75 + 0.25 * (ui.input(|i| i.time) * std::f64::consts::PI).cos() as f32;
            icons::paint(ui, icons::CODE, tile.center(), 16.0, p.accent_light.gamma_multiply(pulse));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                dots(ui, 4.0, p.accent);
                ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                    plain(ui, widgets::lines(if lang.is_empty() { "Writing code…".to_string() } else { format!("Writing {lang}…") }, 14.0, 20.0, W::Medium, p.text));
                    plain(ui, widgets::lines(format!("{} so far", plural(lines, "line")), 11.0, 16.5, W::Regular, p.muted));
                });
            });
        });
    });
}

/// A line the agent left in the reply. Folding the context mid-run is drawn as the divider it is.
fn notice_line(ui: &mut Ui, text: &str) {
    if text.starts_with("Context compacted") {
        chat::divider(ui, text, "Older steps of this reply are summarised for the model. It sees the summary plus what comes after this line.");
    } else {
        ui.add(egui::Label::new(widgets::lines(text, 12.0, 19.5, W::Regular, p().muted)).wrap().selectable(false));
    }
}

/// Markdown, with what was clicked in it passed on. `stretch` names this text among everything in the chat.
fn prose(ui: &mut Ui, text: &str, colour: Color32, env: &mut Env, stretch: u64) {
    let (shown, pending) = match pending_fence(text).filter(|_| env.live) {
        Some((before, lang, lines)) => (before, Some((lang, lines))),
        None => (text, None),
    };
    match markdown::show(ui, shown, colour, &mut env.marks, Some((&mut *env.rows, egui::Id::new(stretch)))) {
        Some(Click::Link(url)) => *env.action = Some(Action::Link(url)),
        Some(Click::Copy(code)) => *env.action = Some(Action::Copy(code)),
        Some(Click::Open(title, lang, code)) => *env.action = Some(Action::OpenCode(title, lang, code)),
        None => {}
    }
    if let Some((lang, lines)) = pending {
        ui.add_space(4.5);
        pending_code(ui, lang, lines);
        ui.add_space(12.0);
    }
}

fn assistant(ui: &mut Ui, msg: &Message, env: &mut Env) {
    let p = p();
    let column = ui.max_rect();
    let top = ui.cursor().top();
    // Transparent, 16 of padding each side, never wider than the cap.
    let area = Rect::from_min_max(pos2(column.left() + 16.0, top), pos2(column.left() + env.cap - 16.0, f32::INFINITY));
    let used = ui
        .scope_builder(egui::UiBuilder::new().max_rect(area), |ui| {
            ui.set_width(area.width());
            assistant_body(ui, msg, env);
        })
        .response
        .rect;
    ui.advance_cursor_after_rect(Rect::from_min_max(pos2(column.left(), top), pos2(column.right(), used.bottom())));
    let _ = p;
}

/// One timeline row: its prose fragments, the tools it ran, its reasoning (and whether that is still streaming), its notice.
type TimelineRow<'a> = (Vec<&'a str>, Vec<&'a ToolEvent>, Option<(Cow<'a, str>, bool)>, Option<&'a str>);

/// Groups a reply's parts into timeline rows, as the web's `buildTimelineRows` does: prose keeps adding to its row until a
/// tool or reasoning comes, a tool joins the row above it unless reasoning came last, and reasoning split across parts reads
/// as one thought in one row.
pub fn timeline_rows(parts: &[Part], live: bool) -> Vec<TimelineRow<'_>> {
    let mut rows: Vec<TimelineRow> = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        match part {
            Part::Thinking { text, ms } => {
                let streaming = live && *ms == 0 && i + 1 == parts.len();
                match rows.last_mut() {
                    Some((_, _, Some((thought, flag)), None)) => {
                        thought.to_mut().push_str(text);
                        *flag = streaming;
                    }
                    _ => rows.push((Vec::new(), Vec::new(), Some((Cow::Borrowed(text.as_str()), streaming)), None)),
                }
            }
            Part::Notice(text) => rows.push((Vec::new(), Vec::new(), None, Some(text.as_str()))),
            Part::Text(text) => match rows.last_mut() {
                Some((texts, tools, None, None)) if tools.is_empty() => texts.push(text.as_str()),
                _ => rows.push((vec![text.as_str()], Vec::new(), None, None)),
            },
            Part::Tool(tool) => match rows.last_mut() {
                Some((_, tools, None, None)) => tools.push(tool),
                _ => rows.push((Vec::new(), vec![tool], None, None)),
            },
        }
    }
    rows
}

fn assistant_body(ui: &mut Ui, msg: &Message, env: &mut Env) {
    let p = p();
    let has_tools = msg.parts.iter().any(|part| matches!(part, Part::Tool(_)));
    // A reply with find matches is drawn flat, as the web draws it while a query is on.
    let timeline = msg.parts.len() > 1 && has_tools && env.marks.is_none();
    let text = msg.text();
    let failed = msg.error.is_some();
    let colour = if msg.incomplete && !env.live { p.text2 } else { p.text };
    let first = std::cell::Cell::new(true);
    let gap = |ui: &mut Ui, space: f32| {
        if !first.replace(false) {
            ui.add_space(space);
        }
    };

    let sources_id = ui.id().with("sources");
    let mut sources_open: bool = ui.data(|d| d.get_temp(sources_id)).unwrap_or(false);
    let before = sources_open;
    if meta_row(ui, msg, env, &mut sources_open) {
        first.set(false);
    }
    if sources_open != before {
        ui.data_mut(|d| d.insert_temp(sources_id, sources_open));
    }
    if sources_open && !msg.search_results.is_empty() {
        gap(ui, 12.0);
        sources(ui, msg, env);
    }

    // Thinking that has its place among the steps is shown there; otherwise in one box up here.
    let inline_thinking = timeline && msg.parts.iter().any(|part| matches!(part, Part::Thinking { .. }));
    if !inline_thinking {
        let reasoning = msg.reasoning();
        let thinking_now = env.live && matches!(msg.parts.last(), Some(Part::Thinking { ms: 0, .. }));
        // A finished reply that was asked to think shows the box even when no thinking came back.
        let asked = !env.live && msg.effort.as_deref().is_some_and(|e| !e.is_empty() && e != "none");
        if !reasoning.trim().is_empty() || asked {
            gap(ui, 12.0);
            thinking_panel(ui, &reasoning, msg.reasoning_ms, thinking_now, env, msg.usage.reasoning);
        }
    }
    // ponytail: a reply written here does not keep its own copy of the plan, so only the newest one shows the chat's.
    let plan = msg.other.get("plan").and_then(super::plan_panel::from_value).or_else(|| env.plan.filter(|_| env.newest).map(super::plan_panel::from_plan));
    if let Some(view) = plan.filter(|view| !view.steps.is_empty()) {
        gap(ui, 12.0);
        match super::plan_panel::show(ui, &view, env.newest && !env.busy) {
            Some(super::plan_panel::Act::Unblock) => *env.action = Some(Action::PlanUnblock),
            Some(super::plan_panel::Act::Clear) => *env.action = Some(Action::PlanClear),
            None => {}
        }
        // The card keeps 10px under it where the other blocks keep 12.
        ui.add_space(-2.0);
    }
    if msg.incomplete && !env.live {
        gap(ui, 12.0);
        interrupted(ui, msg, env);
    }

    // Who refused, when a reply was blocked: apiM adds no content rules of its own.
    if !env.live && !failed {
        let model = models::resolve(&msg.model, &env.settings.custom_models);
        let why = match refusal::refusal_source(&text, msg.finish.as_deref()) {
            Some(RefusalSource::ContentFilter) => Some(format!("The provider behind {} stopped this reply with its own content filter.", model.label)),
            Some(RefusalSource::Model) => Some(format!("This refusal came from {}, not from apiM. apiM adds no content rules. Try again, rephrase, or pick another model.", model.label)),
            None => None,
        };
        if let Some(why) = why {
            gap(ui, 12.0);
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                ui.vertical(|ui| {
                    ui.add_space(3.0);
                    icons::show(ui, icons::INFO, 13.0, p.muted);
                });
                ui.add(egui::Label::new(widgets::lines(why, 12.0, 19.5, W::Regular, p.muted)).wrap().selectable(false)).on_hover_text("apiM sends your message to the model as written and adds no content rules of its own.");
            });
        }
    }

    let open_id = ui.id().with("open-step");
    let mut open: Option<String> = ui.data(|d| d.get_temp(open_id));
    let was_open = open.clone();

    if timeline {
        gap(ui, 12.0);
        // A row is a stretch of prose and the steps it led to; thinking sits between rows where it happened.
        let rows = timeline_rows(&msg.parts, env.live);
        // The classic layout (Settings → Theme): prose on the left, its steps on the right, a rule between rows.
        let split = env.settings.reply_layout == "split";
        let mut after_think = false;
        let width = ui.available_width();
        for (i, (texts, tools, think, notice)) in rows.iter().enumerate() {
            if i > 0 {
                let after = after_think && think.is_none();
                let space = if after { 6.0 } else if split && think.is_none() { 16.0 } else { 12.0 };
                ui.add_space(space);
                if split && !after {
                    let (line, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
                    ui.painter().rect_filled(line, 0.0, alpha(p.border, if think.is_some() { 40.0 } else { 60.0 }));
                    ui.add_space(space);
                }
            }
            after_think = think.is_some();
            // The row a live reply is writing is always laid out; any other only while it shows.
            let writing = env.live && i + 1 == rows.len();
            let key = egui::Id::new((&msg.id, i));
            let chars: usize = texts.iter().map(|text| text.len()).sum();
            let print = lazy::print((
                width.to_bits(),
                split,
                chars,
                think.as_ref().map(|(thought, live)| (thought.len(), *live)),
                notice.map(str::len),
                tools.iter().map(|tool| (tool.ok, tool.image.is_some(), tool.summary.len(), tool.args.len(), open.as_deref() == Some(tool.id.as_str()))).collect::<Vec<_>>(),
                // A row that shows a picture is as tall as what is known of that picture.
                tools.iter().any(|tool| tool.name == "show_image").then(super::trim::generation),
            ));
            let guess = 40.0 + tools.len() as f32 * 31.0 + (chars as f32 / (width / 7.5).max(20.0)).ceil() * 25.5;
            if !writing && env.rows.skip(ui, key, print, guess) {
                continue;
            }
            let top = ui.cursor().top();
            ui.push_id(i, |ui| {
                if let Some((thought, live)) = think {
                    think_row(ui, thought, *live, env);
                } else if let Some(notice) = notice {
                    notice_line(ui, notice);
                } else {
                    let said = texts.concat();
                    let has_text = !said.trim().is_empty();
                    let stretch = lazy::print((&msg.id, i));
                    // Side by side only with something on both sides, room for it, and no table to squeeze.
                    if split && has_text && !tools.is_empty() && !has_table(&said) && ui.ctx().content_rect().width() >= 768.0 {
                        let full = Rect::from_min_size(ui.cursor().min, vec2(ui.available_width(), 0.0));
                        let mut left = ui.new_child(egui::UiBuilder::new().max_rect(full.with_max_x(full.right() - 321.0 - 24.0)).layout(egui::Layout::top_down(egui::Align::Min)));
                        prose(&mut left, &said, colour, env, stretch);
                        let mut right = ui.new_child(egui::UiBuilder::new().max_rect(full.with_min_x(full.right() - 320.0 + 24.0)).layout(egui::Layout::top_down(egui::Align::Min)));
                        steps(&mut right, tools, env, &mut open);
                        let bottom = left.min_rect().bottom().max(right.min_rect().bottom());
                        ui.painter().rect_filled(Rect::from_min_max(pos2(full.right() - 321.0, full.top()), pos2(full.right() - 320.0, bottom)), 0.0, p.border);
                        ui.allocate_rect(full.with_max_y(bottom), Sense::hover());
                    } else {
                        if has_text {
                            prose(ui, &said, colour, env, stretch);
                            if !tools.is_empty() {
                                ui.add_space(8.0);
                            }
                        }
                        if !tools.is_empty() {
                            steps(ui, tools, env, &mut open);
                        }
                    }
                }
            });
            env.rows.store(key, print, ui.cursor().top() - top);
        }
    } else {
        let tools: Vec<&ToolEvent> = msg.parts.iter().filter_map(|part| if let Part::Tool(t) = part { Some(t) } else { None }).collect();
        if !tools.is_empty() {
            gap(ui, 12.0);
            steps(ui, &tools, env, &mut open);
        }
        if !text.is_empty() {
            gap(ui, 12.0);
            prose(ui, &text, colour, env, lazy::print((&msg.id, usize::MAX)));
        }
        for part in &msg.parts {
            if let Part::Notice(notice) = part {
                gap(ui, 12.0);
                notice_line(ui, notice);
            }
        }
    }
    if open != was_open {
        ui.data_mut(|d| {
            d.remove::<String>(open_id);
            if let Some(id) = open {
                d.insert_temp(open_id, id);
            }
        });
    }

    if let Some(error) = &msg.error {
        gap(ui, 12.0);
        error_card(ui, error);
    }
    if env.live {
        return;
    }

    let delete_tip = "Delete this reply and your question — both forget it";
    if env.newest && !failed && !text.is_empty() {
        gap(ui, 12.0);
        ui.add_space(2.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            let copied_id = ui.id().with("copied");
            let done = ui.data(|d| d.get_temp::<f64>(copied_id)).is_some_and(|at| ui.input(|i| i.time) - at < 2.0);
            let copy = if done { action_btn(ui, icons::CHECK_THIN.stroke(2.2), "Copied", "Copy reply", 28.0, false, Some(p.success)) } else { action_btn(ui, icons::COPY_SMALL, "Copy", "Copy reply", 28.0, false, None) };
            if copy.clicked() {
                let now = ui.input(|i| i.time);
                ui.data_mut(|d| d.insert_temp(copied_id, now));
                *env.action = Some(Action::Copy(text.clone()));
            }
            let earlier = msg.other.get("previousVersions").and_then(|v| v.as_array()).map_or(0, Vec::len);
            if earlier > 0 && compare_btn(ui, earlier + 1).clicked() {
                *env.action = Some(Action::Compare(msg.id.clone()));
            }
            if !env.busy && action_btn(ui, icons::REGENERATE, "Regenerate", "Generate a different reply", 28.0, false, None).clicked() {
                *env.action = Some(Action::Retry);
            }
            if !env.busy && action_btn(ui, icons::TRASH_SMALL, "Delete", delete_tip, 28.0, true, None).clicked() {
                *env.action = Some(Action::Delete(msg.id.clone()));
            }
        });
    } else if env.newest && !env.busy {
        gap(ui, 12.0);
        if action_btn(ui, icons::TRASH_SMALL, "Delete", delete_tip, 28.0, true, None).clicked() {
            *env.action = Some(Action::Delete(msg.id.clone()));
        }
    } else if !env.busy {
        // Older replies: a Delete that only shows while its strip is hovered. The strip is always there.
        gap(ui, 12.0);
        let (strip, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
        let shown = widgets::fade(ui, ui.id().with("delete-strip"), ui.rect_contains_pointer(strip));
        if shown > 0.0 {
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(strip.with_min_y(strip.top() + 2.0)).layout(egui::Layout::left_to_right(egui::Align::Center)));
            child.set_opacity(shown);
            if action_btn(&mut child, icons::TRASH_SMALL, "Delete", delete_tip, 28.0, true, None).clicked() {
                *env.action = Some(Action::Delete(msg.id.clone()));
            }
        }
    }
    let _ = CornerRadius::ZERO;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Message;

    /// The web's timeline rows (`timeline_fixtures.json`, dumped from src/lib/timeline.ts): each stored reply goes through
    /// the desktop's own timeline conversion and grouping, and must come out as the same rows.
    #[test]
    fn timeline_rows_match_the_web_app() {
        let cases: Vec<(serde_json::Value, serde_json::Value)> = serde_json::from_str(include_str!("timeline_fixtures.json")).unwrap();
        assert_eq!(cases.len(), 5);
        for (input, expected) in cases {
            let msg = Message::from_web(&input["message"]);
            let rows: Vec<serde_json::Value> = timeline_rows(&msg.parts, false)
                .iter()
                .map(|(texts, tools, think, _)| serde_json::json!({ "text": texts.concat(), "tools": tools.iter().map(|t| t.id.clone()).collect::<Vec<_>>(), "think": think.as_ref().map(|(t, _)| t.clone()) }))
                .collect();
            assert_eq!(serde_json::Value::Array(rows), expected, "{}", input["name"]);
        }
    }

    #[test]
    fn step_words_and_targets() {
        let d = describe("read_file", r#"{"path":"src/main.rs"}"#);
        assert_eq!((d.running.as_str(), d.done.as_str(), d.target.as_deref(), d.mono), ("Reading", "Read", Some("src/main.rs"), true));
        assert_eq!(describe("write_files", r#"{"files":[{},{}]}"#).target.as_deref(), Some("2 files"));
        assert_eq!(describe("edit_files", r#"{"edits":[{}]}"#).target.as_deref(), Some("1 edit"));
        assert_eq!(describe("run_command", r#"{"command":"cargo","args":["test","-q"]}"#).target.as_deref(), Some("cargo test -q"));
        assert_eq!(describe("fetch_url", r#"{"url":"https://example.com/a"}"#).target.as_deref(), Some("example.com/a"));
        let search = describe("web_search", r#"{"query":"rust egui"}"#);
        assert_eq!((search.target.as_deref(), search.mono), (Some("rust egui"), false));
        // Arguments still streaming in: the path so far.
        assert_eq!(describe("write_file", r#"{"path":"notes/pl"#).target.as_deref(), Some("notes/pl"));
        assert_eq!(describe("my_new-tool", "{}").done, "My new tool");
        assert_eq!(describe("mcp__files__read_text", "{}").done, "MCP read_text");
        assert_eq!(step_body(r#"{"command":"git","args":["commit","-m","two words"]}"#).as_deref(), Some(r#"git commit -m "two words""#));
        // A failure says why, not the command the row already shows; an echo of the command says nothing.
        assert_eq!(failure_reason("Failed: cmake --build x", "cmake --build x"), None);
        assert_eq!(failure_reason("Exit 1: main.cpp(42): error C3861", "cmake --build x").as_deref(), Some("Exit 1: main.cpp(42): error C3861"));
        assert_eq!(split_error("OpenRouter returned 429: rate limit exceeded. Provider said: {\"error\":1}"), ("OpenRouter returned 429: rate limit exceeded.".into(), "Provider said: {\"error\":1}".into()));
        assert_eq!(split_error("Network error"), ("Network error".into(), String::new()));
    }

    #[test]
    fn times_and_fences() {
        assert_eq!((thought_time(400), thought_time(42_400), thought_time(184_000)), ("1s".into(), "42s".into(), "3m 04s".into()));
        assert_eq!((tokens_of_chars(2, 1), tokens_of_chars(400, 1), tokens_of_chars(8_000, 1)), ("1".into(), "100".into(), "2.0k".into()));
        assert_eq!(pending_fence("Here:\n```rust\nfn a() {}\nfn b() {}"), Some(("Here:", "rust", 2)));
        assert_eq!(pending_fence("Here:\n```rust\nfn a() {}\n```\ndone"), None);
        assert_eq!(pending_fence("inline ``` is not a fence"), None);
        // A long question folds at a line end near the limit; a short one is left alone.
        let pasted = format!("{}\n{}", "a".repeat(1_000), "b".repeat(20_000));
        assert_eq!((fold("short", false), fold(&pasted, false).len(), fold(&pasted, true).len()), ("short", 1_000, pasted.len()));
    }
}
