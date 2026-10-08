//! The conversation column and the composer under it.

use super::{App, Dialog, theme};
use crate::models;
use crate::refusal::{self, RefusalSource};
use crate::store::{Message, Part, Role, ToolEvent};
use eframe::egui::{self, RichText};
use egui_commonmark::CommonMarkViewer;

const COLUMN: f32 = 780.0;

enum Action {
    Retry,
    Copy(String),
    Settings,
}

pub fn messages(app: &mut App, ui: &mut egui::Ui) {
    let running = app.running_here();
    let mut action = None;

    if app.conv.messages.is_empty() {
        welcome(app, ui);
        return;
    }

    let App { conv, md, heights, run, settings, .. } = app;
    egui::ScrollArea::vertical().auto_shrink(false).stick_to_bottom(true).show(ui, |ui| {
        let column = (ui.available_width() - 32.0).min(COLUMN);
        let pad = ((ui.available_width() - column) / 2.0).max(16.0);
        ui.add_space(12.0);
        let last = conv.messages.len() - 1;
        for (i, msg) in conv.messages.iter().enumerate() {
            let live = running && i == last;
            // Replies off screen are not laid out at all: they keep their measured height.
            if let Some(&(w, h)) = heights.get(&msg.id) {
                let rect = egui::Rect::from_min_size(ui.cursor().min, egui::vec2(ui.available_width(), h));
                if !live && w == column && !ui.is_rect_visible(rect) {
                    ui.allocate_space(egui::vec2(ui.available_width(), h));
                    continue;
                }
            }
            let top = ui.cursor().min.y;
            ui.horizontal_top(|ui| {
                ui.add_space(pad);
                ui.vertical(|ui| {
                    ui.set_width(column);
                    ui.push_id(&msg.id, |ui| match msg.role {
                        Role::User => user_bubble(ui, msg),
                        Role::Assistant => {
                            let status = run.as_ref().filter(|_| live).map(|r| (r.status, r.drafting.as_ref()));
                            assistant(ui, md, msg, settings, status, i == last && !running, &mut action);
                        }
                    });
                });
            });
            ui.add_space(18.0);
            heights.insert(msg.id.clone(), (column, ui.cursor().min.y - top));
        }
    });

    match action {
        Some(Action::Retry) => app.retry(ui.ctx()),
        Some(Action::Copy(text)) => {
            ui.ctx().copy_text(text);
            app.toast("Copied");
        }
        Some(Action::Settings) => app.dialog = Dialog::Settings,
        None => {}
    }
}

fn welcome(app: &mut App, ui: &mut egui::Ui) {
    let has_key = crate::provider::resolve_target(&app.settings.model, &app.settings).is_ok();
    ui.vertical_centered(|ui| {
        ui.add_space((ui.available_height() * 0.30).max(24.0));
        ui.label(RichText::new("How can I help you today?").font(egui::FontId::new(30.0, theme::serif())));
        ui.add_space(8.0);
        if has_key {
            ui.label(theme::secondary("Ask a question, or give it a task: it can write, run and fix files in this chat's workspace."));
        } else {
            ui.label(theme::secondary("Add an OpenRouter or DeepSeek API key to start chatting.\nYour keys stay on this PC. Nothing leaves this app except your requests."));
            ui.add_space(12.0);
            if ui.add(egui::Button::new(RichText::new("🔑  Add API keys").color(egui::Color32::WHITE).strong()).fill(theme::ACCENT).min_size(egui::vec2(140.0, 36.0))).clicked() {
                app.dialog = Dialog::Settings;
                app.settings_tab = 0;
            }
        }
    });
}

fn image(ui: &mut egui::Ui, path: &std::path::Path, max_width: f32) {
    let uri = format!("file://{}", path.display().to_string().replace('\\', "/"));
    let shown = ui.add(egui::Image::new(uri.clone()).max_width(max_width.min(ui.available_width())).max_height(360.0).corner_radius(8).sense(egui::Sense::click()));
    if shown.on_hover_text("Click to open").clicked() {
        ui.ctx().open_url(egui::OpenUrl::new_tab(uri));
    }
}

