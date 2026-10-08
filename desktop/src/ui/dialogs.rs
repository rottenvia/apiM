//! Settings, plugins and the small confirm dialogs.

use super::{App, Dialog, blank_model, blank_plugin, theme};
use crate::models::{self, CustomModel, Vision};
use crate::plugins::{self, Plugin};
use crate::store::{self, Approval};
use eframe::egui::{self, RichText};
use std::sync::mpsc;

pub fn show(app: &mut App, ctx: &egui::Context) {
    let mut dialog = std::mem::replace(&mut app.dialog, Dialog::None);
    let keep = match &mut dialog {
        Dialog::None => return,
        Dialog::Settings => modal(ctx, "Settings", 600.0, |ui| settings(app, ui)),
        Dialog::Plugins => modal(ctx, "Plugins", 640.0, |ui| plugin_list(app, ui)),
        Dialog::Mcp => modal(ctx, "MCP console", 520.0, |ui| {
            ui.add(egui::Label::new(secondary("MCP servers are not wired into the desktop app yet. The web app's console (npm run dev) can call them.")).wrap());
            true
        }),
        Dialog::Delete { ids, opened } => modal(ctx, if ids.len() == 1 { "Delete chat?" } else { "Delete chats?" }, 420.0, |ui| {
            let what = match ids.as_slice() {
                [id] => format!("“{}” and the files in its workspace will be removed from this PC.", app.chats.iter().find(|c| &c.id == id).map_or("This chat", |c| c.title.as_str())),
                many => format!("{} chats and the files in their workspaces will be removed from this PC.", many.len()),
            };
            ui.add(egui::Label::new(what).wrap());
            // The button unlocks after a pause, so a double click cannot delete by accident.
            let left = (app.settings.delete_delay as f32 - opened.elapsed().as_secs_f32()).max(0.0);
            let mut keep = true;
            ui.horizontal(|ui| {
                let label = if left > 0.0 { format!("Delete ({})", left.ceil() as u32) } else { "Delete".to_string() };
                if ui.add_enabled(left <= 0.0, egui::Button::new(RichText::new(label).color(egui::Color32::WHITE)).fill(theme::p().danger)).clicked() {
                    app.delete_chats(ids);
                    keep = false;
                }
                keep &= !ui.button("Cancel").clicked();
            });
            if left > 0.0 {
                ui.ctx().request_repaint_after(std::time::Duration::from_millis(100));
            }
            keep
        }),
        Dialog::Search => false,
        Dialog::Preview(path, text) => modal(ctx, path, 820.0, |ui| {
            if ui.button("Copy").clicked() {
                ui.ctx().copy_text(text.clone());
            }
            egui::ScrollArea::both().max_height(ui.ctx().content_rect().height() - 220.0).auto_shrink(false).show(ui, |ui| {
                ui.add(egui::Label::new(RichText::new(text.as_str()).monospace().size(12.5)).extend());
            });
            true
        }),
    };
    if keep && app.dialog == Dialog::None {
        app.dialog = dialog;
    }
}

/// A centred dialog with a title and a close button. False once it should close.
fn modal(ctx: &egui::Context, title: &str, width: f32, body: impl FnOnce(&mut egui::Ui) -> bool) -> bool {
    let frame = egui::Frame::new().fill(theme::p().bg3).stroke(egui::Stroke::new(1.0, theme::p().border_light)).corner_radius(14).inner_margin(egui::Margin::same(18));
    let mut open = true;
    // egui caps a new area at 600x400 unless told how much room there is.
    let id = egui::Id::new("dialog");
    let area = egui::Modal::default_area(id).default_size(ctx.content_rect().size() - egui::vec2(48.0, 80.0));
    let shown = egui::Modal::new(id).area(area).frame(frame).show(ctx, |ui| {
        ui.set_width(width.min(ctx.content_rect().width() - 48.0));
        ui.horizontal(|ui| {
            ui.add(egui::Label::new(RichText::new(title).font(theme::serif(20.0))).truncate());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                open = !ui.add(egui::Button::new("✕").frame_when_inactive(false)).clicked();
            });
        });
        ui.add_space(8.0);
        body(ui)
    });
    open && shown.inner && !shown.should_close()
}

fn primary(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(egui::Button::new(RichText::new(text).color(egui::Color32::WHITE)).fill(theme::p().accent))
}

fn muted(text: impl Into<String>) -> RichText {
    RichText::new(text).size(12.5).color(theme::p().muted)
}

