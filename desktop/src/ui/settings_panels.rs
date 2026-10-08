//! The panels Settings embeds: SearchBudget, DiagnosticsPanel, McpServersSettings
//! and LocalModelRuntime (src/components, same names).

use super::form::{self, Btn, Input, Seg, Switch};
use super::theme::{self, W, alpha, p};
use super::{App, widgets};
use crate::local::engine::{self, ActionResult, SetOpts};
use crate::local::shared::{self, EngineDownloadEvent, EngineGpu, EngineGpuState, EngineStatus, SidecarMachinePlan};
use crate::mcp::{self, McpServerInput, McpServerPublic};
use crate::store;
use eframe::egui::{self, Color32, Sense, Stroke, StrokeKind, Ui, vec2};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct State {
    servers: Option<Vec<McpServerPublic>>,
    form: Option<ServerForm>,
    /// Whether the token box shows its text. Kept between openings of the form, as on the web.
    show_token: bool,
    usage: Option<(crate::search_usage::Summary, (usize, u64))>,
    report: Option<crate::diagnostics::Report>,
    local: Local,
}

#[derive(Default)]
struct ServerForm {
    /// The server being edited. None adds a new one.
    id: Option<String>,
    name: String,
    url: String,
    token: String,
    error: String,
    test: Test,
}

#[derive(Default)]
enum Test {
    #[default]
    Idle,
    Running(mpsc::Receiver<Result<String, String>>),
    Ok(String),
    Failed(String),
}

// ------------------------------------------------------------------ Web search

/// (id, name, what it does)
const PROFILES: [(&str, &str, &str); 3] = [
    ("quality", "Thorough", "Reads full pages on every search from the start. The most expensive, and how the app behaved before."),
    ("balanced", "Balanced", "Skims first, then reads full pages only for whatever is still missing. Same answers on most questions, roughly half the cost."),
    ("cheap", "Frugal", "Skims only, and asks fewer questions per search. Cheapest, and weaker when an answer is buried deep in a page."),
];

/// "$0.00", "$0.0042", "$1.25": what a search bill looks like.
fn money(usd: f64) -> String {
    if usd == 0.0 {
        "$0.00".into()
    } else if usd < 0.01 {
        format!("${usd:.4}")
    } else {
        format!("${usd:.2}")
    }
}

pub fn search(app: &mut App, ui: &mut Ui) {
    let p = p();
    form::label(ui, "Web search cost", "");
    ui.add_space(8.0);
    form::helper(ui, &[Seg::T("Each search is charged separately, and one question can trigger several. This is how hard the assistant looks before it answers.")]);
    ui.add_space(10.0);
    for (i, (id, name, blurb)) in PROFILES.iter().enumerate() {
        if i > 0 {
            ui.add_space(6.0);
        }
        let active = app.settings.search_profile == *id;
        if form::option_item(ui, active, name, if active && *id == "balanced" { "Recommended" } else { "" }, blurb).clicked() {
            app.settings.search_profile = id.to_string();
        }
    }

    let st = &mut app.settings_ui.panels;
    let (usage, (entries, _)) = st.usage.get_or_insert_with(|| (crate::search_usage::summary(), crate::search_usage::cache_stats()));
    let mut reload = false;
    ui.add_space(12.0);
    form::boxed(ui, alpha(p.bg3, 60.0), p.border, 12, (12, 10), |ui| {
        ui.horizontal(|ui| {
            ui.add(egui::Label::new(widgets::lines("This month", 12.0, 18.0, W::Medium, p.text)).selectable(false));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let days = usage.days_until_reset;
                ui.add(egui::Label::new(widgets::lines(format!("resets in {days} {}", if days == 1 { "day" } else { "days" }), 11.0, 16.5, W::Regular, p.muted)).selectable(false));
            });
        });
        for provider in usage.providers.iter().filter(|q| q.free_monthly_usd > 0.0) {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.add(egui::Label::new(widgets::lines(&provider.label, 11.0, 16.5, W::Regular, p.text2)).selectable(false));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let (text, ink) = if provider.exhausted { ("free credit used up".to_string(), p.danger) } else { (format!("about {} searches left", crate::plugins::grouped(provider.remaining_requests as usize)), p.muted) };
                    ui.add(egui::Label::new(widgets::lines(text, 11.0, 16.5, W::Regular, ink)).selectable(false));
                });
            });
            ui.add_space(4.0);
            let (bar, _) = ui.allocate_exact_size(vec2(ui.available_width(), 4.0), Sense::hover());
            ui.painter().rect_filled(bar, 2.0, p.bg2);
            let part = (provider.usd / provider.free_monthly_usd).clamp(0.0, 1.0) as f32;
            ui.painter().rect_filled(egui::Rect::from_min_size(bar.min, vec2(bar.width() * part, 4.0)), 2.0, if provider.exhausted { p.danger } else { p.accent });
        }
        ui.add_space(10.0);
        widgets::rule(ui);
        ui.add_space(8.0);
        let stats = [(usage.questions.to_string(), "questions"), (usage.total_requests.to_string(), "searches"), (money(usage.total_usd), "spent")];
        form::grid(ui, 3, 8.0, 3, |ui, i, width| {
            ui.allocate_ui_with_layout(vec2(width, 36.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                ui.set_width(width);
                form::line(ui, &stats[i].0, 13.0, 19.5, W::Medium, p.text);
                form::line(ui, stats[i].1, 11.0, 16.5, W::Regular, p.muted);
            });
        });
        if usage.questions > 0 {
            ui.add_space(8.0);
            let reused = if usage.total_cached > 0 { format!(" · {} reused from cache, free", usage.total_cached) } else { String::new() };
            form::para(ui, &format!("{:.1} searches per question{reused}", usage.requests_per_question), 11.0, 16.0, W::Regular, p.muted);
        }
        ui.add_space(6.0);
        form::para(ui, "Counted here rather than read from the provider, so treat it as an estimate. It is accurate as long as this app is the only thing using the key.", 11.0, 16.0, W::Regular, p.muted);
        ui.add_space(8.0);
        form::wrap_row(ui, 6.0, |ui| {
            let small = |label| Btn::outline(label).text(11.0, 16.5).weight(W::Regular).pad(8.0, 4.0).fill(Color32::TRANSPARENT, Color32::TRANSPARENT).border(p.border, p.border_light);
            let cache = if *entries > 0 { format!("Clear cache ({entries})") } else { "Clear cache".to_string() };
            if small(&cache).enabled(*entries > 0).show(ui).clicked() {
                crate::search_usage::clear_cache();
                reload = true;
            }
            if small("Reset counter").show(ui).clicked() {
                crate::search_usage::reset();
                reload = true;
            }
        });
    });
    if reload {
        st.usage = None;
    }
}

