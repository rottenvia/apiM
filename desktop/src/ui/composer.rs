//! The message box and its row of chips, with the popovers that open above it:
//! the composer part of src/components/ChatArea.tsx, ModelSelector.tsx,
//! ThinkingEffortSelector.tsx, WebSearchToggle.tsx and ContextMeter.tsx.

use super::theme::{self, W, alpha, mix, p};
use super::widgets::{self, Chip, SendKind, fade, lerp};
use super::{App, Dialog, icons};
use crate::models;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, pos2, vec2};

/// Which popover is open above the composer.
#[derive(Clone, Copy, PartialEq, Default)]
pub enum Popover {
    #[default]
    None,
    Model,
    Effort,
    Web,
    Context,
}

/// (id, label, what it does, warning)
const EFFORTS: [(&str, &str, &str, &str); 5] = [
    ("auto", "Auto", "Adjusts reasoning depth per message.", "Can spend more tokens on complex prompts."),
    ("none", "None", "No reasoning. Fastest and cheapest responses.", ""),
    ("low", "Low", "Light reasoning for everyday questions.", ""),
    ("high", "High", "Deep reasoning for complex problems and debugging.", ""),
    ("max", "Max", "Maximum depth — 50K+ thinking tokens per reply.", "Slowest and most expensive. Use sparingly."),
];

/// What the model actually does with each level (DeepSeek's and Qwen's own mapping).
fn efforts_for(model: &str) -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    EFFORTS
        .iter()
        .map(|&(id, label, what, warning)| match (model, id) {
            ("deepseek-v4-pro", "low") => (id, label, "Same as High on V4 Pro — this model has no light mode.", "Switch to V4 Flash for genuinely cheaper reasoning."),
            ("qwen-3.8-27b", "none") => (id, label, "enable_thinking: false — answers without a think block.", warning),
            ("qwen-3.8-27b", "low") => (id, label, "Qwen reasoning_effort=low.", warning),
            ("qwen-3.8-27b", "high") => (id, label, "Qwen reasoning_effort=medium (its middle setting).", warning),
            ("qwen-3.8-27b", "max") => (id, label, "Qwen reasoning_effort=xhigh — the model default.", "Can think for a very long time. Use medium unless you need it."),
            _ => (id, label, what, warning),
        })
        .collect()
}

/// 67.4k, 1M, 812: the compact form the meter uses.
pub fn format_tokens(n: u64) -> String {
    let trim = |v: f64, places: usize| {
        let s = format!("{v:.places$}");
        if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
    };
    if n >= 1_000_000 {
        format!("{}M", trim(n as f64 / 1e6, if n % 1_000_000 == 0 { 0 } else { 2 }))
    } else if n >= 1_000 {
        format!("{}k", trim(n as f64 / 1e3, if n >= 100_000 { 0 } else { 1 }))
    } else {
        n.to_string()
    }
}

fn level_colour(pct: f32) -> Color32 {
    let p = p();
    if pct >= 85.0 {
        p.danger
    } else if pct >= 60.0 {
        p.warning
    } else {
        p.accent
    }
}

fn segment_colour(label: &str) -> Color32 {
    let p = p();
    match label {
        "instructions" => p.accent,
        "tool schemas" => p.search,
        "plugins" => mix(p.search, 55.0, p.accent),
        "history" => p.warning,
        "summary" => p.success,
        "your message" => p.text2,
        "tool results" => mix(p.warning, 55.0, p.danger),
        "tool calls" => mix(p.accent, 50.0, p.warning),
        "reasoning" => mix(p.muted, 70.0, p.accent),
        "media" => p.danger,
        _ => p.muted,
    }
}