fn user_bubble(ui: &mut egui::Ui, msg: &Message) {
    // Measured first so the bubble hugs its text and sits on the right.
    const CHROME: f32 = 26.0;
    let room = ui.available_width() * 0.82 - CHROME;
    let galley = ui.painter().layout(msg.text(), egui::TextStyle::Body.resolve(ui.style()), theme::TEXT, room);
    let width = if msg.attachments.is_empty() { galley.size().x } else { galley.size().x.max(room.min(260.0)) };
    ui.horizontal_top(|ui| {
        ui.add_space((ui.available_width() - width - CHROME - ui.spacing().item_spacing.x).max(0.0));
        theme::card(theme::BG_ELEVATED).show(ui, |ui| {
            ui.vertical(|ui| {
                ui.set_width(width);
                for path in &msg.attachments {
                    image(ui, path, 260.0);
                }
                ui.label(galley);
            });
        });
    });
}

/// A short verb for the step row, and what it acted on.
fn step_label(tool: &ToolEvent) -> (String, String) {
    let args: serde_json::Value = serde_json::from_str(&tool.args).unwrap_or_default();
    let arg = |key: &str| args[key].as_str().unwrap_or("").to_string();
    let count = |key: &str| args[key].as_array().map_or(0, Vec::len);
    let (verb, target) = match tool.name.as_str() {
        "list_files" => ("List files", arg("path")),
        "read_file" => ("Read", arg("path")),
        "read_files" => ("Read", format!("{} files", count("paths"))),
        "write_file" => ("Write", arg("path")),
        "write_files" => ("Write", format!("{} files", count("files"))),
        "edit_file" => ("Edit", arg("path")),
        "edit_files" => ("Edit", format!("{} places", count("edits"))),
        "replace_in_files" => ("Replace", arg("find")),
        "search_files" => ("Search", arg("query")),
        "delete_file" => ("Delete", arg("path")),
        "move_file" => ("Move", format!("{} → {}", arg("from"), arg("to"))),
        "undo_file" => ("Undo", arg("path")),
        "run_command" | "start_process" => {
            let rest: Vec<String> = args["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
            (if tool.name == "run_command" { "Run" } else { "Start" }, format!("{} {}", arg("command"), rest.join(" ")))
        }
        "run_tests" => ("Run tests", arg("filter")),
        "read_process" => ("Read output", arg("id")),
        "write_process" => ("Type into", arg("id")),
        "stop_process" => ("Stop", arg("id")),
        "list_processes" => ("List processes", String::new()),
        "wait_for_output" => ("Wait for", if arg("pattern").is_empty() { arg("id") } else { arg("pattern") }),
        "fetch_url" => ("Open", arg("url")),
        "http_request" => ("Request", arg("url")),
        "download_file" => ("Download", arg("url")),
        "web_search" => ("Search the web", arg("query")),
        "make_plan" => ("Plan", arg("goal")),
        "update_plan" => ("Update plan", String::new()),
        "ask_user" => ("Ask", arg("question")),
        "finish" => ("Finish", String::new()),
        "note_finding" => ("Note", arg("claim")),
        "view_image" => ("Look at", arg("path")),
        "show_image" => ("Show", arg("path")),
        other => (other, String::new()),
    };
    (verb.to_string(), target)
}

fn step(ui: &mut egui::Ui, tool: &ToolEvent, index: usize) {
    let (verb, target) = step_label(tool);
    let (mark, colour) = match tool.ok {
        None => ("◌", theme::WARNING),
        Some(true) => ("✔", theme::SUCCESS),
        Some(false) => ("✖", theme::DANGER),
    };
    let target: String = target.chars().take(90).collect();
    let mut title = egui::text::LayoutJob::default();
    let font = egui::FontId::proportional(13.0);
    title.append(mark, 0.0, egui::TextFormat::simple(font.clone(), colour));
    title.append(&verb, 8.0, egui::TextFormat::simple(font.clone(), theme::TEXT_SECONDARY));
    title.append(&target, 6.0, egui::TextFormat::simple(egui::FontId::monospace(12.5), theme::TEXT_MUTED));
    egui::CollapsingHeader::new(title).id_salt(("step", index)).show(ui, |ui| {
        if !tool.summary.is_empty() {
            ui.add(egui::Label::new(RichText::new(tool.summary.as_str()).size(12.5).color(if tool.ok == Some(false) { theme::DANGER } else { theme::TEXT_SECONDARY })).wrap());
        }
        let pretty = serde_json::from_str::<serde_json::Value>(&tool.args).ok().and_then(|v| serde_json::to_string_pretty(&v).ok()).unwrap_or_else(|| tool.args.clone());
        let shown: String = pretty.chars().take(4_000).collect();
        ui.add(egui::Label::new(RichText::new(shown).monospace().size(12.0).color(theme::TEXT_MUTED)).wrap());
    });
    if let Some(path) = &tool.image {
        image(ui, path, 520.0);
    }
}

fn duration(ms: u64) -> String {
    match ms / 1000 {
        s if s >= 60 => format!("{}m {}s", s / 60, s % 60),
        s => format!("{s}s"),
    }
}

fn tokens(n: u64) -> String {
    if n >= 1000 { format!("{:.1}k", n as f64 / 1000.0) } else { n.to_string() }
}

#[allow(clippy::too_many_arguments)]
fn assistant(
    ui: &mut egui::Ui,
    md: &mut egui_commonmark::CommonMarkCache,
    msg: &Message,
    settings: &crate::store::Settings,
    live: Option<(&'static str, Option<&(String, usize)>)>,
    can_retry: bool,
    action: &mut Option<Action>,
) {
    for (i, part) in msg.parts.iter().enumerate() {
        match part {
            Part::Text(text) => {
                ui.push_id(i, |ui| CommonMarkViewer::new().show(ui, md, text));
            }
            Part::Thinking { text, ms } => {
                let title = if *ms == 0 { "Thinking…".to_string() } else { format!("Thought for {}", duration((*ms).max(1000))) };
                egui::CollapsingHeader::new(RichText::new(title).size(13.0).color(theme::WARNING)).id_salt(("think", i)).show(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(text.as_str()).size(12.5).color(theme::TEXT_MUTED)).wrap());
                });
            }
            Part::Tool(tool) => step(ui, tool, i),
            Part::Notice(note) => {
                ui.label(RichText::new(note.as_str()).italics().size(12.5).color(theme::TEXT_MUTED));
            }
        }
    }

    if let Some(error) = &msg.error {
        egui::Frame::new().stroke(egui::Stroke::new(1.0, theme::DANGER)).corner_radius(8).inner_margin(egui::Margin::same(10)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.add(egui::Label::new(RichText::new(error.as_str()).color(theme::DANGER)).wrap());
            ui.horizontal(|ui| {
                if can_retry && ui.button("Try again").clicked() {
                    *action = Some(Action::Retry);
                }
                if error.contains("Settings") && ui.button("Open Settings").clicked() {
                    *action = Some(Action::Settings);
                }
            });
        });
    }

    if let Some((status, drafting)) = live {
        ui.horizontal(|ui| {
            ui.spinner();
            let text = match drafting {
                Some((name, chars)) if *chars > 400 => format!("Writing {name} · {} characters", tokens(*chars as u64)),
                _ => format!("{status}…"),
            };
            ui.label(theme::secondary(text));
        });
        return;
    }

    // Who refused, when a reply was blocked: apiM adds no content rules of its own.
    let text = msg.text();
    let model = models::resolve(&msg.model, &settings.custom_models);
    match refusal::refusal_source(&text, msg.finish.as_deref()) {
        Some(RefusalSource::Model) => {
            ui.label(theme::muted(format!("This refusal came from {}, not from apiM. apiM adds no content rules. Try again, rephrase, or pick another model.", model.label)));
        }
        Some(RefusalSource::ContentFilter) => {
            ui.label(theme::muted(format!("{}'s content filter cut this reply short. That check runs on their servers; apiM does not filter what you send or receive.", model.provider.name())));
        }
        None => {}
    }

    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let mut bits = vec![model.short_label.clone()];
        if msg.usage.prompt > 0 {
            bits.push(format!("{} in · {} out", tokens(msg.usage.prompt), tokens(msg.usage.completion)));
        }
        if let Some(cost) = msg.cost.filter(|c| *c > 0.0) {
            bits.push(if cost < 0.01 { format!("${cost:.4}") } else { format!("${cost:.2}") });
        }
        if msg.duration_ms > 0 {
            bits.push(duration(msg.duration_ms));
        }
        ui.label(theme::muted(bits.join("  ·  ")));
        if !text.is_empty() && ui.add(egui::Button::new(theme::muted("Copy")).frame(false)).on_hover_text("Copy this reply").clicked() {
            *action = Some(Action::Copy(text.clone()));
        }
        if can_retry && msg.error.is_none() && ui.add(egui::Button::new(theme::muted("Retry")).frame(false)).on_hover_text("Answer this again").clicked() {
            *action = Some(Action::Retry);
        }
    });
}

