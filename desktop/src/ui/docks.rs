//! The two chips at the right of the chat header, each with a card that drops
//! under it: this chat's files while their panel is shut
//! (src/components/WorkspaceDock.tsx), and what the assistant left running
//! (ProcessDock.tsx).

use super::form::Btn;
use super::theme::{self, W, alpha, p};
use super::workspace::{self, badge, badge_text, format_size};
use super::{App, icons, widgets, workspace_panel};
use crate::tools::exec::{self, ProcInfo};
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::collections::HashSet;
use std::time::Duration;

/// Tailwind's green-400, the same in every theme.
const GREEN_400: Color32 = Color32::from_rgb(0x05, 0xdf, 0x72);

#[derive(Default)]
pub struct State {
    files_open: bool,
    procs_open: bool,
    /// The process whose output is unfolded.
    expanded: Option<String>,
    /// Processes stopped from here: they read "stopped", not their exit code.
    stopped: HashSet<String>,
    /// Stand-ins for the self-portrait, which starts no processes of its own.
    sample: Vec<ProcInfo>,
}

/// The self-portrait's states for the two chips.
pub fn stage(app: &mut App, token: &str) {
    match token {
        "ws-dock" => (app.settings.workspace_open, app.ws.docks.files_open) = (false, true),
        "process-dock" => {
            let proc = |n: u32, display: &str, exit, log: &str| ProcInfo { id: format!("p{n}"), display: display.into(), pid: 0, exit, log_tail: log.into() };
            app.ws.docks.sample = vec![
                proc(1, "npm run dev -- --port 5173", None, "  VITE v5.4.2  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n"),
                proc(2, "python -m http.server 8000 --directory C:\\Users\\me\\projects\\site\\public\\assets", None, ""),
                proc(3, "cargo watch -x test", Some(1), "error: no such command: `watch`\n"),
                proc(4, "node scripts/seed.js", Some(0), ""),
            ];
            app.ws.docks.stopped = HashSet::from(["p4".to_string()]);
            (app.ws.docks.procs_open, app.ws.docks.expanded) = (true, Some("p1".into()));
        }
        _ => {}
    }
}

/// Draws both chips. The header lays out right to left, so the files chip comes first.
pub fn header(app: &mut App, ui: &mut egui::Ui) {
    workspace::refresh(app);
    // The files chip stands in for the panel and goes when the panel is there.
    if app.settings.workspace_open {
        app.ws.docks.files_open = false;
    } else {
        files(app, ui);
    }
    processes(app, ui);
}

enum Lead {
    Icon(icons::Icon),
    Dot(Color32),
}

/// `.chip` as these two wear it: an icon or a 6px dot in front, and sometimes a dot behind.
fn chip(ui: &mut egui::Ui, lead: Lead, text: &str, active: bool, open: bool, trail: Option<Color32>) -> egui::Response {
    let p = p();
    let label = widgets::galley(ui, text, theme::font(13.0, W::Medium), Color32::WHITE);
    let lead_width = if matches!(lead, Lead::Icon(_)) { 14.0 } else { 6.0 };
    let width = 11.0 + lead_width + 6.0 + label.size().x + if trail.is_some() { 12.0 } else { 0.0 } + 11.0;
    let (rect, response) = ui.allocate_exact_size(vec2(width, 32.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered() || open);
    let (ink, fill, border) = if active {
        (p.accent_light, widgets::lerp(alpha(p.accent, 10.0), alpha(p.accent, 16.0), t), widgets::lerp(alpha(p.accent, 32.0), alpha(p.accent, 44.0), t))
    } else {
        (widgets::lerp(p.text2, p.text, t), widgets::lerp(Color32::TRANSPARENT, p.hover, t), widgets::lerp(p.border, p.border_light, t))
    };
    ui.painter().rect(rect, 8.0, fill, Stroke::new(1.0, border), StrokeKind::Inside);
    let (mut x, y) = (rect.left() + 11.0, rect.center().y);
    match lead {
        Lead::Icon(icon) => icons::paint(ui, icon, pos2(x + 7.0, y), 14.0, ink),
        Lead::Dot(colour) => drop(ui.painter().circle_filled(pos2(x + 3.0, y), 3.0, colour)),
    }
    x += lead_width + 6.0;
    let end = x + label.size().x;
    ui.painter().galley_with_override_text_color(pos2(x, (y - label.size().y / 2.0).round()), label, ink);
    if let Some(colour) = trail {
        ui.painter().circle_filled(pos2(end + 6.0 + 3.0, y), 3.0, colour);
    }
    response
}

/// `.popover-card` hung under a chip: right edges level, 8px below, rising 6px as it fades in.
/// Returns true when Esc or a press anywhere else shuts it.
fn popover(ctx: &egui::Context, name: &str, chip: Rect, width: f32, open: bool, add: impl FnOnce(&mut egui::Ui)) -> bool {
    // Told every frame, so the fade starts from nothing each time it opens.
    let t = ctx.animate_bool_with_time(egui::Id::new((name, "in")), open, 0.15);
    if !open {
        return false;
    }
    let width = width.min(ctx.content_rect().width() - 24.0);
    let area = egui::Area::new(egui::Id::new(name)).order(egui::Order::Foreground).pivot(egui::Align2::RIGHT_TOP).fixed_pos(pos2(chip.right(), chip.bottom() + 8.0 + (6.0 * (1.0 - t)).round())).show(ctx, |ui| {
        ui.set_opacity(t);
        widgets::popover_frame(16).show(ui, |ui| {
            ui.set_width(width - 2.0);
            // An area offers only the height it had last frame; its lists set their own limits.
            ui.set_max_height(ctx.content_rect().height());
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            add(ui);
        });
    });
    ctx.input(|i| i.key_pressed(egui::Key::Escape) || (i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|at| !area.response.rect.contains(at) && !chip.contains(at))))
}