fn secondary(text: impl Into<String>) -> RichText {
    RichText::new(text).color(theme::p().text2)
}

// ---------------------------------------------------------------- settings

fn settings(app: &mut App, ui: &mut egui::Ui) -> bool {
    let before = app.settings.clone();
    ui.horizontal(|ui| {
        for (i, name) in ["API keys", "Models", "Agent"].into_iter().enumerate() {
            ui.selectable_value(&mut app.settings_tab, i, name);
        }
    });
    ui.separator();
    egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() - 220.0).show(ui, |ui| match app.settings_tab {
        0 => keys_tab(app, ui),
        1 => models_tab(app, ui),
        _ => agent_tab(app, ui),
    });
    if app.settings != before {
        app.settings.save();
    }
    true
}

fn key_field(ui: &mut egui::Ui, label: &str, value: &mut String, env: &str, link: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).strong());
        ui.hyperlink_to(muted("get a key"), link);
    });
    let hint = if std::env::var(env).is_ok_and(|v| !v.trim().is_empty()) { format!("Using {env} from the environment") } else { "Paste the key here".into() };
    ui.add(egui::TextEdit::singleline(value).password(true).hint_text(hint).desired_width(f32::INFINITY));
    ui.add_space(8.0);
}

fn keys_tab(app: &mut App, ui: &mut egui::Ui) {
    let s = &mut app.settings;
    ui.label(secondary("Keys are saved on this PC only and go straight to the provider you chose."));
    ui.add_space(8.0);
    key_field(ui, "OpenRouter", &mut s.openrouter_key, "OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys");
    key_field(ui, "DeepSeek", &mut s.deepseek_key, "DEEPSEEK_API_KEY", "https://platform.deepseek.com/api_keys");
    ui.label(secondary("Web search uses the first one of these that has a key."));
    key_field(ui, "Tavily", &mut s.tavily_key, "TAVILY_API_KEY", "https://app.tavily.com");
    key_field(ui, "Exa", &mut s.exa_key, "EXA_API_KEY", "https://dashboard.exa.ai/api-keys");

    ui.separator();
    ui.label(RichText::new("Model on this PC").strong());
    ui.label(secondary("Any OpenAI-compatible server: llama.cpp, Ollama, LM Studio. Leave empty for the default address."));
    egui::Grid::new("local").num_columns(2).show(ui, |ui| {
        ui.label("Address");
        ui.add(egui::TextEdit::singleline(&mut s.local_base_url).hint_text(crate::provider::DEFAULT_LOCAL_BASE_URL).desired_width(360.0));
        ui.end_row();
        ui.label("Model name");
        ui.add(egui::TextEdit::singleline(&mut s.local_api_model).hint_text("as the server calls it").desired_width(360.0));
        ui.end_row();
        ui.label("Key");
        ui.add(egui::TextEdit::singleline(&mut s.local_api_key).password(true).hint_text("usually not needed").desired_width(360.0));
        ui.end_row();
    });
}

