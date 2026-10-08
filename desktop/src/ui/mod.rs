//! The window: sidebar, chat, workspace panel. Drawn directly with egui; there
//! is no web view anywhere. The layout follows the web app's src/app/page.tsx.

mod attachments;
mod bubble;
mod chat;
mod composer;
mod dialogs;
mod emoji;
mod form;
mod icons;
mod markdown;
mod overlay;
mod plan_panel;
mod plugin_modal;
mod prompts;
mod rewind;
mod settings;
mod settings_panels;
mod sidebar;
pub mod theme;
mod widgets;
mod workspace;

use crate::agent::{self, Emitter, Event, Stopwatch};
use crate::store::{self, Attachment, Bucket, ChatMeta, Conversation, HistorySummary, Message, Part, Role, Settings};
use crate::tools::{ChatState, exec::Procs};
use crate::{export, provider, summary};
use composer::Popover;
use eframe::egui::{self, Rect, vec2};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How often a reply in progress is written to disk, so a crash loses seconds, not the answer.
const CHECKPOINT: Duration = Duration::from_secs(5);

pub fn run(rt: tokio::runtime::Runtime) -> eframe::Result {
    let shot = Shot::from_env();
    let mut viewport = egui::ViewportBuilder::default().with_title("apiM").with_inner_size([1280.0, 800.0]).with_min_inner_size([420.0, 420.0]).with_drag_and_drop(true);
    if let Some(shot) = &shot {
        // A picture of itself, for checking the look: off screen, never focused, gone in a moment.
        viewport = viewport.with_inner_size(shot.size).with_position([-8000.0, -8000.0]).with_active(false).with_taskbar(false).with_decorations(false);
    }
    let options = eframe::NativeOptions { viewport, renderer: eframe::Renderer::Glow, ..Default::default() };
    eframe::run_native("apiM", options, Box::new(move |cc| Ok(Box::new(App::new(cc, rt, shot)))))
}

#[derive(PartialEq)]
pub enum Dialog {
    None,
    Settings,
    Plugins,
    Mcp,
    Delete {
        ids: Vec<String>,
        opened: Instant,
    },
    /// A workspace file opened for reading: (path, contents).
    Preview(String, String),
    /// Search across every chat (Ctrl+K).
    Search,
}

struct PendingApproval {
    command: String,
    reason: String,
    /// What "Always allow this" remembers.
    key: String,
    /// A call to an MCP server rather than a command.
    mcp: bool,
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
    /// "btw" notes typed while it works, picked up before its next round.
    notes: Arc<Mutex<Vec<String>>>,
    thinking: Stopwatch,
    started: Instant,
    saved: Instant,
}

/// A summary being written in the background: the automatic one, or `/compact`.
struct SummaryJob {
    conv_id: String,
    manual: bool,
    rx: mpsc::Receiver<Result<HistorySummary, String>>,
}

/// `APIM_SHOT=out.png`: draw one state, save a picture of it, quit. Nothing is clicked or typed.
struct Shot {
    path: PathBuf,
    size: [f32; 2],
    /// What to show: settings, plugins, model, effort, web, context, workspace…
    state: String,
    started: Instant,
    asked: bool,
}