// ------------------------------------------------------------------ Reports

pub fn reports(app: &mut App, ui: &mut Ui) {
    let p = p();
    let st = &mut app.settings_ui.panels;
    form::label(ui, "Problem report", "");
    ui.add_space(8.0);
    form::helper(
        ui,
        &[Seg::T("Failures are recorded as they happen — tools that errored, commands refused, runs that hit a limit. Grouped by how often each one occurs, so the thing worth fixing first is at the top. This never leaves your machine, and API keys are stripped before anything is written.")],
    );
    ui.add_space(12.0);
    let report = st.report.get_or_insert_with(crate::diagnostics::report);
    let total = report.total;
    if report.groups.is_empty() {
        form::boxed(ui, p.bg3, p.border, 12, (12, 16), |ui| {
            ui.vertical_centered(|ui| {
                form::para(ui, "Nothing recorded yet.", 13.0, 19.5, W::Regular, p.text2);
                ui.add_space(4.0);
                form::para(ui, "Failures will show up here as they happen.", 11.0, 16.5, W::Regular, p.muted);
            });
        });
    } else {
        egui::Frame::new().stroke(Stroke::new(1.0, p.border)).corner_radius(12).show(ui, |ui| {
            ui.set_width(ui.available_width());
            for (i, group) in report.groups.iter().take(12).enumerate() {
                if i > 0 {
                    widgets::rule(ui);
                }
                egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal_top(|ui| {
                        ui.spacing_mut().item_spacing.x = 10.0;
                        let count = widgets::galley(ui, &group.count.to_string(), theme::font(11.0, W::Semibold), p.text2);
                        let (cell, pill) = ui.allocate_exact_size(vec2((count.size().x + 12.0).max(20.0), 22.0), Sense::hover());
                        let badge = egui::Rect::from_center_size(cell.center() + vec2(0.0, 1.0), vec2(cell.width(), 20.0));
                        ui.painter().rect_filled(badge, 10.0, p.bg3);
                        widgets::text_at(ui, badge.center().x - count.size().x / 2.0, badge.center().y, count);
                        pill.on_hover_text(format!("{} occurrence{}", group.count, if group.count == 1 { "" } else { "s" }));
                        ui.vertical(|ui| {
                            let mut job = egui::text::LayoutJob::default();
                            job.wrap = egui::text::TextWrapping { max_width: ui.available_width(), max_rows: 1, break_anywhere: true, overflow_character: Some('…') };
                            let format = |font, color| egui::TextFormat { font_id: font, color, line_height: Some(19.5), ..Default::default() };
                            job.append(crate::diagnostics::kind_label(&group.kind), 0.0, format(theme::font(13.0, W::Medium), p.text));
                            job.append(&group.subject, 6.0, format(theme::mono(12.0), p.text2));
                            ui.add(egui::Label::new(job).selectable(false));
                            ui.add_space(2.0);
                            form::para(ui, &group.example, 11.0, 16.0, W::Regular, p.muted);
                        });
                    });
                });
            }
        });
    }
    ui.add_space(12.0);
    let mut reload = false;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let plain = |label| Btn::outline(label).pad(12.0, 6.0).fill(p.bg3, p.bg3).border(p.border, p.border_light);
        if plain("Export as Markdown").enabled(total > 0).show(ui).clicked() {
            if let Some(path) = rfd::FileDialog::new().set_file_name("apim-diagnostics.md").save_file() {
                let _ = std::fs::write(path, crate::diagnostics::markdown());
            }
        }
        reload |= plain("Refresh").show(ui).clicked();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if Btn::ghost("Clear").weight(W::Medium).pad(12.0, 6.0).ink(p.muted, p.danger).enabled(total > 0).show(ui).clicked() {
                crate::diagnostics::clear();
                reload = true;
            }
        });
    });
    if total > 0 {
        ui.add_space(8.0);
        form::para(ui, &format!("{total} event{} recorded. Export and paste it into a chat to have the problems read back to you.", if total == 1 { "" } else { "s" }), 11.0, 16.5, W::Regular, p.muted);
    }
    if reload {
        st.report = None;
    }
}

// ------------------------------------------------------------------ MCP servers