/// The widest the message column gets, like the web app's `max-w-3xl xl:max-w-4xl`.
pub fn column_width(ui: &egui::Ui, fullscreen: bool) -> f32 {
    let window = ui.ctx().content_rect().width();
    if fullscreen {
        if window >= 1536.0 { 1024.0 } else { 896.0 }
    } else if window >= 1280.0 {
        896.0
    } else {
        768.0
    }
}

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let running = app.running_here();
    let has_keys = crate::provider::resolve_target(&app.settings.model, &app.settings).is_ok();
    let gutter = if ui.available_width() >= 640.0 { 24.0 } else { 16.0 };
    let width = (ui.available_width() - gutter * 2.0).min(column_width(ui, app.fullscreen));
    let left = ui.max_rect().left() + (ui.available_width() - width) / 2.0;

    ui.add_space(8.0);
    let top = ui.cursor().top();
    let mut menu: (&'static str, Vec<crate::slash::MenuItem>) = ("", Vec::new());
    let focused = ui.memory(|m| m.has_focus(egui::Id::new("composer-text")));
    let dragging = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
    let frame = egui::Frame::new()
        .fill(if dragging { mix(p.accent, 6.0, p.bg3) } else { p.bg3 })
        .stroke(Stroke::new(1.0, if dragging { p.accent } else if focused { p.border_light } else { p.border }))
        .corner_radius(16)
        .shadow(egui::Shadow { offset: [0, 6], blur: 28, spread: 0, color: Color32::from_black_alpha(if p.is_dark() { 71 } else { 28 }) });
    let outer = ui.scope_builder(egui::UiBuilder::new().max_rect(Rect::from_min_size(pos2(left, top), vec2(width, ui.available_height()))), |ui| {
        frame.show(ui, |ui| {
            ui.set_width(width - 2.0);
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            super::attachments::chips(app, ui);
            if let Some(problem) = &app.attach_error {
                egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 8, bottom: 0 }).show(ui, |ui| {
                    ui.add(egui::Label::new(widgets::lines(problem.as_str(), 11.0, 16.0, W::Regular, p.danger)).wrap().selectable(false));
                });
            }

            super::slash_menu::notice(app, ui);

            // The text itself: 15px on a 24px line, growing with what is typed.
            let hint = if !has_keys {
                "Add your API keys in Settings to start chatting"
            } else if running {
                "Working… start with \"btw\" to tell it something"
            } else if !app.attachments.is_empty() {
                "Add a question about these files…"
            } else {
                "Type a message, or / for commands"
            };
            let mut layouter = |ui: &egui::Ui, text: &dyn egui::TextBuffer, wrap: f32| {
                let mut job = egui::text::LayoutJob::simple(text.as_str().to_string(), theme::font(15.0, W::Regular), p.text, wrap);
                job.sections.iter_mut().for_each(|s| s.format.line_height = Some(24.0));
                ui.painter().layout_job(job)
            };
            // The command menu takes its keys before the text does.
            menu = super::slash_menu::rows(app);
            super::slash_menu::keys(app, ui.ctx(), &menu.1);
            let edit = egui::Frame::new()
                .inner_margin(egui::Margin { left: 16, right: 16, top: 14, bottom: 6 })
                .show(ui, |ui| {
                    egui::ScrollArea::vertical().id_salt("composer-scroll").max_height(240.0).show(ui, |ui| {
                        ui.add_enabled(
                            has_keys,
                            egui::TextEdit::multiline(&mut app.draft)
                                .id(egui::Id::new("composer-text"))
                                .hint_text(widgets::lines(hint, 15.0, 24.0, W::Regular, p.muted))
                                .desired_rows(1)
                                .desired_width(f32::INFINITY)
                                .frame(egui::Frame::NONE)
                                .margin(egui::Margin::ZERO)
                                .return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, egui::Key::Enter))
                                .layouter(&mut layouter),
                        )
                    })
                    .inner
                })
                .inner;
            if std::mem::take(&mut app.focus_composer) && app.dialog == Dialog::None {
                edit.request_focus();
            }
            let enter = edit.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift);
            super::slash_menu::after_edit(app, ui, &edit, !menu.1.is_empty());

            let is_note = running && btw_note(&app.draft).is_some();
            if is_note {
                ui.horizontal(|ui| {
                    ui.add_space(16.0);
                    ui.spacing_mut().item_spacing.x = 6.0;
                    pulse(ui);
                    ui.label(widgets::text("Passes it to the running task — nothing stops", 11.0, W::Regular, p.search));
                });
                ui.add_space(4.0);
            }

            ui.add_space(2.0);
            let send = row(app, ui, running, is_note, has_keys);
            ui.add_space(10.0);
            // While a reply runs Enter still runs a command or passes a note; `submit` lets anything else wait.
            if send || enter {
                app.submit(ui.ctx());
            }
        })
        .response
        .rect
    });
    app.composer_rect = outer.inner;
    if dragging {
        let rect = app.composer_rect;
        ui.painter().rect_filled(rect, 16.0, alpha(p.bg3, 85.0));
        let label = widgets::galley(ui, "Drop files or a .zip to attach", theme::font(14.0, W::Medium), p.accent_light);
        let x = rect.center().x - (label.size().x + 24.0) / 2.0;
        icons::paint(ui, icons::UPLOAD, pos2(x + 8.0, rect.center().y), 16.0, p.accent_light);
        widgets::text_at(ui, x + 24.0, rect.center().y, label);
    }
    ui.advance_cursor_after_rect(Rect::from_min_max(pos2(left, top), pos2(left + width, app.composer_rect.bottom() + 16.0)));

    popovers(app, ui.ctx());
    super::slash_menu::show(app, ui.ctx(), menu.0, &menu.1);
}

