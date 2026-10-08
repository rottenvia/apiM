//! The panels Settings embeds: SearchBudget, DiagnosticsPanel, McpServersSettings
//! and LocalModelRuntime (src/components, same names).

use super::form::{self, Btn, Input, Seg, Switch};
use super::theme::{self, W, alpha, p};
use super::{App, widgets};
use crate::mcp::{self, McpServerInput, McpServerPublic};
use crate::store;
use eframe::egui::{self, Color32, Sense, Stroke, StrokeKind, Ui, vec2};
use std::sync::mpsc;

#[derive(Default)]
pub struct State {
    servers: Option<Vec<McpServerPublic>>,
    form: Option<ServerForm>,
    /// Whether the token box shows its text. Kept between openings of the form, as on the web.
    show_token: bool,
    usage: Option<(crate::search_usage::Summary, (usize, u64))>,
    report: Option<crate::diagnostics::Report>,
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

/// LocalModelRuntime: the card that downloads and runs Qwen inside the app.
// ponytail: the in-app llama.cpp sidecar (src/lib/local-engine.ts) is not ported, so the card only says
// so and points at the custom-server fields. Port the engine to get Download / Start / Unload here.
pub fn local_runtime(_app: &mut App, ui: &mut Ui) {
    let p = p();
    form::boxed(ui, p.bg3, p.border, 12, (12, 12), |ui| {
        ui.horizontal_top(|ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                let (dot, _) = ui.allocate_exact_size(vec2(8.0, 12.0), Sense::hover());
                ui.painter().circle_filled(dot.center() + vec2(0.0, 2.0), 4.0, p.muted);
                ui.add_space(12.0);
                ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                    form::para(ui, "On this PC", 13.0, 20.0, W::Medium, p.text);
                    ui.add_space(2.0);
                    form::para(ui, "Download the 27B into this app. A sidecar on your machine runs it — the chat window never loads the weights.", 11.0, 16.0, W::Regular, p.muted);
                });
            });
        });
        ui.add_space(8.0);
        form::para(ui, "The built-in engine is not part of the desktop app yet. Run Qwen with Ollama, vLLM or llama.cpp and point at it under “Advanced — custom local server”.", 12.0, 16.0, W::Regular, p.text2);
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn search_bills() {
        assert_eq!((super::money(0.0), super::money(0.0042), super::money(1.256)), ("$0.00".into(), "$0.0042".into(), "$1.26".into()));
    }
}
