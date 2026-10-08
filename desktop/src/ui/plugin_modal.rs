//! The Plugins dialog (src/components/PluginsModal.tsx): the list with its
//! switches, and the editor for the user's own plugins.

use super::form::{self, Btn, Input, Switch};
use super::overlay::{self, Card};
use super::settings::{close_btn, part};
use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use crate::plugins::{self, Plugin};
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, Ui, pos2, vec2};

#[derive(Default)]
pub struct State {
    /// The plugin being written or changed. None shows the list.
    editor: Option<Draft>,
}

impl State {
    /// The dialog with the editor open on a blank plugin.
    pub fn writing() -> State {
        State { editor: Some(Draft::blank()) }
    }
}

struct Draft {
    /// Empty for a new plugin.
    id: String,
    icon: String,
    name: String,
    description: String,
    category: String,
    prompt: String,
    error: String,
}

impl Draft {
    fn blank() -> Draft {
        Draft { id: String::new(), icon: "✨".into(), name: String::new(), description: String::new(), category: "enhancement".into(), prompt: String::new(), error: String::new() }
    }
    fn from(plugin: &Plugin, copy: bool) -> Draft {
        Draft {
            id: if copy { String::new() } else { plugin.id.clone() },
            icon: if plugin.icon.is_empty() { "✨".into() } else { plugin.icon.clone() },
            name: if copy { format!("{} (copy)", plugin.name) } else { plugin.name.clone() },
            description: plugin.description.clone(),
            category: if plugin.category.is_empty() { "enhancement".into() } else { plugin.category.clone() },
            prompt: plugin.prompt.clone(),
            error: String::new(),
        }
    }
}

/// About how many tokens `chars` characters of instructions cost on every request.
fn tokens(chars: usize) -> usize {
    (chars as f64 / 3.6).ceil() as usize
}

pub fn show(app: &mut App, ctx: &egui::Context) -> bool {
    let p = p();
    let before = app.settings.clone();
    let editing = app.plugin_ui.editor.is_some();
    // Esc leaves the editor first, and the dialog only from the list.
    if editing && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Escape)) {
        app.plugin_ui.editor = None;
    }
    let height = (ctx.content_rect().height() * 0.86).min(640.0);
    let shown = Card::new("plugins", 672.0, height).show(ctx, |ui, close| {
        let rect = ui.max_rect();
        let editing = app.plugin_ui.editor.is_some();
        let (head, rest) = rect.split_top_bottom_at_y(rect.top() + 79.0);
        let (body, foot) = rest.split_top_bottom_at_y(rest.bottom() - if editing { 67.0 } else { 65.0 });
        let line = Stroke::new(1.0, p.border);
        ui.painter().hline(head.x_range(), head.bottom() - 0.5, line);
        ui.painter().hline(foot.x_range(), foot.top() + 0.5, line);

        let (title, sub) = match &app.plugin_ui.editor {
            None => ("Plugins", "Active styles are sent as a dedicated system instruction every round"),
            Some(d) => (if d.id.is_empty() { "New plugin" } else { "Edit plugin" }, "Instructions added to the system prompt when enabled"),
        };
        part(ui, head, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(24, 16)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if close_btn(ui, 36.0, 12.0, 20.0, "").clicked() {
                            // In the editor the X only leaves the editor.
                            if editing {
                                app.plugin_ui.editor = None;
                            } else {
                                *close = true;
                            }
                        }
                        ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                            form::line(ui, title, 18.0, 28.0, W::Bold, p.text);
                            ui.add_space(2.0);
                            form::line(ui, sub, 12.0, 16.0, W::Regular, p.text2);
                        });
                    });
                });
            });
        });

        let mut save = false;
        part(ui, body, |ui| {
            egui::ScrollArea::vertical().id_salt(("plugins", editing)).auto_shrink(false).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::symmetric(24, 20)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                    match app.plugin_ui.editor.as_mut() {
                        Some(draft) => editor(ui, draft),
                        None => list(app, ui),
                    }
                });
            });
        });

        part(ui, foot.with_min_y(foot.top() + 1.0), |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(24, 14)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 12.0;
                        match app.plugin_ui.editor.as_ref() {
                            Some(draft) => {
                                let ready = !draft.name.trim().is_empty() && !draft.prompt.trim().is_empty();
                                save = Btn::accent(if draft.id.is_empty() { "Create plugin" } else { "Save changes" }).text(14.0, 20.0).pad(16.0, 8.0).radius(12.0).enabled(ready).show(ui).clicked();
                                if Btn::outline("Cancel").text(14.0, 20.0).weight(W::Regular).pad(14.0, 8.0).radius(12.0).show(ui).clicked() {
                                    app.plugin_ui.editor = None;
                                }
                            }
                            None => {
                                if Btn::accent("New plugin").text(14.0, 20.0).pad(14.0, 8.0).radius(12.0).icon(icons::PLUS.stroke(2.2), 14.0).show(ui).clicked() {
                                    app.plugin_ui.editor = Some(Draft::blank());
                                }
                                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| active_line(app, ui));
                            }
                        }
                    });
                });
            });
        });

        if save {
            let Some(draft) = app.plugin_ui.editor.as_mut() else { return };
            let typed = Plugin { id: draft.id.clone(), name: draft.name.clone(), icon: draft.icon.clone(), description: draft.description.clone(), category: draft.category.clone(), prompt: draft.prompt.clone(), ..Plugin::default() };
            match plugins::save(&typed) {
                Ok(_) => {
                    app.settings.custom_plugins = plugins::custom();
                    app.plugin_ui.editor = None;
                }
                Err(why) => draft.error = why,
            }
        }
    });
    if app.settings != before {
        app.settings.save();
    }
    shown == overlay::State::Open
}

