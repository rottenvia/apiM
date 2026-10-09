//! The Settings dialog (src/components/SettingsModal.tsx) and the panels inside it.
//! Everything is saved the moment it changes; there is no Save button.

use super::form::{self, Btn, Input, Seg, Switch};
use super::icons::{self, Icon};
use super::overlay::{self, Card};
use super::theme::{self, W, alpha, p};
use super::{App, widgets};
use crate::models::{self, CustomModel, Vision};
use crate::provider::{self, Verified};
use crate::store::Approval;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use std::sync::mpsc;

type Lookup = mpsc::Receiver<Result<Verified, String>>;

/// What the dialog remembers while it is open.
#[derive(Default)]
pub struct State {
    pub tab: usize,
    /// Counts tab changes: the web app rebuilds a tab from scratch when it is opened.
    epoch: u32,
    // "Your OpenRouter models"
    slug: String,
    label: String,
    verifying: Option<Lookup>,
    verified: Option<Verified>,
    verify_error: String,
    /// The model being re-checked: (its id, the answer on its way).
    refreshing: Option<(String, Lookup)>,
    /// The delete lock's number box, as typed.
    delay: Option<String>,
    pub panels: super::settings_panels::State,
}

/// (label, the line under "Settings", icon)
const TABS: [(&str, &str, Icon); 7] = [
    ("API keys", "Credentials for the services this app talks to", icons::TAB_KEYS),
    ("Model", "Which model answers, and how hard it thinks", icons::TAB_MODEL),
    ("Theme", "The app's colours, MonkeyType-style", icons::TAB_THEME),
    ("Web search", "How much to spend looking things up", icons::GLOBE.stroke(1.7)),
    ("Reports", "What has been failing, so it can be fixed", icons::TAB_REPORTS),
    ("MCP servers", "Remote tools the AI may call, with permission", icons::MCP.stroke(1.7)),
    ("Safety", "Guards on the actions that touch your machine", icons::TAB_SAFETY),
];

/// A child with its own rectangle, laid out top down.
pub fn part<R>(ui: &mut Ui, rect: Rect, add: impl FnOnce(&mut Ui) -> R) -> R {
    // A child, not a scope: a scope would drag the parent's cursor to this rect.
    add(&mut ui.new_child(egui::UiBuilder::new().max_rect(rect).layout(egui::Layout::top_down(egui::Align::Min))))
}

/// The X of a dialog header: a square that lights up, the icon in the secondary colour.
pub fn close_btn(ui: &mut Ui, size: f32, radius: f32, icon: f32, tip: &str) -> egui::Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(size, size), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, radius, widgets::lerp(Color32::TRANSPARENT, p.hover, t));
    icons::paint(ui, icons::CLOSE, rect.center(), icon, p.text2);
    if tip.is_empty() { response } else { response.on_hover_text(tip) }
}

/// Draws the dialog. False once it should close.
pub fn show(app: &mut App, ctx: &egui::Context) -> bool {
    let p = p();
    let before = app.settings.clone();
    let height = (ctx.content_rect().height() * 0.86).min(640.0);
    let shown = Card::new("settings", 672.0, height).show(ctx, |ui, close| {
        let rect = ui.max_rect();
        let (head, rest) = rect.split_top_bottom_at_y(rect.top() + 71.0);
        let (body, foot) = rest.split_top_bottom_at_y(rest.bottom() - 69.0);
        let (rail, content) = body.split_left_right_at_x(body.left() + 168.0);
        let tab = app.settings_ui.tab.min(TABS.len() - 1);
        let line = Stroke::new(1.0, p.border);
        ui.painter().hline(head.x_range(), head.bottom() - 0.5, line);
        ui.painter().hline(foot.x_range(), foot.top() + 0.5, line);
        ui.painter().vline(rail.right() - 0.5, rail.y_range(), line);

        part(ui, head, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 16)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if close_btn(ui, 36.0, 12.0, 20.0, "Close (Esc)").clicked() {
                            *close = true;
                        }
                        ui.add_space(12.0);
                        ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                            form::line(ui, "Settings", 15.0, 20.0, W::Semibold, p.text);
                            ui.add_space(2.0);
                            form::line(ui, TABS[tab].1, 12.0, 16.0, W::Regular, p.muted);
                        });
                    });
                });
            });
        });

        part(ui, Rect::from_min_max(rail.min + vec2(10.0, 10.0), rail.max - vec2(11.0, 10.0)), |ui| {
            for (i, (name, _, icon)) in TABS.iter().enumerate() {
                if i > 0 {
                    ui.add_space(2.0);
                }
                let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 32.75), Sense::click());
                let response = response.on_hover_cursor(CursorIcon::PointingHand);
                let t = widgets::fade(ui, response.id, response.hovered());
                let (fill, ink) = if i == tab { (p.elevated, p.text) } else { (widgets::lerp(Color32::TRANSPARENT, p.bg3, t), widgets::lerp(p.muted, p.text2, t)) };
                ui.painter().rect_filled(row, 8.0, fill);
                icons::paint(ui, *icon, pos2(row.left() + 10.0 + 7.5, row.center().y), 15.0, ink);
                let text = widgets::clipped(ui, name, theme::font(12.5, W::Medium), ink, row.width() - 44.0);
                widgets::text_at(ui, row.left() + 34.0, row.center().y, text);
                if response.clicked() && i != tab {
                    app.settings_ui.tab = i;
                    app.settings_ui.epoch += 1;
                }
            }
        });

        part(ui, content, |ui| {
            egui::ScrollArea::vertical().id_salt(("settings", tab)).auto_shrink(false).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::same(20)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                    ui.push_id(app.settings_ui.epoch, |ui| match tab {
                        0 => keys(app, ui),
                        1 => model(app, ui),
                        2 => theme_tab(app, ui),
                        3 => super::settings_panels::search(app, ui),
                        4 => super::settings_panels::reports(app, ui),
                        5 => super::settings_panels::mcp(app, ui),
                        _ => safety(app, ui),
                    });
                });
            });
        });

        part(ui, foot.with_min_y(foot.top() + 1.0), |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 14)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if widgets::btn_primary(ui, None, "Done").clicked() {
                            *close = true;
                        }
                        ui.add_space(12.0);
                        ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                            form::line(ui, "Saved automatically as you change them.", 11.0, 16.5, W::Regular, p.muted);
                        });
                    });
                });
            });
        });
    });
    if app.settings != before {
        app.settings.save();
    }
    shown == overlay::State::Open
}