// ---------------------------------------------------------------- composer

/// One toolbar control; every chip shares a geometry so the row stays even.
fn chip(ui: &mut egui::Ui, text: impl Into<String>, on: bool) -> egui::Response {
    let colour = if on { theme::ACCENT_LIGHT } else { theme::TEXT_SECONDARY };
    let mut button = egui::Button::new(RichText::new(text).size(13.0).color(colour)).min_size(egui::vec2(0.0, 30.0)).corner_radius(8);
    if on {
        button = button.fill(theme::ACCENT.gamma_multiply(0.14)).stroke(egui::Stroke::new(1.0, theme::ACCENT.gamma_multiply(0.5)));
    }
    ui.add(button)
}

fn prompts(app: &mut App, ui: &mut egui::Ui) {
    let Some(run) = app.run.as_mut().filter(|r| r.conv_id == app.conv.id) else { return };
    if let Some(pending) = &run.approval {
        let mut verdict = None;
        theme::card(theme::BG_TERTIARY).stroke(egui::Stroke::new(1.0, theme::WARNING)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new("Allow this command?").strong());
            ui.add(egui::Label::new(RichText::new(pending.command.as_str()).monospace()).wrap());
            if !pending.reason.is_empty() {
                ui.label(theme::secondary(pending.reason.as_str()));
            }
            ui.horizontal(|ui| {
                if ui.add(egui::Button::new(RichText::new("Allow").color(egui::Color32::WHITE)).fill(theme::ACCENT)).clicked() {
                    verdict = Some(true);
                }
                if ui.button("Deny").clicked() {
                    verdict = Some(false);
                }
                ui.label(theme::muted("Settings → Agent → Auto runs developer tools without asking."));
            });
        });
        if let Some(allow) = verdict {
            if let Some(p) = run.approval.take() {
                let _ = p.reply.send(allow);
            }
        }
        ui.add_space(8.0);
    }
    if let Some(pending) = run.question.as_mut() {
        let mut answer = None;
        theme::card(theme::BG_TERTIARY).stroke(egui::Stroke::new(1.0, theme::SEARCH)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.add(egui::Label::new(RichText::new(pending.question.as_str()).strong()).wrap());
            if !pending.context.is_empty() {
                ui.label(theme::secondary(pending.context.as_str()));
            }
            ui.horizontal_wrapped(|ui| {
                for option in &pending.options {
                    if ui.button(option.as_str()).clicked() {
                        answer = Some(option.clone());
                    }
                }
            });
            ui.horizontal(|ui| {
                let field = ui.add(egui::TextEdit::singleline(&mut pending.answer).hint_text("Or type your own answer").desired_width(ui.available_width() - 150.0));
                let entered = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if (ui.button("Answer").clicked() || entered) && !pending.answer.trim().is_empty() {
                    answer = Some(pending.answer.trim().to_string());
                }
                if ui.button("Skip").clicked() {
                    answer = Some(String::new());
                }
            });
        });
        if let Some(text) = answer {
            if let Some(q) = run.question.take() {
                let _ = q.reply.send(text);
            }
        }
        ui.add_space(8.0);
    }
}