/// "2 active · ~310 tokens per request" at the foot of the list.
fn active_line(app: &App, ui: &mut Ui) {
    let p = p();
    let every = plugins::all(&app.settings.custom_plugins);
    let on: Vec<&Plugin> = every.iter().filter(|q| app.settings.enabled_plugins.contains(&q.id)).collect();
    let chars: usize = on.iter().map(|q| q.prompt.chars().count()).sum();
    let over = chars > plugins::MAX_PLUGIN_TOTAL;
    let mut text = format!("{} active", on.len());
    if !on.is_empty() {
        text += &format!(" · ~{} tokens per request", plugins::grouped(tokens(chars)));
        if over {
            text += " — over budget, some are ignored";
        }
    }
    let tip = if over { "Over the 250,000 character budget — the ones past it are left out of the prompt." } else { "Added to every request while these are on. Cached after the first round of a conversation." };
    form::line(ui, &text, 12.0, 16.0, W::Regular, if over { p.danger } else { p.muted }).on_hover_text(tip);
}

/// A small heading over a group of cards.
fn heading(ui: &mut Ui, text: &str, below: f32) {
    let mut job = egui::text::LayoutJob::default();
    job.append(&text.to_uppercase(), 0.0, egui::TextFormat { font_id: theme::font(11.0, W::Semibold), color: p().muted, line_height: Some(16.5), extra_letter_spacing: 1.1, ..Default::default() });
    ui.add(egui::Label::new(job).selectable(false));
    ui.add_space(below);
}

fn list(app: &mut App, ui: &mut Ui) {
    let p = p();
    let custom = app.settings.custom_plugins.clone();
    let (current, classic): (Vec<&Plugin>, Vec<&Plugin>) = plugins::BUILTIN.iter().partition(|q| !q.legacy);
    if !custom.is_empty() {
        heading(ui, "Your plugins", 8.0);
        for plugin in &custom {
            card(app, ui, plugin, true);
            ui.add_space(8.0);
        }
        ui.add_space(8.0);
    }
    heading(ui, "Built in", 8.0);
    for plugin in current {
        card(app, ui, plugin, false);
        ui.add_space(8.0);
    }
    ui.add_space(8.0);
    heading(ui, "Classic", 4.0);
    form::para(ui, "The original wording, kept so an older chat can be continued in the voice it was written in. These sit earlier in the prompt than the current versions, so they carry less weight.", 11.0, 16.0, W::Regular, p.muted);
    ui.add_space(8.0);
    for (i, plugin) in classic.into_iter().enumerate() {
        if i > 0 {
            ui.add_space(8.0);
        }
        card(app, ui, plugin, false);
    }
}