/// The label of a block, its hint, and for Tavily and Exa the switch at the end of the row.
fn head(ui: &mut Ui, title: &str, hint: &str, switch: Option<&mut bool>) {
    let p = p();
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        ui.add(egui::Label::new(widgets::lines(title, 14.0, 20.0, W::Semibold, p.text)).selectable(false));
        ui.add(egui::Label::new(widgets::lines(hint, 12.0, 20.0, W::Regular, p.muted)).selectable(false));
        if let Some(on) = switch {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if form::switch(ui, Switch::A, *on).clicked() {
                    *on = !*on;
                }
            });
        }
    });
    ui.add_space(6.0);
}

/// A small muted label over a field of the local-model block.
fn mini_label(ui: &mut Ui, text: &str) {
    form::para(ui, text, 11.0, 16.5, W::Medium, p().muted);
    ui.add_space(4.0);
}

/// A chip that picks a value: 11px, bordered, accent-tinted when it is the one in use.
fn pick_chip(ui: &mut Ui, label: &str, active: bool, mono: bool) -> egui::Response {
    let p = p();
    let mut b = Btn::outline(label).text(11.0, 16.5).weight(W::Regular).pad(10.0, 4.0);
    b.mono = mono;
    if active {
        b = b.ink(p.accent_light, p.accent_light).fill(alpha(p.accent, 10.0), alpha(p.accent, 10.0)).border(alpha(p.accent, 50.0), alpha(p.accent, 50.0));
    }
    b.show(ui)
}

// ------------------------------------------------------------------ API keys

