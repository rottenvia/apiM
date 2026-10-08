//! The window: sidebar, chat, workspace panel. Drawn directly with egui; there
//! is no web view anywhere.

mod chat;
mod dialogs;
pub mod theme;

use crate::agent::{self, Emitter, Event, Stopwatch};
use crate::models::CustomModel;
use crate::provider;
use crate::store::{self, ChatMeta, Conversation, Message, Part, Role, Settings};
use crate::tools::{ChatState, exec::Procs, files};
use eframe::egui::{self, RichText};
use egui_commonmark::CommonMarkCache;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const SIDEBAR_WIDTH: f32 = 264.0;
/// How often a reply in progress is written to disk, so a crash loses seconds, not the answer.
const CHECKPOINT: Duration = Duration::from_secs(5);

pub fn run(rt: tokio::runtime::Runtime) -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("apiM").with_inner_size([1180.0, 780.0]).with_min_inner_size([560.0, 420.0]).with_drag_and_drop(true),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native("apiM", options, Box::new(move |cc| Ok(Box::new(App::new(cc, rt)))))
}

#[derive(PartialEq)]
enum Dialog {
    None,
    Settings,
    Plugins,
    Rename(String, String),
    Delete(String, String),
    /// A workspace file opened for reading: (path, contents).
    Preview(String, String),
}

struct PendingApproval {
    command: String,
    reason: String,
    reply: oneshot::Sender<bool>,
}

struct PendingQuestion {
    question: String,
    options: Vec<String>,
    context: String,
    answer: String,
    reply: oneshot::Sender<String>,
}

/// A reply being generated.
struct Run {
    rx: mpsc::Receiver<Event>,
    handle: tokio::task::JoinHandle<()>,
    conv_id: String,
    status: &'static str,
    /// A tool call still streaming its arguments: (name, characters so far).
    drafting: Option<(String, usize)>,
    approval: Option<PendingApproval>,
    question: Option<PendingQuestion>,
    thinking: Stopwatch,
    started: Instant,
    saved: Instant,
}

