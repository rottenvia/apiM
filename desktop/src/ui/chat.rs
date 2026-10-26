//! The conversation column: header, transcript, the wait rows under it.
//! The frame of src/components/ChatArea.tsx.

use super::theme::{self, W, mix, p};
use super::widgets;
use super::lazy::{self, Measured};
use super::{App, Dialog, bubble, composer, icons, markdown};
use crate::store::{Bucket, Message, Part, Role};
use eframe::egui::{self, Color32, Rect, Sense, Stroke, pos2, vec2};

/// How long a chat takes to come in once it is on screen, and how far below its place it starts.
const ENTER: f32 = 0.2;
const ENTER_DROP: f32 = 10.0;
/// How long room a live reply gave up stays blank under it, for what comes next to fill (a thought's goes at once).
const FLOOR_HOLD: Duration = Duration::from_millis(600);
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
    widgets::tick(ui);
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
            app.toggle_fullscreen(ui.ctx());
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
        // The first cost of a chat fades in beside the files chip, which is changing its words just then.
        let priced = widgets::fade(ui, ui.id().with("cost-in"), totals.priced > 0);
        if priced > 0.0 {
            ui.add_space(4.0);
            ui.scope(|ui| {
                ui.multiply_opacity(priced);
                ui.label(widgets::text(format_cost(totals.cost), 11.0, W::Regular, p.muted)).on_hover_text("What this chat has cost so far, estimated from published rates — the full breakdown is at the top of the conversation");
            });
        }
    });
}