fn keys(app: &mut App, ui: &mut Ui) {
    let p = p();
    let help = |ui: &mut Ui, segs: &[Seg]| {
        form::rich(ui, 12.0, 16.0, p.text2, segs);
        ui.add_space(8.0);
    };

    head(ui, "DeepSeek API Key", "(for V4 Pro / Flash)", None);
    help(ui, &[Seg::T("Get your key from "), Seg::Link("platform.deepseek.com", "https://platform.deepseek.com")]);
    Input::new("sk-...").password().show(ui, "deepseek", &mut app.settings.deepseek_key);
    if !app.settings.deepseek_key.is_empty() {
        form::key_saved(ui);
    }
    ui.add_space(20.0);

    head(ui, "OpenRouter API Key", "(GLM 5.3 Flash · free lane · your models)", None);
    help(
        ui,
        &[
            Seg::T("Get a key from "),
            Seg::Link("openrouter.ai/settings/keys", "https://openrouter.ai/settings/keys"),
            Seg::T(". One key covers every OpenRouter model: the built-ins and anything you add under the Model tab. Verifying a model also checks this key is valid."),
        ],
    );
    let had = !app.settings.openrouter_key.trim().is_empty();
    Input::new("sk-or-v1-...").password().show(ui, "openrouter", &mut app.settings.openrouter_key);
    let s = &mut app.settings;
    // A first OpenRouter key with no DeepSeek one: move off a model that could not answer.
    if !had && !s.openrouter_key.trim().is_empty() && s.deepseek_key.trim().is_empty() && models::resolve(&s.model, &s.custom_models).provider == models::ProviderId::Deepseek {
        s.model = "nvidia-nemotron-3-ultra-free".into();
    }
    if !s.openrouter_key.is_empty() {
        form::key_saved(ui);
    }
    ui.add_space(20.0);

    head(ui, "Local model", "(Qwen 3.8 27B on this PC)", None);
    help(
        ui,
        &[
            Seg::T("Download the 27B into this app. A sidecar on your machine runs it so the UI stays light. Thinking is on by default; the effort slider maps to Qwen's "),
            Seg::Code("reasoning_effort"),
            Seg::T(" (low / medium / xhigh)."),
        ],
    );
    super::settings_panels::local_runtime(app, ui);
    ui.add_space(12.0);
    let s = &mut app.settings;
    form::details(ui, "local-advanced", "Advanced — custom local server", 11.0, p.muted, |ui| {
        ui.add_space(8.0);
        form::wrap_row(ui, 6.0, |ui| {
            for (name, url, wire) in [("Ollama", "http://127.0.0.1:11434/v1", "qwen3.8:27b"), ("vLLM", "http://127.0.0.1:8000/v1", "Qwen/Qwen3.8-27B"), ("llama.cpp", "http://127.0.0.1:8080/v1", "Qwen3.8-27B")] {
                if pick_chip(ui, name, false, false).clicked() {
                    s.local_base_url = url.into();
                    s.local_api_model = wire.into();
                    s.model = "qwen-3.8-27b".into();
                }
            }
        });
        ui.add_space(8.0);
        mini_label(ui, "Endpoint");
        Input::new(provider::DEFAULT_LOCAL_BASE_URL).show(ui, "local-url", &mut s.local_base_url);
        ui.add_space(8.0);
        mini_label(ui, "Wire model id");
        Input::new("qwen-3.8-27b").mono().show(ui, "local-model", &mut s.local_api_model);
        ui.add_space(8.0);
    });
    ui.add_space(8.0);
    mini_label(ui, "API key (optional — the in-app sidecar ignores it)");
    Input::new("Leave empty for the in-app sidecar").password().show(ui, "local-key", &mut s.local_api_key);
    ui.add_space(20.0);

    head(ui, "Tavily API Key", if s.tavily_enabled { "(for Web Search)" } else { "(switched off)" }, Some(&mut s.tavily_enabled));
    help(ui, &[Seg::T("Get your key from "), Seg::Link("app.tavily.com", "https://app.tavily.com"), Seg::T(" — 1,000 free credits/month")]);
    Input::new("tvly-...").password().search().show(ui, "tavily", &mut s.tavily_key);
    if !s.tavily_key.is_empty() {
        form::key_saved(ui);
    }
    ui.add_space(20.0);
    widgets::rule(ui);
    ui.add_space(20.0);

    head(ui, "Exa API Key", if s.exa_enabled { "(optional — searched alongside Tavily)" } else { "(switched off)" }, Some(&mut s.exa_enabled));
    help(
        ui,
        &[
            Seg::T("Get your key from "),
            Seg::Link("dashboard.exa.ai", "https://dashboard.exa.ai/api-keys"),
            Seg::T(" — $10 free credit. Searched at the same time as Tavily and the results merged, so a quota error on one side no longer stops the search. Set either key, or both."),
        ],
    );
    Input::new("Leave empty to skip").password().search().show(ui, "exa", &mut s.exa_key);
    if !s.exa_key.is_empty() {
        form::key_saved(ui);
    }
    ui.add_space(20.0);
    widgets::rule(ui);
    ui.add_space(20.0);

    let current = models::resolve(&s.model, &s.custom_models);
    let helper = current.vision != Vision::Native;
    head(ui, "Vision API Key", if helper { "(optional — OCR is free)" } else { "(DeepSeek only)" }, None);
    if helper {
        help(
            ui,
            &[
                Seg::T(&current.label),
                Seg::T(" can't see images. Screenshots are scraped locally with free OCR — no OpenAI key or funds needed. Add a key below only if you want a full visual description (layout, highlighted controls) instead of just the text. If the key is empty or out of credit, we fall back to OCR. MP4 is not supported on this model. Optional key from "),
                Seg::Link("platform.openai.com", "https://platform.openai.com/api-keys"),
            ],
        );
    } else {
        let sees = if current.video { " sees images and video itself — no vision provider is used while it is selected. A key here is only needed if you switch to DeepSeek." } else { " sees images itself — no vision provider is used while it is selected. A key here is only needed if you switch to DeepSeek." };
        help(ui, &[Seg::T(&current.label), Seg::T(sees)]);
    }
    Input::new("sk-...").password().show(ui, "vision", &mut s.vision_key);
    ui.add_space(8.0);
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
        for m in ["gpt-4o-mini", "gpt-4o"] {
            if pick_chip(ui, m, s.vision_model == m, true).clicked() {
                s.vision_model = m.into();
            }
        }
        ui.add(egui::Label::new(widgets::lines("mini is ~10x cheaper and enough for most screenshots", 11.0, 16.5, W::Regular, p.muted)).selectable(false));
    });
    if !s.vision_key.is_empty() {
        form::key_saved(ui);
    }
    ui.add_space(20.0);
    widgets::rule(ui);
}

// ------------------------------------------------------------------ Model

/// Spending-limit presets, and how the web app prints them.
const BUDGETS: [f64; 6] = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0];