/// A card's head: a title over a line of small print, a button at the right, a rule under it all.
/// `middle` sets the button halfway down; otherwise it sits level with the title. Returns whether it was clicked.
fn head(ui: &mut egui::Ui, title: &str, sub: &str, button: Option<Btn>, middle: bool) -> bool {
    let p = p();
    let (left, top, width) = (ui.max_rect().left(), ui.cursor().top(), ui.available_width());
    // Measured first: the small print wraps in whatever the button leaves.
    let button_width = button.map_or(0.0, |b| widgets::galley(ui, b.label, theme::font(b.size, b.weight), p.text).size().x + b.pad.0 * 2.0 + 2.0 + 12.0);
    let mut job = egui::text::LayoutJob::simple(sub.to_string(), theme::font(11.0, W::Regular), p.muted, width - 28.0 - button_width);
    job.sections[0].format.line_height = Some(16.0);
    let small = ui.painter().layout_job(job);
    let height = 10.0 + 20.0 + 2.0 + small.size().y + 10.0;
    let (rect, _) = ui.allocate_exact_size(vec2(width, height + 1.0), Sense::hover());
    widgets::text_at(ui, left + 14.0, top + 20.0, widgets::galley(ui, title, theme::font(13.0, W::Semibold), p.text));
    ui.painter().galley(pos2(left + 14.0, top + 32.0), small, p.muted);
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.border));
    let Some(button) = button else { return false };
    let room = Rect::from_min_max(pos2(left + 14.0, top + 10.0), pos2(rect.right() - 14.0, top + height - 10.0));
    let mut ui = ui.new_child(egui::UiBuilder::new().max_rect(room).layout(egui::Layout::right_to_left(if middle { egui::Align::Center } else { egui::Align::Min })));
    button.show(&mut ui).clicked()
}

/// A small bordered button of these cards: 12px, 8 by 4 padding.
fn card_btn(label: &str) -> Btn<'_> {
    Btn::outline(label).text(12.0, 18.0).weight(W::Regular).pad(8.0, 4.0).fill(Color32::TRANSPARENT, Color32::TRANSPARENT)
}