pub struct App {
    rt: tokio::runtime::Runtime,
    settings: Settings,
    chats: Vec<ChatMeta>,
    /// The chat on screen.
    conv: Conversation,
    /// The chat a reply is still being written to, when the user has switched away from it.
    parked: Option<Conversation>,
    run: Option<Run>,
    procs: Arc<Procs>,
    draft: String,
    attachments: Vec<PathBuf>,
    md: CommonMarkCache,
    /// Measured height of each message at a given width, so off-screen ones are skipped.
    heights: HashMap<String, (f32, f32)>,
    dialog: Dialog,
    filter: String,
    /// Files of the workspace on screen, refreshed when a tool changes something.
    files: Vec<(String, u64)>,
    files_stale: bool,
    toast: Option<(String, Instant)>,
    focus_composer: bool,
    // Settings dialog state.
    settings_tab: usize,
    new_model: CustomModel,
    verify: Option<mpsc::Receiver<Result<CustomModel, String>>>,
    verify_note: String,
    new_plugin: crate::plugins::Plugin,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, rt: tokio::runtime::Runtime) -> App {
        theme::apply(&cc.egui_ctx);
        egui_extras::install_image_loaders(&cc.egui_ctx);
        let settings = Settings::load();
        cc.egui_ctx.set_zoom_factor(settings.zoom.clamp(0.6, 2.0));
        App {
            rt,
            chats: Conversation::list(),
            conv: Conversation::new(),
            parked: None,
            run: None,
            procs: Arc::new(Procs::default()),
            draft: String::new(),
            attachments: Vec::new(),
            md: CommonMarkCache::default(),
            heights: HashMap::new(),
            dialog: Dialog::None,
            filter: String::new(),
            files: Vec::new(),
            files_stale: true,
            toast: None,
            focus_composer: true,
            settings_tab: 0,
            new_model: blank_model(),
            verify: None,
            verify_note: String::new(),
            new_plugin: blank_plugin(),
            settings,
        }
    }

    fn toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    fn running_here(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.conv_id == self.conv.id)
    }

    // ------------------------------------------------------------ chats

    /// Leaves the chat on screen, keeping it alive if a reply is still being written to it.
    fn leave_current(&mut self) {
        if self.running_here() {
            self.parked = Some(std::mem::take(&mut self.conv));
        }
        self.heights.clear();
        self.files_stale = true;
        self.focus_composer = true;
    }

    fn new_chat(&mut self) {
        if self.conv.messages.is_empty() && !self.running_here() {
            return;
        }
        self.leave_current();
        self.conv = Conversation::new();
    }

    fn open_chat(&mut self, id: &str) {
        if id == self.conv.id {
            return;
        }
        self.leave_current();
        self.conv = match self.parked.take_if(|p| p.id == id) {
            Some(parked) => parked,
            None => Conversation::load(id).unwrap_or_else(Conversation::new),
        };
    }

    fn delete_chat(&mut self, id: &str) {
        if self.run.as_ref().is_some_and(|r| r.conv_id == id) {
            self.stop();
        }
        Conversation::delete(id);
        self.chats.retain(|c| c.id != id);
        if self.conv.id == id {
            self.conv = Conversation::new();
            self.heights.clear();
            self.files_stale = true;
        }
    }

    fn refresh_chats(&mut self) {
        self.chats = Conversation::list();
    }

    // ------------------------------------------------------------ sending

    fn send(&mut self, ctx: &egui::Context) {
        let mut text = self.draft.trim().to_string();
        if (text.is_empty() && self.attachments.is_empty()) || self.run.is_some() {
            if self.run.is_some() && !self.running_here() {
                self.toast("Another chat is still being answered. Stop it or wait for it to finish.");
            }
            return;
        }
        if let Err(problem) = provider::resolve_target(&self.settings.model, &self.settings) {
            self.toast(problem);
            self.dialog = Dialog::Settings;
            self.settings_tab = 0;
            return;
        }
        let history: Vec<(Role, String)> = self.conv.messages.iter().map(|m| (m.role, m.history_text())).collect();
        if self.conv.messages.is_empty() {
            self.conv.title = store::derive_title(if text.is_empty() { "Attached files" } else { &text });
        }

        // Pictures go to the model; any other file is copied into the workspace for the tools to read.
        let workspace = self.conv.workspace();
        let mut images = Vec::new();
        for path in std::mem::take(&mut self.attachments) {
            if is_image(&path) {
                images.push(path);
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
            let dest = workspace.join("uploads").join(&name);
            let copied = std::fs::create_dir_all(workspace.join("uploads")).and_then(|_| std::fs::copy(&path, &dest));
            text.push_str(&match copied {
                Ok(_) => format!("\n\n[Attached file saved in the workspace: uploads/{name}]"),
                Err(e) => format!("\n\n[Could not attach {name}: {e}]"),
            });
        }

        let mut user = Message::new(Role::User, &text);
        user.attachments = images.clone();
        self.conv.messages.push(user);
        let mut reply = Message::new(Role::Assistant, "");
        reply.model = self.settings.model.clone();
        self.conv.messages.push(reply);
        self.conv.updated_at = store::now_ms();
        self.conv.save();
        self.refresh_chats();

        let (tx, rx) = mpsc::channel();
        let wake = ctx.clone();
        let request = agent::Request {
            settings: self.settings.clone(),
            history,
            text,
            images,
            workspace,
            state_dir: self.conv.state_dir(),
            chat: ChatState { plan: self.conv.plan.clone(), findings: self.conv.findings.clone(), finish_bounced: false },
            conv_id: self.conv.id.clone(),
        };
        let handle = self.rt.spawn(agent::run(request, Emitter::new(tx, move || wake.request_repaint()), self.procs.clone()));
        self.run = Some(Run {
            rx,
            handle,
            conv_id: self.conv.id.clone(),
            status: "Thinking",
            drafting: None,
            approval: None,
            question: None,
            thinking: Stopwatch::new(),
            started: Instant::now(),
            saved: Instant::now(),
        });
        self.draft.clear();
        self.focus_composer = true;
    }

    /// Drops the last reply and asks the same question again.
    fn retry(&mut self, ctx: &egui::Context) {
        if self.run.is_some() || self.conv.messages.last().is_none_or(|m| m.role != Role::Assistant) {
            return;
        }
        self.conv.messages.pop();
        if let Some(question) = self.conv.messages.pop() {
            self.draft = question.text();
            self.attachments = question.attachments;
            self.heights.clear();
            self.send(ctx);
        }
    }

    fn stop(&mut self) {
        let Some(run) = self.run.take() else { return };
        run.handle.abort();
        let conv = match self.parked.as_mut() {
            Some(parked) => parked,
            None => &mut self.conv,
        };
        if let Some(msg) = conv.messages.last_mut() {
            finish_message(msg, run.started);
            for part in &mut msg.parts {
                if let Part::Tool(t) = part {
                    if t.ok.is_none() {
                        t.ok = Some(false);
                        t.summary = "Stopped".into();
                    }
                }
            }
            msg.incomplete = true;
            msg.parts.push(Part::Notice("Stopped.".into()));
        }
        conv.updated_at = store::now_ms();
        conv.save();
        self.parked = None;
        self.files_stale = true;
        self.refresh_chats();
    }

    /// Applies everything the agent reported since the last frame.
    fn pump(&mut self, ctx: &egui::Context) {
        let Some(run) = self.run.as_mut() else { return };
        let events: Vec<Event> = run.rx.try_iter().collect();
        let conv = match self.parked.as_mut() {
            Some(parked) => parked,
            None => &mut self.conv,
        };
        let mut finished = false;
        for event in events {
            let Some(msg) = conv.messages.last_mut() else { break };
            match event {
                Event::Status(status) => run.status = status,
                Event::Reasoning(text) => {
                    run.thinking.start();
                    match msg.parts.last_mut() {
                        Some(Part::Thinking { text: so_far, ms: 0 }) => so_far.push_str(&text),
                        _ => msg.parts.push(Part::Thinking { text, ms: 0 }),
                    }
                }
                Event::Content(text) => {
                    close_thinking(msg, &mut run.thinking);
                    match msg.parts.last_mut() {
                        Some(Part::Text(so_far)) => so_far.push_str(&text),
                        _ => msg.parts.push(Part::Text(text)),
                    }
                }
                Event::ToolDraft { name, chars } => run.drafting = Some((name, chars)),
                Event::ToolStart(tool) => {
                    close_thinking(msg, &mut run.thinking);
                    run.drafting = None;
                    msg.parts.push(Part::Tool(tool));
                }
                Event::ToolDone { id, ok, summary, image } => {
                    if let Some(tool) = msg.parts.iter_mut().rev().find_map(|p| match p {
                        Part::Tool(t) if t.id == id => Some(t),
                        _ => None,
                    }) {
                        tool.ok = Some(ok);
                        tool.summary = summary;
                        tool.image = image;
                    }
                    self.files_stale = true;
                }
                Event::Approval { command, reason, reply } => {
                    run.approval = Some(PendingApproval { command, reason, reply });
                    ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
                }
                Event::Question { question, options, context, reply } => {
                    run.question = Some(PendingQuestion { question, options, context, answer: String::new(), reply });
                    ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
                }
                Event::Usage(usage) => {
                    msg.usage = usage;
                    msg.cost = usage.cost(&msg.model, &self.settings.custom_models);
                }
                Event::State(state) => {
                    conv.plan = state.plan;
                    conv.findings = state.findings;
                }
                Event::Notice(note) => {
                    close_thinking(msg, &mut run.thinking);
                    msg.parts.push(Part::Notice(note));
                }
                Event::Done { finish, incomplete, stop_reason } => {
                    finish_message(msg, run.started);
                    msg.finish = finish;
                    msg.incomplete = incomplete;
                    msg.parts.extend(stop_reason.map(Part::Notice));
                    finished = true;
                }
                Event::Error(error) => {
                    finish_message(msg, run.started);
                    msg.error = Some(error);
                    msg.incomplete = true;
                    finished = true;
                }
            }
        }
        if finished || run.saved.elapsed() > CHECKPOINT {
            run.saved = Instant::now();
            conv.updated_at = store::now_ms();
            conv.save();
        }
        if finished {
            self.run = None;
            self.parked = None;
            self.files_stale = true;
            self.refresh_chats();
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
        }
    }

    // ------------------------------------------------------------ panels

    fn sidebar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("apiM").font(egui::FontId::new(19.0, theme::serif())));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("+ New chat").on_hover_text("Start a new chat (Ctrl+N)").clicked() {
                    self.new_chat();
                }
            });
        });
        ui.add_space(4.0);
        ui.add(egui::TextEdit::singleline(&mut self.filter).hint_text("Search chats").desired_width(f32::INFINITY));
        ui.add_space(4.0);

        let mut open = None;
        let mut dialog = None;
        let needle = self.filter.to_lowercase();
        let now = chrono::Local::now().date_naive();
        egui::ScrollArea::vertical().auto_shrink(false).max_height(ui.available_height() - 44.0).show(ui, |ui| {
            let mut last_group = "";
            for chat in self.chats.iter().filter(|c| needle.is_empty() || c.title.to_lowercase().contains(&needle)) {
                let group = date_group(chat.updated_at, now);
                if group != last_group {
                    ui.add_space(6.0);
                    ui.label(theme::muted(group));
                    last_group = group;
                }
                let busy = self.run.as_ref().is_some_and(|r| r.conv_id == chat.id);
                let title = if busy { format!("● {}", chat.title) } else { chat.title.clone() };
                let row = ui.add_sized([ui.available_width(), 30.0], egui::Button::selectable(chat.id == self.conv.id, title).truncate().frame_when_inactive(false));
                if row.clicked() {
                    open = Some(chat.id.clone());
                }
                egui::Popup::context_menu(&row).show(|ui| {
                    if ui.button("Rename").clicked() {
                        dialog = Some(Dialog::Rename(chat.id.clone(), chat.title.clone()));
                    }
                    if ui.button(RichText::new("Delete").color(theme::DANGER)).clicked() {
                        dialog = Some(Dialog::Delete(chat.id.clone(), chat.title.clone()));
                    }
                });
            }
            if self.chats.is_empty() {
                ui.add_space(12.0);
                ui.label(theme::muted("Your chats will appear here."));
            }
        });
        if let Some(id) = open {
            self.open_chat(&id);
        }
        if let Some(d) = dialog {
            self.dialog = d;
        }

        ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
            ui.horizontal(|ui| {
                if ui.button("⚙ Settings").clicked() {
                    self.dialog = Dialog::Settings;
                }
                if ui.button("🔌 Plugins").clicked() {
                    self.dialog = Dialog::Plugins;
                }
            });
        });
    }

    fn top_bar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_centered(|ui| {
            if ui.add(egui::Button::new("☰").frame_when_inactive(false)).on_hover_text("Show or hide the chat list").clicked() {
                self.settings.sidebar_open = !self.settings.sidebar_open;
                self.settings.save();
            }
            ui.label(theme::secondary(self.conv.title.as_str()));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add(egui::Button::selectable(self.settings.workspace_open, "📁 Workspace").frame_when_inactive(false)).on_hover_text("Files the agent works on in this chat").clicked() {
                    self.settings.workspace_open = !self.settings.workspace_open;
                    self.files_stale = true;
                    self.settings.save();
                }
                let running = self.procs.running();
                if running > 0 && ui.button(RichText::new(format!("■ {running} running")).color(theme::WARNING)).on_hover_text("Background processes the agent started. Click to stop them all.").clicked() {
                    self.procs.stop_all();
                }
            });
        });
    }

    fn workspace_panel(&mut self, ui: &mut egui::Ui) {
        let root = self.conv.workspace();
        if std::mem::take(&mut self.files_stale) {
            self.files = if root.exists() { files::walk(&root, &root) } else { Vec::new() };
        }
        ui.horizontal(|ui| {
            ui.label(RichText::new("Workspace").strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.small_button("⟳").on_hover_text("Refresh the list").clicked() {
                    self.files_stale = true;
                }
            });
        });
        let shown = root.display().to_string();
        ui.add(egui::Label::new(theme::muted(shown.as_str())).truncate()).on_hover_text(shown.as_str());
        ui.horizontal_wrapped(|ui| {
            if ui.small_button("Open folder").clicked() {
                let _ = std::fs::create_dir_all(&root);
                open_in_file_manager(&root);
            }
            if ui.small_button("Choose folder…").on_hover_text("Point this chat at a project on this PC. The agent reads and edits files inside it.").clicked() && !self.running_here() {
                if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                    self.conv.folder = Some(folder);
                    self.conv.save();
                    self.files_stale = true;
                }
            }
            if self.conv.folder.is_some() && ui.small_button("Use chat folder").on_hover_text("Go back to this chat's own folder").clicked() && !self.running_here() {
                self.conv.folder = None;
                self.conv.save();
                self.files_stale = true;
            }
        });
        ui.separator();

        egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            if let Some(plan) = &self.conv.plan {
                ui.label(RichText::new("Plan").strong());
                ui.label(theme::secondary(plan.goal.as_str()));
                for step in &plan.steps {
                    let (mark, colour) = match step.state.as_str() {
                        "done" => ("✔", theme::SUCCESS),
                        "doing" => ("▶", theme::ACCENT_LIGHT),
                        "blocked" => ("!", theme::DANGER),
                        _ => ("○", theme::TEXT_MUTED),
                    };
                    ui.horizontal_top(|ui| {
                        ui.label(RichText::new(mark).color(colour));
                        ui.add(egui::Label::new(RichText::new(step.text.as_str()).size(12.5)).wrap()).on_hover_text(step.note.as_str());
                    });
                }
                ui.separator();
            }
            let active: Vec<_> = self.conv.findings.iter().filter(|f| f.active).collect();
            if !active.is_empty() {
                egui::CollapsingHeader::new(format!("Findings ({})", active.len())).show(ui, |ui| {
                    for f in active {
                        ui.add(egui::Label::new(RichText::new(format!("• {}", f.claim)).size(12.5)).wrap()).on_hover_text(f.evidence.as_str());
                    }
                });
                ui.separator();
            }

            ui.label(theme::muted(format!("{} files", self.files.len())));
            if self.files.is_empty() {
                ui.label(theme::muted("No files yet. Ask for one and it appears here."));
            }
            let mut preview = None;
            // ponytail: a flat list, capped. Make it a collapsible tree if big projects are common.
            for (path, size) in self.files.iter().take(500) {
                let label = format!("{path}  ·  {}", human_size(*size));
                if ui.add(egui::Button::new(RichText::new(label).size(12.5)).frame(false).truncate()).on_hover_text("Click to read").clicked() {
                    preview = Some(path.clone());
                }
            }
            if self.files.len() > 500 {
                ui.label(theme::muted(format!("… and {} more", self.files.len() - 500)));
            }
            if let Some(path) = preview {
                let text = match files::read_text(&root.join(&path)) {
                    Ok(t) => t.chars().take(200_000).collect(),
                    Err(e) => e,
                };
                self.dialog = Dialog::Preview(path, text);
            }
        });
    }

    /// Files dropped on the window become attachments.
    fn take_drops(&mut self, ctx: &egui::Context) {
        let dropped: Vec<PathBuf> = ctx.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect());
        self.attachments.extend(dropped.into_iter().filter(|p| p.is_file()));
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.pump(&ctx);
        self.take_drops(&ctx);
        if ctx.input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, egui::Key::N)) {
            self.new_chat();
        }
        if self.run.is_some() {
            // Keeps the spinner and the elapsed time moving between tokens.
            ctx.request_repaint_after(Duration::from_millis(120));
        }

        if self.settings.sidebar_open {
            let frame = egui::Frame::new().fill(theme::BG_SIDEBAR).inner_margin(egui::Margin::same(10));
            egui::Panel::left("sidebar").exact_size(SIDEBAR_WIDTH).resizable(false).frame(frame).show(ui, |ui| self.sidebar(ui));
        }
        if self.settings.workspace_open {
            let frame = egui::Frame::new().fill(theme::BG_SIDEBAR).inner_margin(egui::Margin::same(10));
            egui::Panel::right("workspace").default_size(300.0).size_range(220.0..=520.0).frame(frame).show(ui, |ui| self.workspace_panel(ui));
        }
        egui::CentralPanel::default().frame(egui::Frame::new().fill(theme::BG)).show(ui, |ui| {
            let bar = egui::Frame::new().inner_margin(egui::Margin::symmetric(10, 4));
            egui::Panel::top("bar").exact_size(40.0).show_separator_line(false).frame(bar).show(ui, |ui| self.top_bar(ui));
            let composer = egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 12));
            egui::Panel::bottom("composer").show_separator_line(false).resizable(false).frame(composer).show(ui, |ui| chat::composer(self, ui));
            egui::CentralPanel::default().frame(egui::Frame::new()).show(ui, |ui| chat::messages(self, ui));
        });

        dialogs::show(self, &ctx);
        self.show_toast(&ctx);
    }
}