fn model(app: &mut App, ui: &mut Ui) {
    let p = p();
    form::label(ui, "Model", "");
    ui.add_space(8.0);
    let all = models::all(&app.settings.custom_models);
    form::grid(ui, 2, 8.0, all.len(), |ui, i, width| {
        let m = &all[i];
        let (rect, response, ink) = form::choice(ui, vec2(width, 62.0), app.settings.model == m.id);
        let name = widgets::clipped(ui, &m.label, theme::font(14.0, W::Semibold), ink, width - 34.0);
        widgets::text_at(ui, rect.left() + 17.0, rect.top() + 23.0, name);
        let sub = widgets::clipped(ui, &m.settings_subtitle, theme::font(11.0, W::Medium), ink.gamma_multiply(0.7), width - 34.0);
        widgets::text_at(ui, rect.left() + 17.0, rect.top() + 41.0, sub);
        if response.clicked() {
            app.settings.model = m.id.clone();
        }
    });
    if app.settings.model == "qwen-3.8-27b" {
        ui.add_space(8.0);
        super::settings_panels::local_runtime(app, ui);
    }
    ui.add_space(20.0);

    custom_models(app, ui);
    ui.add_space(20.0);

    let s = &mut app.settings;
    form::label(ui, "Default Thinking Effort", "");
    ui.add_space(8.0);
    let efforts = [("Auto", "auto"), ("None", "none"), ("Low", "low"), ("High", "high"), ("Max", "max")];
    form::grid(ui, 5, 6.0, efforts.len(), |ui, i, width| {
        if form::choice_text(ui, vec2(width, 38.0), s.effort == efforts[i].1, efforts[i].0).clicked() {
            s.effort = efforts[i].1.into();
        }
    });
    ui.add_space(8.0);
    form::note(ui, "On V4 Pro, “Low” is mapped to “High” by DeepSeek itself — only Max is genuinely different. Use V4 Flash if you want a cheaper, shallower answer.");
    ui.add_space(20.0);

    form::label(ui, "Spending limit per reply", "");
    ui.add_space(8.0);
    form::helper(ui, &[Seg::T("Stops a reply once it has cost this much. The work done so far is kept and you can Resume it — nothing is thrown away. This is the guard against a task the model never finishes.")]);
    ui.add_space(10.0);
    form::grid(ui, 4, 6.0, BUDGETS.len() + 1, |ui, i, width| {
        let (label, value) = match i {
            0 => ("Off".to_string(), None),
            _ => {
                let amount = BUDGETS[i - 1];
                (if amount < 1.0 { format!("${amount:.2}") } else { format!("${amount:.0}") }, Some(amount))
            }
        };
        if form::choice_text(ui, vec2(width, 38.0), s.budget_usd == value, &label).clicked() {
            s.budget_usd = value;
        }
    });
    ui.add_space(8.0);
    form::note(ui, "For scale: an ordinary reply is a fraction of a cent. A forty-round agent task on Max thinking is around $0.50.");
    let _ = p;
}

/// A checked model as the entry the app keeps.
fn to_custom(found: &Verified, label: &str, old: Option<&CustomModel>) -> Option<CustomModel> {
    let api_model = found.id.trim();
    if api_model.len() > 128 || !models::valid_slug(api_model) {
        return None;
    }
    let label = label.trim();
    let label: String = if label.is_empty() { if found.name.is_empty() { api_model.to_string() } else { found.name.clone() } } else { label.to_string() };
    Some(CustomModel {
        api_model: api_model.to_string(),
        label: label.chars().take(60).collect(),
        // Natives get the picture itself; anything else gets a description of it.
        vision: if found.supports_vision { Vision::Native } else { Vision::Helper },
        max_output_tokens: old.map_or(65_536, |o| o.max_output_tokens),
        context_length: found.context_length,
        input_price: found.input_price,
        output_price: found.output_price,
        open_limits: old.is_some_and(|o| o.open_limits),
    })
}

fn price_line(found: &Verified) -> String {
    let price = match (found.input_price, found.output_price) {
        (Some(i), Some(o)) if i == 0.0 && o == 0.0 => "Free".to_string(),
        (None, None) => "Pricing unknown — usage won't be costed".to_string(),
        (i, o) => {
            let f = |v: Option<f64>| v.map_or("?".to_string(), |v| v.to_string());
            format!("${} / ${} per 1M in/out", f(i), f(o))
        }
    };
    let caps: Vec<&str> = [Some(if found.supports_tools { "tools" } else { "no tools" }), found.supports_vision.then_some("vision"), found.supports_thinking.then_some("thinking")].into_iter().flatten().collect();
    format!("{price} · {}", caps.join(" · "))
}

fn start_verify(app: &App, ctx: &egui::Context, slug: String) -> Lookup {
    let (tx, rx) = mpsc::channel();
    let key = app.settings.openrouter();
    let wake = ctx.clone();
    app.rt.spawn(async move {
        let _ = tx.send(provider::verify_openrouter(&slug, &key).await);
        wake.request_repaint();
    });
    rx
}