/// A 28px icon button that only shows while its card is hovered.
fn hover_btn(ui: &mut Ui, icon: icons::Icon, seen: bool, danger: bool, tip: &str) -> egui::Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let show = widgets::fade(ui, response.id.with("seen"), seen || response.has_focus());
    let t = widgets::fade(ui, response.id, response.hovered());
    let (fill, ink) = if danger { (alpha(p.danger, 15.0), p.danger) } else { (p.hover, p.text) };
    ui.painter().rect_filled(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, fill, t).gamma_multiply(show));
    icons::paint(ui, icon, rect.center(), 13.0, widgets::lerp(p.muted, ink, t).gamma_multiply(show));
    response.on_hover_text(tip)
}

fn card(app: &mut App, ui: &mut Ui, plugin: &Plugin, yours: bool) {
    let p = p();
    let on = app.settings.enabled_plugins.contains(&plugin.id);
    // Hovered last frame: the card's size is only known once it is laid out.
    let seen_id = ui.id().with(("plugin-card", &plugin.id));
    let hovered = ui.data(|d| d.get_temp::<Rect>(seen_id)).is_some_and(|r| ui.rect_contains_pointer(r));
    let (fill, border) = if on { (alpha(p.accent, 7.0), alpha(p.accent, 40.0)) } else { (alpha(p.bg3, 40.0), p.border) };
    let mut toggle = false;
    let frame = egui::Frame::new().fill(fill).stroke(Stroke::new(1.0, border)).corner_radius(12).inner_margin(egui::Margin::same(12)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.add_space(2.0);
                ui.add(egui::Label::new(widgets::lines(&plugin.icon, 18.0, 18.0, W::Regular, p.text)).selectable(false));
            });
            ui.add_space(12.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                ui.allocate_ui_with_layout(vec2(36.0, 28.0), egui::Layout::left_to_right(egui::Align::Center), |ui| toggle = form::switch(ui, Switch::D, on).clicked());
                if yours {
                    if hover_btn(ui, icons::TRASH.stroke(1.8), hovered, true, "Delete").clicked() {
                        let _ = plugins::delete(&plugin.id);
                        app.settings.custom_plugins = plugins::custom();
                        app.settings.enabled_plugins.retain(|id| id != &plugin.id);
                    }
                    if hover_btn(ui, icons::RENAME.stroke(1.8), hovered, false, "Edit").clicked() {
                        app.plugin_ui.editor = Some(Draft::from(plugin, false));
                    }
                } else if hover_btn(ui, icons::COPY_SMALL, hovered, false, "Duplicate as your own").clicked() {
                    app.plugin_ui.editor = Some(Draft::from(plugin, true));
                }
                ui.add_space(8.0);
                ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        let badge = widgets::galley(ui, "YOURS", theme::font(9.0, W::Regular), p.muted);
                        let room = ui.available_width() - if yours { badge.size().x + 16.0 } else { 0.0 };
                        let name = widgets::clipped(ui, &plugin.name, theme::font(14.0, W::Medium), p.text, room);
                        let (at, _) = ui.allocate_exact_size(vec2(name.size().x, 20.0), Sense::hover());
                        widgets::text_at(ui, at.left(), at.center().y, name);
                        if yours {
                            let (tag, _) = ui.allocate_exact_size(vec2(badge.size().x + 10.0, 15.5), Sense::hover());
                            ui.painter().rect(tag, 4.0, Color32::TRANSPARENT, Stroke::new(1.0, p.border), egui::StrokeKind::Inside);
                            widgets::text_at(ui, tag.left() + 5.0, tag.center().y, badge);
                        }
                    });
                    if !plugin.description.is_empty() {
                        ui.add_space(2.0);
                        form::para(ui, &plugin.description, 12.0, 20.0, W::Regular, p.text2);
                    }
                });
            });
        });
    });
    ui.data_mut(|d| d.insert_temp(seen_id, frame.response.rect));
    if toggle {
        if on {
            app.settings.enabled_plugins.retain(|id| id != &plugin.id);
        } else {
            app.settings.enabled_plugins.push(plugin.id.clone());
        }
    }
}

fn field_label(ui: &mut Ui, text: &str, hint: &str) {
    let p = p();
    ui.horizontal(|ui| {
        ui.add(egui::Label::new(widgets::lines(text, 12.0, 16.0, W::Semibold, p.text)).selectable(false));
        if !hint.is_empty() {
            ui.add(egui::Label::new(widgets::lines(hint, 12.0, 16.0, W::Regular, p.muted)).selectable(false));
        }
    });
    ui.add_space(6.0);
}