/// The files chip: how many files the chat has, a dot when the last reply wrote one, and the list under it.
fn files(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let count = app.files.len();
    let open = app.ws.docks.files_open;
    let touched = app.files.iter().any(|file| app.ws.is_changed(&file.0));
    let label = if count == 0 { "Files".to_string() } else { count.to_string() };
    let chip = chip(ui, Lead::Icon(icons::FOLDER_PLAIN), &label, true, open, (touched && !open).then_some(p.accent_light)).on_hover_text("Files the assistant can read and write");
    if chip.clicked() {
        app.ws.docks.files_open = !open;
    }
    // None: nothing; Some(None): the whole panel; Some(Some(path)): that file in it.
    let mut pick = None;
    let ctx = ui.ctx().clone();
    let shut = popover(&ctx, "workspace-dock", chip.rect, 320.0, app.ws.docks.files_open, |ui| {
        let sub = if count == 0 { "Empty — ask for a file and it appears here".to_string() } else { format!("{count} file{} in this chat", if count == 1 { "" } else { "s" }) };
        if head(ui, "Workspace", &sub, Some(card_btn("Open").border(p.border, p.border_light)), false) {
            pick = Some(None);
        }
        if count == 0 {
            let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 16.0 + 19.5 + 16.0), Sense::hover());
            let words = widgets::galley(ui, "Nothing here yet.", theme::font(12.0, W::Regular), p.muted);
            widgets::text_at(ui, rect.center().x - words.size().x / 2.0, rect.center().y, words);
            return;
        }
        egui::ScrollArea::vertical().id_salt("workspace-dock-list").max_height((ctx.content_rect().height() * 0.6).min(384.0)).show(ui, |ui| {
            ui.add_space(6.0);
            for (path, size) in &app.files {
                let rect = Rect::from_min_size(pos2(ui.max_rect().left() + 6.0, ui.cursor().top()), vec2(ui.available_width() - 12.0, 30.0));
                ui.advance_cursor_after_rect(rect);
                if !ui.is_rect_visible(rect) {
                    continue;
                }
                let row = ui.interact(rect, ui.id().with(("file", path)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
                let t = widgets::fade(ui, row.id, row.hovered());
                ui.painter().rect_filled(rect, 8.0, p.hover.gamma_multiply(t));
                let mid = rect.center().y;
                let letters = badge_text(ui, badge(path, false), false);
                widgets::text_at(ui, rect.left() + 8.0 + 12.0 - letters.size().x / 2.0, mid, letters);
                let bytes = widgets::galley(ui, &format_size(*size), theme::font(11.0, W::Regular), p.muted);
                let bytes_left = rect.right() - 8.0 - bytes.size().x;
                widgets::text_at(ui, bytes_left, mid, bytes);
                let ink = if app.ws.is_changed(path) { p.accent_light } else { p.text2 };
                widgets::text_at(ui, rect.left() + 40.0, mid, widgets::clipped(ui, path, theme::mono(12.0), ink, bytes_left - 8.0 - (rect.left() + 40.0)));
                if row.on_hover_text(path.as_str()).clicked() {
                    pick = Some(Some(path.clone()));
                }
            }
            ui.add_space(6.0);
        });
    });
    if shut || pick.is_some() {
        app.ws.docks.files_open = false;
    }
    if let Some(path) = pick {
        workspace_panel::open(app, path);
    }
}

