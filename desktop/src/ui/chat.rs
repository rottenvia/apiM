//! The conversation column: header, transcript, the wait rows under it.
//! The frame of src/components/ChatArea.tsx.

use super::theme::{self, W, mix, p};
use super::widgets;
use super::lazy::{self, Measured};
use super::{App, Dialog, bubble, composer, icons, markdown};
use crate::store::{Bucket, Message, Part, Role};
use eframe::egui::{self, Color32, Rect, Sense, Stroke, pos2, vec2};
use std::time::{Duration, Instant};

/// `toLocaleString()` for whole numbers: 1,234,567.
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub fn format_cost(usd: f64) -> String {
    if usd < 0.01 {
        format!("${usd:.4}")
    } else if usd < 1.0 {
        format!("${usd:.3}")
    } else {
        format!("${usd:.2}")
    }
}

pub fn format_duration(ms: u64) -> String {
    let seconds = ms as f64 / 1000.0;
    if ms < 1000 {
        format!("{ms}ms")
    } else if seconds < 60.0 {
        format!("{seconds:.1}s")
    } else {
        format!("{}m {}s", (seconds / 60.0).floor(), (seconds % 60.0).round())
    }
}

/// What a whole chat has used.
#[derive(Default, Clone, Copy)]
pub struct Totals {
    pub tokens: u64,
    pub cost: f64,
    pub ms: u64,
    /// Replies whose price is known.
    pub priced: u32,
    /// Questions asked.
    pub messages: usize,
}

/// A label whose colour sweeps like the web app's `.thinking-shimmer`.
pub fn shimmer(ui: &egui::Ui, text: &str, size: f32) -> egui::text::LayoutJob {
    let p = p();
    let dim = mix(p.thinking, 55.0, p.muted);
    let bright = mix(p.thinking, 65.0, Color32::WHITE);
    let time = ui.input(|i| i.time);
    // The band crosses the text once every 1.5s, right to left like the CSS.
    let centre = 1.5 - (time % 1.5) / 1.5 * 2.0;
    let count = text.chars().count().max(1) as f64;
    let mut job = egui::text::LayoutJob::default();
    for (i, ch) in text.chars().enumerate() {
        let x = i as f64 / count;
        let near = (1.0 - ((x - centre).abs() / 0.3)).clamp(0.0, 1.0) as f32;
        let format = egui::TextFormat { font_id: theme::font(size, W::Regular), color: dim.lerp_to_gamma(bright, near), line_height: Some(20.0), ..Default::default() };
        job.append(&ch.to_string(), 0.0, format);
    }
    ui.ctx().request_repaint();
    job
}

pub fn header(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    ui.spacing_mut().item_spacing.x = 4.0;
    let tip = if app.settings.sidebar_open { "Close sidebar" } else { "Open sidebar" };
    if widgets::icon_btn(ui, icons::SIDEBAR_LEFT, tip).clicked() {
        app.settings.sidebar_open = !app.settings.sidebar_open;
        app.settings.save();
    }
    if !app.settings.sidebar_open && widgets::icon_btn(ui, icons::PLUS.stroke(1.6), "New chat").clicked() {
        app.new_chat();
    }
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let tip = if app.fullscreen { "Exit full screen" } else { "Full screen" };
        if widgets::icon_btn(ui, if app.fullscreen { icons::FULLSCREEN_EXIT } else { icons::FULLSCREEN }, tip).clicked() {
            app.fullscreen = !app.fullscreen;
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Fullscreen(app.fullscreen));
        }
        if widgets::icon_btn(ui, icons::FIND, "Find in this chat (Ctrl+F)").clicked() {
            app.find_open = !app.find_open;
        }
        if !app.settings.workspace_open && widgets::icon_btn(ui, icons::PANEL_RIGHT, "Show the workspace panel").clicked() {
            app.settings.workspace_open = true;
            app.files_stale = true;
            app.settings.save();
        }
        super::docks::header(app, ui);
        let totals = app.totals();
        if totals.priced > 0 {
            ui.add_space(4.0);
            ui.label(widgets::text(format_cost(totals.cost), 11.0, W::Regular, p.muted)).on_hover_text("What this chat has cost so far, estimated from published rates — the full breakdown is at the top of the conversation");
        }
    });
}