pub fn composer(app: &mut App, ui: &mut egui::Ui) {
    let column = (ui.available_width()).min(COLUMN + 32.0);
    let pad = ((ui.available_width() - column) / 2.0).max(0.0);
    let ctx = ui.ctx().clone();
    ui.horizontal(|ui| {
        ui.add_space(pad);
        ui.vertical(|ui| {
            ui.set_width(column);
            prompts(app, ui);
            theme::card(theme::BG_TERTIARY).corner_radius(16).show(ui, |ui| {
                ui.set_width(ui.available_width());
                attachments_row(app, ui);

                let running = app.running_here();
                let hint = if running { "Reply in progress…" } else { "Ask anything, or describe a task" };
                let edit = egui::TextEdit::multiline(&mut app.draft)
                    .hint_text(hint)
                    .desired_rows(2)
                    .desired_width(f32::INFINITY)
                    .frame(egui::Frame::new())
                    // Enter sends; Shift+Enter makes a new line.
                    .return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, egui::Key::Enter));
                let field = egui::ScrollArea::vertical().max_height(220.0).id_salt("draft").show(ui, |ui| ui.add(edit)).inner;
                if std::mem::take(&mut app.focus_composer) && app.dialog == Dialog::None {
                    field.request_focus();
                }
                let enter = field.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift);

                ui.add_space(4.0);
                let mut send = enter;
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    if chip(ui, "📎", false).on_hover_text("Attach files or images (or drop them on the window)").clicked() {
                        if let Some(picked) = rfd::FileDialog::new().pick_files() {
                            app.attachments.extend(picked);
                        }
                    }
                    model_menu(app, ui);
                    effort_menu(app, ui);
                    if chip(ui, "🌐 Web", app.settings.web_search).on_hover_text("Let the agent search the web (needs a Tavily or Exa key in Settings)").clicked() {
                        app.settings.web_search = !app.settings.web_search;
                        app.settings.save();
                    }
                    let on = app.settings.enabled_plugins.len();
                    if chip(ui, if on > 0 { format!("🔌 Plugins · {on}") } else { "🔌 Plugins".into() }, on > 0).clicked() {
                        app.dialog = Dialog::Plugins;
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if running {
                            if ui.add(egui::Button::new(RichText::new("■").color(egui::Color32::WHITE)).fill(theme::DANGER).min_size(egui::vec2(32.0, 30.0)).corner_radius(15)).on_hover_text("Stop").clicked() {
                                app.stop();
                            }
                        } else {
                            let ready = !app.draft.trim().is_empty() || !app.attachments.is_empty();
                            let fill = if ready { theme::ACCENT } else { theme::BG_ELEVATED };
                            if ui.add(egui::Button::new(RichText::new("↑").color(egui::Color32::WHITE).strong()).fill(fill).min_size(egui::vec2(32.0, 30.0)).corner_radius(15)).on_hover_text("Send (Enter)").clicked() {
                                send = true;
                            }
                        }
                        context_meter(app, ui);
                    });
                });
                if send && !running {
                    app.send(&ctx);
                }
            });
        });
    });
}