fn editor(ui: &mut Ui, draft: &mut Draft) {
    let p = p();
    let plain = |hint| Input::new(hint).pad(12, 9).fill(p.bg).focus(alpha(p.accent, 60.0));
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing.x = 12.0;
        ui.vertical(|ui| {
            ui.set_width(56.0);
            field_label(ui, "Icon", "");
            let mut icon = plain("").text(18.0, 20.0).pad(4, 9);
            icon.center = true;
            icon.show(ui, "plugin-icon", &mut draft.icon);
        });
        ui.vertical(|ui| {
            field_label(ui, "Name", "");
            plain("Rust expert").limit(40).show(ui, "plugin-name", &mut draft.name);
        });
    });
    ui.add_space(4.0);
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(4.0, 4.0);
        for emoji in ["✨", "🎯", "🧠", "⚡", "🔧", "📐", "🎨", "🧪", "📚", "🛠️", "🚀", "🦉"] {
            let (rect, response) = ui.allocate_exact_size(vec2(32.0, 32.0), Sense::click());
            let response = response.on_hover_cursor(CursorIcon::PointingHand);
            let t = widgets::fade(ui, response.id, response.hovered());
            ui.painter().rect_filled(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t));
            let glyph = widgets::galley(ui, emoji, theme::font(16.0, W::Regular), p.text);
            widgets::text_at(ui, rect.center().x - glyph.size().x / 2.0, rect.center().y, glyph);
            if response.clicked() {
                draft.icon = emoji.into();
            }
        }
    });
    ui.add_space(16.0);

    field_label(ui, "Description", " (optional)");
    plain("Terse Rust answers, no hand-holding").limit(140).show(ui, "plugin-description", &mut draft.description);
    ui.add_space(16.0);

    field_label(ui, "Category", "");
    form::wrap_row(ui, 6.0, |ui| {
        for (id, name) in [("token-saving", "Token saving"), ("enhancement", "Enhancement"), ("formatting", "Formatting"), ("safety", "Safety")] {
            let mut chip = Btn::outline(name).text(12.0, 16.0).weight(W::Regular).pad(10.0, 4.0);
            if draft.category == id {
                chip = chip.ink(p.accent_light, p.accent_light).fill(alpha(p.accent, 10.0), alpha(p.accent, 10.0)).border(alpha(p.accent, 50.0), alpha(p.accent, 50.0));
            }
            if chip.show(ui).clicked() {
                draft.category = id.into();
            }
        }
    });
    ui.add_space(16.0);

    field_label(ui, "Prompt", "");
    ui.add_space(-2.0);
    form::para(ui, "Written as an instruction to the assistant. Appended to the system prompt whenever this plugin is on.", 11.0, 16.0, W::Regular, p.muted);
    ui.add_space(8.0);
    // ponytail: the box does not drag taller like the web's `resize-y`; it scrolls with the dialog instead.
    plain("You are a Rust expert. Prefer idiomatic, zero-cost abstractions.\nNever explain basic syntax. Show complete compiling code.").mono().text(13.0, 21.125).pad(12, 10).rows(7).limit(plugins::MAX_PLUGIN_PROMPT).show(ui, "plugin-prompt", &mut draft.prompt);
    ui.add_space(4.0);
    let len = draft.prompt.chars().count();
    ui.horizontal(|ui| {
        if len > 0 {
            ui.add(egui::Label::new(widgets::lines(format!("~{} tokens, added to every request", plugins::grouped(tokens(len))), 11.0, 16.5, W::Regular, p.muted)).selectable(false));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add(egui::Label::new(widgets::lines(format!("{}/100,000", plugins::grouped(len)), 11.0, 16.5, W::Regular, if len > 90_000 { p.danger } else { p.muted })).selectable(false));
        });
    });
    if !draft.error.is_empty() {
        ui.add_space(16.0);
        form::boxed(ui, alpha(p.danger, 10.0), alpha(p.danger, 30.0), 8, (12, 8), |ui| form::para(ui, &draft.error, 12.0, 16.0, W::Regular, p.danger));
    }
    let _ = pos2(0.0, 0.0);
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_estimate_rounds_up() {
        assert_eq!((super::tokens(0), super::tokens(36), super::tokens(37)), (0, 10, 11));
    }
}