pub fn mcp(app: &mut App, ui: &mut Ui) {
    let p = p();
    let data = store::data_dir();
    let rt = app.rt.handle().clone();
    let st = &mut app.settings_ui.panels;
    let servers = st.servers.get_or_insert_with(|| mcp::list(&data)).clone();
    let mut reload = false;

    form::para(ui, "MCP servers lend the AI extra tools — a Roblox bridge, a database, a search box. Enabled servers' tools appear in its tool list, and every call asks your permission first.", 12.0, 16.0, W::Regular, p.text2);
    for server in &servers {
        ui.add_space(16.0);
        form::boxed(ui, p.bg3, p.border, 12, (16, 12), |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                if form::switch(ui, Switch::B, server.enabled).clicked() {
                    let _ = mcp::save(&data, &McpServerInput { id: Some(server.id.clone()), name: server.name.clone(), url: server.url.clone(), enabled: Some(!server.enabled), ..Default::default() });
                    reload = true;
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    let small = |label| Btn::ghost(label).pad(10.0, 6.0).text(12.0, 18.0);
                    if small("Delete").ink(alpha(p.danger, 80.0), p.danger).fill(Color32::TRANSPARENT, alpha(p.danger, 10.0)).show(ui).clicked() {
                        let _ = mcp::delete(&data, &server.id);
                        reload = true;
                    }
                    if small("Edit").ink(p.text2, p.text).fill(Color32::TRANSPARENT, p.hover).show(ui).clicked() {
                        st.form = Some(ServerForm { id: Some(server.id.clone()), name: server.name.clone(), url: server.url.clone(), ..Default::default() });
                    }
                    ui.add_space(10.0);
                    ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                        form::line(ui, &server.name, 14.0, 20.0, W::Semibold, p.text);
                        let address = format!("{}{}", server.url, if server.has_token { " · token set" } else { "" });
                        ui.add(egui::Label::new(egui::RichText::new(address).font(theme::mono(12.0)).color(p.muted).line_height(Some(18.0))).truncate().selectable(false));
                    });
                });
            });
        });
    }
    ui.add_space(16.0);

    let Some(form) = st.form.as_mut() else {
        if servers.is_empty() {
            form::para(ui, "No MCP servers yet. Add one to give the AI remote tools.", 14.0, 20.0, W::Regular, p.muted);
            ui.add_space(16.0);
        }
        if Btn::outline("+ Add MCP server").text(14.0, 20.0).weight(W::Regular).pad(16.0, 8.0).radius(12.0).fill(Color32::TRANSPARENT, Color32::TRANSPARENT).border(p.border, alpha(p.accent, 50.0)).dashed().show(ui).clicked() {
            st.form = Some(ServerForm { url: "http://127.0.0.1:8225/mcp".into(), ..Default::default() });
        }
        if reload {
            st.servers = None;
            mcp::clear_tool_cache();
        }
        return;
    };

    // The answer of a connection test that was under way.
    if let Test::Running(rx) = &form.test {
        if let Ok(result) = rx.try_recv() {
            form.test = match result {
                Ok(text) => Test::Ok(text),
                Err(why) => Test::Failed(why),
            };
        }
    }
    let editing = form.id.is_some();
    let mut close = false;
    form::boxed(ui, alpha(p.accent, 4.0), alpha(p.accent, 30.0), 12, (16, 16), |ui| {
        form::label(ui, "Name", "");
        ui.add_space(6.0);
        Input::new("Potassium").show(ui, "mcp-name", &mut form.name);
        ui.add_space(12.0);
        form::label(ui, "Endpoint URL", "");
        ui.add_space(6.0);
        Input::new("http://127.0.0.1:8225/mcp").mono().show(ui, "mcp-url", &mut form.url);
        ui.add_space(12.0);
        form::label(ui, "Bearer token", if editing { "(leave empty to keep the stored one)" } else { "" });
        ui.add_space(6.0);
        let mut token = Input::new(if editing { "••••••" } else { "paste the server token" });
        token.password = false;
        let field = if st.show_token { token.show(ui, "mcp-token", &mut form.token) } else { secret(ui, token, &mut form.token) };
        // "Show" / "Hide" sits over the box's right edge.
        let word = widgets::galley(ui, if st.show_token { "Hide" } else { "Show" }, theme::font(14.0, W::Regular), p.muted);
        let frame = field.rect.expand2(vec2(16.0, 10.0));
        let at = egui::Rect::from_min_size(egui::pos2(frame.right() - 12.0 - word.size().x - 1.0, frame.center().y - 10.0), vec2(word.size().x, 20.0));
        let toggle = ui.interact(at, ui.id().with("show-token"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
        ui.painter().galley_with_override_text_color(egui::pos2(at.left(), at.center().y - word.size().y / 2.0), word, if toggle.hovered() { p.text2 } else { p.muted });
        if toggle.clicked() {
            st.show_token = !st.show_token;
        }
        if !form.error.is_empty() {
            ui.add_space(12.0);
            form::para(ui, &form.error, 13.0, 19.5, W::Regular, p.danger);
        }
        let status = match &form.test {
            Test::Idle => None,
            Test::Running(_) => Some(("Connecting…", p.muted)),
            Test::Ok(text) => Some((text.as_str(), p.success)),
            Test::Failed(why) => Some((why.as_str(), p.danger)),
        };
        if let Some((text, ink)) = status {
            ui.add_space(12.0);
            form::para(ui, text, 13.0, 19.5, W::Regular, ink);
        }
        ui.add_space(12.0);
        let testing = matches!(form.test, Test::Running(_));
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(8.0, 8.0);
            let ready = !form.name.trim().is_empty() && !form.url.trim().is_empty();
            if Btn::accent(if editing { "Save changes" } else { "Add server" }).text(14.0, 20.0).pad(16.0, 8.0).radius(12.0).enabled(ready).show(ui).clicked() {
                // An edit always switches the server back on, as on the web.
                let input = McpServerInput { id: form.id.clone(), name: form.name.clone(), url: form.url.clone(), token: form.token.clone(), enabled: editing.then_some(true), ..Default::default() };
                match mcp::save(&data, &input) {
                    Ok(_) => close = true,
                    Err(why) => form.error = if why.is_empty() { "Could not save.".into() } else { why },
                }
            }
            if Btn::outline(if testing { "Testing…" } else { "Test connection" }).text(14.0, 20.0).weight(W::Regular).pad(16.0, 8.0).radius(12.0).enabled(!testing && !form.url.trim().is_empty()).show(ui).clicked() {
                let (tx, rx) = mpsc::channel();
                // A saved server with nothing typed is tested with its stored token.
                let (id, url, token) = match &form.id {
                    Some(id) if form.token.is_empty() => (id.clone(), String::new(), String::new()),
                    _ => (String::new(), form.url.clone(), form.token.clone()),
                };
                let (data, wake) = (data.clone(), ui.ctx().clone());
                rt.spawn(async move {
                    let result = mcp::test(&crate::provider::client(), &data, &id, &url, &token).await.map(|found| {
                        let names: Vec<&str> = found.tools.iter().map(|t| t.name.as_str()).collect();
                        let server = if found.server.name.is_empty() { "server" } else { found.server.name.as_str() };
                        format!("Connected to {server} — {} tool(s): {}", names.len(), if names.is_empty() { "none listed".to_string() } else { names.join(", ") })
                    });
                    let _ = tx.send(result.map_err(|why| if why.is_empty() { "Connection failed.".to_string() } else { why }));
                    wake.request_repaint();
                });
                form.test = Test::Running(rx);
            }
            if Btn::ghost("Cancel").text(14.0, 20.0).pad(12.0, 8.0).radius(12.0).show(ui).clicked() {
                close = true;
                reload = false;
            }
        });
    });
    if close {
        st.form = None;
        st.servers = None;
        mcp::clear_tool_cache();
    }
    if reload {
        st.servers = None;
        mcp::clear_tool_cache();
    }
}