/// The processes chip: absent until the assistant has started something, then how many still run,
/// with the list, their output and Stop under it.
fn processes(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let list = if app.ws.docks.sample.is_empty() { app.procs.list() } else { app.ws.docks.sample.clone() };
    if list.is_empty() {
        app.ws.docks.procs_open = false;
        return;
    }
    let running = list.iter().filter(|proc| proc.exit.is_none()).count();
    let open = app.ws.docks.procs_open;
    // Tailwind's `animate-pulse`: down to half and back every two seconds. A cosine stands in for its ease.
    let dot = if running > 0 {
        ui.ctx().request_repaint_after(Duration::from_millis(50));
        GREEN_400.gamma_multiply(0.75 + 0.25 * (ui.input(|i| i.time) * std::f64::consts::PI).cos() as f32)
    } else {
        p.muted
    };
    let (label, tip) = if running > 0 { (format!("{running} running"), format!("{running} running in the background")) } else { ("Stopped".to_string(), "Recently finished processes".to_string()) };
    let chip = chip(ui, Lead::Dot(dot), &label, running > 0, open, None).on_hover_text(tip);
    if chip.clicked() {
        app.ws.docks.procs_open = !open;
    }
    let mut stop: Vec<&ProcInfo> = Vec::new();
    let ctx = ui.ctx().clone();
    let st = &mut app.ws.docks;
    let shut = popover(&ctx, "process-dock", chip.rect, 416.0, st.procs_open, |ui| {
        let danger = alpha(p.danger, 40.0);
        let stop_all = (running > 0).then(|| card_btn("Stop all").ink(p.danger, p.danger).fill(Color32::TRANSPARENT, alpha(p.danger, 10.0)).border(danger, danger));
        if head(ui, "Background processes", "Servers and leftover Ghidra from a closed tab", stop_all, true) {
            stop = list.iter().filter(|proc| proc.exit.is_none()).collect();
        }
        egui::ScrollArea::vertical().id_salt("process-dock-list").max_height((ctx.content_rect().height() * 0.6).min(416.0)).show(ui, |ui| {
            ui.add_space(6.0);
            for proc in &list {
                let alive = proc.exit.is_none();
                let output = proc.log_tail.trim();
                let unfolded = st.expanded.as_deref() == Some(proc.id.as_str());
                // The row is as tall as the tallest thing on it: Stop, then the Output switch, then the words.
                let tall = if alive { 22.5 } else if output.is_empty() { 18.0 } else { 20.5 };
                ui.add_space(6.0);
                let (line, _) = ui.allocate_exact_size(vec2(ui.available_width(), tall), Sense::hover());
                let line = line.shrink2(vec2(14.0, 0.0));
                ui.painter().circle_filled(pos2(line.left() + 3.0, line.center().y), 3.0, if alive { GREEN_400 } else { p.muted });
                let mut row = ui.new_child(egui::UiBuilder::new().max_rect(line).layout(egui::Layout::right_to_left(egui::Align::Center)));
                row.spacing_mut().item_spacing.x = 8.0;
                if alive {
                    if Btn::outline("Stop").text(11.0, 16.5).weight(W::Regular).pad(8.0, 2.0).fill(Color32::TRANSPARENT, Color32::TRANSPARENT).ink(p.text2, p.danger).border(p.border, danger).show(&mut row).clicked() {
                        stop.push(proc);
                    }
                } else {
                    let how = if st.stopped.contains(&proc.id) { "stopped".to_string() } else { format!("exit {}", proc.exit.unwrap_or_default()) };
                    let words = widgets::galley(&row, &how, theme::font(11.0, W::Regular), p.muted);
                    let (at, _) = row.allocate_exact_size(words.size(), Sense::hover());
                    row.painter().galley(at.min, words, p.muted);
                }
                if !output.is_empty() && Btn::ghost(if unfolded { "Hide" } else { "Output" }).text(11.0, 16.5).pad(6.0, 2.0).radius(4.0).show(&mut row).clicked() {
                    st.expanded = (!unfolded).then(|| proc.id.clone());
                }
                let name = Rect::from_min_max(pos2(line.left() + 14.0, line.top()), pos2(row.min_rect().left() - 8.0, line.bottom()));
                widgets::text_at(ui, name.left(), name.center().y, widgets::clipped(ui, &proc.display, theme::mono(12.0), p.text2, name.width()));
                ui.interact(name, ui.id().with(("command", &proc.id)), Sense::hover()).on_hover_text(proc.display.as_str());
                if unfolded {
                    ui.add_space(6.0);
                    egui::Frame::new().fill(p.bg).stroke(Stroke::new(1.0, p.border)).corner_radius(8).inner_margin(egui::Margin::same(8)).outer_margin(egui::Margin::symmetric(14, 0)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        // 192 at most, its padding and border included.
                        egui::ScrollArea::both().id_salt(("output", &proc.id)).max_height(174.0).show(ui, |ui| {
                            let words = if output.is_empty() { "(no output)" } else { output };
                            ui.add(egui::Label::new(widgets::lines(words, 11.0, 17.875, W::Regular, p.text2).font(theme::mono(11.0))).extend());
                        });
                    });
                }
                ui.add_space(6.0);
            }
            ui.add_space(6.0);
        });
    });
    // Stopped off the window's thread: `taskkill` takes a moment, and the row turns to "stopped" when the process is gone.
    for proc in stop {
        let pid = proc.pid;
        std::thread::spawn(move || exec::kill_tree(pid));
        st.stopped.insert(proc.id.clone());
        // What it was writing is final now.
        app.files_stale = true;
    }
    if shut {
        st.procs_open = false;
    }
}