/// "btw fix the header too": the note in it, for the running task instead of a new message.
/// None when the text is not one (the web's `^btw[\s,:]+(.+)`, any letter case).
pub fn btw_note(text: &str) -> Option<&str> {
    let text = text.trim();
    let rest = text.get(3..).filter(|_| text[..3].eq_ignore_ascii_case("btw"))?;
    let note = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':');
    (note.len() < rest.len() && !note.is_empty()).then_some(note)
}

/// "resume", or "continue, and also fix the header": the instruction after the word, "" when there is none.
/// None when the text does not open with one of the web's resume words.
pub fn resume_note(text: &str) -> Option<&str> {
    let text = text.trim();
    let word = ["resume", "continue", "carry on", "keep going", "go on"].into_iter().find(|w| text.get(..w.len()).is_some_and(|head| head.eq_ignore_ascii_case(w)))?;
    let rest = &text[word.len()..];
    // The word must end there: "continued" and "resumes" are ordinary messages.
    if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some(rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ':' | '.' | '—' | '-')).trim_end())
}

/// The teal dot that breathes beside a note (`.btw-pulse`).
fn pulse(ui: &mut egui::Ui) {
    let (rect, _) = ui.allocate_exact_size(vec2(6.0, 16.0), Sense::hover());
    let t = ((ui.input(|i| i.time) / 1.5 * std::f64::consts::TAU).sin() as f32 + 1.0) / 2.0;
    ui.painter().circle_filled(rect.center(), 3.0 * (0.8 + 0.2 * t), p().search.gamma_multiply(0.25 + 0.75 * t));
    ui.ctx().request_repaint_after(std::time::Duration::from_millis(50));
}