/// A password box without the eye (the MCP form has its own Show/Hide word).
fn secret(ui: &mut Ui, look: Input, value: &mut String) -> egui::Response {
    let p = p();
    let id = ui.make_persistent_id("mcp-token");
    let focused = ui.memory(|m| m.has_focus(id));
    let frame = egui::Frame::new().fill(look.fill).stroke(Stroke::new(1.0, if focused { look.focus } else { p.border })).corner_radius(look.radius).inner_margin(egui::Margin::symmetric(look.pad.0, look.pad.1));
    let out = frame.show(ui, |ui| {
        ui.add(
            egui::TextEdit::singleline(value)
                .id(id)
                .password(true)
                .hint_text(widgets::text(look.hint, look.size, W::Regular, p.muted))
                .font(theme::font(look.size, W::Regular))
                .text_color(p.text)
                .desired_width(f32::INFINITY)
                .min_size(vec2(0.0, look.line))
                .vertical_align(egui::Align::Center)
                .frame(egui::Frame::NONE)
                .margin(egui::Margin::ZERO),
        )
    });
    if focused {
        ui.painter().rect_stroke(out.response.rect, look.radius, Stroke::new(1.0, look.ring), StrokeKind::Outside);
    }
    out.inner
}

// ------------------------------------------------------------------ the local model

/// How often the card asks the engine for its status: the web's 4 s poll.
const POLL: Duration = Duration::from_secs(4);
/// The model the card switches Settings to (the web's QWEN_38_27B_ID).
const QWEN_ID: &str = "qwen-3.8-27b";

/// What the card keeps between frames: the last status, the engine call under way and the download's progress.
#[derive(Default)]
pub struct Local {
    status: Option<EngineStatus>,
    probe: Option<mpsc::Receiver<EngineStatus>>,
    probed_at: Option<Instant>,
    job: Option<Job>,
    pull: Option<Pull>,
    error: Option<String>,
    /// The llama-server flag being typed.
    flag: String,
}

/// An engine call on its way. `cancel` stops a download; an action only reports back.
struct Job {
    kind: Busy,
    rx: mpsc::Receiver<Note>,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Copy, PartialEq)]
enum Busy {
    Download,
    Start,
    Restart,
    Opts,
    Stop,
}

/// What a background thread reports: a download event, the answer to an engine action, or the end of a download.
enum Note {
    Pull(EngineDownloadEvent),
    Acted(Result<ActionResult, String>),
    Ended,
}

/// The download's progress line. `percent` is None while the total is unknown.
#[derive(Clone, Default)]
struct Pull {
    label: String,
    percent: Option<u32>,
    completed: u64,
    total: u64,
}

/// An engine action, run off the UI thread.
enum Call {
    Start,
    Restart,
    Stop,
    Opts(SetOpts),
}

impl Call {
    async fn run(self) -> Result<ActionResult, String> {
        match self {
            Call::Start => Ok(engine::start().await),
            Call::Restart => Ok(engine::restart().await),
            Call::Stop => Ok(engine::stop().await),
            Call::Opts(req) => engine::set_opts(req).await,
        }
    }
}

/// A click on the card. Clicks are collected while the card is drawn and acted on after it.
enum Click {
    Use,
    Start,
    Restart,
    Unload,
    Download,
    Cancel,
    Backend(&'static str),
    Preset(&'static str),
    Remove(usize),
    Add,
}

/// Runs `work` on a thread of its own with its own runtime, as ui/github.rs does: the engine waits on child processes
/// and probes, so it stays off the app's runtime. The window wakes when the answer is in.
fn background<T: Send + 'static, F: Future<Output = T>>(ctx: &egui::Context, work: impl FnOnce() -> F + Send + 'static) -> mpsc::Receiver<T> {
    let (tx, rx) = mpsc::channel();
    let wake = ctx.clone();
    std::thread::spawn(move || {
        let out = tokio::runtime::Runtime::new().expect("async runtime").block_on(work());
        let _ = tx.send(out);
        wake.request_repaint();
    });
    rx
}

/// Settings point at the in-app sidecar and at Qwen: the web's applyReady.
fn use_qwen(settings: &mut store::Settings) {
    settings.local_base_url = shared::DEFAULT_LOCAL_BASE_URL.into();
    settings.local_api_model = shared::DEFAULT_LOCAL_API_MODEL.into();
    settings.model = QWEN_ID.into();
}

/// Starts a status probe. Only one is in flight at a time.
fn probe(st: &mut Local, ctx: &egui::Context) {
    st.probed_at = Some(Instant::now());
    st.probe = Some(background(ctx, engine::status));
}

/// Takes in what the background threads sent since the last frame, and asks for a status when one is due.
/// With `live` off (a shot state) no engine is called.
fn pump(st: &mut Local, settings: &mut store::Settings, ctx: &egui::Context, live: bool) {
    match st.probe.as_ref().map(|rx| rx.try_recv()) {
        Some(Ok(status)) => {
            st.status = Some(status);
            st.probe = None;
        }
        Some(Err(mpsc::TryRecvError::Disconnected)) => st.probe = None,
        _ => {}
    }
    let notes: Vec<Note> = st.job.as_ref().map(|job| job.rx.try_iter().collect()).unwrap_or_default();
    let mut ended = false;
    for note in notes {
        match note {
            Note::Pull(EngineDownloadEvent::Progress { label, completed, total, percent }) => st.pull = Some(Pull { label, percent, completed, total }),
            Note::Pull(EngineDownloadEvent::Status { message }) => st.pull = Some(Pull { label: message, ..st.pull.take().unwrap_or_default() }),
            Note::Pull(EngineDownloadEvent::Done) => {
                st.pull = Some(Pull { label: "Ready".into(), percent: Some(100), ..Default::default() });
                use_qwen(settings);
            }
            Note::Pull(EngineDownloadEvent::Error { message }) => st.error = Some(message),
            Note::Acted(Ok(result)) => {
                st.status = Some(result.status);
                if !result.ok {
                    st.error = Some(result.error.unwrap_or_else(|| "Could not update the local model.".into()));
                }
                ended = true;
            }
            Note::Acted(Err(why)) => {
                st.error = Some(why);
                ended = true;
            }
            Note::Ended => ended = true,
        }
    }
    if ended {
        // The web refreshes the status after every action and every download.
        st.job = None;
        st.pull = None;
        st.probed_at = None;
    }
    if live {
        // The status is not polled during a download, as on the web.
        let downloading = st.job.as_ref().is_some_and(|job| job.kind == Busy::Download);
        if st.probe.is_none() && !downloading && st.probed_at.is_none_or(|at| at.elapsed() >= POLL) {
            probe(st, ctx);
        }
        ctx.request_repaint_after(POLL);
    }
}

/// Starts the download on its own thread. Its events come back through `pump`; `cancel` stops it between chunks.
// ponytail: the download keeps going when Settings closes (the web aborts it on unmount); Use Qwen then waits for the card to draw again.
fn download(st: &mut Local, ctx: &egui::Context) {
    let cancel = Arc::new(AtomicBool::new(false));
    let (flag, wake) = (cancel.clone(), ctx.clone());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        tokio::runtime::Runtime::new().expect("async runtime").block_on(async {
            let mut emit = |ev: EngineDownloadEvent| {
                let _ = tx.send(Note::Pull(ev));
                wake.request_repaint();
            };
            engine::download(&flag, &mut emit).await;
            let _ = tx.send(Note::Ended);
            wake.request_repaint();
        });
    });
    st.error = None;
    st.pull = Some(Pull { label: "Starting".into(), ..Default::default() });
    st.job = Some(Job { kind: Busy::Download, rx, cancel });
}