/// CustomModelsManager: the user's own OpenRouter models.
fn custom_models(app: &mut App, ui: &mut Ui) {
    let p = p();
    form::label(ui, "Your OpenRouter models", "");
    ui.add_space(8.0);
    form::helper(
        ui,
        &[Seg::T("Any model id from "), Seg::Link("openrouter.ai/models", "https://openrouter.ai/models"), Seg::T(" — paste it, Verify, Add. It rides your OpenRouter key and appears in the model picker like a built-in.")],
    );
    ui.add_space(10.0);

    // Answers that arrived since last frame.
    if let Some(result) = app.settings_ui.verifying.as_ref().and_then(|rx| rx.try_recv().ok()) {
        app.settings_ui.verifying = None;
        match result {
            Ok(found) => {
                app.settings_ui.label = if found.name.is_empty() { found.id.clone() } else { found.name.clone() };
                app.settings_ui.verified = Some(found);
            }
            Err(why) => app.settings_ui.verify_error = why,
        }
    }
    if let Some((id, result)) = app.settings_ui.refreshing.as_ref().and_then(|(id, rx)| rx.try_recv().ok().map(|r| (id.clone(), r))) {
        app.settings_ui.refreshing = None;
        // A failed re-check is silent: the entry simply stays as it was.
        if let (Ok(found), Some(c)) = (result, app.settings.custom_models.iter_mut().find(|c| c.id() == id)) {
            c.context_length = found.context_length;
            c.input_price = found.input_price;
            c.output_price = found.output_price;
            c.vision = if found.supports_vision { Vision::Native } else { Vision::Helper };
        }
    }

    let (mut remove, mut recheck) = (None, None);
    let busy = app.settings_ui.refreshing.as_ref().map(|(id, _)| id.clone());
    for i in 0..app.settings.custom_models.len() {
        let c = app.settings.custom_models[i].clone();
        let id = c.id();
        let selected = app.settings.model == id;
        let unknown = c.input_price.is_none() && c.output_price.is_none();
        let (fill, border) = if selected { (alpha(p.accent, 7.0), alpha(p.accent, 30.0)) } else { (p.bg3, p.border) };
        form::boxed(ui, fill, border, 12, (12, 10), |ui| {
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    let small = |label| Btn::ghost(label).text(11.0, 16.5).pad(8.0, 4.0).fill(Color32::TRANSPARENT, p.hover);
                    if small("✕").ink(p.muted, p.danger).show(ui).on_hover_text(format!("Remove {}", c.label)).clicked() {
                        remove = Some(i);
                    }
                    let checking = busy.as_deref() == Some(id.as_str());
                    if small(if checking { "…" } else { "↻" }).ink(p.muted, p.text2).enabled(busy.is_none()).show(ui).on_hover_text("Re-check capabilities and pricing with OpenRouter").clicked() {
                        recheck = Some(i);
                    }
                    ui.add_space(4.0);
                    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 52.5), Sense::click());
                    let width = rect.width();
                    let specs = format!("{}{}{}", c.specs(), if unknown { " · pricing unknown" } else { "" }, if c.vision == Vision::Native { " · vision" } else { "" });
                    widgets::text_at(ui, rect.left(), rect.top() + 9.75, widgets::clipped(ui, &c.label, theme::font(13.0, W::Medium), p.text, width));
                    widgets::text_at(ui, rect.left(), rect.top() + 27.75, widgets::clipped(ui, &c.api_model, theme::mono(11.0), p.muted, width));
                    widgets::text_at(ui, rect.left(), rect.top() + 44.25, widgets::clipped(ui, &specs, theme::font(11.0, W::Regular), p.text2, width));
                    if response.on_hover_cursor(CursorIcon::PointingHand).clicked() {
                        app.settings.model = id.clone();
                    }
                });
            });
            if unknown {
                ui.add_space(4.0);
                form::para(ui, "OpenRouter reported no pricing — usage on this model won't be costed. Re-verify if that looks wrong.", 11.0, 16.0, W::Regular, p.warning);
            }
            ui.add_space(6.0);
            let row = ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (tick, _) = ui.allocate_exact_size(vec2(14.0, 16.5), Sense::hover());
                let square = Rect::from_center_size(tick.center(), vec2(14.0, 14.0));
                if c.open_limits {
                    ui.painter().rect_filled(square, 3.0, p.accent);
                    icons::paint(ui, icons::CHECK.stroke(3.0), square.center(), 10.0, Color32::WHITE);
                } else {
                    ui.painter().rect(square, 3.0, p.bg, Stroke::new(1.0, p.border_light), StrokeKind::Inside);
                }
                ui.add(egui::Label::new(widgets::lines("Uncapped tools — whole-file reads, no batch ceilings", 11.0, 16.5, W::Regular, p.text2)).selectable(false));
            });
            if ui.interact(row.response.rect, ui.id().with(("limits", i)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand).clicked() {
                app.settings.custom_models[i].open_limits = !c.open_limits;
            }
        });
        ui.add_space(6.0);
    }
    if !app.settings.custom_models.is_empty() {
        ui.add_space(6.0);
    }
    if let Some(i) = recheck {
        let c = &app.settings.custom_models[i];
        app.settings_ui.refreshing = Some((c.id(), start_verify(app, ui.ctx(), c.api_model.clone())));
    }
    if let Some(i) = remove {
        let gone = app.settings.custom_models.remove(i);
        if app.settings.model == gone.id() {
            app.settings.model = models::DEFAULT_MODEL_ID.into();
        }
    }

    form::boxed(ui, alpha(p.bg3, 50.0), p.border, 12, (12, 10), |ui| {
        let st = &mut app.settings_ui;
        let mut go = false;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let waiting = st.verifying.is_some();
                go |= Btn::outline(if waiting { "…" } else { "Verify" }).fill(p.bg3, p.hover).pad(12.0, 8.0).enabled(!st.slug.trim().is_empty() && !waiting).show(ui).clicked();
                let before = st.slug.clone();
                let field = Input::new("author/model-name or author/model:free").mono().text(12.0, 16.0).pad(12, 8).radius(8).show(ui, "slug", &mut st.slug);
                if st.slug != before {
                    // Typing clears what the last check said.
                    st.verified = None;
                    st.verify_error.clear();
                }
                go |= field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            });
        });
        if go && !st.slug.trim().is_empty() && st.verifying.is_none() {
            st.verify_error.clear();
            st.verified = None;
            let slug = st.slug.clone();
            app.settings_ui.verifying = Some(start_verify(app, ui.ctx(), slug));
        }
        let st = &mut app.settings_ui;
        if !st.verify_error.is_empty() {
            ui.add_space(6.0);
            form::para(ui, &st.verify_error, 11.0, 16.0, W::Regular, p.danger);
        }
        let Some(found) = st.verified.clone() else { return };
        ui.add_space(8.0);
        form::boxed(ui, p.bg2, p.border, 8, (12, 8), |ui| {
            form::line(ui, &found.name, 12.0, 18.0, W::Medium, p.text);
            ui.add_space(2.0);
            ui.add(egui::Label::new(egui::RichText::new(&found.id).font(theme::mono(11.0)).color(p.muted).line_height(Some(16.5))).selectable(false));
            ui.add_space(2.0);
            form::para(ui, &price_line(&found), 11.0, 16.5, W::Regular, p.text2);
            if !found.supports_tools {
                ui.add_space(4.0);
                form::para(ui, "This model reports no tool support — the agent can chat but its tools will be refused. Still addable; check the model's page if that surprises you.", 11.0, 16.0, W::Regular, p.warning);
            }
        });
        ui.add_space(8.0);
        let mut add = false;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // `.btn-primary` keeps its 40px height whatever the padding classes say.
                add |= Btn::accent("Add").pad(12.0, 12.0).radius(12.0).show(ui).clicked();
                let field = Input::new("Display name").text(12.0, 16.0).pad(12, 6).radius(8).show(ui, "display-name", &mut st.label);
                add |= field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            });
        });
        if !add {
            return;
        }
        let old = app.settings.custom_models.iter().position(|c| c.api_model == found.id.trim());
        match to_custom(&found, &st.label, old.map(|i| &app.settings.custom_models[i])) {
            None => st.verify_error = format!("The verified id \"{}\" is not a usable model id. Copy it fresh from openrouter.ai.", found.id),
            Some(def) => {
                app.settings.model = def.id();
                // Same wire id, same entry: this replaces rather than duplicates.
                match old {
                    Some(i) => app.settings.custom_models[i] = def,
                    None => app.settings.custom_models.push(def),
                }
                *st = State { tab: st.tab, epoch: st.epoch, panels: std::mem::take(&mut st.panels), ..State::default() };
            }
        }
    });
}