/// The bottom row. Returns true when Send was pressed.
fn row(app: &mut App, ui: &mut egui::Ui, running: bool, is_note: bool, has_keys: bool) -> bool {
    let p = p();
    let width = ui.available_width();
    // The web app decides these on the composer's own width, not the window's.
    let (wide, roomy, narrow, tiny) = (width >= 576.0, width >= 512.0, width <= 480.0, width <= 352.0);
    let pad = if tiny { 5.0 } else if narrow { 7.0 } else { 10.0 };
    let gap = if tiny { 4.0 } else if narrow { 6.0 } else { 8.0 };
    let mut send = false;

    // Chips that do not fit wrap onto a second line; the row is as tall as they were last frame.
    let height_id = egui::Id::new("composer-chips-height");
    let height: f32 = ui.data(|d| d.get_temp(height_id)).unwrap_or(32.0);
    let (rect, _) = ui.allocate_exact_size(vec2(width, height), Sense::hover());
    let mut ui = ui.new_child(egui::UiBuilder::new().max_rect(rect.shrink2(vec2(10.0, 0.0))).layout(egui::Layout::left_to_right(egui::Align::Center)));
    let ui = &mut ui;
    ui.spacing_mut().item_spacing = vec2(gap, 0.0);
    let separator = |ui: &mut egui::Ui| {
        let (r, _) = ui.allocate_exact_size(vec2(1.0, 24.0), Sense::hover());
        ui.painter().rect_filled(r, 0.0, p.border);
    };

    let count = app.attachments.len();
    let attached = if count > 0 { count.to_string() } else { String::new() };
    if (Chip { icon: Some(icons::PAPERCLIP), text: &attached, active: count > 0, pad, ..Default::default() }).show(ui).on_hover_text("Attach files, or a .zip / .tar.gz of a whole project").clicked() {
        app.pick_files();
    }
    if !narrow {
        if (Chip { icon: Some(icons::FOLDER), pad, ..Default::default() }).show(ui).on_hover_text("Attach a whole folder").clicked() {
            app.pick_folder();
        }
        separator(ui);
    }

    // Right side first, so the chips in the middle know how much room is left.
    let start = ui.cursor().min;
    let right = ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        let kind = if running && is_note {
            SendKind::Note
        } else if running {
            SendKind::Stop
        } else {
            SendKind::Send { enabled: has_keys && (!app.draft.trim().is_empty() || !app.attachments.is_empty()) && !app.compacting() }
        };
        let tip = match kind {
            SendKind::Note => "Pass it to the running task — won't interrupt it",
            SendKind::Stop => "Stop generating",
            SendKind::Send { .. } => "Send message",
        };
        if widgets::send_btn(ui, kind, tip).clicked() {
            match kind {
                SendKind::Stop => app.stop(),
                _ => send = true,
            }
        }
        if !narrow {
            separator(ui);
        }

        let (used, estimated, _) = app.context_used();
        let window = models::context_window(&app.settings.model, &app.settings.custom_models);
        let pct = if window > 0 { (used.unwrap_or(0) as f32 / window as f32 * 100.0).min(100.0) } else { 0.0 };
        let pct_label = if pct > 0.0 && pct < 1.0 { "<1".to_string() } else { format!("{}", pct.round() as u32) };
        let label = if roomy { format!("{pct_label}%") } else { String::new() };
        let ring = (pct.max(if used.is_some_and(|u| u > 0) { 2.0 } else { 0.0 }), level_colour(pct));
        let tip = match used {
            None => "Context window — fills as the chat grows".to_string(),
            Some(u) => format!("Context: {}{} / {} tokens ({pct_label}%)", if estimated { "~" } else { "" }, format_tokens(u), format_tokens(window)),
        };
        let open = app.popover == Popover::Context;
        if (Chip { ring: Some(ring), text: &label, open, pad: 8.0, ..Default::default() }).show(ui).on_hover_text(tip).clicked() {
            app.toggle_popover(Popover::Context);
        }
        ui.min_rect().left()
    });

    let room = Rect::from_min_max(start, pos2(right.inner - gap, rect.bottom()));
    let mut chips = ui.new_child(egui::UiBuilder::new().max_rect(room).layout(egui::Layout::left_to_right(egui::Align::Center).with_main_wrap(true)));
    let ui = &mut chips;
    ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
    ui.set_row_height(32.0);

    let model = models::resolve(&app.settings.model, &app.settings.custom_models);
    let dot = (model.provider == models::ProviderId::Deepseek).then(|| if crate::provider::deepseek_off_peak() { Color32::from_rgb(0x34, 0xd3, 0x99) } else { Color32::from_rgb(0xfb, 0xbf, 0x24) });
    let max_text = if roomy { 0.0 } else if tiny { 64.0 } else { 88.0 };
    if (Chip { icon: Some(icons::CHIP), text: &model.short_label, open: app.popover == Popover::Model, chevron: true, dot, max_text, pad, ..Default::default() }).show(ui).on_hover_text("Choose model").clicked() {
        app.toggle_popover(Popover::Model);
    }

    let effort = EFFORTS.iter().find(|e| e.0 == app.settings.effort).unwrap_or(&EFFORTS[0]);
    let chip = Chip { icon: Some(icons::SPARKLES), text: if wide { effort.1 } else { "" }, active: effort.0 != "auto", open: app.popover == Popover::Effort, chevron: wide, pad, ..Default::default() };
    if chip.show(ui).on_hover_text("Thinking effort — how deeply the model reasons").clicked() {
        app.toggle_popover(Popover::Effort);
    }

    let mode = app.settings.web_mode();
    let tip = match mode {
        "always" => "Web search on every message — right-click to change",
        "off" => "Web search off",
        _ => "Web search on — right-click for more",
    };
    let web = Chip { icon: Some(icons::GLOBE), text: if wide { "Web" } else { "" }, active: mode != "off", open: app.popover == Popover::Web, dot: (mode == "always").then_some(p.accent_light), pad, ..Default::default() }.show(ui).on_hover_text(tip);
    if web.secondary_clicked() || web.long_touched() {
        app.toggle_popover(Popover::Web);
    } else if web.clicked() && app.popover != Popover::Web {
        app.settings.set_web_mode(if mode == "off" { "auto" } else { "off" });
        app.settings.save();
    }

    // On for every chat, or for this one alone.
    let on = crate::plugins::enabled_for(&app.settings.enabled_plugins, &app.conv.names("skills")).len();
    let label = match (wide, on) {
        (true, 0) => "Plugins".to_string(),
        (true, n) => format!("Plugins · {n}"),
        (false, 0) => String::new(),
        (false, n) => n.to_string(),
    };
    if (Chip { icon: Some(icons::PLUGINS), text: &label, active: on > 0, pad, ..Default::default() }).show(ui).on_hover_text("Open plugins").clicked() {
        app.dialog = Dialog::Plugins;
    }
    let used = ui.min_rect().height().max(32.0);
    if used != height {
        ui.data_mut(|d| d.insert_temp(height_id, used));
        ui.ctx().request_repaint();
    }
    send
}

// ------------------------------------------------------------------ popovers