impl App {
    fn show_toast(&mut self, ctx: &egui::Context) {
        let Some((text, since)) = &self.toast else { return };
        if since.elapsed() > Duration::from_secs(6) {
            self.toast = None;
            return;
        }
        egui::Area::new(egui::Id::new("toast")).anchor(egui::Align2::CENTER_TOP, [0.0, 52.0]).order(egui::Order::Tooltip).show(ctx, |ui| {
            theme::card(theme::BG_ELEVATED).stroke(egui::Stroke::new(1.0, theme::WARNING)).show(ui, |ui| {
                ui.set_max_width(520.0);
                ui.label(text.as_str());
            });
        });
        ctx.request_repaint_after(Duration::from_millis(500));
    }
}

fn close_thinking(msg: &mut Message, watch: &mut Stopwatch) {
    if let Some(Part::Thinking { ms: ms @ 0, .. }) = msg.parts.last_mut() {
        *ms = watch.stop().max(1);
    }
}

fn finish_message(msg: &mut Message, started: Instant) {
    for part in &mut msg.parts {
        if let Part::Thinking { ms: ms @ 0, .. } = part {
            *ms = 1;
        }
    }
    msg.duration_ms = started.elapsed().as_millis() as u64;
}

fn date_group(updated_ms: u64, today: chrono::NaiveDate) -> &'static str {
    let day = chrono::DateTime::from_timestamp_millis(updated_ms as i64).map(|d| d.with_timezone(&chrono::Local).date_naive()).unwrap_or(today);
    match (today - day).num_days() {
        ..=0 => "Today",
        1 => "Yesterday",
        2..=7 => "Previous 7 days",
        _ => "Older",
    }
}

fn human_size(size: u64) -> String {
    match size {
        s if s >= 1 << 20 => format!("{:.1} MB", s as f64 / (1u64 << 20) as f64),
        s if s >= 1024 => format!("{:.0} KB", s as f64 / 1024.0),
        s => format!("{s} B"),
    }
}

fn is_image(path: &std::path::Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
}

fn open_in_file_manager(path: &std::path::Path) {
    let program = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(program).arg(path).spawn();
}

fn blank_model() -> CustomModel {
    CustomModel { api_model: String::new(), label: String::new(), vision: crate::models::Vision::None, max_output_tokens: 65_536, context_length: None, input_price: None, output_price: None }
}

fn blank_plugin() -> crate::plugins::Plugin {
    crate::plugins::Plugin { id: String::new(), name: String::new(), icon: "🔌".into(), description: String::new(), category: "custom".into(), prompt: String::new() }
}