fn models_tab(app: &mut App, ui: &mut egui::Ui) {
    ui.label(RichText::new("Default model").strong());
    let current = models::resolve(&app.settings.model, &app.settings.custom_models);
    egui::ComboBox::from_id_salt("default-model").selected_text(current.label.as_str()).width(320.0).show_ui(ui, |ui| {
        for m in models::all(&app.settings.custom_models) {
            ui.selectable_value(&mut app.settings.model, m.id.clone(), format!("{}  ·  {}", m.label, m.provider.name()));
        }
    });
    ui.label(muted(format!("{}  ·  {}", current.description, current.specs)));
    ui.separator();

    ui.label(RichText::new("Your OpenRouter models").strong());
    let mut remove = None;
    for (i, m) in app.settings.custom_models.iter().enumerate() {
        ui.horizontal(|ui| {
            ui.label(m.label.as_str());
            ui.label(muted(m.to_info().specs));
            if ui.small_button("Remove").clicked() {
                remove = Some(i);
            }
        });
    }
    if let Some(i) = remove {
        let gone = app.settings.custom_models.remove(i);
        if app.settings.model == gone.id() {
            app.settings.model = models::DEFAULT_MODEL_ID.into();
        }
    }

    ui.add_space(6.0);
    ui.label(secondary("Add any model OpenRouter serves by its slug, for example anthropic/claude-sonnet-5-5."));
    let draft = &mut app.new_model;
    egui::Grid::new("new-model").num_columns(2).show(ui, |ui| {
        ui.label("Slug");
        ui.add(egui::TextEdit::singleline(&mut draft.api_model).hint_text("vendor/model-name").desired_width(360.0));
        ui.end_row();
        ui.label("Name");
        ui.add(egui::TextEdit::singleline(&mut draft.label).hint_text("shown in the model list").desired_width(360.0));
        ui.end_row();
        ui.label("Images");
        ui.horizontal(|ui| {
            ui.selectable_value(&mut draft.vision, Vision::None, "Text only");
            ui.selectable_value(&mut draft.vision, Vision::Native, "Sees images");
        });
        ui.end_row();
    });

    if let Some(result) = app.verify.as_ref().and_then(|rx| rx.try_recv().ok()) {
        app.verify = None;
        match result {
            Ok(found) => {
                app.verify_note = format!("Found: {}", found.to_info().specs);
                app.new_model = found;
            }
            Err(problem) => app.verify_note = problem,
        }
    }
    let slug = app.new_model.api_model.trim().to_string();
    let valid = models::valid_slug(&slug);
    ui.horizontal(|ui| {
        if ui.add_enabled(valid && app.verify.is_none(), egui::Button::new("Check on OpenRouter")).on_hover_text("Reads the context size and prices from OpenRouter's public model list").clicked() {
            let (tx, rx) = mpsc::channel();
            let wake = ui.ctx().clone();
            let wanted = slug.clone();
            app.rt.spawn(async move {
                let _ = tx.send(lookup(&wanted).await);
                wake.request_repaint();
            });
            app.verify = Some(rx);
            app.verify_note = "Checking…".into();
        }
        if ui.add_enabled(valid, egui::Button::new(RichText::new("Add model").color(egui::Color32::WHITE)).fill(theme::p().accent)).clicked() {
            let mut model = std::mem::replace(&mut app.new_model, blank_model());
            model.api_model = slug.clone();
            if model.label.trim().is_empty() {
                model.label = slug.rsplit('/').next().unwrap_or(&slug).to_string();
            }
            app.settings.custom_models.retain(|m| m.api_model != model.api_model);
            app.settings.model = model.id();
            app.settings.custom_models.push(model);
            app.verify_note.clear();
        }
    });
    if !slug.is_empty() && !valid {
        ui.label(RichText::new("That does not look like an OpenRouter slug (vendor/model-name).").color(theme::p().warning));
    }
    if !app.verify_note.is_empty() {
        ui.label(secondary(app.verify_note.as_str()));
    }
}

/// Looks a slug up in OpenRouter's public model list (no key needed).
async fn lookup(slug: &str) -> Result<CustomModel, String> {
    let list: serde_json::Value = crate::provider::client()
        .get("https://openrouter.ai/api/v1/models")
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?
        .json()
        .await
        .map_err(|e| format!("OpenRouter sent an unreadable list: {e}"))?;
    let found = list["data"].as_array().into_iter().flatten().find(|m| m["id"] == slug).ok_or_else(|| format!("OpenRouter has no model called {slug}."))?;
    // Prices arrive as USD per token, in strings.
    let per_million = |key: &str| found["pricing"][key].as_str().and_then(|p| p.parse::<f64>().ok()).map(|p| (p * 1e9).round() / 1e3);
    let sees = found["architecture"]["input_modalities"].as_array().is_some_and(|m| m.iter().any(|x| x == "image"));
    Ok(CustomModel {
        api_model: slug.to_string(),
        label: found["name"].as_str().unwrap_or(slug).to_string(),
        vision: if sees { Vision::Native } else { Vision::None },
        max_output_tokens: found["top_provider"]["max_completion_tokens"].as_u64().map_or(65_536, |n| n.min(u32::MAX as u64) as u32),
        context_length: found["context_length"].as_u64(),
        input_price: per_million("prompt"),
        output_price: per_million("completion"),
    })
}