/// A popover above the composer. `right` pins it to the composer's right edge; otherwise it is centred.
fn popover(app: &mut App, ctx: &egui::Context, width: f32, right: bool, body: impl FnOnce(&mut App, &mut egui::Ui)) {
    let anchor = app.composer_rect;
    let width = width.min(ctx.content_rect().width() - 24.0);
    let t = ctx.animate_bool_with_time(egui::Id::new(("popover-in", app.popover as u8)), true, 0.15);
    let x = if right { anchor.right() - width } else { anchor.center().x - width / 2.0 };
    let area = egui::Area::new(egui::Id::new(("popover", app.popover as u8)))
        .order(egui::Order::Foreground)
        .pivot(egui::Align2::LEFT_BOTTOM)
        .fixed_pos(pos2(x, anchor.top() - 12.0 + 6.0 * (1.0 - t)))
        .constrain(true)
        .show(ctx, |ui| {
            ui.set_opacity(t);
            widgets::popover_frame(16).show(ui, |ui| {
                ui.set_width(width - 2.0);
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                body(app, ui);
            });
        });
    let pressed_outside = ctx.input(|i| i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|at| !area.response.rect.contains(at) && !anchor.contains(at)));
    if pressed_outside || ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        app.popover = Popover::None;
    }
}

/// Title, subtitle and the X: the head every list popover shares.
fn head(app: &mut App, ui: &mut egui::Ui, title: &str, subtitle: &str) {
    let p = p();
    egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 12)).show(ui, |ui| {
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.label(widgets::lines(title, 13.0, 20.0, W::Semibold, p.text));
                ui.add_space(2.0);
                ui.label(widgets::lines(subtitle, 11.0, 16.0, W::Regular, p.muted));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                if widgets::popover_close(ui).clicked() {
                    app.popover = Popover::None;
                }
            });
        });
    });
    widgets::rule(ui);
}

/// `.option-item`: a title, an optional tick, and up to two more lines. Returns true when clicked.
fn option(ui: &mut egui::Ui, title: &str, selected: bool, title_colour: Option<Color32>, lines: &[(&str, f32, f32, Color32, bool)]) -> bool {
    let p = p();
    let width = ui.available_width();
    let inner = width - 24.0;
    let title_font = theme::font(13.0, W::Medium);
    let title_galley = widgets::clipped(ui, title, title_font, title_colour.unwrap_or(if selected { p.accent_light } else { p.text }), inner - if selected { 24.0 } else { 0.0 });
    let bodies: Vec<_> = lines
        .iter()
        .map(|&(text, size, line, colour, mono)| {
            let font = if mono { theme::mono(size) } else { theme::font(size, W::Regular) };
            let mut job = egui::text::LayoutJob::simple(text.to_string(), font, colour, inner);
            job.sections.iter_mut().for_each(|s| s.format.line_height = Some(line));
            ui.painter().layout_job(job)
        })
        .collect();
    let gaps = [2.0, 4.0];
    let height = 20.0 + bodies.iter().enumerate().map(|(i, g)| g.size().y + gaps[i.min(1)]).sum::<f32>() + 20.0;
    let (rect, response) = ui.allocate_exact_size(vec2(width, height), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = fade(ui, response.id, response.hovered());
    let fill = if selected { alpha(p.accent, 8.0) } else { lerp(Color32::TRANSPARENT, p.hover, t) };
    ui.painter().rect_filled(rect, 8.0, fill);
    let (x, mut y) = (rect.left() + 12.0, rect.top() + 10.0);
    widgets::text_at(ui, x, y + 10.0, title_galley);
    if selected {
        icons::paint(ui, icons::CHECK, pos2(rect.right() - 12.0 - 8.0, y + 10.0), 16.0, p.accent);
    }
    y += 20.0;
    for (i, galley) in bodies.into_iter().enumerate() {
        y += gaps[i.min(1)];
        let size = galley.size();
        ui.painter().galley(pos2(x, y), galley, Color32::PLACEHOLDER);
        y += size.y;
    }
    response.clicked()
}

fn popovers(app: &mut App, ctx: &egui::Context) {
    let p = p();
    match app.popover {
        Popover::None => {}
        Popover::Model => popover(app, ctx, 336.0, false, |app, ui| {
            head(app, ui, "Model", "DeepSeek, OpenRouter, yours, or a local Qwen");
            let current = models::resolve(&app.settings.model, &app.settings.custom_models);
            if current.provider == models::ProviderId::Deepseek {
                peak_hours(ui);
            }
            let max = (ctx.content_rect().height() - 260.0).clamp(120.0, 352.0);
            egui::ScrollArea::vertical().max_height(max).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                    let mut pick = None;
                    for m in models::MODELS.iter() {
                        let selected = app.settings.model == m.id;
                        if option(ui, &m.label, selected, None, &[(&m.description, 12.0, 20.0, p.text2, false), (&m.specs, 11.0, 16.0, p.muted, false)]) {
                            pick = Some(m.id.clone());
                        }
                    }
                    if !app.settings.custom_models.is_empty() {
                        egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 8, bottom: 4 }).show(ui, |ui| {
                            ui.label(widgets::text("YOUR MODELS", 11.0, W::Semibold, p.muted).extra_letter_spacing(0.55));
                        });
                        for def in &app.settings.custom_models {
                            let info = def.to_info();
                            let selected = app.settings.model == info.id;
                            let specs = format!("OpenRouter · {}{}", info.specs, if info.vision == models::Vision::Native { " · vision" } else { "" });
                            if option(ui, &def.label, selected, None, &[(&def.api_model, 11.0, 16.0, p.text2, true), (&specs, 11.0, 16.0, p.muted, false)]) {
                                pick = Some(info.id);
                            }
                        }
                    }
                    if option(ui, "＋ Add any OpenRouter model…", false, Some(p.accent_light), &[("Paste its openrouter.ai link in the chat and ask to add it, or an id in Settings → Model.", 12.0, 20.0, p.text2, false)]) {
                        app.popover = Popover::None;
                        app.dialog = Dialog::Settings;
                        app.settings_ui.tab = 1;
                    }
                    if let Some(id) = pick {
                        app.settings.model = id;
                        app.settings.save();
                        app.popover = Popover::None;
                    }
                });
            });
        }),
        Popover::Effort => popover(app, ctx, 336.0, false, |app, ui| {
            let model = app.settings.model.clone();
            head(app, ui, "Thinking effort", if model == "deepseek-v4-pro" { "V4 Pro has two real depths: High and Max" } else { "How deeply the model reasons before replying" });
            egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                for (id, label, what, warning) in efforts_for(&model) {
                    let selected = app.settings.effort == id;
                    let mut lines = vec![(what, 12.0, 20.0, p.text2, false)];
                    if !warning.is_empty() {
                        lines.push((warning, 11.0, 16.0, p.warning, false));
                    }
                    if option(ui, label, selected, None, &lines) {
                        app.settings.effort = id.into();
                        app.settings.save();
                        app.popover = Popover::None;
                    }
                }
            });
        }),
        Popover::Web => popover(app, ctx, 304.0, false, |app, ui| {
            egui::Frame::new().inner_margin(egui::Margin::same(6)).show(ui, |ui| {
                let modes = [
                    ("auto", "On", "Gives the agent the web_search tool; it looks things up when it decides it needs to."),
                    ("always", "Every message", "Same tool, but nudged to default to looking things up."),
                    ("off", "Off", "The web_search tool is hidden; answers from the model's own knowledge only."),
                ];
                for (id, label, blurb) in modes {
                    if option(ui, label, app.settings.web_mode() == id, None, &[(blurb, 11.0, 16.0, p.muted, false)]) {
                        app.settings.set_web_mode(id);
                        app.settings.save();
                        app.popover = Popover::None;
                    }
                }
            });
        }),
        Popover::Context => popover(app, ctx, 352.0, true, context_panel),
    }
}