/// Starts an engine action on its own thread. Its answer comes back through `pump`.
fn act(st: &mut Local, ctx: &egui::Context, kind: Busy, call: Call) {
    st.error = None;
    let rx = background(ctx, move || async move { Note::Acted(call.run().await) });
    st.job = Some(Job { kind, rx, cancel: Arc::new(AtomicBool::new(false)) });
}

/// Saves flags and restarts the sidecar with them. Settings point at Qwen first, as on the web.
fn opts(st: &mut Local, ctx: &egui::Context, settings: &mut store::Settings, req: SetOpts) {
    use_qwen(settings);
    act(st, ctx, Busy::Opts, Call::Opts(req));
}

/// Stops the download under way. Its late events are dropped with the job.
fn cancel(st: &mut Local) {
    if let Some(job) = st.job.take() {
        job.cancel.store(true, Ordering::Relaxed);
    }
    st.pull = None;
}

/// Before the first answer nothing is known yet (the web's emptyStatus).
fn checking() -> EngineStatus {
    let mut s = blank_status();
    s.hint = "Checking this PC…".into();
    s.gpu.note = "Checking this PC…".into();
    s
}

/// Nothing on disk and nothing running.
fn blank_status() -> EngineStatus {
    EngineStatus {
        gguf_ready: false,
        gguf_bytes: 0,
        gguf_expected: shared::GGUF_BYTES,
        mmproj_ready: false,
        mmproj_bytes: 0,
        mmproj_expected: shared::MMPROJ_BYTES,
        server_ready: false,
        running: false,
        base_url: shared::DEFAULT_LOCAL_BASE_URL.into(),
        api_model: shared::DEFAULT_LOCAL_API_MODEL.into(),
        hint: String::new(),
        n_ctx: None,
        spec: shared::default_spec_state(),
        gpu: EngineGpuState { detected: EngineGpu::None, in_use: None, backend: None, offloaded: None, note: "Not running. The GPU is used once Qwen starts.".into(), log_tail: vec![] },
        gpu_plan: None,
    }
}

/// Shot states (`APIM_SHOT_STATE`): `local-none`, `local-partial`, `local-downloading`, `local`, `local-error`,
/// `local-running` (window too small) and `local-ready`. The card gets a sample status; no engine call is made.
pub fn stage(app: &mut App, token: &str) {
    // `local-end` is a scroll flag (see local_runtime), not a state.
    if token == "local-end" {
        return;
    }
    let mut s = blank_status();
    let mut st = Local::default();
    if matches!(token, "local" | "local-error" | "local-running" | "local-ready") {
        s.gguf_ready = true;
        s.gguf_bytes = shared::GGUF_BYTES;
        s.mmproj_ready = true;
        s.mmproj_bytes = shared::MMPROJ_BYTES;
        s.spec.extra = vec!["--spec-draft-p-min 0.85".into()];
        s.gpu.detected = EngineGpu::Nvidia;
        s.gpu.log_tail = vec![
            "llama_model_load: loaded Qwen3.8-27B-Q4_K_M.gguf".into(),
            "load_tensors: offloaded 65/65 layers to GPU".into(),
            "load_tensors:   CUDA0 model buffer size = 11204.13 MiB".into(),
            "srv    load_model: n_ctx = 81920".into(),
            "main: server is listening on http://127.0.0.1:18765".into(),
        ];
    }
    let run = |s: &mut EngineStatus, n_ctx: u64| {
        s.running = true;
        s.server_ready = true;
        s.n_ctx = Some(n_ctx);
    };
    match token {
        "local-partial" => s.gguf_bytes = shared::GGUF_BYTES * 37 / 100,
        "local-downloading" => {
            s.gguf_bytes = shared::GGUF_BYTES * 42 / 100;
            st.pull = Some(Pull { label: "Downloading Qwen3.8-27B-Q4_K_M.gguf".into(), percent: Some(42), completed: 7_470_000_000, total: shared::GGUF_BYTES });
            st.job = Some(Job { kind: Busy::Download, rx: mpsc::channel::<Note>().1, cancel: Arc::new(AtomicBool::new(false)) });
        }
        "local-error" => st.error = Some("Qwen did not start: llama-server exited with code 1. The engine log says why.".into()),
        "local-running" => {
            run(&mut s, 65_536);
            s.gpu.in_use = Some(false);
            s.gpu.note = "The engine runs on the CPU: no CUDA device was loaded. Switch the build, Download, then Restart.".into();
        }
        "local-ready" => {
            run(&mut s, shared::SIDECAR_CTX);
            s.gpu.in_use = Some(true);
            s.gpu.note = "CUDA0 holds all 65 layers (11.2 GB).".into();
            s.gpu_plan = Some(SidecarMachinePlan { ngl: 99, threads: 8, vram_mb: 12_288, layers: 65, ram_free_gb: 18.0 });
        }
        _ => {}
    }
    s.hint = shared::engine_hint(s.gguf_ready, s.mmproj_ready, s.server_ready, s.running, s.gguf_bytes as f64);
    st.status = Some(s);
    app.settings_ui.panels.local = st;
}