fn agent_tab(app: &mut App, ui: &mut egui::Ui) {
    let s = &mut app.settings;
    ui.label(RichText::new("Running commands").strong());
    ui.radio_value(&mut s.approval, Approval::Manual, "Manual: ask me before a command runs");
    ui.label(muted("Reading files and read-only commands never ask."));
    ui.radio_value(&mut s.approval, Approval::Auto, "Auto: run developer tools without asking");
    ui.label(muted("git, npm, cargo, python and the like run straight away. Shells, unknown programs and programs built in the workspace still ask."));
    ui.separator();

    ui.label(RichText::new("Spending limit per reply").strong());
    let mut capped = s.budget_usd.is_some();
    ui.horizontal(|ui| {
        ui.checkbox(&mut capped, "Stop a reply once it has cost");
        let mut amount = s.budget_usd.unwrap_or(0.50);
        ui.add_enabled(capped, egui::DragValue::new(&mut amount).speed(0.05).range(0.01..=500.0).prefix("$").fixed_decimals(2));
        s.budget_usd = capped.then_some(amount);
    });
    ui.separator();

    ui.label(RichText::new("Text size").strong());
    ui.horizontal(|ui| {
        let mut zoom = s.zoom;
        if ui.button("−").clicked() {
            zoom -= 0.1;
        }
        ui.label(format!("{:.0}%", s.zoom * 100.0));
        if ui.button("＋").clicked() {
            zoom += 0.1;
        }
        if ui.button("Reset").clicked() {
            zoom = 1.0;
        }
        zoom = zoom.clamp(0.6, 2.0);
        if zoom != s.zoom {
            s.zoom = zoom;
            ui.ctx().set_zoom_factor(zoom);
        }
    });
    ui.separator();
    ui.label(muted(format!("Chats and settings live in {}", store::data_dir().display())));
}

// ---------------------------------------------------------------- plugins

fn plugin_list(app: &mut App, ui: &mut egui::Ui) -> bool {
    let before = app.settings.clone();
    ui.label(secondary("A plugin is a standing instruction the model follows in every reply while it is on."));
    ui.add_space(6.0);
    egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() - 220.0).show(ui, |ui| {
        let mut edit = None;
        let mut remove = None;
        for p in plugins::all(&app.settings.custom_plugins) {
            let custom = p.category == "custom";
            let mut on = app.settings.enabled_plugins.contains(&p.id);
            ui.horizontal(|ui| {
                if super::widgets::toggle(ui, &mut on).changed() {
                    app.settings.enabled_plugins.retain(|id| id != &p.id);
                    if on {
                        app.settings.enabled_plugins.push(p.id.clone());
                    }
                }
                ui.label(RichText::new(p.name.as_str()).strong());
                if custom {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("Delete").clicked() {
                            remove = Some(p.id.clone());
                        }
                        if ui.small_button("Edit").clicked() {
                            edit = Some(p.clone());
                        }
                    });
                }
            });
            if !p.description.is_empty() {
                ui.add(egui::Label::new(muted(p.description.as_str())).wrap());
            }
            ui.add_space(4.0);
        }
        if let Some(id) = remove {
            app.settings.custom_plugins.retain(|p| p.id != id);
            app.settings.enabled_plugins.retain(|e| e != &id);
        }
        if let Some(p) = edit {
            app.new_plugin = p;
        }

        ui.separator();
        let editing = !app.new_plugin.id.is_empty();
        ui.label(RichText::new(if editing { "Edit your plugin" } else { "Write your own" }).strong());
        let draft = &mut app.new_plugin;
        ui.add(egui::TextEdit::singleline(&mut draft.name).hint_text("Name").desired_width(f32::INFINITY));
        ui.add(egui::TextEdit::singleline(&mut draft.description).hint_text("What it does, in one line (optional)").desired_width(f32::INFINITY));
        ui.add(egui::TextEdit::multiline(&mut draft.prompt).hint_text("The instruction, for example: Always answer in Russian.").desired_rows(4).desired_width(f32::INFINITY));
        let too_long = draft.prompt.len() > plugins::MAX_PLUGIN_PROMPT;
        if too_long {
            ui.label(RichText::new(format!("Too long: {} of {} characters.", draft.prompt.len(), plugins::MAX_PLUGIN_PROMPT)).color(theme::p().warning));
        }
        let ready = !draft.name.trim().is_empty() && !draft.prompt.trim().is_empty() && !too_long;
        ui.horizontal(|ui| {
            if ui.add_enabled(ready, egui::Button::new(RichText::new(if editing { "Save" } else { "Add plugin" }).color(egui::Color32::WHITE)).fill(theme::p().accent)).clicked() {
                let mut plugin: Plugin = std::mem::replace(&mut app.new_plugin, blank_plugin());
                if plugin.id.is_empty() {
                    plugin.id = format!("custom-{}", store::new_id());
                    app.settings.enabled_plugins.push(plugin.id.clone());
                }
                app.settings.custom_plugins.retain(|p| p.id != plugin.id);
                app.settings.custom_plugins.push(plugin);
            } else if editing && ui.button("Cancel").clicked() {
                app.new_plugin = blank_plugin();
            }
        });
    });
    if app.settings != before {
        app.settings.save();
    }
    true
}