fn attachments_row(app: &mut App, ui: &mut egui::Ui) {
    if app.attachments.is_empty() {
        return;
    }
    let mut remove = None;
    ui.horizontal_wrapped(|ui| {
        for (i, path) in app.attachments.iter().enumerate() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if ui.button(format!("{name}  ✕")).on_hover_text("Remove").clicked() {
                remove = Some(i);
            }
        }
    });
    if let Some(i) = remove {
        app.attachments.remove(i);
    }
}

fn model_menu(app: &mut App, ui: &mut egui::Ui) {
    let current = models::resolve(&app.settings.model, &app.settings.custom_models);
    let mut picked = None;
    ui.menu_button(RichText::new(format!("{} ▾", current.short_label)).size(13.0), |ui| {
        ui.set_min_width(300.0);
        for m in models::all(&app.settings.custom_models) {
            let row = ui.add(egui::Button::selectable(m.id == current.id, RichText::new(m.label.as_str()).strong()).right_text(theme::muted(m.provider.name())));
            if row.on_hover_text(format!("{}\n{}", m.description, m.specs)).clicked() {
                picked = Some(m.id.clone());
                ui.close();
            }
        }
        ui.separator();
        if ui.button("Add a custom model…").clicked() {
            app.dialog = Dialog::Settings;
            app.settings_tab = 1;
            ui.close();
        }
    })
    .response
    .on_hover_text("Model");
    if let Some(id) = picked {
        app.settings.model = id;
        app.settings.save();
    }
}

fn effort_menu(app: &mut App, ui: &mut egui::Ui) {
    const EFFORTS: [(&str, &str, &str); 5] = [
        ("auto", "Auto", "Adjusts to how hard the message looks"),
        ("none", "None", "Fastest, no reasoning"),
        ("low", "Low", "Light reasoning"),
        ("high", "High", "Deep reasoning"),
        ("max", "Max", "Maximum depth, slowest and dearest"),
    ];
    let current = EFFORTS.iter().find(|e| e.0 == app.settings.effort).unwrap_or(&EFFORTS[0]);
    let mut picked = None;
    ui.menu_button(RichText::new(format!("✦ {} ▾", current.1)).size(13.0), |ui| {
        for (id, name, blurb) in EFFORTS {
            if ui.add(egui::Button::selectable(id == current.0, name).right_text(theme::muted(blurb))).clicked() {
                picked = Some(id);
                ui.close();
            }
        }
    })
    .response
    .on_hover_text("Thinking effort");
    if let Some(id) = picked {
        app.settings.effort = id.into();
        app.settings.save();
    }
}

/// How full the model's context window is after the last reply.
fn context_meter(app: &App, ui: &mut egui::Ui) {
    let used = app.conv.messages.iter().rev().find(|m| m.role == Role::Assistant && m.usage.context > 0).map_or(0, |m| m.usage.context);
    let window = models::context_window(&app.settings.model, &app.settings.custom_models);
    let percent = (used as f64 / window as f64 * 100.0).min(100.0);
    let colour = if percent > 80.0 { theme::DANGER } else if percent > 50.0 { theme::WARNING } else { theme::TEXT_MUTED };
    ui.label(RichText::new(format!("{percent:.0}%")).size(12.0).color(colour)).on_hover_text(format!("Context used: {} of {} tokens", tokens(used), tokens(window)));
}