/// The accent button, the bordered one, the unload one that turns red on hover, and the muted cancel link.
fn primary(label: &str) -> Btn<'_> {
    let p = p();
    Btn::outline(label).text(12.0, 16.0).weight(W::Medium).pad(10.0, 6.0).fill(alpha(p.accent, 10.0), alpha(p.accent, 15.0)).border(alpha(p.accent, 30.0), alpha(p.accent, 30.0)).ink(p.accent_light, p.accent_light)
}

fn secondary(label: &str) -> Btn<'_> {
    let p = p();
    Btn::outline(label).text(12.0, 16.0).weight(W::Medium).pad(10.0, 6.0).fill(p.bg2, p.bg2).border(p.border, p.border_light).ink(p.text2, p.text)
}

fn unload(label: &str) -> Btn<'_> {
    let p = p();
    secondary(label).border(p.border, alpha(p.danger, 40.0)).ink(p.text2, p.danger)
}

fn cancel_btn() -> Btn<'static> {
    let p = p();
    Btn::ghost("Cancel").text(12.0, 16.0).weight(W::Medium).pad(10.0, 6.0).ink(p.muted, p.text)
}

/// A backend choice: a box with its name at the left, lit when it is the build in use.
fn tile(ui: &mut Ui, width: f32, active: bool, enabled: bool, label: &str) -> egui::Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(width, 30.0), Sense::click());
    let response = response.on_hover_cursor(if enabled { egui::CursorIcon::PointingHand } else { egui::CursorIcon::NotAllowed });
    let t = widgets::fade(ui, response.id, response.hovered() && enabled && !active);
    let (fill, border, ink) = if active { (alpha(p.accent, 15.0), alpha(p.accent, 30.0), p.accent_light) } else { (p.bg2, widgets::lerp(p.border, p.border_light, t), widgets::lerp(p.text2, p.text, t)) };
    let dim = if enabled { 1.0 } else { 0.4 };
    ui.painter().rect(rect, 8.0, fill.gamma_multiply(dim), Stroke::new(1.0, border.gamma_multiply(dim)), StrokeKind::Inside);
    let text = widgets::galley(ui, label, theme::font(12.0, W::Medium), ink.gamma_multiply(dim));
    widgets::text_at(ui, rect.left() + 10.0, rect.center().y, text);
    response
}

/// A spec preset: its flag and what it does, with On or Off at the right. Bordered like the web's row.
fn preset_row(ui: &mut Ui, enabled: bool, on: bool, label: &str, blurb: &str) -> egui::Response {
    let p = p();
    let dim = if enabled { 1.0 } else { 0.4 };
    let frame = egui::Frame::new().fill(p.bg2.gamma_multiply(dim)).stroke(Stroke::new(1.0, p.border.gamma_multiply(dim))).corner_radius(8).inner_margin(egui::Margin::symmetric(10, 6));
    let row = frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                form::line(ui, label, 12.0, 16.0, W::Medium, p.text.gamma_multiply(dim));
                form::para(ui, blurb, 11.0, 12.0, W::Regular, p.muted.gamma_multiply(dim));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                let (word, ink) = if on { ("On", p.accent_light) } else { ("Off", p.muted) };
                form::line(ui, word, 11.0, 16.0, W::Medium, ink.gamma_multiply(dim));
            });
        });
    });
    ui.interact(row.response.rect, ui.id().with(("preset", label)), Sense::click()).on_hover_cursor(if enabled { egui::CursorIcon::PointingHand } else { egui::CursorIcon::NotAllowed })
}