/// DeepSeek's peak / off-peak strip in the model menu.
fn peak_hours(ui: &mut egui::Ui) {
    let p = p();
    let off = crate::provider::deepseek_off_peak();
    let (bg, fg, dot) = if off {
        (Color32::from_rgba_unmultiplied(0x10, 0xb9, 0x81, 38), Color32::from_rgb(0x6e, 0xe7, 0xb7), Color32::from_rgb(0x34, 0xd3, 0x99))
    } else {
        (Color32::from_rgba_unmultiplied(0xf5, 0x9e, 0x0b, 38), Color32::from_rgb(0xfc, 0xd3, 0x4d), Color32::from_rgb(0xfb, 0xbf, 0x24))
    };
    egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 10)).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let label = widgets::galley(ui, if off { "OFF-PEAK" } else { "PEAK" }, theme::font(9.0, W::Semibold), fg);
            let (rect, _) = ui.allocate_exact_size(vec2(label.size().x + 8.0 + 6.0 + 6.0 + 8.0, 18.0), Sense::hover());
            ui.painter().rect_filled(rect, 9.0, bg);
            ui.painter().circle_filled(pos2(rect.left() + 8.0 + 3.0, rect.center().y), 3.0, dot);
            widgets::text_at(ui, rect.left() + 8.0 + 6.0 + 6.0, rect.center().y, label);
            let (next, minutes) = crate::provider::deepseek_next_change();
            let text = format!("{} · switches to {} at {next} your time (in {})", if off { "Discount pricing active" } else { "Standard pricing" }, if off { "peak" } else { "off-peak" }, countdown(minutes));
            ui.add(egui::Label::new(widgets::lines(text, 11.0, 16.0, W::Regular, p.muted)).wrap());
        });
    });
    widgets::rule(ui);
}