pub fn messages(app: &mut App, ui: &mut egui::Ui) {
    let area = ui.max_rect();
    super::find_bar::show(app, ui, area);
    if app.conv.messages.is_empty() {
        welcome(app, ui);
        return;
    }
    let p = p();
    let running = app.running_here();
    let gutter = if area.width() >= 640.0 { 24.0 } else { 16.0 };
    let column = (area.width() - gutter * 2.0).min(composer::column_width(ui, app.fullscreen));
    let left = area.left() + (area.width() - column) / 2.0;
    let totals = app.totals();
    let mut action = None;
    // Going to the end of a chat takes two steps when it was just opened: its last messages are measured out of
    // sight first (over as many frames as that needs), then one more pass lands on the end they turned out to have.
    let jump = std::mem::take(&mut app.jump_to_latest);
    let landing = jump && std::mem::take(&mut app.tail_measured);

    // Find in this chat: how many matches each message holds, and which of them is the focused one.
    // ponytail: counted again every frame the bar is open; cache per (chat, query) if a long chat stutters.
    let matcher = if app.find_open { crate::find::Matcher::new(&app.find, app.finder.whole_word) } else { None };
    let counts: Vec<usize> = matcher.as_ref().map_or(Vec::new(), |m| app.conv.messages.iter().map(|msg| if msg.note { 0 } else { m.ranges(&msg.text()).len() }).collect());
    let total: usize = counts.iter().sum();
    app.finder.active = app.finder.active.min(total.saturating_sub(1));
    let located = crate::find::locate(&counts, app.finder.active);
    // Not on the frame that jumps to the end: the two would pull the view apart.
    let reveal = !jump && std::mem::take(&mut app.finder.reveal) && located.is_some();
    if app.finder.total != total {
        app.finder.total = total;
        ui.ctx().request_repaint();
    }

    // Only the newest messages are laid out; a search shows everything from its first match on.
    let hidden = app.conv.messages.len().saturating_sub(app.mounted);
    let start = counts.iter().position(|n| *n > 0).map_or(hidden, |first| first.min(hidden));
    let mut more = false;

    // Each chat keeps its own place, and a chat opened for the first time starts at its end.
    let mut scroll = egui::ScrollArea::vertical().id_salt(("transcript", &app.conv.id)).auto_shrink(false).stick_to_bottom(true);
    // Heights measured out of sight last frame are taken up now. Where a message sat above the window the view
    // moves by as much as it changed, so what is on screen stays where it is.
    let mut shift = std::mem::take(&mut app.anchor);
    for m in app.heights.values_mut() {
        if let Some(next) = m.next.take() {
            if m.above {
                shift += next - m.height;
            }
            m.height = next;
        }
    }
    if app.staged("top") {
        scroll = scroll.vertical_scroll_offset(0.0);
    } else if jump {
        // Past the end: clamped to it, and the view then follows the reply as it grows.
        scroll = scroll.vertical_scroll_offset(1e9);
    } else if shift != 0.0 {
        scroll = scroll.vertical_scroll_offset((app.scroll_y + shift).max(0.0));
    }
    // What this frame may spend measuring messages nobody is looking at. A chat just opened gets more: nothing
    // of it shows until its end is measured.
    app.rows.begin(Duration::from_millis(if landing { 0 } else if jump { 12 } else { 4 }));
    // (how far the view has to follow next frame, lay this frame out again before showing it, more to measure, the end is measured)
    let (mut anchor, mut redo, mut unmeasured, mut tail_ready) = (0.0_f32, false, false, true);
    let out = scroll.show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.add_space(24.0);
        // `unseen` lays it out without drawing it, to learn its height.
        let column_in = |ui: &mut egui::Ui, unseen: bool, add: &mut dyn FnMut(&mut egui::Ui)| {
            let top = ui.cursor().top();
            let rect = Rect::from_min_size(pos2(left, top), vec2(column, 0.0));
            let builder = egui::UiBuilder::new().max_rect(rect.with_max_y(f32::INFINITY));
            let used = ui.scope_builder(if unseen { builder.invisible() } else { builder }, |ui| {
                ui.set_width(column);
                add(ui);
            });
            ui.advance_cursor_after_rect(Rect::from_min_max(pos2(area.left(), top), pos2(area.right(), used.response.rect.bottom())));
        };
        let column_ui = |ui: &mut egui::Ui, add: &mut dyn FnMut(&mut egui::Ui)| column_in(ui, false, add);

        if totals.tokens > 0 {
            column_ui(ui, &mut |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;
                    let small = |text: String, colour| widgets::lines(text, 11.0, 16.0, W::Regular, colour);
                    ui.label(widgets::lines("This conversation", 11.0, 16.0, W::Medium, p.text2));
                    ui.label(small(format!("{} tokens", thousands(totals.tokens)), p.muted));
                    if totals.priced > 0 {
                        ui.label(small(format_cost(totals.cost), p.muted)).on_hover_text("Estimated from the models used");
                    }
                    if totals.ms > 0 {
                        ui.label(small(format_duration(totals.ms), p.muted)).on_hover_text("Total time spent generating");
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(small(format!("{} messages", totals.messages), p.muted));
                    });
                });
                ui.add_space(12.0);
                widgets::rule(ui);
                ui.add_space(20.0);
            });
        }

        let last = app.conv.messages.len() - 1;
        let workspace = app.conv.workspace();
        // The line under the last message a manual /compact covered.
        let compacted = app.conv.summary.as_ref().filter(|s| s.manual).map(|s| (s.up_to_id.clone(), s.covered_turns));
        let has_output = app.conv.messages.last().is_some_and(|m| m.role == Role::Assistant && (!m.loose_reasoning.trim().is_empty() || m.parts.iter().any(|part| matches!(part, Part::Text(text) | Part::Thinking { text, .. } if !text.trim().is_empty()))));
        // Until something comes back the rows sit close together (`space-y-1`), then at the usual 24.
        let gap = if running && !has_output { 4.0 } else { 24.0 };
        if start > 0 {
            column_ui(ui, &mut |ui| more = earlier_pill(ui, start));
            ui.add_space(8.0 + gap);
        }

        let App { conv, heights, rows, typed, run, settings, editing, rewind, .. } = app;
        let (plan, rewind) = (conv.plan.as_ref(), rewind.as_ref());
        // Bubbles stop at three quarters of the column; a narrow window gives them a little more.
        let cap = column * if ui.ctx().content_rect().width() < 768.0 { 0.85 } else { 0.75 };
        let thinking_secs = run.as_ref().and_then(|r| r.thinking.secs());
        let split = settings.reply_layout == "split";
        // A message with matches is laid out differently, so it is measured apart.
        fn key_for(hits: usize, msg: &Message) -> std::borrow::Cow<'_, str> {
            if hits > 0 { format!("{}#find", msg.id).into() } else { msg.id.as_str().into() }
        }
        let key_of = |i: usize, msg| key_for(counts.get(i).copied().unwrap_or(0), msg);
        // What a message's height hangs on besides its width.
        let print_of = |i: usize, msg: &Message| lazy::print((running, i == last, msg.parts.len(), msg.incomplete, msg.error.is_some(), split));
        // Messages still to be measured are measured out of sight, the four nearest the end first: reading starts there.
        let pending: Vec<usize> = (start..=last).rev().filter(|&i| !heights.get(key_of(i, &conv.messages[i]).as_ref()).is_some_and(|m| m.exact && m.width == column && m.print == print_of(i, &conv.messages[i]))).take(if landing { 0 } else { 4 }).collect();
        for (i, msg) in conv.messages.iter().enumerate().skip(start) {
            let live = running && i == last;
            let hits = counts.get(i).copied().unwrap_or(0);
            let focused = located.filter(|at| at.0 == i).map(|at| at.1);
            let wanted = reveal && focused.is_some();
            let (key, print) = (key_of(i, msg), print_of(i, msg));
            let known = heights.get(key.as_ref()).copied();
            let exact = known.is_some_and(|m| m.exact && m.width == column && m.print == print);
            let room = known.map_or_else(|| guess(msg, cap), |m| m.height);
            let rect = Rect::from_min_size(ui.cursor().min, vec2(area.width(), room));
            // On the frame that jumps to the end nothing is where it will be, so nothing counts as showing.
            let shows = !jump && (live || wanted || ui.is_rect_visible(rect));
            if !shows && (exact || !(pending.contains(&i) && rows.has_time())) {
                // Off screen: it keeps its room. One not measured yet waits its turn at the height it had, or a guess.
                ui.allocate_space(rect.size());
                unmeasured |= !exact;
            } else {
                let top = ui.cursor().top();
                rows.guessed = false;
                let mut marks = matcher.as_ref().filter(|_| hits > 0).map(|matcher| markdown::Marks { matcher, active: focused, seen: 0, reveal: wanted, shown: false });
                column_in(ui, !shows, &mut |ui| {
                    let mut env = bubble::Env { settings, workspace: &workspace, live, newest: i == last, busy: running, cap, thinking_secs, editing, action: &mut action, plan, rewind, marks: marks.take(), rows, typed };
                    ui.push_id(&msg.id, |ui| bubble::show(ui, msg, &mut env));
                    marks = env.marks.take();
                });
                let height = ui.cursor().top() - top;
                if shows {
                    // The match sits where nothing marks it (inside code): show its message at least.
                    if wanted && !marks.is_some_and(|m| m.shown) {
                        ui.scroll_to_rect(Rect::from_min_max(pos2(left, top), pos2(left + column, top + height)), Some(egui::Align::Center));
                    }
                    // It came into view from above at a height that was only a guess: what is under it must not jump.
                    if !exact && !live && rect.top() < ui.clip_rect().top() && (height - room).abs() > 0.5 {
                        anchor += height - room;
                        redo = true;
                    }
                    heights.insert(key.into_owned(), Measured { width: column, height, print, exact: true, next: None, above: false });
                } else {
                    // Measured out of sight. It keeps the room it had for this frame; the next one takes the new height up.
                    ui.add_space(room - height);
                    heights.insert(key.into_owned(), Measured { width: column, height: room, print, exact: !rows.guessed, next: Some(height), above: rect.bottom() <= ui.clip_rect().top() });
                    unmeasured = true;
                }
            }
            if i + 3 > last {
                tail_ready &= heights.get(key_of(i, msg).as_ref()).is_some_and(|m| m.exact);
            }
            match compacted.as_ref().filter(|(id, _)| *id == msg.id && !live) {
                Some((_, turns)) => {
                    let text = format!("Context compacted{}", turns.filter(|n| *n > 0).map_or(String::new(), |n| format!(" · {n} messages summarised")));
                    ui.add_space(gap.max(16.0));
                    column_ui(ui, &mut |ui| divider(ui, &text, "Everything above is summarised for the model. It sees the summary plus what comes after this line."));
                    ui.add_space(16.0);
                }
                None => ui.add_space(gap),
            }
        }

        // Whatever the reply is waiting on the user for sits right under it, at its width.
        if running {
            let mut asked = false;
            column_ui(ui, &mut |ui| {
                super::markdown::indented(ui, 16.0, |ui| {
                    ui.set_max_width(cap - 32.0);
                    asked = super::prompts::show(app, ui);
                });
            });
            if asked {
                ui.add_space(24.0);
            }
        }
        if let Some(run) = app.run.as_ref().filter(|_| running) {
            column_ui(ui, &mut |ui| wait_rows(ui, run, has_output));
        }
        ui.add_space(24.0);
    });
    if more {
        app.mounted += 60;
    }
    app.scroll_y = out.state.offset.y;
    app.anchor = anchor;
    if jump && !landing {
        // Jump again: to go on measuring its end, or, with that done, to land on it.
        app.jump_to_latest = true;
        app.tail_measured = tail_ready;
    }
    if redo || landing || (jump && tail_ready) {
        // This pass put things where they will not stay (or nowhere at all): it is laid out again before anyone sees it.
        ui.ctx().request_discard("the transcript settled");
    }
    if unmeasured || jump {
        ui.ctx().request_repaint();
    }
    opening_pill(app, ui, area);

    // Jump to latest: only when scrolled away from the end.
    let distance = out.content_size.y - out.state.offset.y - out.inner_rect.height();
    if distance > 40.0 {
        let centre = pos2(area.center().x, area.bottom() - 12.0 - 17.0);
        let rect = Rect::from_center_size(centre, vec2(34.0, 34.0));
        let response = ui.interact(rect, ui.id().with("jump"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        let t = widgets::fade(ui, response.id, response.hovered());
        ui.painter().add(egui::Shadow { offset: [0, 6], blur: 20, spread: 0, color: Color32::from_black_alpha(102) }.as_shape(rect, egui::CornerRadius::same(17)));
        ui.painter().circle(centre, 17.0, widgets::lerp(p.elevated, p.hover, t), Stroke::new(1.0, p.border_light));
        icons::paint(ui, icons::ARROW_DOWN, centre, 16.0, widgets::lerp(p.text2, p.text, t));
        if response.clicked() {
            app.jump_to_latest = true;
        }
    }

    match action {
        Some(bubble::Action::Retry) => app.retry(ui.ctx()),
        Some(bubble::Action::Resume) => {
            if let Err(why) = app.resume(ui.ctx(), String::new()) {
                app.toast(why);
            }
        }
        Some(bubble::Action::Copy(text)) => ui.ctx().copy_text(text),
        Some(bubble::Action::Link(url)) => ui.ctx().open_url(egui::OpenUrl::new_tab(url)),
        Some(bubble::Action::OpenCode(title, language, code)) => app.artifact = Some(super::overlay::Artifact { title, language, code, copied: None }),
        Some(bubble::Action::Image(name, uri)) => app.lightbox = Some((name, uri)),
        Some(bubble::Action::OpenFile(path)) => super::workspace::open(app, path),
        Some(bubble::Action::Delete(id)) => app.delete_exchange(&id),
        Some(bubble::Action::Edit(id, text)) => app.resend_edited(ui.ctx(), &id, text),
        Some(bubble::Action::Compare(id)) => app.compare = app.conv.messages.iter().find(|m| m.id == id).and_then(|m| super::compare::open(m.other.get("previousVersions"), &m.text(), &m.model)),
        Some(bubble::Action::RewindOpen(id)) => app.rewind_open(&id),
        Some(bubble::Action::Rewind(files)) => app.rewind_run(files),
        Some(bubble::Action::PlanUnblock) => app.edit_plan(false),
        Some(bubble::Action::PlanClear) => app.edit_plan(true),
        None => {}
    }
}

/// About the room a message never laid out will take: enough to place it until it is measured.
fn guess(msg: &Message, width: f32) -> f32 {
    let per_line = (width / 7.5).max(20.0);
    60.0 + msg
        .parts
        .iter()
        .map(|part| match part {
            Part::Text(text) => 15.0 + (text.len() as f32 / per_line).ceil() * 25.5,
            Part::Tool(_) => 31.0,
            Part::Thinking { .. } => 40.0,
            Part::Notice(_) => 32.0,
        })
        .sum::<f32>()
}

/// "Opening…" over the transcript, once the chat that was clicked has taken a moment to read from disk.
fn opening_pill(app: &App, ui: &mut egui::Ui, area: Rect) {
    let Some(opening) = app.opening.as_ref() else { return };
    let waited = opening.since.elapsed();
    if waited < Duration::from_millis(150) {
        ui.ctx().request_repaint_after(Duration::from_millis(150) - waited);
        return;
    }
    let p = p();
    let title = app.chats.iter().find(|c| c.id == opening.id).map_or("chat", |c| c.title.as_str());
    let short: String = if title.chars().count() > 36 { format!("{}…", title.chars().take(35).collect::<String>()) } else { title.to_string() };
    let label = ui.painter().layout_job(shimmer(ui, &format!("Opening {short}…"), 13.0));
    let rect = Rect::from_center_size(pos2(area.center().x, area.top() + 28.0), vec2(label.size().x + 28.0, 34.0));
    ui.painter().add(egui::Shadow { offset: [0, 6], blur: 20, spread: 0, color: Color32::from_black_alpha(102) }.as_shape(rect, egui::CornerRadius::same(17)));
    ui.painter().rect(rect, 17.0, p.elevated, Stroke::new(1.0, p.border_light), egui::StrokeKind::Inside);
    widgets::text_at(ui, rect.left() + 14.0, rect.center().y, label);
}

/// "Show 60 earlier of 212": older messages stay out of the layout until asked for. True when clicked.
fn earlier_pill(ui: &mut egui::Ui, hidden: usize) -> bool {
    let p = p();
    let mut text = format!("Show {} earlier", hidden.min(60));
    if hidden > 60 {
        text += &format!(" of {hidden}");
    }
    let label = widgets::galley(ui, &text, theme::font(12.0, W::Medium), Color32::WHITE);
    let (row, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
    let rect = Rect::from_center_size(row.center(), vec2(13.0 + 12.0 + 6.0 + label.size().x + 13.0, 30.0));
    let response = ui.interact(rect, ui.id().with("earlier"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect(rect, 15.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t), Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), egui::StrokeKind::Inside);
    let colour = widgets::lerp(p.text2, p.text, t);
    icons::paint(ui, icons::CHEVRON_UP.stroke(2.0), pos2(rect.left() + 13.0 + 6.0, rect.center().y), 12.0, colour);
    ui.painter().galley_with_override_text_color(pos2(rect.left() + 13.0 + 12.0 + 6.0, (rect.center().y - label.size().y / 2.0).round()), label, colour);
    response.clicked()
}

/// A rule across the column with a few words in its middle: "Context compacted".
pub fn divider(ui: &mut egui::Ui, text: &str, tip: &str) {
    let p = p();
    let room = ui.available_width();
    let label = widgets::clipped(ui, text, theme::font(11.0, W::Regular), p.muted, (room - 88.0).max(40.0));
    let (rect, response) = ui.allocate_exact_size(vec2(room, 16.5), Sense::hover());
    let (x, width) = (rect.center().x - label.size().x / 2.0, label.size().x);
    let line = Stroke::new(1.0, p.border);
    ui.painter().hline(egui::Rangef::new(rect.left() + 16.0, x - 12.0), rect.center().y, line);
    ui.painter().hline(egui::Rangef::new(x + width + 12.0, rect.right() - 16.0), rect.center().y, line);
    widgets::text_at(ui, x, rect.center().y, label);
    response.on_hover_text(tip);
}

/// 1234 is "1k", 812 is "812": sizes in the wait rows.
fn k(n: u64) -> String {
    if n >= 1000 { format!("{}k", (n as f64 / 1000.0).round()) } else { n.to_string() }
}

/// What a request carries, and its characters of text: "415k in (history 310k · tool results 96k) + media 2.0 MB".
fn describe_request(buckets: &[Bucket]) -> (u64, String) {
    let media: u64 = buckets.iter().filter(|b| b.label == "media").map(|b| b.chars).sum();
    let mut text: Vec<&Bucket> = buckets.iter().filter(|b| b.label != "media" && b.chars > 0).collect();
    let chars: u64 = text.iter().map(|b| b.chars).sum();
    text.sort_by(|a, b| b.chars.cmp(&a.chars));
    let top: Vec<String> = text.iter().take(2).map(|b| format!("{} {}", b.label, k(b.chars))).collect();
    let mut out = format!("{} in", k(chars));
    if !top.is_empty() {
        out += &format!(" ({})", top.join(" · "));
    }
    if media > 0 {
        // Media is counted in base64 characters: three bytes for every four.
        out += &format!(" + media {:.1} MB", media as f64 * 0.75 / 1048576.0);
    }
    (chars, out)
}

/// The lines under a reply that is still on its way (StatusRow, RetryBanner, RequestSizeLine, WaitRow
/// and DraftRow in ChatArea.tsx): "✻ Thinking… · 12s" and its kin.
fn wait_rows(ui: &mut egui::Ui, run: &super::Run, has_output: bool) {
    let p = p();
    let row = |ui: &mut egui::Ui, top: f32, add: &mut dyn FnMut(&mut egui::Ui)| {
        ui.add_space(top);
        ui.horizontal(|ui| {
            ui.add_space(16.0);
            ui.spacing_mut().item_spacing.x = 8.0;
            add(ui);
        });
        ui.add_space(8.0);
    };
    let mark = |ui: &mut egui::Ui| {
        ui.label(widgets::lines("✻", 13.0, 20.0, W::Regular, p.accent));
    };
    let small = |text: String, colour| widgets::lines(text, 11.0, 16.0, W::Regular, colour);
    let glow = |ui: &mut egui::Ui, text: String| {
        let job = shimmer(ui, &text, 13.0);
        ui.label(job);
    };
    // A failed request counts down to its next try.
    let retry = run.retry.as_ref().map(|(text, until)| format!("{text} in {}s", until.saturating_duration_since(Instant::now()).as_secs_f32().ceil()));
    let sent = run.request.as_ref().map(|r| (r, describe_request(&r.buckets)));
    let body = |r: &super::Round| r.buckets.iter().map(|b| format!("{} {}", b.label, k(b.chars))).collect::<Vec<_>>().join(" · ");
    let heavy = |chars: u64| if chars >= 400_000 { " — big context, first token may take a while" } else { "" };

    if !has_output {
        let stage = match run.status {
            "Writing" => "Writing",
            "Working" => "Working on your files",
            "Searching" => "Searching the web",
            _ => "Thinking",
        };
        row(ui, 8.0, &mut |ui| {
            mark(ui);
            // A retry takes the word's place rather than adding a line.
            match &retry {
                Some(text) => {
                    let said = ui.label(widgets::lines(text.as_str(), 13.0, 20.0, W::Regular, p.warning));
                    if let Some((r, _)) = &sent {
                        said.on_hover_text(format!("Request body: {}", body(r)));
                    }
                }
                None => glow(ui, format!("{stage}…")),
            }
            ui.label(widgets::text(format!("· {}s", run.started.elapsed().as_secs()), 11.0, W::Regular, p.muted));
        });
        if let Some((r, (chars, described))) = sent.as_ref().filter(|(_, (chars, _))| *chars >= 100_000) {
            row(ui, 4.0, &mut |ui| {
                let tip = format!("Request {} body: {}{}", r.number, body(r), if *chars >= 400_000 { "\nBig context — the first token can take a while" } else { "" });
                ui.label(small(format!("Request {} · {described}{}", r.number, heavy(*chars)), p.muted)).on_hover_text(tip);
            });
        }
        return;
    }
    if let Some(text) = retry {
        row(ui, 0.0, &mut |ui| {
            ui.label(small(text.clone(), p.warning));
        });
    }
    if let Some(draft) = run.drafting.as_ref().filter(|d| d.chars > 0) {
        let size = if draft.chars >= 1000 { format!("{:.1}k chars", draft.chars as f64 / 1000.0) } else { format!("{} chars", draft.chars) };
        row(ui, 0.0, &mut |ui| {
            mark(ui);
            glow(ui, format!("{}…", drafting_label(&draft.name, draft.path.as_deref())));
            ui.label(widgets::text(format!("· {size} · {}s", draft.since.elapsed().as_secs()), 11.0, W::Regular, p.muted));
        });
    } else if let Some((r, (chars, described))) = sent.as_ref().filter(|(r, _)| !r.answered) {
        row(ui, 0.0, &mut |ui| {
            mark(ui);
            glow(ui, "Waiting for the model…".into());
            ui.label(widgets::text(format!("· {}s · {described}{}", r.fired.elapsed().as_secs(), heavy(*chars)), 11.0, W::Regular, p.muted))
                .on_hover_text("The next round was sent. The provider is reading it (a big request can take a while) before the first token comes back.");
        });
    }
}

/// "Writing ui/chat.rs", "Preparing edits", "Planning": what a tool call still streaming in is doing.
fn drafting_label(name: &str, path: Option<&str>) -> String {
    // The last two parts of the path say which file without the whole way to it.
    let file = path.map(|p| p.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>()).filter(|parts| !parts.is_empty()).map(|parts| parts[parts.len().saturating_sub(2)..].join("/"));
    match (name, file) {
        ("write_file" | "write_files" | "create_file", Some(file)) => format!("Writing {file}"),
        ("write_file" | "write_files" | "create_file", None) => "Writing files".into(),
        ("edit_file" | "edit_files" | "replace_in_files", Some(file)) => format!("Editing {file}"),
        ("edit_file" | "edit_files" | "replace_in_files", None) => "Preparing edits".into(),
        (n, _) if n.contains("plan") => "Planning".into(),
        (n, _) => format!("Preparing {}", n.replace('_', " ")),
    }
}

fn welcome(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let area = ui.max_rect();
    let has_keys = crate::provider::resolve_target(&app.settings.model, &app.settings).is_ok();
    let width = (area.width() - 48.0).min(576.0);
    let heading = theme::serif(if area.width() >= 640.0 { 36.0 } else { 30.0 });
    let model = crate::models::resolve(&app.settings.model, &app.settings.custom_models);
    let provider = match model.provider {
        crate::models::ProviderId::Openrouter => "OpenRouter",
        crate::models::ProviderId::Local => "local server",
        crate::models::ProviderId::Deepseek => "DeepSeek",
    };
    let blurb = if has_keys {
        "Type a message below to start a conversation.".to_string()
    } else {
        format!("Connect a {provider} API key to start chatting. DeepSeek and OpenRouter both work. Your keys stay on this PC — nothing leaves this app except your requests.")
    };
    // Laid out once to learn the height, so the block sits centred (lifted 32, like the web's pb-16).
    let id = ui.id().with("welcome-height");
    let height: f32 = ui.data(|d| d.get_temp(id)).unwrap_or(200.0);
    let top = area.center().y - 32.0 - height / 2.0;
    let rect = Rect::from_min_size(pos2(area.center().x - width / 2.0, top.max(area.top())), vec2(width, area.height()));
    let used = ui.scope_builder(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::top_down(egui::Align::Center)), |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        ui.label(egui::RichText::new("How can I help you today?").font(heading).color(p.text).extra_letter_spacing(-0.3));
        ui.add_space(12.0);
        ui.add(egui::Label::new(widgets::lines(blurb, 14.0, 24.0, W::Regular, p.text2)).wrap().halign(egui::Align::Center));
        if has_keys {
            ui.add_space(28.0);
            let text = widgets::galley(ui, "Ask for a file and it gets written to disk.", theme::font(12.0, W::Regular), p.muted);
            let (pill, _) = ui.allocate_exact_size(vec2(14.0 + 16.0 + 10.0 + text.size().x + 14.0, 34.0), Sense::hover());
            ui.painter().rect_stroke(pill, 17.0, Stroke::new(1.0, p.border), egui::StrokeKind::Inside);
            icons::paint(ui, icons::FOLDER_PLAIN, pos2(pill.left() + 14.0 + 8.0, pill.center().y), 16.0, p.accent_light);
            widgets::text_at(ui, pill.left() + 14.0 + 16.0 + 10.0, pill.center().y, text);
        } else {
            ui.add_space(24.0);
            if widgets::btn_primary(ui, Some(icons::KEY), "Add API keys").clicked() {
                app.dialog = Dialog::Settings;
                app.settings_ui.tab = 0;
            }
        }
    });
    ui.data_mut(|d| d.insert_temp(id, used.response.rect.height()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_row_words() {
        let bucket = |label: &str, chars| Bucket { label: label.into(), chars };
        let request = [bucket("instructions", 9_400), bucket("history", 310_000), bucket("media", 2_800_000), bucket("tool results", 96_500), bucket("plugins", 0)];
        assert_eq!(describe_request(&request), (415_900, "416k in (history 310k · tool results 97k) + media 2.0 MB".into()));
        assert_eq!(describe_request(&[bucket("your message", 812)]), (812, "812 in (your message 812)".into()));
        assert_eq!(describe_request(&[]), (0, "0 in".into()));
        assert_eq!((k(999), k(1000), k(2500)), ("999".into(), "1k".into(), "3k".into()));

        assert_eq!(drafting_label("write_file", Some("desktop/src/ui/chat.rs")), "Writing ui/chat.rs");
        assert_eq!(drafting_label("edit_file", Some("main.rs")), "Editing main.rs");
        assert_eq!((drafting_label("write_files", None), drafting_label("replace_in_files", None)), ("Writing files".into(), "Preparing edits".into()));
        assert_eq!((drafting_label("make_plan", Some("x")), drafting_label("run_command", None)), ("Planning".into(), "Preparing run command".into()));
    }
}