/// LocalModelRuntime: the card that downloads and runs Qwen inside the app. Mirrors src/components/LocalModelRuntime.tsx.
pub fn local_runtime(app: &mut App, ui: &mut Ui) {
    let p = p();
    let ctx = ui.ctx().clone();
    let live = app.shot.is_none();
    // Shot states only: the settings scroll area is brought to the card (or its end, for `local-end`) so the harness can see it.
    let shot_end = !live && app.staged("local-end");
    let st = &mut app.settings_ui.panels.local;
    pump(st, &mut app.settings, &ctx, live);
    let s = st.status.clone().unwrap_or_else(checking);
    let busy = st.job.as_ref().map(|job| job.kind);
    let downloading = busy == Some(Busy::Download);
    let (pull, error) = (st.pull.clone(), st.error.clone());
    let ready = s.running && s.gguf_ready;
    let small = s.n_ctx.is_some_and(|n| n < shared::SIDECAR_CTX);
    let mut click = None;

    form::boxed(ui, p.bg3, p.border, 12, (12, 12), |ui| {
        if !live && !shot_end {
            ui.scroll_to_cursor(Some(egui::Align::TOP));
        }
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                form::para(ui, "On this PC", 13.0, 20.0, W::Medium, p.text);
                ui.add_space(2.0);
                form::para(ui, "Download the 27B into this app. A sidecar on your machine runs it — the chat window never loads the weights.", 11.0, 16.0, W::Regular, p.muted);
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                ui.vertical(|ui| {
                    ui.add_space(2.0);
                    let (dot, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
                    let ink = if ready && !small { p.success } else if busy.is_some() || small { p.warning } else { p.muted };
                    ui.painter().circle_filled(dot.center(), 4.0, ink);
                });
            });
        });

        ui.add_space(8.0);
        form::para(ui, &s.hint, 12.0, 16.0, W::Regular, p.text2);
        if s.running {
            ui.add_space(4.0);
            let window = s.n_ctx.map_or_else(|| "unknown".to_string(), |n| format!("{} tokens", crate::plugins::grouped(n as usize)));
            let verdict = if small { "— too small, Restart".to_string() } else { format!("(need {})", crate::plugins::grouped(shared::SIDECAR_CTX as usize)) };
            form::para(ui, &format!("Window: {window} {verdict}"), 11.0, 16.0, W::Regular, if small { p.danger } else { p.muted });
        }
        let (word, ink) = match s.gpu.in_use {
            Some(true) => ("GPU active", p.success),
            Some(false) => ("GPU not in use", p.danger),
            None => ("GPU", p.muted),
        };
        ui.add_space(4.0);
        form::rich(ui, 11.0, 16.0, ink, &[Seg::B(&format!("{word}: ")), Seg::T(&s.gpu.note)]);
        if let Some(plan) = shared::format_gpu_plan(s.gpu_plan.as_ref()) {
            ui.add_space(4.0);
            form::para(ui, &plan, 11.0, 16.0, W::Regular, p.muted);
        }
        if s.gguf_bytes > 0 && !s.gguf_ready && pull.is_none() {
            ui.add_space(4.0);
            let on_disk = format!("{} of {} on disk — click Download to resume.", shared::format_bytes(s.gguf_bytes as f64), shared::format_bytes(s.gguf_expected as f64));
            form::para(ui, &on_disk, 11.0, 16.0, W::Regular, p.muted);
        }
        if let Some(pull) = &pull {
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                let label = if pull.label.is_empty() { "Downloading".to_string() } else { pull.label.clone() };
                ui.add(egui::Label::new(widgets::text(label, 11.0, W::Regular, p.muted)).selectable(false));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let right = match (pull.percent, pull.total) {
                        (Some(percent), _) => format!("{percent}%"),
                        (None, total) if total > 0 => format!("{} / {}", shared::format_bytes(pull.completed as f64), shared::format_bytes(total as f64)),
                        _ => "…".to_string(),
                    };
                    ui.add(egui::Label::new(widgets::text(right, 11.0, W::Regular, p.muted)).selectable(false));
                });
            });
            ui.add_space(4.0);
            let (track, _) = ui.allocate_exact_size(vec2(ui.available_width(), 6.0), Sense::hover());
            ui.painter().rect_filled(track, 3.0, p.bg2);
            let share = pull.percent.map_or(0.08, |percent| percent as f32 / 100.0);
            ui.painter().rect_filled(egui::Rect::from_min_size(track.min, vec2(track.width() * share, 6.0)), 3.0, p.accent);
        }
        if let Some(error) = &error {
            ui.add_space(8.0);
            form::para(ui, error, 12.0, 16.0, W::Regular, p.danger);
        }

        ui.add_space(12.0);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
            if ready {
                if primary("Use Qwen 3.8 27B").show(ui).clicked() {
                    click = Some(Click::Use);
                }
                if secondary(if busy == Some(Busy::Restart) { "Restarting…" } else { "Restart" }).enabled(busy.is_none()).show(ui).clicked() {
                    click = Some(Click::Restart);
                }
                if unload(if busy == Some(Busy::Stop) { "Unloading…" } else { "Unload" }).enabled(busy.is_none()).show(ui).clicked() {
                    click = Some(Click::Unload);
                }
            } else if s.gguf_ready {
                if primary(if busy == Some(Busy::Start) { "Starting…" } else { "Start Qwen" }).enabled(busy.is_none()).show(ui).clicked() {
                    click = Some(Click::Start);
                }
                if secondary(if downloading { "Downloading…" } else { "Re-download" }).enabled(!matches!(busy, Some(Busy::Start | Busy::Restart | Busy::Stop))).show(ui).clicked() {
                    click = Some(Click::Download);
                }
                if downloading && cancel_btn().show(ui).clicked() {
                    click = Some(Click::Cancel);
                }
            } else {
                let label = if downloading { "Downloading…" } else if s.gguf_bytes > 0 { "Resume download" } else { "Download Qwen 3.8 27B" };
                if primary(label).enabled(!matches!(busy, Some(Busy::Start | Busy::Restart))).show(ui).clicked() {
                    click = Some(Click::Download);
                }
                if downloading && cancel_btn().show(ui).clicked() {
                    click = Some(Click::Cancel);
                }
            }
        });

        if s.gguf_ready {
            ui.add_space(12.0);
            widgets::rule(ui);
            ui.add_space(10.0);
            form::para(ui, "Engine backend", 12.0, 16.0, W::Medium, p.text);
            ui.add_space(2.0);
            form::para(ui, "Which llama.cpp build runs the 27B. Auto picks from the detected GPU. If the GPU sits idle (GPU 0% in Task Manager), the log below says why — switch the build, Download, then Restart.", 11.0, 16.0, W::Regular, p.muted);
            ui.add_space(8.0);
            // Two columns under the web's 640 px breakpoint, four above it.
            let columns = if ui.ctx().content_rect().width() < 640.0 { 2 } else { 4 };
            let build = s.spec.build.clone().unwrap_or_else(|| "auto".into());
            form::grid(ui, columns, 6.0, shared::ENGINE_BUILDS.len(), |ui, i, width| {
                let (id, label) = shared::ENGINE_BUILDS[i];
                if tile(ui, width, build == id, busy.is_none(), label).clicked() && build != id && busy.is_none() {
                    click = Some(Click::Backend(id));
                }
            });
            if !s.gpu.log_tail.is_empty() {
                ui.add_space(8.0);
                form::details(ui, "local-log", &format!("Engine log (last {} lines)", s.gpu.log_tail.len()), 11.0, p.muted, |ui| {
                    ui.add_space(4.0);
                    egui::Frame::new().fill(p.bg2).corner_radius(8).inner_margin(egui::Margin::same(8)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        egui::ScrollArea::both().max_height(160.0).auto_shrink([false, true]).show(ui, |ui| {
                            let text = egui::RichText::new(s.gpu.log_tail.join("\n")).font(theme::mono(11.0)).color(p.text2).line_height(Some(16.0));
                            ui.add(egui::Label::new(text).wrap_mode(egui::TextWrapMode::Extend).selectable(false));
                        });
                    });
                });
            }
        }

        if s.gguf_ready {
            ui.add_space(12.0);
            widgets::rule(ui);
            ui.add_space(10.0);
            form::para(ui, "Spec optimizations", 12.0, 16.0, W::Medium, p.text);
            ui.add_space(2.0);
            form::para(ui, "llama-server flags. Toggle these or add your own. Restart applies them.", 11.0, 16.0, W::Regular, p.muted);
            ui.add_space(8.0);
            for (i, preset) in shared::SPEC_PRESETS.iter().enumerate() {
                if i > 0 {
                    ui.add_space(6.0);
                }
                let on = s.spec.enabled.iter().any(|id| id == preset.id);
                if preset_row(ui, busy.is_none(), on, preset.label, preset.blurb).clicked() && busy.is_none() {
                    click = Some(Click::Preset(preset.id));
                }
            }
            if !s.spec.extra.is_empty() {
                ui.add_space(8.0);
                for (i, token) in s.spec.extra.iter().enumerate() {
                    if i > 0 {
                        ui.add_space(4.0);
                    }
                    ui.horizontal(|ui| {
                        ui.add(egui::Label::new(egui::RichText::new(token).font(theme::mono(11.0)).color(p.text2)).selectable(false));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if Btn::ghost("Remove").text(11.0, 16.0).weight(W::Regular).pad(0.0, 0.0).ink(p.muted, p.danger).show(ui).clicked() {
                                click = Some(Click::Remove(i));
                            }
                        });
                    });
                }
            }
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                // The field leaves room for the Add button at its right.
                let width = ui.available_width() - 46.0;
                let typed = ui.allocate_ui(vec2(width, 30.0), |ui| Input::new("--spec-draft-p-min 0.85").mono().text(11.0, 16.0).pad(8, 6).radius(8).fill(p.bg2).show(ui, "local-flag", &mut st.flag)).inner;
                let enter = typed.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                let add = Btn::outline("Add").text(11.0, 16.0).weight(W::Medium).pad(10.0, 6.0).fill(Color32::TRANSPARENT, Color32::TRANSPARENT).border(p.border, p.border).ink(p.text2, p.text2).enabled(busy.is_none() && !st.flag.trim().is_empty()).show(ui).clicked();
                if enter || add {
                    click = Some(Click::Add);
                }
            });
        }
        if shot_end {
            ui.scroll_to_cursor(Some(egui::Align::BOTTOM));
        }
    });

    match click {
        Some(Click::Use) => use_qwen(&mut app.settings),
        Some(Click::Start) => {
            use_qwen(&mut app.settings);
            act(st, &ctx, Busy::Start, Call::Start);
        }
        Some(Click::Restart) => {
            use_qwen(&mut app.settings);
            act(st, &ctx, Busy::Restart, Call::Restart);
        }
        Some(Click::Unload) => act(st, &ctx, Busy::Stop, Call::Stop),
        Some(Click::Download) => download(st, &ctx),
        Some(Click::Cancel) => cancel(st),
        Some(Click::Backend(build)) => opts(st, &ctx, &mut app.settings, SetOpts { enabled: Some(s.spec.enabled.clone()), extra: Some(s.spec.extra.clone()), build: Some(build.into()), ..Default::default() }),
        // Unlike the web, the chosen build travels with every flag change, so it is not reset to auto.
        Some(Click::Preset(id)) => {
            let mut enabled = s.spec.enabled.clone();
            match enabled.iter().position(|on| on == id) {
                Some(i) => {
                    enabled.remove(i);
                }
                None => enabled.push(id.into()),
            }
            opts(st, &ctx, &mut app.settings, SetOpts { enabled: Some(enabled), extra: Some(s.spec.extra.clone()), build: s.spec.build.clone(), ..Default::default() });
        }
        Some(Click::Remove(i)) => {
            let mut extra = s.spec.extra.clone();
            extra.remove(i);
            opts(st, &ctx, &mut app.settings, SetOpts { enabled: Some(s.spec.enabled.clone()), extra: Some(extra), build: s.spec.build.clone(), ..Default::default() });
        }
        Some(Click::Add) if !st.flag.trim().is_empty() => {
            let flag = std::mem::take(&mut st.flag);
            opts(st, &ctx, &mut app.settings, SetOpts { enabled: Some(s.spec.enabled.clone()), extra: Some(s.spec.extra.clone()), add_flag: Some(flag), build: s.spec.build.clone(), ..Default::default() });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn search_bills() {
        assert_eq!((super::money(0.0), super::money(0.0042), super::money(1.256)), ("$0.00".into(), "$0.0042".into(), "$1.26".into()));
    }

    /// A finished download points Settings at Qwen; a failed action shows its error and frees the card. No engine call (live off).
    #[test]
    fn card_answers_settle_the_job() {
        use crate::local::{engine::ActionResult, shared::EngineDownloadEvent};
        let (ctx, mut settings) = (eframe::egui::Context::default(), crate::store::Settings::default());
        let mut st = super::Local::default();
        let (tx, rx) = std::sync::mpsc::channel();
        st.job = Some(super::Job { kind: super::Busy::Download, rx, cancel: Default::default() });
        tx.send(super::Note::Pull(EngineDownloadEvent::Done)).unwrap();
        tx.send(super::Note::Acted(Ok(ActionResult { ok: false, error: Some("Port busy.".into()), status: super::blank_status() }))).unwrap();
        super::pump(&mut st, &mut settings, &ctx, false);
        assert_eq!(settings.model, "qwen-3.8-27b");
        assert_eq!(st.error.as_deref(), Some("Port busy."));
        assert!(st.job.is_none() && st.pull.is_none());
    }
}