// ------------------------------------------------------------------ Theme

fn theme_tab(app: &mut App, ui: &mut Ui) {
    let p = p();
    let s = &mut app.settings;
    form::label(ui, "Reply layout", "");
    ui.add_space(8.0);
    form::helper(ui, &[Seg::T("How the agent's text and its steps sit together. Applies instantly.")]);
    ui.add_space(10.0);
    let layouts = [("claude", "Claude", "One column: text, then its steps. No dividers."), ("split", "Split (classic)", "Text on the left, steps on the right.")];
    let width = ((ui.available_width() - 8.0) / 2.0).floor();
    let hints: Vec<_> = layouts
        .iter()
        .map(|(_, _, hint)| {
            let mut job = egui::text::LayoutJob::simple(hint.to_string(), theme::font(12.0, W::Regular), p.text2, width - 26.0);
            job.sections[0].format.line_height = Some(16.5);
            ui.painter().layout_job(job)
        })
        .collect();
    let tall = hints.iter().map(|g| g.size().y).fold(0.0, f32::max) + 2.0 + 20.0 + 19.5 + 2.0;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        for ((id, name, _), hint) in layouts.iter().zip(hints) {
            let (rect, response) = ui.allocate_exact_size(vec2(width, tall), Sense::click());
            let response = response.on_hover_cursor(CursorIcon::PointingHand);
            let on = s.reply_layout == *id;
            let t = widgets::fade(ui, response.id, response.hovered());
            let (fill, border) = if on { (alpha(p.accent, 10.0), p.accent) } else { (widgets::lerp(Color32::TRANSPARENT, p.hover, t), p.border) };
            ui.painter().rect(rect, 12.0, fill, Stroke::new(1.0, border), StrokeKind::Inside);
            widgets::text_at(ui, rect.left() + 13.0, rect.top() + 11.0 + 9.75, widgets::galley(ui, name, theme::font(13.0, W::Medium), p.text));
            ui.painter().galley(pos2(rect.left() + 13.0, rect.top() + 11.0 + 19.5 + 2.0), hint, p.text2);
            if response.clicked() {
                s.reply_layout = id.to_string();
            }
        }
    });
    ui.add_space(20.0);

    form::label(ui, "Theme", "");
    ui.add_space(8.0);
    form::helper(ui, &[Seg::T("Applies instantly — every bubble, panel and button follows.")]);
    ui.add_space(10.0);
    let custom_bg = theme::hex(&s.custom_theme[0]).unwrap_or(p.bg);
    let custom_accent = theme::hex(&s.custom_theme[3]).unwrap_or(p.accent);
    form::grid(ui, 2, 8.0, theme::THEMES.len() + 1, |ui, i, width| {
        // (id, name, swatch, dots)
        let (id, name, bg, dots) = match theme::THEMES.get(i) {
            Some(t) => (t.id.as_str(), t.name.as_str(), theme::hex(&t.bg).unwrap_or(p.bg), vec![theme::hex(&t.accent).unwrap_or(p.accent), theme::hex(&t.text).unwrap_or(p.text)]),
            None => (theme::CUSTOM_THEME, "Custom", custom_bg, vec![custom_accent]),
        };
        let on = s.theme == id;
        let (rect, response, _) = form::choice(ui, vec2(width, 50.0), on);
        let swatch = Rect::from_min_size(pos2(rect.left() + 13.0, rect.top() + 11.0), vec2(28.0, 28.0));
        ui.painter().rect(swatch, 8.0, bg, Stroke::new(1.0, Color32::from_black_alpha(51)), StrokeKind::Inside);
        let span = dots.len() as f32 * 10.0 + (dots.len() as f32 - 1.0) * 3.0;
        for (n, dot) in dots.iter().enumerate() {
            ui.painter().circle_filled(pos2(swatch.center().x - span / 2.0 + 5.0 + n as f32 * 13.0, swatch.center().y), 5.0, *dot);
        }
        let text = widgets::clipped(ui, name, theme::font(13.0, W::Medium), if on { p.accent_light } else { p.text }, width - 26.0 - 38.0);
        widgets::text_at(ui, swatch.right() + 10.0, rect.center().y, text);
        if response.clicked() {
            s.theme = id.to_string();
        }
    });
    ui.add_space(20.0);

    form::label(ui, "Custom colours", "");
    ui.add_space(8.0);
    let wearing = s.theme == theme::CUSTOM_THEME;
    form::helper(
        ui,
        &[Seg::T("Four colours; the rest of the palette is derived from them."), Seg::T(if wearing { " You are wearing them now — every change is live." } else { " Pick them here, then select Custom above to wear them." })],
    );
    ui.add_space(10.0);
    let names = ["Background", "Panels", "Text", "Accent"];
    let fallback = [0x191715u32, 0x2a2723, 0xede9e2, 0xc96442];
    form::grid(ui, 2, 8.0, 4, |ui, i, width| {
        let (rect, response) = ui.allocate_exact_size(vec2(width, 52.5), Sense::click());
        let response = response.on_hover_cursor(CursorIcon::PointingHand);
        ui.painter().rect(rect, 12.0, p.bg3, Stroke::new(1.0, p.border), StrokeKind::Inside);
        let mut colour = theme::hex(&s.custom_theme[i]).unwrap_or(Color32::from_rgb((fallback[i] >> 16) as u8, (fallback[i] >> 8) as u8, fallback[i] as u8));
        let well = Rect::from_min_size(pos2(rect.left() + 13.0, rect.center().y - 14.0), vec2(36.0, 28.0));
        ui.painter().rect(well, 8.0, Color32::TRANSPARENT, Stroke::new(1.0, p.border), StrokeKind::Inside);
        ui.painter().rect_filled(well.shrink(3.0), 5.0, colour);
        widgets::text_at(ui, well.right() + 10.0, rect.center().y - 8.25, widgets::galley(ui, names[i], theme::font(12.0, W::Medium), p.text));
        widgets::text_at(ui, well.right() + 10.0, rect.center().y + 9.0, widgets::galley(ui, &theme::to_hex(colour).to_uppercase(), theme::mono(11.0), p.muted));
        egui::Popup::from_toggle_button_response(&response).close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside).show(|ui| {
            ui.spacing_mut().slider_width = 220.0;
            if egui::color_picker::color_picker_color32(ui, &mut colour, egui::color_picker::Alpha::Opaque) {
                s.custom_theme[i] = theme::to_hex(colour);
            }
        });
    });
}