fn countdown(minutes: u32) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

fn ago(iso: &str) -> String {
    let then = crate::store::from_iso(iso);
    let s = crate::store::now_ms().saturating_sub(then) / 1000;
    match s {
        _ if then == 0 => String::new(),
        0..=59 => "just now".into(),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86400),
    }
}

/// The context meter's panel: what fills the window, what the chat has cost, and Compact.
fn context_panel(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let model = models::resolve(&app.settings.model, &app.settings.custom_models);
    let window = models::context_window(&app.settings.model, &app.settings.custom_models);
    let (used, estimated, compacted) = app.context_used();
    let tokens = used.unwrap_or(0);
    let pct = if window > 0 { (tokens as f32 / window as f32 * 100.0).min(100.0) } else { 0.0 };
    let pct_label = if pct > 0.0 && pct < 1.0 { "<1".to_string() } else { format!("{}", pct.round() as u32) };
    let breakdown = app.context_breakdown();
    let total_chars: u64 = breakdown.iter().map(|b| b.chars).sum();
    let segments: Vec<(String, f64)> = if total_chars > 0 && tokens > 0 { breakdown.iter().map(|b| (b.label.clone(), b.chars as f64 / total_chars as f64 * tokens as f64)).collect() } else { Vec::new() };
    let small = |text: String, colour| widgets::lines(text, 11.0, 16.0, W::Regular, colour);

    egui::Frame::new().inner_margin(egui::Margin::same(12)).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(widgets::lines("Context window", 12.0, 20.0, W::Medium, p.text));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let text = match used {
                    None => format!("— / {}", format_tokens(window)),
                    Some(_) => format!("{}{} / {} ({pct_label}%)", if estimated { "~" } else { "" }, format_tokens(tokens), format_tokens(window)),
                };
                ui.label(widgets::lines(text, 12.0, 20.0, W::Regular, p.text2));
            });
        });

        ui.add_space(8.0);
        let (bar, _) = ui.allocate_exact_size(vec2(ui.available_width(), 6.0), Sense::hover());
        ui.painter().rect_filled(bar, 3.0, p.hover);
        let clip = ui.painter().with_clip_rect(bar);
        if segments.is_empty() {
            clip.rect_filled(bar.with_max_x(bar.left() + bar.width() * pct / 100.0), 3.0, level_colour(pct));
        } else {
            let mut x = bar.left();
            for (label, share) in &segments {
                let w = bar.width() * (*share / window as f64) as f32;
                clip.rect_filled(Rect::from_min_size(pos2(x, bar.top()), vec2(w, 6.0)), 0.0, segment_colour(label));
                x += w;
            }
        }

        if !segments.is_empty() {
            ui.add_space(8.0);
            let col = (ui.available_width() - 12.0) / 2.0;
            for pair in segments.chunks(2).take(4) {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;
                    for (label, share) in pair {
                        let (rect, _) = ui.allocate_exact_size(vec2(col, 18.0), Sense::hover());
                        ui.painter().circle_filled(pos2(rect.left() + 4.0, rect.center().y), 4.0, segment_colour(label));
                        let amount = widgets::galley(ui, &format_tokens(share.round() as u64), theme::font(11.0, W::Regular), p.muted);
                        let amount_width = amount.size().x;
                        widgets::text_at(ui, rect.right() - amount_width, rect.center().y, amount);
                        widgets::text_at(ui, rect.left() + 14.0, rect.center().y, widgets::clipped(ui, label, theme::font(11.0, W::Regular), p.muted, col - 14.0 - amount_width - 6.0));
                    }
                });
            }
        }

        ui.add_space(8.0);
        let about = match used {
            None => format!("Fills as the chat grows. {} holds {} tokens.", model.short_label, format_tokens(window)),
            Some(_) if compacted => format!("About what the next request to {} will carry, now that the chat is compacted: the summary and what was said since.", model.short_label),
            Some(_) => format!("What the newest request to {} carried{}. The next message adds to it.", model.short_label, if estimated { " (estimated from its size)" } else { "" }),
        };
        ui.add(egui::Label::new(small(about, p.muted)).wrap());
        let limit = crate::compact::compact_at(window);
        ui.add(egui::Label::new(small(format!("Older steps are folded into a summary on their own once a reply passes {} tokens.", format_tokens(limit)), p.muted)).wrap());

        if let Some(summary) = app.conv.summary.clone() {
            ui.add_space(12.0);
            widgets::rule(ui);
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                let mut what = if summary.manual { "Compacted".to_string() } else { "Older turns summarised".to_string() };
                if let Some(n) = summary.covered_turns.filter(|n| *n > 0) {
                    what += &format!(" · {n} messages");
                }
                ui.label(widgets::lines(what, 12.0, 20.0, W::Regular, p.text2));
                ui.label(widgets::lines(format!(" · {}", ago(&summary.updated_at)), 12.0, 20.0, W::Regular, p.muted));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let label = if app.show_summary { "Hide" } else { "View summary" };
                    if ui.add(egui::Label::new(small(label.into(), p.accent_light)).sense(Sense::click())).on_hover_cursor(CursorIcon::PointingHand).clicked() {
                        app.show_summary = !app.show_summary;
                    }
                });
            });
            if app.show_summary {
                ui.add_space(6.0);
                egui::Frame::new().fill(alpha(p.hover, 60.0)).corner_radius(8).inner_margin(egui::Margin::same(8)).show(ui, |ui| {
                    egui::ScrollArea::vertical().id_salt("summary").max_height(192.0).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.add(egui::Label::new(small(summary.text.clone(), p.text2)).wrap());
                    });
                });
            }
        }

        let totals = app.totals();
        if totals.tokens > 0 {
            ui.add_space(12.0);
            widgets::rule(ui);
            ui.add_space(10.0);
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = vec2(12.0, 2.0);
                ui.label(widgets::text("This chat", 11.0, W::Medium, p.text2));
                ui.label(small(format!("{} tokens", super::chat::thousands(totals.tokens)), p.muted));
                if totals.priced > 0 {
                    ui.label(small(super::chat::format_cost(totals.cost), p.muted));
                }
                if totals.ms > 0 {
                    ui.label(small(super::chat::format_duration(totals.ms), p.muted));
                }
                ui.label(small(format!("{} messages", totals.messages), p.muted));
            });
        }

        ui.add_space(12.0);
        widgets::rule(ui);
        ui.add_space(10.0);
        let blocked = if app.running_here() { Some("Compact is available once the reply finishes.") } else { crate::summary::compact_blocker(&app.conv) };
        match blocked {
            // Right after a compaction "nothing new to compact" is true and beside the point: the line below says what it did.
            Some(_) if app.compact_note.as_ref().is_some_and(|(done, _)| *done) => {}
            Some(why) => {
                ui.label(small(why.into(), p.muted));
            }
            None => {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let busy = app.compacting();
                    let button = if busy { "Compacting…" } else { "Compact" };
                    let button_width = widgets::galley(ui, button, theme::font(12.0, W::Medium), Color32::WHITE).size().x + 20.0;
                    egui::Frame::new().stroke(Stroke::new(1.0, p.border)).corner_radius(8).inner_margin(egui::Margin::symmetric(8, 4)).show(ui, |ui| {
                        ui.add_enabled(!busy, egui::TextEdit::singleline(&mut app.compact_focus).hint_text(widgets::text("Keep in focus (optional)", 12.0, W::Regular, p.muted)).font(theme::font(12.0, W::Regular)).desired_width(ui.available_width() - button_width - 24.0).frame(egui::Frame::NONE));
                    });
                    if widgets::small_btn(ui, button, Color32::WHITE, if busy { alpha(p.accent, 60.0) } else { p.accent }, Color32::TRANSPARENT).clicked() && !busy {
                        let focus = app.compact_focus.trim().to_string();
                        app.compact(ui.ctx(), focus);
                    }
                });
            }
        }
        if let Some((ok, text)) = &app.compact_note {
            ui.add_space(6.0);
            ui.add(egui::Label::new(small(text.clone(), if *ok { p.success } else { p.danger })).wrap());
        }
        ui.add_space(6.0);
        ui.add(egui::Label::new(small("Compact replaces the conversation with a summary for the model — your transcript stays on screen. Also: /compact in the message box.".into(), p.muted)).wrap());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_words() {
        assert_eq!(resume_note(" Resume "), Some(""));
        assert_eq!(resume_note("continue, and also fix the header"), Some("and also fix the header"));
        assert_eq!(resume_note("carry on — use tabs"), Some("use tabs"));
        for not_one in ["continued fraction maths", "resumes are hard", "please continue", "go online"] {
            assert_eq!(resume_note(not_one), None, "{not_one}");
        }
    }

    #[test]
    fn btw_notes() {
        assert_eq!(btw_note("btw fix the header too"), Some("fix the header too"));
        assert_eq!(btw_note("  BTW, : use tabs\nnot spaces "), Some("use tabs\nnot spaces"));
        for not_one in ["btw", "btw ", "btwfix it", "by the way fix it", "bt", "б btw x"] {
            assert_eq!(btw_note(not_one), None, "{not_one}");
        }
    }
}
