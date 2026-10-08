//! The conversation column: header, transcript, the wait rows under it.
//! The frame of src/components/ChatArea.tsx.

use super::theme::{self, W, mix, p};
use super::widgets;
use super::{App, Dialog, bubble, composer, icons};
use crate::store::Role;
use eframe::egui::{self, Color32, Rect, Sense, Stroke, pos2, vec2};
use std::time::Duration;

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
    ui.ctx().request_repaint_after(Duration::from_millis(40));
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
        let running = app.procs.running();
        if running > 0 {
            let label = format!("{running} running");
            if widgets::small_btn(ui, &label, p.warning, Color32::TRANSPARENT, p.border).on_hover_text("Background processes the agent started. Click to stop them all.").clicked() {
                app.procs.stop_all();
            }
        }
        let totals = app.totals();
        if totals.priced > 0 {
            ui.add_space(4.0);
            ui.label(widgets::text(format_cost(totals.cost), 11.0, W::Regular, p.muted)).on_hover_text("What this chat has cost so far, estimated from published rates — the full breakdown is at the top of the conversation");
        }
    });
}

pub fn messages(app: &mut App, ui: &mut egui::Ui) {
    let area = ui.max_rect();
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
    let jump = std::mem::take(&mut app.jump_to_latest);

    // Each chat keeps its own place, and a chat opened for the first time starts at its end.
    let mut scroll = egui::ScrollArea::vertical().id_salt(("transcript", &app.conv.id)).auto_shrink(false).stick_to_bottom(true);
    if jump {
        // Past the end: clamped to it, and the view then follows the reply as it grows.
        scroll = scroll.vertical_scroll_offset(1e9);
    }
    let out = scroll.show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.add_space(24.0);
        let column_ui = |ui: &mut egui::Ui, add: &mut dyn FnMut(&mut egui::Ui)| {
            let top = ui.cursor().top();
            let rect = Rect::from_min_size(pos2(left, top), vec2(column, 0.0));
            let used = ui.scope_builder(egui::UiBuilder::new().max_rect(rect.with_max_y(f32::INFINITY)), |ui| {
                ui.set_width(column);
                add(ui);
            });
            ui.advance_cursor_after_rect(Rect::from_min_max(pos2(area.left(), top), pos2(area.right(), used.response.rect.bottom())));
        };

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
        let App { conv, heights, run, settings, editing, .. } = app;
        // Bubbles stop at three quarters of the column; a narrow window gives them a little more.
        let cap = column * if ui.ctx().content_rect().width() < 768.0 { 0.85 } else { 0.75 };
        let thinking_secs = run.as_ref().and_then(|r| r.thinking.secs());
        let has_output = conv.messages.last().is_some_and(|m| m.role == Role::Assistant && !m.parts.is_empty());
        for (i, msg) in conv.messages.iter().enumerate() {
            let live = running && i == last;
            // An empty reply that is still on its way is the status row's job.
            if live && !has_output {
                continue;
            }
            // Replies off screen are not laid out at all: they keep their measured height.
            if let Some(&(w, h)) = heights.get(&msg.id) {
                let rect = Rect::from_min_size(ui.cursor().min, vec2(area.width(), h));
                if !live && w == column && !ui.is_rect_visible(rect) {
                    ui.allocate_space(vec2(area.width(), h));
                    continue;
                }
            }
            let top = ui.cursor().top();
            column_ui(ui, &mut |ui| {
                let mut env = bubble::Env { settings, workspace: &workspace, live, newest: i == last, busy: running, cap, thinking_secs, editing, action: &mut action };
                ui.push_id(&msg.id, |ui| bubble::show(ui, msg, &mut env));
            });
            ui.add_space(24.0);
            heights.insert(msg.id.clone(), (column, ui.cursor().top() - top));
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
        Some(bubble::Action::Copy(text)) => ui.ctx().copy_text(text),
        Some(bubble::Action::Link(url)) => ui.ctx().open_url(egui::OpenUrl::new_tab(url)),
        Some(bubble::Action::OpenCode(title, language, code)) => app.artifact = Some(super::overlay::Artifact { title, language, code, copied: None }),
        Some(bubble::Action::Image(name, uri)) => app.lightbox = Some((name, uri)),
        Some(bubble::Action::OpenFile(path)) => super::workspace::open(app, path),
        Some(bubble::Action::Delete(id)) => app.delete_exchange(&id),
        Some(bubble::Action::Edit(id, text)) => app.resend_edited(ui.ctx(), &id, text),
        None => {}
    }
}

/// The lines under a reply that is still on its way: "✻ Thinking… · 12s".
fn wait_rows(ui: &mut egui::Ui, run: &super::Run, has_output: bool) {
    let p = p();
    let seconds = run.started.elapsed().as_secs();
    let line = |ui: &mut egui::Ui, label: String, detail: String| {
        ui.horizontal(|ui| {
            ui.add_space(16.0);
            ui.spacing_mut().item_spacing.x = 8.0;
            ui.label(widgets::lines("✻", 13.0, 20.0, W::Regular, p.accent));
            let job = shimmer(ui, &label, 13.0);
            ui.label(job);
            ui.label(widgets::text(detail, 11.0, W::Regular, p.muted));
        });
    };
    match &run.drafting {
        Some((name, chars)) if *chars > 0 => {
            let size = if *chars >= 1000 { format!("{:.1}k chars", *chars as f64 / 1000.0) } else { format!("{chars} chars") };
            ui.add_space(if has_output { 0.0 } else { 8.0 });
            line(ui, format!("{}…", drafting_label(name)), format!("· {size} · {seconds}s"));
        }
        _ if !has_output => {
            ui.add_space(8.0);
            let stage = match run.status {
                "Writing" => "Writing",
                "Working" => "Working on your files",
                "Searching" => "Searching the web",
                _ => "Thinking",
            };
            line(ui, format!("{stage}…"), format!("· {seconds}s"));
        }
        _ => {}
    }
    ui.add_space(8.0);
}

/// "Writing files", "Preparing edits", "Planning": what a tool call still streaming in is doing.
fn drafting_label(name: &str) -> String {
    match name {
        "write_file" | "write_files" | "create_file" => "Writing files".into(),
        "edit_file" | "edit_files" | "replace_in_files" => "Preparing edits".into(),
        n if n.contains("plan") => "Planning".into(),
        n => format!("Preparing {}", n.replace('_', " ")),
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