// ------------------------------------------------------------------ Safety

fn safety(app: &mut App, ui: &mut Ui) {
    let p = p();
    let s = &mut app.settings;
    form::label(ui, "Learn from this project", "");
    ui.add_space(8.0);
    form::helper(
        ui,
        &[
            Seg::T("After a task, the assistant writes down what it proved — a command that failed, a path that did not exist — into a "),
            Seg::Code("LESSONS.md"),
            Seg::T(" in the workspace, and reads it back next time so it does not repeat the same wrong turn. Only facts with evidence behind them are kept, and one is corrected automatically when a later run disproves it."),
        ],
    );
    ui.add_space(10.0);
    let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 58.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect(row, 12.0, p.bg3, Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), StrokeKind::Inside);
    widgets::text_at(ui, row.left() + 13.0, row.top() + 11.0 + 9.75, widgets::galley(ui, if s.lessons_enabled { "On" } else { "Off" }, theme::font(13.0, W::Medium), p.text));
    let small = if s.lessons_enabled { "Adds a few hundred tokens per task; the file is yours to edit" } else { "Nothing is recorded between tasks" };
    widgets::text_at(ui, row.left() + 13.0, row.top() + 11.0 + 19.5 + 8.25, widgets::galley(ui, small, theme::font(11.0, W::Regular), p.text2));
    part(ui, Rect::from_min_size(pos2(row.right() - 13.0 - 36.0, row.center().y - 10.0), vec2(36.0, 20.0)), |ui| form::switch(ui, Switch::B, s.lessons_enabled));
    if response.clicked() {
        s.lessons_enabled = !s.lessons_enabled;
    }
    ui.add_space(20.0);

    form::label(ui, "Running commands", "");
    ui.add_space(8.0);
    form::helper(ui, &[Seg::T("When the assistant writes code, it can run it to check whether it works — and fix its own mistakes from the error.")]);
    ui.add_space(10.0);
    let auto = s.approval == Approval::Auto;
    if form::option_item(ui, !auto, "Ask me first", if auto { "" } else { "Recommended" }, "You see each command and click Run or Skip before anything happens.").clicked() {
        s.approval = Approval::Manual;
    }
    ui.add_space(6.0);
    if form::option_item(ui, auto, "Run automatically", "", "Faster, and closer to how Arena feels. Nothing pauses to ask.").clicked() {
        s.approval = Approval::Auto;
    }
    if auto {
        ui.add_space(10.0);
        form::boxed(ui, alpha(p.warning, 7.0), alpha(p.warning, 30.0), 12, (12, 10), |ui| {
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.vertical(|ui| {
                    ui.add_space(2.0);
                    icons::show(ui, icons::WARNING, 14.0, p.warning);
                });
                form::para(
                    ui,
                    "Code the assistant writes will run on this computer without asking, and so will a program it builds or downloads into the chat's folder. It can start interpreters and those programs, never a shell, and each command is stopped after 30 seconds — but a program it runs has the same access to your files that you do. Keep a restore point.",
                    12.0,
                    16.0,
                    W::Regular,
                    p.text2,
                );
            });
        });
    }
    ui.add_space(20.0);

    form::label(ui, "Delete confirmation lock", "");
    ui.add_space(6.0);
    form::helper(ui, &[Seg::T("How long the Delete button stays locked when deleting a chat. Deleting is permanent, so the pause is there to catch a misclick.")]);
    ui.add_space(10.0);
    let typed = &mut app.settings_ui.delay;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 12.0;
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            // The row is as tall as the number box from the start: laid out first, "sec" would otherwise be
            // centred on a shorter row and sit above the number's middle.
            ui.set_min_height(36.0);
            ui.add(egui::Label::new(widgets::lines("sec", 12.0, 18.0, W::Regular, p.text2)).selectable(false));
            ui.scope(|ui| {
                ui.set_width(64.0);
                let mut text = typed.clone().unwrap_or_else(|| s.delete_delay.to_string());
                let mut box_ = Input::new("").pad(8, 6).radius(8).focus(p.border_light);
                box_.center = true;
                let field = box_.show(ui, "delete-delay", &mut text);
                if field.changed() {
                    // The number as typed, unclamped until the box is left.
                    s.delete_delay = text.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0).map_or(0, |n| n.round().min(1e6) as u32);
                    *typed = Some(text);
                }
                if field.lost_focus() {
                    s.delete_delay = if s.delete_delay == 0 && typed.as_deref().is_some_and(|t| t.trim().parse::<f64>().is_err()) { 5 } else { s.delete_delay.clamp(1, 30) };
                    *typed = None;
                }
            });
            if form::slider(ui, &mut s.delete_delay, 1, 30) {
                *typed = None;
            }
        });
    });
    ui.add_space(6.0);
    form::para(ui, "Between 1 and 30 seconds.", 11.0, 16.5, W::Regular, p.muted);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_models_become_entries() {
        let found = Verified { id: "z/glm:free".into(), name: "GLM".into(), context_length: Some(1_000_000), input_price: Some(0.0), output_price: Some(0.0), supports_tools: false, supports_vision: true, supports_thinking: true };
        assert_eq!(price_line(&found), "Free · no tools · vision · thinking");
        let def = to_custom(&found, "  ", None).unwrap();
        assert_eq!((def.id().as_str(), def.label.as_str(), def.vision), ("custom:z/glm:free", "GLM", Vision::Native));
        let half = Verified { input_price: Some(0.15), output_price: None, supports_vision: false, supports_thinking: false, supports_tools: true, ..found.clone() };
        assert_eq!(price_line(&half), "$0.15 / $? per 1M in/out · tools");
        assert_eq!(price_line(&Verified { input_price: None, ..half.clone() }), "Pricing unknown — usage won't be costed · tools");
        assert!(to_custom(&Verified { id: "not a slug".into(), ..half }, "x", None).is_none());
    }
}