pub fn messages(app: &mut App, ui: &mut egui::Ui) {
    let area = ui.max_rect();
    super::find_bar::show(app, ui, area);
    let leaving = app.opening.as_ref().map_or(0.0, |opening| ((opening.since.elapsed().as_secs_f32() - 0.05) / 0.15).clamp(0.0, 1.0));
    if app.conv.messages.is_empty() {
        if app.opening.is_none() {
            app.arriving = None;
        }
        let come = widgets::entrance(ui.ctx(), *app.entered.get_or_insert_with(Instant::now), ENTER);
        ui.scope(|ui| {
            ui.set_opacity(come * (1.0 - 0.6 * leaving));
            welcome(app, ui, (1.0 - come) * ENTER_DROP);
        });
        opening_pill(app, ui, area);
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
    // A chat comes in from the moment it has landed: it fades up from a little below its place. The one being
    // left for a chat still on its way from disk dims meanwhile, so the click is seen to have been taken.
    if !jump {
        if app.opening.is_none() {
            app.arriving = None;
        }
        app.entered.get_or_insert_with(Instant::now);
    }
    let come = app.entered.map_or(0.0, |at| widgets::entrance(ui.ctx(), at, ENTER));
    // Messages just sent come in the same way, under the ones that were there.
    let fresh = app.fresh.as_ref().and_then(|(id, at)| Some((app.conv.messages.iter().position(|m| m.id == *id)?, widgets::entrance(ui.ctx(), *at, 0.25))));
    if fresh.is_none_or(|(_, come)| come >= 1.0) {
        app.fresh = None;
    }

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
    let mut scroll = egui::ScrollArea::vertical().id_salt(("transcript", &app.conv.id)).auto_shrink(false);
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
    } else if landing {
        // Past the end: clamped to it, and the view then follows the reply as it grows. Only now, with the end
        // measured, and only as far past as the heights just taken up could have added. Every frame of a jump
        // used to be laid out a thousand million points down, where a float steps 64 points at a time: each
        // message measured there came out some multiple of 64 tall, and the chat landed short of its end by
        // however much that was wrong, to be put right a frame later.
        scroll = scroll.vertical_scroll_offset(app.scroll_end + 100_000.0);
    } else if shift != 0.0 && !jump {
        scroll = scroll.vertical_scroll_offset((app.scroll_y + shift).max(0.0));
    }
    // Following the end, the view glides onto it rather than stepping a line at a time (`widgets::Follow`). egui's
    // own sticking jumped by each line a reply wrapped onto, and showed it cut off under the edge first.
    let glide = app.at_end && !jump && !landing && shift == 0.0 && !app.staged("top");
    let forced = glide.then(|| app.follow.step(app.scroll_y, ui.input(|i| i.stable_dt)));
    if let Some(offset) = forced {
        scroll = scroll.vertical_scroll_offset(offset);
    }
    // What this frame may spend measuring messages nobody is looking at. A chat just opened gets more: nothing
    // of it shows until its end is measured.
    // of it shows until its end is measured, so one longer frame there is cheaper than several empty ones.
    app.rows.begin(Duration::from_millis(if landing { 0 } else if jump { 28 } else { 4 }));
    // (how far the view has to follow next frame, lay this frame out again before showing it, more to measure, the end is measured)
    let (mut anchor, mut redo, mut unmeasured, mut tail_ready) = (0.0_f32, false, false, true);
    let mut tall = 0.0;
    // A thought that folds gives its room back as it shuts, the chat following its end down with it: one shut by
    // hand (a click in the transcript) and one the reply shuts as its step or its words come. Held, a thought shut
    // under the reply's end left its height of blank there for 0.6 s and then glided back, a second after the fold.
    if ui.input(|i| i.pointer.any_click() && i.pointer.interact_pos().is_some_and(|at| area.contains(at))) {
        app.floor_free = Some(Instant::now());
    }
    let folding = app.runs.iter().find(|r| r.conv_id == app.conv.id).and_then(|r| r.folded);
    let free = [app.floor_free, folding].into_iter().flatten().any(|at| at.elapsed().as_secs_f32() < widgets::FOLD + 0.1);
    let out = scroll.show(ui, |ui| {
        let content_top = ui.cursor().top();
        // Where the last message starts: the room kept under a live reply is its own (below).
        let mut last_top = content_top;
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.set_opacity(come * (1.0 - 0.6 * leaving));
        // The room it gives up above its place comes off the room below it: the whole is as tall as ever.
        ui.add_space(24.0 + (1.0 - come) * ENTER_DROP);
        // `unseen` lays it out without drawing it, to learn its height. `come` under 1 draws it that far into its
        // entrance, fainter and lower than its place; the room it takes is the same.
        let column_in = |ui: &mut egui::Ui, unseen: bool, come: f32, add: &mut dyn FnMut(&mut egui::Ui)| {
            let (top, drop) = (ui.cursor().top(), (1.0 - come) * 14.0);
            let rect = Rect::from_min_size(pos2(left, top + drop), vec2(column, 0.0));
            let builder = egui::UiBuilder::new().max_rect(rect.with_max_y(f32::INFINITY));
            let used = ui.scope_builder(if unseen { builder.invisible() } else { builder }, |ui| {
                ui.set_width(column);
                if come < 1.0 {
                    ui.multiply_opacity(come);
                }
                add(ui);
            });
            ui.advance_cursor_after_rect(Rect::from_min_max(pos2(area.left(), top), pos2(area.right(), used.response.rect.bottom() - drop)));
        };
        let column_ui = |ui: &mut egui::Ui, add: &mut dyn FnMut(&mut egui::Ui)| column_in(ui, false, 1.0, add);

        // The chat's totals come with its first reply's first count of tokens. Their room is there from the moment a
        // reply runs, and the words fade in when the count comes: arriving then, they pushed the whole of a new chat
        // down mid-reply. Keyed by the chat's first message, so the room is simply there in the frame it is sent.
        let first = app.conv.messages.first().map_or("", |m| m.id.as_str());
        let totals_shown = widgets::opened(ui, egui::Id::new(("totals", first)), totals.tokens > 0 || running);
        let counted = widgets::opened(ui, egui::Id::new(("totals-count", first)), totals.tokens > 0);
        if totals_shown > 0.0 {
            column_ui(ui, &mut |ui| widgets::unfold(ui, egui::Id::new(("totals-strip", &app.conv.id)), totals_shown, |ui| {
                ui.horizontal(|ui| {
                    ui.multiply_opacity(counted);
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
                        ui.label(small(format!("{} message{}", totals.messages, if totals.messages == 1 { "" } else { "s" }), p.muted));
                    });
                });
                ui.add_space(12.0);
                widgets::rule(ui);
                ui.add_space(20.0);
            }));
        }

        let last = app.conv.messages.len() - 1;
        let workspace = app.conv.workspace();
        // The line under the last message a manual /compact covered.
        let compacted = app.conv.summary.as_ref().filter(|s| s.manual).map(|s| (s.up_to_id.clone(), s.covered_turns));
        let has_output = app.conv.messages.last().is_some_and(|m| m.role == Role::Assistant && (!m.loose_reasoning.trim().is_empty() || m.parts.iter().any(|part| matches!(part, Part::Text(text) | Part::Thinking { text, .. } if !text.trim().is_empty()))));
        // The same 24 while a reply waits for its first words. It was 4 then (`space-y-1`), every gap in the chat at
        // once: the chat drew together on each send and apart at the first word, the reply 20 points down in a frame.
        let gap = 24.0;
        if start > 0 {
            column_ui(ui, &mut |ui| more = earlier_pill(ui, start));
            ui.add_space(8.0 + gap);
        }

        let App { conv, heights, rows, runs, settings, editing, rewind, .. } = app;
        let run = runs.iter().find(|r| r.conv_id == conv.id);
        // What a live reply is doing is said under it, as far from it as a step is from the text before it: a
        // reply that ends in text keeps room of its own under its last line, one that is only its label has none.
        // A question to the user keeps its distance.
        let asking = run.is_some_and(|r| r.approval.is_some() || r.question.is_some());
        let tail_gap = if !running || asking { gap } else if has_output { 6.0 } else { 18.0 };
        let rewind = rewind.as_ref();
        // Bubbles stop at three quarters of the column; a narrow window gives them a little more.
        let cap = column * if ui.ctx().content_rect().width() < 768.0 { 0.85 } else { 0.75 };
        // A thought's clock goes on from the line before it ("Thinking… · 4s" became "Thinking · 0s"): the round's.
        let thinking_secs = run.map(|r| r.request.as_ref().filter(|q| q.number > 1).map_or(r.started, |q| q.fired).elapsed().as_secs());
        let drafted = run.map(super::Run::drafted).unwrap_or_default();
        let split = settings.reply_layout == "split";
        // A message with matches is laid out differently, so it is measured apart.
        fn key_for(hits: usize, msg: &Message) -> std::borrow::Cow<'_, str> {
            if hits > 0 { format!("{}#find", msg.id).into() } else { msg.id.as_str().into() }
        }
        let key_of = |i: usize, msg| key_for(counts.get(i).copied().unwrap_or(0), msg);
        // What a message's height hangs on besides its width.
        let print_of = |i: usize, msg: &Message| lazy::print((running, i == last, msg.parts.len(), msg.incomplete, msg.error.is_some(), split));
        // Messages still to be measured are measured out of sight, the four nearest the end first: reading starts there.
        // The end of a chat can be landed on once every message that will be in view there is measured. With
        // only its last three measured, a fourth in view changed height as it was drawn, and the chat was seen
        // for a frame some way short of its end before it moved there.
        let mut view = area.height();
        let in_view = (start..=last)
            .rev()
            .take_while(|&i| {
                let wanted = view > 0.0;
                view -= gap + heights.get(key_of(i, &conv.messages[i]).as_ref()).map_or_else(|| guess(&conv.messages[i], cap), |m| m.next.unwrap_or(m.height));
                wanted
            })
            .last()
            .unwrap_or(last);
        // Messages still to be measured are measured out of sight, the four nearest the end first: reading starts
        // there. On the way to the end only those that will show there are, and the rest once it has landed:
        // measured oldest first with the others, the one message in view of a chat of long replies waited for
        // twenty-three that were not, and the window stood empty for two seconds.
        let unmeasured_yet = |i: &usize| !heights.get(key_of(*i, &conv.messages[*i]).as_ref()).is_some_and(|m| m.exact && m.width == column && m.print == print_of(*i, &conv.messages[*i]));
        let pending: Vec<usize> = (if jump { in_view } else { start }..=last).rev().filter(unmeasured_yet).take(if landing { 0 } else if jump { usize::MAX } else { 4 }).collect();
        for (i, msg) in conv.messages.iter().enumerate().skip(start) {
            if i == last {
                last_top = ui.cursor().top();
            }
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
                column_in(ui, !shows, fresh.filter(|(from, _)| i >= *from).map_or(1.0, |(_, come)| come), &mut |ui| {
                    let mut env = bubble::Env { settings, workspace: &workspace, live, newest: i == last, busy: running, cap, thinking_secs, drafted: &drafted, editing, action: &mut action, rewind, marks: marks.take(), rows };
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
            if i >= in_view {
                tail_ready &= heights.get(key_of(i, msg).as_ref()).is_some_and(|m| m.exact);
            }
            match compacted.as_ref().filter(|(id, _)| *id == msg.id && !live) {
                Some((_, turns)) => {
                    let text = format!("Context compacted{}", turns.filter(|n| *n > 0).map_or(String::new(), |n| format!(" · {n} messages summarised")));
                    ui.add_space(gap.max(16.0));
                    column_ui(ui, &mut |ui| divider(ui, &text, "Everything above is summarised for the model. It sees the summary plus what comes after this line."));
                    ui.add_space(16.0);
                }
                None => ui.add_space(if i == last { tail_gap } else { gap }),
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
        if let Some(run) = app.runs.iter().find(|r| r.conv_id == app.conv.id) {
            column_ui(ui, &mut |ui| wait_rows(ui, run, has_output));
        }
        ui.add_space(24.0 - (1.0 - come) * ENTER_DROP);
        // Room a live reply gave up stays, blank, under it for a moment (not a thought's: `free` above). Kept until the
        // reply grew into it, the wait on the model that follows a step showed the reply's last line a folded
        // thought's height above the box, the box under blank for as long as the model took. Only the reply's
        // own room: kept for the whole transcript, the guessed heights of a long chat's older messages, measured
        // smaller as the reply ran, left a screen of blank under it, the view at its end and the question above.
        tall = ui.cursor().top() - last_top;
        if !free {
            ui.add_space((app.floor - tall).max(0.0));
        }
    });
    if free {
        app.floor = if running { tall } else { 0.0 };
        app.floor_since = None;
    } else if app.floor <= tall {
        if running {
            app.floor = tall;
        }
        app.floor_since = None;
    } else {
        let since = *app.floor_since.get_or_insert_with(Instant::now);
        match FLOOR_HOLD.checked_sub(since.elapsed()).filter(|_| running) {
            Some(left) => ui.ctx().request_repaint_after(left),
            None => {
                // Then the room goes, gliding, as it does once the reply is done: kept, a chat ended in blank space
                // until the next message was sent.
                let k = (ui.input(|i| i.stable_dt) * 12.0).min(1.0);
                app.floor = if app.floor - tall < 0.5 { 0.0 } else { app.floor - (app.floor - tall) * k };
                ui.ctx().request_repaint();
            }
        }
    }
    if more {
        app.mounted += 60;
    }
    let distance = out.content_size.y - out.state.offset.y - out.inner_rect.height();
    // A wheel or the bar took the view up from where it was put: it stops following. Otherwise it goes on, also
    // through a frame that moved it for heights changed above, and catches up from wherever that left it.
    let taken = forced.is_some_and(|offset| out.state.offset.y < offset.min(out.content_size.y - out.inner_rect.height()) - 1.0);
    app.at_end = if app.at_end && !jump && !landing && !taken { true } else { distance <= 1.0 };
    app.follow.left(if app.at_end { distance } else { 0.0 });
    if app.follow.lag > 0.0 {
        ui.ctx().request_repaint();
    }
    app.scroll_end = out.content_size.y;
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
    // It comes up into its place when the end is left behind, and sinks away when the end is back in view.
    let away = ui.ctx().animate_bool_with_time_and_easing(ui.id().with("jump-in"), distance > 40.0 && !jump && !app.at_end, 0.18, egui::emath::easing::cubic_out);
    if away > 0.0 {
        let centre = pos2(area.center().x, area.bottom() - 12.0 - 17.0 + 10.0 * (1.0 - away));
        let rect = Rect::from_center_size(centre, vec2(34.0, 34.0));
        let response = ui.interact(rect, ui.id().with("jump"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        let t = widgets::fade(ui, response.id, response.hovered());
        let mut seen = ui.new_child(egui::UiBuilder::new().max_rect(area));
        seen.set_opacity(away);
        seen.painter().add(egui::Shadow { offset: [0, 6], blur: 20, spread: 0, color: Color32::from_black_alpha(102) }.as_shape(rect, egui::CornerRadius::same(17)));
        seen.painter().circle(centre, 17.0, widgets::lerp(p.elevated, p.hover, t), Stroke::new(1.0, p.border_light));
        icons::paint(&seen, icons::ARROW_DOWN, centre, 16.0, widgets::lerp(p.text2, p.text, t));
        if response.clicked() && distance > 40.0 {
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

/// "Opening…" over the transcript, once the chat that was clicked has taken a moment: to read from disk, and
/// then to measure its end. (It used to go when the file was read, and a long chat then showed an empty window
/// for as long as its last messages took to lay out.)
fn opening_pill(app: &App, ui: &mut egui::Ui, area: Rect) {
    let Some(waited) = app.arriving.map(|since| since.elapsed()) else { return };
    // Not for a chat that is there in a quarter of a second: a pill that comes and goes at once is a flicker.
    if waited < Duration::from_millis(250) {
        ui.ctx().request_repaint_after(Duration::from_millis(250) - waited);
        return;
    }
    let come = widgets::entrance(ui.ctx(), app.arriving.unwrap_or_else(Instant::now) + Duration::from_millis(250), 0.18);
    let ui = &mut ui.new_child(egui::UiBuilder::new().max_rect(area.translate(vec2(0.0, -6.0 * (1.0 - come)))));
    ui.set_opacity(come);
    let area = ui.max_rect();
    let p = p();
    let id = app.current_id();
    let title = app.chats.iter().find(|c| c.id == id).map_or("chat", |c| c.title.as_str());
    let short: String = if title.chars().count() > 36 { format!("{}…", title.chars().take(35).collect::<String>()) } else { title.to_string() };
    let label = ui.painter().layout_job(shimmer(ui, &format!("Opening {short}…"), 13.0));
    // A chat of some size says how long it still takes, and shows it: its file is read at a known pace.
    let (share, secs) = app.opening.as_ref().map_or((1.0, 0.0), |opening| opening.progress.eta());
    let wait = (secs >= 0.2).then(|| widgets::galley(ui, &super::splash::left(secs), theme::font(11.0, W::Regular), p.muted));
    let width = label.size().x + wait.as_ref().map_or(0.0, |wait| 10.0 + wait.size().x);
    let rect = Rect::from_center_size(pos2(area.center().x, area.top() + 28.0), vec2(width + 28.0, 34.0));
    ui.painter().add(egui::Shadow { offset: [0, 6], blur: 20, spread: 0, color: Color32::from_black_alpha(102) }.as_shape(rect, egui::CornerRadius::same(17)));
    ui.painter().rect(rect, 17.0, p.elevated, Stroke::new(1.0, p.border_light), egui::StrokeKind::Inside);
    let x = rect.left() + 14.0 + widgets::text_at(ui, rect.left() + 14.0, rect.center().y, label);
    if let Some(wait) = wait {
        widgets::text_at(ui, x + 10.0, rect.center().y, wait);
    }
    let shown = widgets::glide(ui.ctx(), egui::Id::new(("opening-bar", id)), share, 0.12, true);
    super::splash::bar(ui, Rect::from_min_max(pos2(rect.left() + 16.0, rect.bottom() - 5.0), pos2(rect.right() - 16.0, rect.bottom() - 3.0)), shown, true, 1.0);
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
    widgets::text_at_copy(ui, x, rect.center().y, label);
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

/// How long a reply may say nothing, mid-text, before the row under it says it is waiting.
const QUIET: Duration = Duration::from_secs(2);

/// How long what a line under a reply would say has to last before it is said.
const GLANCE: Duration = Duration::from_millis(300);

/// The lines under a reply that is still on its way (StatusRow, RetryBanner, RequestSizeLine, WaitRow
/// and DraftRow in ChatArea.tsx): "✻ Thinking… · 12s" and its kin.
fn wait_rows(ui: &mut egui::Ui, run: &super::Run, has_output: bool) {
    let p = p();
    // A failed request counts down to its next try.
    let retry = run.retry.as_ref().map(|(text, until)| format!("{text} in {}s", until.saturating_duration_since(Instant::now()).as_secs_f32().ceil()));
    let sent = run.request.as_ref().map(|r| (r, describe_request(&r.buckets)));
    let stage = match run.status {
        "Writing" => "Writing",
        "Working" => "Working on your files",
        "Searching" => "Searching the web",
        _ => "Thinking",
    };
    let waiting = sent.as_ref().filter(|(r, _)| !r.answered);
    // Mid-reply and nothing has come for a while: the provider is slow, and saying so tells it from a window that
    // has stopped.
    let quiet = matches!(run.status, "Writing" | "Thinking") && run.retry.is_none() && run.approval.is_none() && run.question.is_none() && run.heard.elapsed() >= QUIET;
    // A tool call being written is not said here: it shows as the step it will be (`Run::drafted`).
    let says = if !has_output {
        stage.to_string()
    } else if waiting.is_some() || quiet {
        "Waiting for the model".into()
    } else {
        String::new()
    };
    // A line fades in when its words change, not its counters, nor what stands behind it: "Thinking…" dimmed and
    // came back twice in its first second, as the request went out and as its first byte came.
    let said = {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (&says, run.retry.is_some()).hash(&mut hash);
        hash.finish()
    };
    let speaks = !says.is_empty() || run.retry.is_some();
    // (what it says, since when, when that went up). On an empty row, mid-reply, a line goes up once its words have
    // stood a glance: filmed, "Writing a.txt…" came up under a folding thought for a tenth of a second before the
    // step it spoke of took its place. In place of a line that is up, new words go up at once.
    let (now, id) = (ui.input(|i| i.time), ui.id().with(("wait-said", &run.conv_id)));
    let (before, since, up) = ui.data(|d| d.get_temp::<(u64, f64, f64)>(id)).unwrap_or((0, now, f64::NAN));
    let (since, mut up) = if before == said { (since, up) } else { (now, if up.is_nan() { f64::NAN } else { now }) };
    if !speaks {
        up = f64::NAN;
    } else if up.is_nan() && (!has_output || now - since >= GLANCE.as_secs_f64()) {
        up = now;
    }
    ui.data_mut(|d| d.insert_temp(id, (said, since, up)));
    if up.is_nan() {
        if speaks {
            ui.ctx().request_repaint_after(GLANCE);
        }
        return;
    }
    let come = egui::emath::easing::cubic_out((((now - up) / 0.16) as f32).clamp(0.0, 1.0));
    if come < 1.0 {
        ui.multiply_opacity(come);
        ui.ctx().request_repaint();
    }
    let row = |ui: &mut egui::Ui, top: f32, add: &mut dyn FnMut(&mut egui::Ui)| {
        ui.add_space(top);
        // As tall as its text: a row of the usual height would stand off from the reply it speaks for.
        ui.allocate_ui_with_layout(vec2(ui.available_width(), 20.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
            ui.add_space(16.0);
            ui.spacing_mut().item_spacing.x = 6.0;
            add(ui);
        });
        ui.add_space(6.0);
    };
    let mark = |ui: &mut egui::Ui| {
        ui.label(widgets::lines("✻", 13.0, 20.0, W::Regular, p.accent));
        ui.add_space(2.0);
    };
    let small = |text: String, colour| widgets::lines(text, 11.0, 16.0, W::Regular, colour);
    // The small print after the glowing words. Each fact follows a dot that stands midway between its neighbours:
    // written into the text ("· 4.2k chars") the dot leaned on the word after it.
    let facts = |ui: &mut egui::Ui, facts: &[String], tip: &str| {
        for fact in facts {
            ui.label(widgets::text("·", 11.0, W::Regular, p.muted));
            // One line, cut short when the column is narrow: wrapped, it grew taller than its row and, centred on
            // it, ran up over the step above.
            let said = ui.add(egui::Label::new(widgets::text(fact.as_str(), 11.0, W::Regular, p.muted)).truncate());
            if !tip.is_empty() {
                said.on_hover_text(tip);
            }
        }
    };
    let glow = |ui: &mut egui::Ui, text: String| {
        let job = shimmer(ui, &text, 13.0);
        ui.add(egui::Label::new(job).truncate());
    };
    let body = |r: &super::Round| r.buckets.iter().map(|b| format!("{} {}", b.label, k(b.chars))).collect::<Vec<_>>().join(" · ");
    let heavy = |chars: u64| if chars >= 400_000 { " — big context, first token may take a while" } else { "" };

    if !has_output {
        row(ui, 0.0, &mut |ui| {
            mark(ui);
            // A retry takes the word's place rather than adding a line.
            match &retry {
                Some(text) => {
                    let said = ui.add(egui::Label::new(widgets::lines(text.as_str(), 13.0, 20.0, W::Regular, p.warning)).truncate());
                    if let Some((r, _)) = &sent {
                        said.on_hover_text(format!("Request body: {}", body(r)));
                    }
                }
                None => glow(ui, format!("{says}…")),
            }
            facts(ui, &[format!("{}s", run.started.elapsed().as_secs())], "");
        });
        if let Some((r, (chars, described))) = sent.as_ref().filter(|(_, (chars, _))| *chars >= 100_000) {
            row(ui, 0.0, &mut |ui| {
                let tip = format!("Request {} body: {}{}", r.number, body(r), if *chars >= 400_000 { "\nBig context — the first token can take a while" } else { "" });
                ui.add(egui::Label::new(small(format!("Request {} · {described}{}", r.number, heavy(*chars)), p.muted)).truncate()).on_hover_text(tip);
            });
        }
        return;
    }
    if let Some(text) = retry {
        row(ui, 0.0, &mut |ui| {
            ui.add(egui::Label::new(small(text.clone(), p.warning)).truncate());
        });
    }
    if let Some((r, (chars, described))) = waiting {
        row(ui, 0.0, &mut |ui| {
            mark(ui);
            glow(ui, "Waiting for the model…".into());
            let tip = "The next round was sent. The provider is reading it (a big request can take a while) before the first token comes back.";
            facts(ui, &[format!("{}s", r.fired.elapsed().as_secs()), format!("{described}{}", heavy(*chars))], tip);
        });
    } else if quiet {
        row(ui, 0.0, &mut |ui| {
            mark(ui);
            glow(ui, "Waiting for the model…".into());
            facts(ui, &[format!("{}s", run.heard.elapsed().as_secs())], "Nothing has come from the model for this long. The reply goes on when it sends more.");
        });
    }
}

fn welcome(app: &mut App, ui: &mut egui::Ui, drop: f32) {
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
        crate::models::ProviderId::Anthropic => "Anthropic",
    };
    let blurb = if has_keys {
        "Type a message below to start a conversation.".to_string()
    } else {
        format!("Connect a {provider} API key to start chatting. DeepSeek, OpenRouter and Anthropic all work. Your keys stay on this PC — nothing leaves this app except your requests.")
    };
    // Laid out once to learn the height, so the block sits centred (lifted 32, like the web's pb-16).
    let id = ui.id().with("welcome-height");
    let height: f32 = ui.data(|d| d.get_temp(id)).unwrap_or(200.0);
    let top = area.center().y - 32.0 - height / 2.0 + drop;
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
    }
}