impl Shot {
    fn from_env() -> Option<Shot> {
        let path = PathBuf::from(std::env::var_os("APIM_SHOT")?);
        let size = std::env::var("APIM_SHOT_SIZE").ok().and_then(|s| s.split_once('x').and_then(|(w, h)| Some([w.parse().ok()?, h.parse().ok()?]))).unwrap_or([1280.0, 800.0]);
        Some(Shot { path, size, state: std::env::var("APIM_SHOT_STATE").unwrap_or_default(), started: Instant::now(), asked: false })
    }
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
    summary_job: Option<SummaryJob>,
    procs: Arc<Procs>,
    draft: String,
    attachments: Vec<attachments::Pending>,
    /// The question being edited in place: (message id, draft).
    editing: Option<(String, String)>,
    /// A long code block opened in the side viewer.
    artifact: Option<overlay::Artifact>,
    /// A picture opened large: (name, where egui loads it from).
    lightbox: Option<(String, String)>,
    /// Why the last thing dropped or picked was not attached.
    attach_error: Option<String>,
    /// Commands the user said never to ask about again, per chat.
    always_allow: HashMap<String, std::collections::HashSet<String>>,
    /// Measured height of each message at a given width, so off-screen ones are skipped.
    heights: HashMap<String, (f32, f32)>,
    dialog: Dialog,
    side: sidebar::State,
    popover: Popover,
    fullscreen: bool,
    /// Where the composer sat last frame: its popovers hang above it.
    composer_rect: Rect,
    /// A line above the message box: why something was not sent.
    composer_note: Option<String>,
    compact_focus: String,
    compact_note: Option<(bool, String)>,
    show_summary: bool,
    find_open: bool,
    find: String,
    jump_to_latest: bool,
    /// Files of the workspace on screen, refreshed when a tool changes something.
    files: Vec<(String, u64)>,
    files_stale: bool,
    toast: Option<(String, Instant)>,
    focus_composer: bool,
    /// The theme the window is drawn in right now, to notice a change in Settings.
    applied_theme: (String, [String; 4]),
    shot: Option<Shot>,
    /// The rewind popover that is open, if one is.
    rewind: Option<rewind::Preview>,
    /// The files as they were before the last rewind, to undo it.
    rewind_undo: Option<String>,
    // What the dialogs remember while they are open.
    settings_ui: settings::State,
    plugin_ui: plugin_modal::State,
    console: dialogs::Console,
    search: dialogs::Search,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, rt: tokio::runtime::Runtime, shot: Option<Shot>) -> App {
        let settings = Settings::load();
        theme::install_fonts(&cc.egui_ctx);
        theme::apply(&cc.egui_ctx, theme::Palette::for_theme(&settings.theme, &settings.custom_theme));
        egui_extras::install_image_loaders(&cc.egui_ctx);
        cc.egui_ctx.set_zoom_factor(settings.zoom.clamp(0.6, 2.0));
        let mut app = App {
            rt,
            chats: Conversation::list(),
            conv: Conversation::new(),
            parked: None,
            run: None,
            summary_job: None,
            procs: Arc::new(Procs::default()),
            draft: String::new(),
            attachments: Vec::new(),
            editing: None,
            artifact: None,
            lightbox: None,
            attach_error: None,
            always_allow: HashMap::new(),
            heights: HashMap::new(),
            dialog: Dialog::None,
            side: sidebar::State::default(),
            popover: Popover::None,
            fullscreen: false,
            composer_rect: Rect::NOTHING,
            composer_note: None,
            compact_focus: String::new(),
            compact_note: None,
            show_summary: false,
            find_open: false,
            find: String::new(),
            jump_to_latest: false,
            files: Vec::new(),
            files_stale: true,
            toast: None,
            focus_composer: true,
            applied_theme: (settings.theme.clone(), settings.custom_theme.clone()),
            shot,
            rewind: None,
            rewind_undo: None,
            settings_ui: Default::default(),
            plugin_ui: Default::default(),
            console: Default::default(),
            search: Default::default(),
            settings,
        };
        app.stage_shot();
        app
    }

    /// Puts the window in the state a self-portrait was asked for.
    fn stage_shot(&mut self) {
        let Some(shot) = self.shot.as_ref().map(|s| Shot { path: s.path.clone(), size: s.size, state: s.state.clone(), started: s.started, asked: s.asked }) else { return };
        let state = shot.state.clone();
        self.focus_composer = false;
        if let Ok(wanted) = std::env::var("APIM_SHOT_CHAT") {
            let found = self.chats.iter().find(|c| c.id == wanted || c.title.to_lowercase().contains(&wanted.to_lowercase())).map(|c| c.id.clone());
            if let Some(id) = found {
                self.open_chat(&id);
            }
        }
        for part in state.split(',') {
            match part {
                "settings" => self.dialog = Dialog::Settings,
                "plugins" => self.dialog = Dialog::Plugins,
                "mcp" => self.dialog = Dialog::Mcp,
                "delete" => self.dialog = Dialog::Delete { ids: self.chats.iter().take(1).map(|c| c.id.clone()).collect(), opened: Instant::now() },
                "model" => self.popover = Popover::Model,
                "effort" => self.popover = Popover::Effort,
                "web" => self.popover = Popover::Web,
                "context" => self.popover = Popover::Context,
                "workspace" => self.settings.workspace_open = true,
                "no-workspace" => self.settings.workspace_open = false,
                "no-sidebar" => self.settings.sidebar_open = false,
                "sidebar" => self.settings.sidebar_open = true,
                "archive" => self.side.show_archived = true,
                "attach" => {
                    // The app's own sources, and the picture it took last time if there is one.
                    let here = std::env::current_dir().unwrap_or_default();
                    for item in [here.join("Cargo.toml"), here.join("src"), shot.path.with_file_name("b1.png")] {
                        attachments::add(self, item);
                    }
                }
                "artifact" => self.artifact = Some(overlay::Artifact { title: "main.rs".into(), language: "rust".into(), code: include_str!("../main.rs").into(), copied: None }),
                "lightbox" => self.lightbox = Some(("b1.png".into(), file_uri(&shot.path.with_file_name("b1.png")))),
                "toast" => self.toast("That chat couldn't be deleted. Please try again."),
                "draft" => self.draft = "Explain how the context meter decides when to compact, and show me where that lives in the code.".into(),
                "search" => {
                    self.dialog = Dialog::Search;
                    self.search = dialogs::Search::asking(&std::env::var("APIM_SHOT_QUERY").unwrap_or_default());
                }
                "plugin-editor" => self.plugin_ui = plugin_modal::State::writing(),
                "auto-run" => self.settings.approval = store::Approval::Auto,
                "rewind" => {
                    if let Some(id) = self.conv.messages.iter().rev().find(|m| m.role == Role::User && !m.note).map(|m| m.id.clone()) {
                        self.rewind_open(&id);
                    }
                }
                which @ ("plan" | "plan-blocked") => {
                    let step = |id, text: &str, state: &str, note: &str| store::PlanStep { id, text: text.into(), state: state.into(), note: note.into() };
                    let last = if which == "plan" { step(4, "Write the README section", "todo", "") } else { step(4, "Publish the release", "blocked", "no signing key on this machine") };
                    self.conv.plan = Some(store::Plan { goal: "Ship the importer with tests".into(), steps: vec![step(1, "Read the current parser", "done", "read src/parser.rs in full"), step(2, "Add the CSV path", "done", ""), step(3, "Cover it with tests", "doing", ""), last] });
                }
                tab if tab.starts_with("tab") => self.settings_ui.tab = tab[3..].parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    fn toast(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    fn running_here(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.conv_id == self.conv.id)
    }

    fn toggle_popover(&mut self, which: Popover) {
        self.popover = if self.popover == which { Popover::None } else { which };
    }

    /// Runs `change` on a chat wherever it lives right now (on screen, parked, or only on disk) and saves it.
    fn with_chat(&mut self, id: &str, change: impl FnOnce(&mut Conversation)) {
        if self.conv.id == id {
            change(&mut self.conv);
            self.conv.save();
        } else if let Some(parked) = self.parked.as_mut().filter(|p| p.id == id) {
            change(parked);
            parked.save();
        } else if let Some(mut conv) = Conversation::load(id) {
            change(&mut conv);
            conv.save();
        }
        self.refresh_chats();
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
        self.popover = Popover::None;
        self.compact_note = None;
        self.show_summary = false;
        self.jump_to_latest = true;
    }

    fn new_chat(&mut self) {
        if self.conv.messages.is_empty() && !self.running_here() {
            self.focus_composer = true;
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
        self.editing = None;
        self.jump_to_latest = true;
    }

    fn delete_chats(&mut self, ids: &[String]) {
        for id in ids {
            if self.run.as_ref().is_some_and(|r| &r.conv_id == id) {
                self.stop();
            }
            Conversation::delete(id);
            if &self.conv.id == id {
                self.conv = Conversation::new();
                self.heights.clear();
                self.files_stale = true;
            }
        }
        self.refresh_chats();
        self.side.finish_selecting();
    }

    fn rename_chat(&mut self, id: &str, title: &str) {
        let title = title.trim().to_string();
        if !title.is_empty() {
            self.with_chat(id, |c| c.title = title);
        }
    }

    fn archive_chat(&mut self, id: &str, archived: bool) {
        self.with_chat(id, |c| c.archived = archived);
    }

    /// "Download": the chat as a file, wherever the user wants it.
    fn export_chat(&mut self, id: &str, format: &str) {
        let conv = if self.conv.id == id { Some(self.conv.clone()) } else { Conversation::load(id) };
        let Some(conv) = conv else { return };
        let Some(path) = rfd::FileDialog::new().set_file_name(export::filename(&conv.title, format)).save_file() else { return };
        match std::fs::write(&path, export::render(&conv, format)) {
            Ok(()) => self.side.note = Some((format!("Saved {}", path.file_name().unwrap_or_default().to_string_lossy()), Instant::now())),
            Err(e) => self.toast(format!("Could not save the file: {e}")),
        }
    }

    fn import_chats(&mut self) {
        let Some(paths) = rfd::FileDialog::new().add_filter("apiM chat export", &["json"]).pick_files() else { return };
        let mut imported = 0;
        for path in &paths {
            let Some(mut conv) = std::fs::read(path).ok().and_then(|b| Conversation::from_json(&b)) else { continue };
            conv.save();
            imported += 1;
        }
        self.refresh_chats();
        self.side.note = Some((
            match (imported, paths.len()) {
                (0, _) => "That file is not an apiM chat export".to_string(),
                (1, 1) => "Imported 1 chat".to_string(),
                (n, total) if n == total => format!("Imported {n} chats"),
                (n, total) => format!("Imported {n} of {total} files"),
            },
            Instant::now(),
        ));
    }

    fn refresh_chats(&mut self) {
        self.chats = Conversation::list();
        self.side.prune(&self.chats);
    }

    // ------------------------------------------------------------ context

    /// Tokens the newest request occupied in the model's window, and whether that is a guess.
    fn context_used(&self) -> (Option<u64>, bool) {
        if let Some(m) = self.conv.messages.iter().rev().find(|m| m.usage.context > 0) {
            return (Some(m.usage.context), false);
        }
        if self.conv.messages.is_empty() {
            return (None, false);
        }
        let chars: usize = self.conv.messages.iter().map(|m| m.history_text().len()).sum();
        (Some((chars as f64 / 3.6) as u64), true)
    }

    fn context_breakdown(&self) -> Vec<Bucket> {
        self.conv.messages.iter().rev().find(|m| !m.context_breakdown.is_empty()).map(|m| m.context_breakdown.clone()).unwrap_or_default()
    }

    fn totals(&self) -> chat::Totals {
        let mut t = chat::Totals::default();
        let off_peak = provider::deepseek_off_peak();
        for m in &self.conv.messages {
            if m.role == Role::User {
                t.messages += 1;
                continue;
            }
            t.tokens += m.usage.prompt + m.usage.completion;
            t.ms += m.duration_ms;
            if let Some(cost) = m.usage.shown_cost(&m.model, &self.settings.custom_models, off_peak).filter(|_| m.usage.prompt > 0) {
                t.cost += cost;
                t.priced += 1;
            }
        }
        t
    }

    fn compacting(&self) -> bool {
        self.summary_job.as_ref().is_some_and(|j| j.manual && j.conv_id == self.conv.id)
    }

    fn can_compact(&self) -> bool {
        summary::compact_blocker(&self.conv).is_none()
    }

    /// `/compact`: one summary replaces the conversation for the model. The transcript stays on screen.
    fn compact(&mut self, ctx: &egui::Context, focus: String) {
        if self.running_here() {
            self.compact_note = Some((false, "A reply is still running in this chat. Stop it or wait for it to finish, then compact.".into()));
            return;
        }
        if let Some(why) = summary::compact_blocker(&self.conv) {
            self.compact_note = Some((false, why.into()));
            return;
        }
        if let Err(problem) = provider::resolve_target(&self.settings.model, &self.settings) {
            self.compact_note = Some((false, problem));
            return;
        }
        let (tx, rx) = mpsc::channel();
        let wake = ctx.clone();
        let (messages, stored, settings) = (self.conv.messages.clone(), self.conv.summary.clone(), self.settings.clone());
        self.rt.spawn(async move {
            let _ = tx.send(summary::compact(messages, stored, settings, focus).await);
            wake.request_repaint();
        });
        self.summary_job = Some(SummaryJob { conv_id: self.conv.id.clone(), manual: true, rx });
        self.compact_note = None;
    }

    /// Older turns are folded into the summary once enough of them have piled up behind the newest eight.
    fn refresh_summary(&mut self, ctx: &egui::Context, conv_id: &str) {
        if self.summary_job.is_some() {
            return;
        }
        let conv = match &self.parked {
            Some(parked) if parked.id == conv_id => parked,
            _ => &self.conv,
        };
        let shape = summary::shape(&conv.messages, conv.summary.as_ref());
        if conv.id != conv_id || !summary::should_refresh(shape.pending) {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let wake = ctx.clone();
        let (stored, pending, settings) = (conv.summary.clone(), shape.pending.to_vec(), self.settings.clone());
        self.rt.spawn(async move {
            let _ = tx.send(summary::refresh(stored, pending, settings).await.ok_or_else(String::new));
            wake.request_repaint();
        });
        self.summary_job = Some(SummaryJob { conv_id: conv_id.to_string(), manual: false, rx });
    }

    fn pump_summary(&mut self) {
        let Some(job) = &self.summary_job else { return };
        let Ok(result) = job.rx.try_recv() else { return };
        let job = self.summary_job.take().unwrap();
        match result {
            Ok(fresh) => {
                let turns = fresh.covered_turns.unwrap_or(0);
                // A chat that changed underneath (retry, delete) keeps its old summary.
                self.with_chat(&job.conv_id, |c| {
                    if c.messages.iter().any(|m| m.id == fresh.up_to_id) {
                        c.summary = Some(fresh);
                    }
                });
                if job.manual && job.conv_id == self.conv.id {
                    self.compact_note = Some((true, format!("Compacted {turns} messages into a summary. The model now starts from it.")));
                    self.compact_focus.clear();
                }
            }
            Err(problem) if job.manual => self.compact_note = Some((false, problem)),
            Err(_) => {}
        }
    }

    // ------------------------------------------------------------ sending

    /// The Send button and Enter.
    fn submit(&mut self, ctx: &egui::Context) {
        let text = self.draft.trim().to_string();
        if self.running_here() {
            // "btw …" while a reply runs is handed to it; anything else waits.
            if composer::is_btw(&text) {
                if let Some(run) = &self.run {
                    run.notes.lock().unwrap().push(text.clone());
                }
                let mut note = Message::new(Role::User, &text);
                note.note = true;
                let at = self.conv.messages.len().saturating_sub(1);
                self.conv.messages.insert(at, note);
                self.heights.clear();
                self.draft.clear();
            }
            return;
        }
        if let Some(rest) = text.strip_prefix("/compact") {
            if rest.is_empty() || rest.starts_with(' ') {
                self.draft.clear();
                self.popover = Popover::Context;
                self.compact(ctx, rest.trim().to_string());
                return;
            }
        }
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        if self.run.is_some() {
            self.composer_note = Some("Another chat is still being answered. Stop it or wait for it to finish.".into());
            return;
        }
        if self.compacting() {
            return;
        }
        // Pictures go to the model; any other file is copied into the workspace for the tools to read.
        let workspace = self.conv.workspace();
        let (attached, notes) = attachments::take(std::mem::take(&mut self.attachments), &workspace);
        self.draft.clear();
        self.send(ctx, format!("{text}{notes}"), attached);
    }

    fn send(&mut self, ctx: &egui::Context, text: String, attached: Vec<Attachment>) {
        if let Err(problem) = provider::resolve_target(&self.settings.model, &self.settings) {
            self.toast(problem);
            self.dialog = Dialog::Settings;
            self.settings_ui.tab = 0;
            self.draft = text;
            return;
        }
        let shape = summary::shape(&self.conv.messages, self.conv.summary.as_ref());
        let history: Vec<(Role, String)> = shape.verbatim.iter().map(|m| (m.role, m.history_text())).collect();
        let stored = self.conv.summary.as_ref().filter(|s| self.conv.messages.iter().any(|m| m.id == s.up_to_id)).map(summary::render);
        if self.conv.messages.is_empty() {
            self.conv.title = store::derive_title(if text.trim().is_empty() { "Attached files" } else { &text });
        }

        let mut user = Message::new(Role::User, &text);
        user.attachments = attached.clone();
        // A restore point before the question, so Rewind can put the files back. Failing must not block the reply.
        // ponytail: copied on this thread; a workspace of many large new files makes sending pause.
        let workspace = self.conv.workspace();
        if let Ok(snapshot) = crate::snapshots::create(&workspace, &text.chars().take(80).collect::<String>(), &[]) {
            crate::snapshots::link_restore_point(&workspace, &mut user.other, snapshot.as_ref());
        }
        self.conv.messages.push(user);
        let mut reply = Message::new(Role::Assistant, "");
        reply.model = self.settings.model.clone();
        // "auto" is settled per message, and the reply is labelled with what it got.
        reply.effort = Some(if self.settings.effort == "auto" { crate::prompt::auto_effort(&text).to_string() } else { self.settings.effort.clone() });
        reply.plugins_used = self.settings.enabled_plugins.clone();
        self.conv.messages.push(reply);
        self.conv.updated_at = store::now_ms();
        self.conv.save();
        self.refresh_chats();

        let (tx, rx) = mpsc::channel();
        let wake = ctx.clone();
        let notes = Arc::new(Mutex::new(Vec::new()));
        let request = agent::Request {
            settings: self.settings.clone(),
            history,
            summary: stored,
            text,
            images: attached.into_iter().filter(|a| a.kind == "image").collect(),
            workspace: self.conv.workspace(),
            state_dir: self.conv.state_dir(),
            chat: ChatState { plan: self.conv.plan.clone(), findings: self.conv.findings.clone(), finish_bounced: false },
            conv_id: self.conv.id.clone(),
            notes: notes.clone(),
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
            notes,
            thinking: Stopwatch::new(),
            started: Instant::now(),
            saved: Instant::now(),
        });
        self.focus_composer = true;
        self.jump_to_latest = true;
        self.composer_note = None;
    }

    /// Drops the last reply and asks the same question again.
    fn retry(&mut self, ctx: &egui::Context) {
        if self.run.is_some() || self.conv.messages.last().is_none_or(|m| m.role != Role::Assistant) {
            return;
        }
        self.conv.messages.pop();
        // Notes passed to that reply go with it.
        while self.conv.messages.last().is_some_and(|m| m.note) {
            self.conv.messages.pop();
        }
        if let Some(question) = self.conv.messages.pop() {
            self.heights.clear();
            self.send(ctx, question.text(), question.attachments);
        }
    }

    /// The question a message belongs to and everything up to the next one: `start..end`.
    fn exchange(&self, id: &str) -> Option<(usize, usize)> {
        let asked = |m: &Message| m.role == Role::User && !m.note;
        let at = self.conv.messages.iter().position(|m| m.id == id)?;
        let start = self.conv.messages[..=at].iter().rposition(asked)?;
        let end = self.conv.messages[start + 1..].iter().position(asked).map_or(self.conv.messages.len(), |i| start + 1 + i);
        Some((start, end))
    }

    /// Removes a question and its reply, so neither is sent to the model again.
    fn delete_exchange(&mut self, id: &str) {
        if self.running_here() {
            return;
        }
        let Some((start, end)) = self.exchange(id) else { return };
        self.conv.messages.drain(start..end);
        self.heights.clear();
        self.conv.updated_at = store::now_ms();
        self.conv.save();
        self.refresh_chats();
    }

    /// Opens the rewind popover on a question, with what going back to it would do.
    fn rewind_open(&mut self, id: &str) {
        let Some(at) = self.conv.messages.iter().position(|m| m.id == id) else { return };
        let msg = &self.conv.messages[at];
        let next = self.conv.messages[at + 1..].iter().find(|m| m.role == Role::User && !m.note).map(|m| m.created_at);
        let point = crate::snapshots::find_restore_point(&self.conv.workspace(), msg.other.get("restorePoint"), &msg.text(), msg.created_at, next);
        self.rewind = Some(rewind::Preview { id: id.to_string(), removed: self.conv.messages.len() - at, point, error: String::new() });
    }

    /// The popover's answer: None closes it, otherwise the chat is cut at the question (files first, when asked).
    fn rewind_run(&mut self, files: Option<bool>) {
        let (Some(preview), Some(files)) = (self.rewind.take(), files) else { return };
        let Some(at) = self.conv.messages.iter().position(|m| m.id == preview.id).filter(|_| !self.running_here()) else { return };
        let question = self.conv.messages[at].text();
        let mut counts = None;
        if files {
            // Before the cut, so an error leaves the chat as it was.
            match crate::snapshots::rewind_files(&self.conv.workspace(), &preview.point, &question) {
                Ok(restored) => {
                    counts = Some((restored.restored, restored.removed));
                    self.rewind_undo = restored.safety.map(|s| s.id);
                }
                Err(error) => {
                    self.rewind = Some(rewind::Preview { error, ..preview });
                    return;
                }
            }
        }
        let removed = self.conv.messages.len() - at;
        self.conv.messages.truncate(at);
        // A summary that stood in for turns now gone would describe a chat that no longer exists.
        if self.conv.summary.as_ref().is_some_and(|s| !self.conv.messages.iter().any(|m| m.id == s.up_to_id)) {
            self.conv.summary = None;
        }
        self.heights.clear();
        self.conv.updated_at = store::now_ms();
        self.conv.save();
        self.refresh_chats();
        self.files_stale = true;
        self.draft = if self.draft.trim().is_empty() { question } else { format!("{question}

{}", self.draft) };
        self.focus_composer = true;
        // ponytail: the "Undo file changes" button is not on this line yet; Restore points in the file panel does it.
        self.composer_note = Some(rewind::done_text(removed, counts));
    }

    /// The plan card's footer: clear the plan, or put its blocked steps back to "todo".
    fn edit_plan(&mut self, clear: bool) {
        if self.running_here() {
            return;
        }
        if clear {
            self.conv.plan = None;
        } else if let Some(plan) = self.conv.plan.as_mut() {
            for step in plan.steps.iter_mut().filter(|s| s.state == "blocked") {
                step.state = "todo".into();
                step.note.clear();
            }
        }
        self.heights.clear();
        self.conv.save();
    }

    /// Asks an earlier question again with new words: it and everything after it are replaced.
    fn resend_edited(&mut self, ctx: &egui::Context, id: &str, text: String) {
        if self.run.is_some() || self.compacting() {
            return;
        }
        let Some((start, _)) = self.exchange(id) else { return };
        let attached = std::mem::take(&mut self.conv.messages[start].attachments);
        self.conv.messages.truncate(start);
        self.heights.clear();
        self.send(ctx, text, attached);
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
                Event::ToolDone { id, ok, summary, image, changed } => {
                    if let Some(tool) = msg.parts.iter_mut().rev().find_map(|p| match p {
                        Part::Tool(t) if t.id == id => Some(t),
                        _ => None,
                    }) {
                        tool.ok = Some(ok);
                        tool.summary = summary;
                        tool.image = image;
                        tool.changed_path = changed;
                    }
                    self.files_stale = true;
                }
                Event::Approval { key, reply, .. } if self.always_allow.get(&run.conv_id).is_some_and(|allowed| allowed.contains(&key)) => {
                    let _ = reply.send(true);
                }
                Event::Approval { command, reason, key, mcp, reply } => {
                    run.approval = Some(PendingApproval { command, reason, key, mcp, reply });
                    ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
                }
                Event::Question { question, options, context, reply } => {
                    run.question = Some(PendingQuestion { question, options, context, answer: String::new(), reply });
                    ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
                }
                Event::Usage(usage) => {
                    msg.usage = usage;
                    msg.raw_usage = None;
                    msg.cost = usage.cost(&msg.model, &self.settings.custom_models);
                }
                Event::Context(breakdown) => msg.context_breakdown = breakdown,
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
            let conv_id = run.conv_id.clone();
            self.run = None;
            self.refresh_summary(ctx, &conv_id);
            self.parked = None;
            self.files_stale = true;
            self.refresh_chats();
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational));
        }
    }

    // ------------------------------------------------------------ attaching

    fn pick_files(&mut self) {
        if let Some(picked) = rfd::FileDialog::new().pick_files() {
            picked.into_iter().for_each(|p| attachments::add(self, p));
        }
    }

    fn pick_folder(&mut self) {
        if let Some(folder) = rfd::FileDialog::new().pick_folder() {
            attachments::add(self, folder);
        }
    }

    /// Files dropped on the window become attachments.
    fn take_drops(&mut self, ctx: &egui::Context) {
        let dropped: Vec<PathBuf> = ctx.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect());
        dropped.into_iter().for_each(|p| attachments::add(self, p));
    }

    /// The web app has exactly two global shortcuts, so this does too.
    fn shortcuts(&mut self, ctx: &egui::Context) {
        let pressed = |key| ctx.input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, key));
        if pressed(egui::Key::F) {
            self.find_open = true;
        }
        if pressed(egui::Key::K) {
            self.dialog = Dialog::Search;
        }
    }

    /// The self-portrait: wait for the first frames to settle, ask for the pixels, save them, leave.
    fn take_shot(&mut self, ctx: &egui::Context) {
        let Some(shot) = self.shot.as_mut() else { return };
        ctx.request_repaint();
        if !shot.asked && shot.started.elapsed() > Duration::from_millis(std::env::var("APIM_SHOT_WAIT").ok().and_then(|ms| ms.parse().ok()).unwrap_or(1200)) {
            shot.asked = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
        }
        let image = ctx.input(|i| {
            i.events.iter().find_map(|e| match e {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(image) = image {
            let [w, h] = image.size;
            let saved = image::save_buffer(&shot.path, image.as_raw(), w as u32, h as u32, image::ColorType::Rgba8);
            if let Err(e) = saved {
                eprintln!("could not save the picture: {e}");
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        } else if shot.started.elapsed() > Duration::from_secs(15) {
            eprintln!("no picture arrived");
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.pump(&ctx);
        self.pump_summary();
        self.take_drops(&ctx);
        self.shortcuts(&ctx);
        if self.run.is_some() || self.summary_job.is_some() {
            // Keeps the elapsed time moving between tokens.
            ctx.request_repaint_after(Duration::from_millis(120));
        }
        if self.applied_theme != (self.settings.theme.clone(), self.settings.custom_theme.clone()) {
            self.applied_theme = (self.settings.theme.clone(), self.settings.custom_theme.clone());
            theme::apply(&ctx, theme::Palette::for_theme(&self.settings.theme, &self.settings.custom_theme));
        }
        let p = theme::p();

        // The sidebar slides: its content keeps its full width and is cut off, like the web app's.
        let open = ctx.animate_bool_with_time_and_easing(egui::Id::new("sidebar-open"), self.settings.sidebar_open && !self.fullscreen, 0.3, egui::emath::easing::cubic_out);
        if open > 0.0 {
            let width = (sidebar::WIDTH * open).round();
            egui::Panel::left("sidebar").exact_size(width).resizable(false).show_separator_line(false).frame(egui::Frame::new().fill(p.bg2)).show(ui, |ui| {
                let rect = ui.max_rect();
                ui.set_clip_rect(rect);
                let full = Rect::from_min_size(rect.min, vec2(sidebar::WIDTH, rect.height()));
                ui.scope_builder(egui::UiBuilder::new().max_rect(full), |ui| sidebar::show(self, ui));
                ui.painter().vline(rect.right() - 0.5, rect.y_range(), egui::Stroke::new(1.0, p.border));
            });
        }
        // A fixed rail, and only when the window has room for it (the web hides it under 1024).
        if self.settings.workspace_open && !self.fullscreen && ctx.content_rect().width() >= 1024.0 {
            egui::Panel::right("workspace").exact_size(workspace::WIDTH).resizable(false).show_separator_line(false).frame(egui::Frame::new().fill(p.bg2)).show(ui, |ui| workspace::show(self, ui));
        }
        egui::CentralPanel::default().frame(egui::Frame::new().fill(p.bg)).show(ui, |ui| {
            let bar = egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 0));
            egui::Panel::top("header").exact_size(56.0).show_separator_line(false).frame(bar).show(ui, |ui| ui.horizontal_centered(|ui| chat::header(self, ui)));
            egui::Panel::bottom("composer").show_separator_line(false).resizable(false).frame(egui::Frame::NONE).show(ui, |ui| composer::show(self, ui));
            egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| chat::messages(self, ui));
        });

        overlay::artifact(self, &ctx);
        dialogs::show(self, &ctx);
        overlay::lightbox(self, &ctx);
        self.show_toast(&ctx);
        self.take_shot(&ctx);
    }
}

impl App {
    /// Something went wrong and nothing on screen says so: a line at the bottom that stays until dismissed.
    fn show_toast(&mut self, ctx: &egui::Context) {
        let Some((text, _)) = &self.toast else { return };
        let p = theme::p();
        let mut dismiss = false;
        egui::Area::new(egui::Id::new("toast")).anchor(egui::Align2::CENTER_BOTTOM, [0.0, -20.0]).order(egui::Order::Tooltip).show(ctx, |ui| {
            let shadow = egui::Shadow { offset: [0, 25], blur: 50, spread: 0, color: egui::Color32::from_black_alpha(64) };
            egui::Frame::new().fill(p.bg2).stroke(egui::Stroke::new(1.0, theme::alpha(p.danger, 30.0))).corner_radius(12).shadow(shadow).inner_margin(egui::Margin::symmetric(16, 10)).show(ui, |ui| {
                ui.set_max_width(560.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;
                    icons::show(ui, icons::WARNING.stroke(1.8), 15.0, p.danger);
                    ui.add(egui::Label::new(widgets::lines(text.as_str(), 13.0, 19.5, theme::W::Regular, p.text)).wrap().selectable(false));
                    let label = widgets::galley(ui, "Dismiss", theme::font(12.0, theme::W::Regular), egui::Color32::WHITE);
                    let (rect, response) = ui.allocate_exact_size(vec2(label.size().x + 16.0, 22.0), egui::Sense::click());
                    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
                    let t = widgets::fade(ui, response.id, response.hovered());
                    ui.painter().rect_filled(rect, 8.0, widgets::lerp(egui::Color32::TRANSPARENT, p.hover, t));
                    ui.painter().galley_with_override_text_color(egui::pos2(rect.left() + 8.0, (rect.center().y - label.size().y / 2.0).round()), label, widgets::lerp(p.text2, p.text, t));
                    dismiss = response.clicked();
                });
            });
        });
        if dismiss {
            self.toast = None;
        }
    }
}

fn close_thinking(msg: &mut Message, watch: &mut Stopwatch) {
    if let Some(Part::Thinking { ms: ms @ 0, .. }) = msg.parts.last_mut() {
        *ms = watch.stop().max(1);
    }
}

fn finish_message(msg: &mut Message, started: Instant) {
    let mut thought = 0;
    for part in &mut msg.parts {
        if let Part::Thinking { ms, .. } = part {
            *ms = (*ms).max(1);
            thought += *ms;
        }
    }
    msg.reasoning_ms = thought;
    msg.duration_ms = started.elapsed().as_millis() as u64;
}

fn human_size(size: u64) -> String {
    match size {
        s if s >= 1 << 20 => format!("{:.1} MB", s as f64 / (1u64 << 20) as f64),
        s if s >= 1024 => format!("{:.0} KB", s as f64 / 1024.0),
        s => format!("{s} B"),
    }
}

/// Where egui loads a file on disk from. Windows paths need the third slash, or the drive reads as a host name.
fn file_uri(path: &std::path::Path) -> String {
    let text = path.display().to_string().replace(std::path::MAIN_SEPARATOR, "/");
    if text.starts_with('/') { format!("file://{text}") } else { format!("file:///{text}") }
}

fn is_image(path: &std::path::Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
}

fn open_in_file_manager(path: &std::path::Path) {
    let program = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(program).arg(path).spawn();
}

