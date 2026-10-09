//! The Plugins dialog (src/components/PluginsModal.tsx): the list, and the editor for the user's own plugins.
//!
//! Past the web's: a plugin is put where the user wants it (off, this chat, every chat) rather than switched
//! on for all, the list can be searched, and under it is the catalog of skills that can be added.

use super::form::{self, Btn, Input};
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
    /// What the list is narrowed to.
    query: String,
}

impl State {
    /// The dialog with the editor open on a blank plugin.
    pub fn writing() -> State {
        State { editor: Some(Draft::blank()), ..State::default() }
    }

    /// The list narrowed to `query`, for self-portraits.
    pub fn searching(query: &str) -> State {
        State { query: query.into(), ..State::default() }
    }
}

/// Where a plugin applies.
#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Off,
    Chat,
    All,
}

/// Which list a card is in.
#[derive(Clone, Copy, PartialEq)]
enum From {
    Yours,
    BuiltIn,
    /// Not added yet.
    Catalog,
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
            None => ("Plugins", "Standing instructions for the assistant. Each applies where you put it: this chat, or all of them"),
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
            // A skill from the catalog keeps its guide and reminder through an edit of the rest.
            let kept = app.settings.custom_plugins.iter().find(|q| !draft.id.is_empty() && q.id == draft.id).cloned().unwrap_or_default();
            let typed = Plugin { id: draft.id.clone(), name: draft.name.clone(), icon: draft.icon.clone(), description: draft.description.clone(), category: draft.category.clone(), prompt: draft.prompt.clone(), guide: kept.guide, reminder: kept.reminder, catalog: kept.catalog, ..Plugin::default() };
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

/// "2 active here · ~310 tokens per request" at the foot of the list: what is on for this chat, its own and everyone's.
fn active_line(app: &App, ui: &mut Ui) {
    let p = p();
    let every = plugins::all(&app.settings.custom_plugins);
    let here = plugins::enabled_for(&app.settings.enabled_plugins, &app.conv.names("skills"));
    let on: Vec<&Plugin> = every.iter().filter(|q| here.contains(&q.id)).collect();
    let chars: usize = on.iter().map(|q| q.prompt.chars().count() + q.reminder.chars().count()).sum();
    let over = chars > plugins::MAX_PLUGIN_TOTAL;
    let mut text = format!("{} active here", on.len());
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
    // The catalog on the project's page may have grown since this build: asked for once, the first time the list is opened.
    static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !ASKED.swap(true, std::sync::atomic::Ordering::Relaxed) && app.shot.is_none() {
        let ctx = ui.ctx().clone();
        app.rt.spawn(async move {
            if plugins::refresh_catalog(&reqwest::Client::new()).await {
                ctx.request_repaint();
            }
        });
    }
    Input::new("Search plugins and the catalog").pad(12, 9).fill(p.bg).focus(alpha(p.accent, 60.0)).show(ui, "plugin-search", &mut app.plugin_ui.query);
    ui.add_space(16.0);
    let query = app.plugin_ui.query.trim().to_lowercase();
    let wanted = |q: &Plugin| query.is_empty() || format!("{} {} {}", q.name, q.description, q.category).to_lowercase().contains(&query);
    let custom: Vec<Plugin> = app.settings.custom_plugins.iter().filter(|q| wanted(q)).cloned().collect();
    let (current, classic): (Vec<&Plugin>, Vec<&Plugin>) = plugins::BUILTIN.iter().filter(|q| wanted(q)).partition(|q| !q.legacy);
    // What can still be added: the catalog, less what is already among the user's own.
    let more: Vec<Plugin> = plugins::catalog().into_iter().filter(|c| wanted(c) && !app.settings.custom_plugins.iter().any(|q| q.id == c.id)).collect();
    if custom.is_empty() && current.is_empty() && classic.is_empty() && more.is_empty() {
        form::para(ui, &format!("Nothing here matches \"{}\".", app.plugin_ui.query.trim()), 13.0, 20.0, W::Regular, p.muted);
        return;
    }
    if !custom.is_empty() {
        heading(ui, "Your plugins", 8.0);
        for plugin in &custom {
            card(app, ui, plugin, From::Yours);
            ui.add_space(8.0);
        }
        ui.add_space(8.0);
    }
    if !current.is_empty() {
        heading(ui, "Built in", 8.0);
        for plugin in current {
            card(app, ui, plugin, From::BuiltIn);
            ui.add_space(8.0);
        }
        ui.add_space(8.0);
    }
    if !more.is_empty() {
        heading(ui, "Catalog", 4.0);
        form::para(ui, "Skills you can add. Put one on this chat or on all chats and it joins your plugins; the assistant can add them too when you ask it to.", 11.0, 16.0, W::Regular, p.muted);
        ui.add_space(8.0);
        for plugin in &more {
            card(app, ui, plugin, From::Catalog);
            ui.add_space(8.0);
        }
        ui.add_space(8.0);
    }
    if !classic.is_empty() {
        heading(ui, "Classic", 4.0);
        form::para(ui, "The original wording, kept so an older chat can be continued in the voice it was written in. These sit earlier in the prompt than the current versions, so they carry less weight.", 11.0, 16.0, W::Regular, p.muted);
        ui.add_space(8.0);
        for (i, plugin) in classic.into_iter().enumerate() {
            if i > 0 {
                ui.add_space(8.0);
            }
            card(app, ui, plugin, From::BuiltIn);
        }
    }
}

/// Where a plugin applies, as three places to click: off, this chat, every chat. Returns the one clicked when it
/// is not where the plugin already is.
fn scope_pick(ui: &mut Ui, key: &str, now: Scope) -> Option<Scope> {
    let p = p();
    let places = [(Scope::Off, "Off", "Not used"), (Scope::Chat, "This chat", "Used in this chat only"), (Scope::All, "All chats", "Used in every chat")];
    let labels: Vec<_> = places.iter().map(|(_, label, _)| widgets::galley(ui, label, theme::font(11.0, W::Medium), Color32::WHITE)).collect();
    let widths: Vec<f32> = labels.iter().map(|label| label.size().x + 18.0).collect();
    let (track, _) = ui.allocate_exact_size(vec2(widths.iter().sum::<f32>() + 4.0, 26.0), Sense::hover());
    ui.painter().rect(track, 9.0, alpha(p.bg, 60.0), Stroke::new(1.0, p.border), egui::StrokeKind::Inside);
    let mut picked = None;
    let mut x = track.left() + 2.0;
    for (((scope, name, tip), label), width) in places.into_iter().zip(labels).zip(widths) {
        let rect = Rect::from_min_size(pos2(x, track.top() + 2.0), vec2(width, 22.0));
        x += width;
        let response = ui.interact(rect, ui.id().with(("scope", key, name)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
        let chosen = scope == now;
        let t = widgets::fade(ui, response.id, response.hovered());
        if chosen {
            ui.painter().rect_filled(rect, 7.0, if scope == Scope::Off { p.hover } else { alpha(p.accent, 22.0) });
        }
        let ink = match (chosen, scope) {
            (true, Scope::Off) => p.text2,
            (true, _) => p.accent_light,
            (false, _) => widgets::lerp(p.muted, p.text, t),
        };
        ui.painter().galley_with_override_text_color(pos2((rect.center().x - label.size().x / 2.0).round(), (rect.center().y - label.size().y / 2.0).round()), label, ink);
        if response.on_hover_text(tip).clicked() && !chosen {
            picked = Some(scope);
        }
    }
    picked
}

/// Puts a plugin where the user chose. One from the catalog joins the user's own first.
fn place(app: &mut App, plugin: &Plugin, from: From, to: Scope) {
    if from == From::Catalog {
        if let Err(why) = plugins::install(plugin) {
            app.toast(format!("Couldn't add {}: {why}", plugin.name));
            return;
        }
        app.settings.custom_plugins = plugins::custom();
    }
    let before = app.conv.names("skills");
    let mut chat: Vec<String> = before.iter().filter(|id| *id != &plugin.id).cloned().collect();
    app.settings.enabled_plugins.retain(|id| id != &plugin.id);
    match to {
        Scope::All => app.settings.enabled_plugins.push(plugin.id.clone()),
        Scope::Chat => chat.push(plugin.id.clone()),
        Scope::Off => {}
    }
    if chat != before {
        app.conv.set_names("skills", chat);
        // A chat nothing was said in yet is not on disk, and is not put there for this.
        if !app.conv.messages.is_empty() {
            app.conv.save();
        }
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

fn card(app: &mut App, ui: &mut Ui, plugin: &Plugin, from: From) {
    let p = p();
    let yours = from == From::Yours;
    let now = if app.settings.enabled_plugins.contains(&plugin.id) {
        Scope::All
    } else if app.conv.names("skills").contains(&plugin.id) {
        Scope::Chat
    } else {
        Scope::Off
    };
    let on = now != Scope::Off;
    // Hovered last frame: the card's size is only known once it is laid out.
    let seen_id = ui.id().with(("plugin-card", &plugin.id));
    let hovered = ui.data(|d| d.get_temp::<Rect>(seen_id)).is_some_and(|r| ui.rect_contains_pointer(r));
    let (fill, border) = if on { (alpha(p.accent, 7.0), alpha(p.accent, 40.0)) } else { (alpha(p.bg3, 40.0), p.border) };
    let mut picked = None;
    let frame = egui::Frame::new().fill(fill).stroke(Stroke::new(1.0, border)).corner_radius(12).inner_margin(egui::Margin::same(12)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.add_space(2.0);
                let (slot, _) = ui.allocate_exact_size(vec2(18.0 * super::emoji::ADVANCE, 18.0), Sense::hover());
                super::emoji::paint(ui, &plugin.icon, slot.center(), 18.0, p.text);
            });
            ui.add_space(12.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                picked = scope_pick(ui, &plugin.id, now);
                if yours {
                    if hover_btn(ui, icons::TRASH.stroke(1.8), hovered, true, if plugin.catalog { "Remove (it stays in the catalog)" } else { "Delete" }).clicked() {
                        let _ = plugins::delete(&plugin.id);
                        app.settings.custom_plugins = plugins::custom();
                        picked = Some(Scope::Off);
                    }
                    if hover_btn(ui, icons::RENAME.stroke(1.8), hovered, false, "Edit").clicked() {
                        app.plugin_ui.editor = Some(Draft::from(plugin, false));
                    }
                } else if from == From::Catalog {
                    if hover_btn(ui, icons::PLUS.stroke(2.0), hovered, false, "Add to your plugins, switched off").clicked() && plugins::install(plugin).is_ok() {
                        app.settings.custom_plugins = plugins::custom();
                    }
                } else if hover_btn(ui, icons::COPY_SMALL, hovered, false, "Duplicate as your own").clicked() {
                    app.plugin_ui.editor = Some(Draft::from(plugin, true));
                }
                ui.add_space(8.0);
                ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        let badge = widgets::galley(ui, if plugin.catalog { "FROM THE CATALOG" } else { "YOURS" }, theme::font(9.0, W::Regular), p.muted);
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
    if let Some(to) = picked {
        // A plugin just deleted is only taken off the lists.
        let gone = yours && !app.settings.custom_plugins.iter().any(|q| q.id == plugin.id);
        place(app, plugin, if gone { From::BuiltIn } else { from }, to);
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
            let field = icon.show(ui, "plugin-icon", &mut draft.icon);
            // The text field cannot draw colour glyphs, so the picture covers its text while nobody types in it.
            if !field.has_focus() && super::emoji::has(draft.icon.trim()) {
                ui.painter().rect_filled(field.rect.shrink(2.0), 10.0, p.bg);
                super::emoji::paint(ui, &draft.icon, field.rect.center(), 18.0, p.text);
            }
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
            super::emoji::paint(ui, emoji, rect.center(), 16.0, p.text);
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
