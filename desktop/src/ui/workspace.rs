//! The panel pinned to the right of the chat: this chat's files as a tree, its
//! restore points, and the way out as a zip (src/components/WorkspaceSidePanel.tsx).
//! Everything else that shows the workspace hangs off the state kept here.

use super::theme::{self, W, alpha, p};
use super::{App, chat, docks, github, icons, import_files, widgets, workspace_panel};
use crate::filetree::{self, Node};
use crate::snapshots::{self, SnapshotInfo};
use crate::store::Part;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::collections::HashSet;
use std::sync::Arc;

/// 17.5rem, the left border included.
pub const WIDTH: f32 = 280.0;

#[derive(Default)]
pub struct State {
    /// The files as a tree, rebuilt whenever the list is read again.
    tree: Vec<Node>,
    /// Every folder in it, for "Expand all".
    dirs: Vec<String>,
    /// Folders opened by hand. They all start shut, and the choice outlives a rebuild, as on the web.
    open: HashSet<String>,
    /// What the reply running now, or the last one in this chat, wrote: (chat, paths).
    changed: (String, Vec<String>),
    /// The history button is on: restore points in place of the tree.
    history_on: bool,
    snapshots: Vec<SnapshotInfo>,
    /// The chat and file count the restore points were read for. They are read again when either moves.
    snapshots_for: Option<(String, usize)>,
    pub panel: workspace_panel::State,
    pub docks: docks::State,
    pub import: Option<import_files::State>,
    /// The GitHub connector, while it is open.
    pub github: Option<github::State>,
}

impl State {
    /// Whether the last reply here wrote this file: its name is drawn in the accent.
    pub fn is_changed(&self, path: &str) -> bool {
        self.changed.1.iter().any(|c| c == path)
    }
}

enum Act {
    Github,
    History,
    Import,
    Download,
    Close,
    /// "Expand all" or "Collapse all"; true when everything was open.
    ToggleAll(bool),
    Toggle(String),
    Open(String),
    /// (snapshot id, when it was taken)
    Restore(String, String),
}

/// The browser's `window.confirm`: a native OK / Cancel box that holds the window until it is answered.
pub fn confirm(text: &str) -> bool {
    rfd::MessageDialog::new().set_title("apiM").set_description(text).set_buttons(rfd::MessageButtons::OkCancel).show() == rfd::MessageDialogResult::Ok
}

/// JavaScript's `toFixed(1)`: a tie rounds up, where Rust's own formatting rounds to even.
fn fixed1(x: f64) -> String {
    format!("{:.1}", (x * 10.0).round() / 10.0)
}

/// Sizes in this panel: one decimal for KB and MB.
fn format_bytes(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{} KB", fixed1(n as f64 / 1024.0)),
        _ => format!("{} MB", fixed1(n as f64 / 1_048_576.0)),
    }
}

/// Sizes in the files slide-over and the header's list: whole KB.
pub fn format_size(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{} KB", (n as f64 / 1024.0).round()),
        _ => format!("{} MB", fixed1(n as f64 / 1_048_576.0)),
    }
}

/// The two-letter badge before a file name, so a list of names reads at a glance.
/// `full` is this panel's table; the header's list knows fewer kinds.
pub fn badge(path: &str, full: bool) -> &'static str {
    // Whatever follows the last dot of the whole path, as the web takes it: "Makefile" has none, a file named "py" is Python.
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "py" => "py",
        "js" | "mjs" | "cjs" => "js",
        "ts" | "tsx" => "ts",
        "html" | "htm" => "ht",
        "css" | "scss" => "css",
        "json" => "{}",
        "md" | "txt" => "md",
        "sh" | "bash" => "sh",
        "cfg" | "conf" | "ini" if full => "sh",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" if full => "im",
        _ => "•",
    }
}

/// A badge's letters: 9px mono capitals.
pub fn badge_text(ui: &egui::Ui, text: &str, tight: bool) -> Arc<egui::Galley> {
    let mut job = egui::text::LayoutJob::simple_singleline(text.to_uppercase(), theme::mono(9.0), p().muted);
    job.sections[0].format.extra_letter_spacing = if tight { -0.225 } else { 0.0 };
    ui.painter().layout_job(job)
}

/// An ISO time as the local clock reads, with `format` in chrono's notation.
// ponytail: the web follows the browser's locale (12-hour in en-US); this is always day/month and 24-hour.
fn local_time(iso: &str, format: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).map_or(String::new(), |t| t.with_timezone(&chrono::Local).format(format).to_string())
}

/// A workspace's files, listed and laid out as a tree: (the workspace, its files, the tree, the folders in it).
pub type Listing = (std::path::PathBuf, Vec<(String, u64)>, Vec<Node>, Vec<String>);

fn list(workspace: std::path::PathBuf) -> Listing {
    let files: Vec<(String, u64)> = snapshots::list_files(&workspace).into_iter().map(|(path, size, _)| (path, size)).collect();
    let tree = filetree::collapse_chains(filetree::build(&files));
    let dirs = filetree::dir_paths(&tree);
    (workspace, files, tree, dirs)
}

/// Reads the file list again when something changed it, and notes what the running reply wrote.
/// Both the rail and the header call it; whichever is drawn first does the work.
pub fn refresh(app: &mut App) {
    if std::mem::take(&mut app.files_stale) {
        let workspace = app.conv.workspace();
        if app.shot.is_some() && !app.staged("send") {
            // A self-portrait is taken of the first frames: it cannot wait for another thread.
            (_, app.files, app.ws.tree, app.ws.dirs) = list(workspace);
        } else {
            // A workspace of thousands of files takes tens of milliseconds to list, and it is listed again after
            // every step of a reply: not on the thread that draws. A newer listing replaces one still on its way.
            let (tx, rx) = std::sync::mpsc::channel();
            let ctx = app.ctx.clone();
            std::thread::spawn(move || {
                let _ = tx.send(list(workspace));
                ctx.request_repaint();
            });
            app.listing = Some(rx);
        }
    }
    if let Some(Ok((workspace, files, tree, dirs))) = app.listing.as_ref().map(|rx| rx.try_recv()) {
        app.listing = None;
        // Not one for a chat that has been left since.
        if workspace == app.conv.workspace() {
            (app.files, app.ws.tree, app.ws.dirs) = (files, tree, dirs);
        }
    }
    // The marks belong to one chat and go when it is left.
    if app.ws.changed.0 != app.conv.id {
        app.ws.changed = (app.conv.id.clone(), Vec::new());
    }
    if app.running_here() {
        let written: Vec<String> = app.conv.messages.last().into_iter().flat_map(|m| &m.parts).filter_map(|part| if let Part::Tool(tool) = part { tool.changed_path.clone() } else { None }).collect();
        // A reply that has written nothing yet leaves the last one's marks alone.
        if !written.is_empty() {
            app.ws.changed.1 = written;
        }
    }
}

/// Opens the Workspace files slide-over on a file: a row here, or a "Created x.py" line in a reply.
pub fn open(app: &mut App, path: String) {
    workspace_panel::open(app, Some(path));
}

/// What opens over the window from this corner of the app: the files slide-over and the copy dialog.
pub fn overlays(app: &mut App, ctx: &egui::Context) {
    workspace_panel::show(app, ctx);
    import_files::show(app, ctx);
    github::show(app, ctx);
}

/// The self-portrait's states (`APIM_SHOT_STATE`) for the rail, the slide-over, the header chips and the copy dialog.
pub fn stage(app: &mut App, token: &str) {
    match token {
        "ws-history" => (app.settings.workspace_open, app.ws.history_on) = (true, true),
        "ws-expand" => {
            app.settings.workspace_open = true;
            refresh(app);
            app.ws.open = app.ws.dirs.iter().cloned().collect();
        }
        _ => {}
    }
    workspace_panel::stage(app, token);
    docks::stage(app, token);
    import_files::stage(app, token);
    github::stage(app, token);
}

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    refresh(app);
    let full = ui.max_rect();
    let rule = Stroke::new(1.0, p.border);
    ui.painter().vline(full.left() + 0.5, full.y_range(), rule);
    let (x0, count) = (full.left(), app.files.len());
    let total: u64 = app.files.iter().map(|f| f.1).sum();
    if app.ws.history_on && app.ws.snapshots_for.as_ref().is_none_or(|(chat, files)| *chat != app.conv.id || *files != count) {
        app.ws.snapshots = snapshots::list(&app.conv.workspace());
        app.ws.snapshots_for = Some((app.conv.id.clone(), count));
    }
    let st = &app.ws;
    let mut act = None;

    // The header: 56 with its rule. Five 38px buttons leave the title 26px, so it is cut short here as it is on the web.
    let mid = full.top() + 27.5;
    ui.painter().hline(full.x_range(), full.top() + 55.5, rule);
    icons::paint(ui, icons::FOLDER_PLAIN, pos2(x0 + 13.0 + 7.5, mid), 15.0, p.muted);
    widgets::text_at(ui, x0 + 36.0, mid, widgets::clipped(ui, "Workspace", theme::font(13.0, W::Medium), p.text, 26.0));
    let download_tip = if count == 0 { "Nothing to download yet" } else { "Download everything as a .zip" };
    let buttons = [
        (icons::GITHUB, 14.0, "Connect a GitHub repository", true, Act::Github),
        (icons::HISTORY, 14.0, "Earlier versions of this workspace", true, Act::History),
        (icons::COPY_FILES, 15.0, "Copy files from another chat", true, Act::Import),
        (icons::DOWNLOAD_TRAY, 14.0, download_tip, count > 0, Act::Download),
        (icons::CLOSE, 14.0, "Hide the workspace panel", true, Act::Close),
    ];
    for (i, (icon, size, tip, enabled, what)) in buttons.into_iter().enumerate() {
        let rect = Rect::from_min_size(pos2(x0 + 70.0 + 40.0 * i as f32, full.top() + 8.5), vec2(38.0, 38.0));
        if head_btn(ui, rect, i, icon, size, tip, enabled) {
            act = Some(what);
        }
    }

    // What is here: "12 files · 3.4 KB", and the switch for every folder at once.
    let toggle = count > 0 && !st.history_on;
    let line = if toggle { 20.5 } else { 16.5 };
    let strip = full.top() + 56.0;
    let small = theme::font(11.0, W::Regular);
    let (mut x, y) = (x0 + 13.0, strip + 12.0 + line / 2.0);
    x += widgets::text_at(ui, x, y, widgets::galley(ui, &chat::thousands(count as u64), small.clone(), p.text2)) + 6.0;
    x += widgets::text_at(ui, x, y, widgets::galley(ui, if count == 1 { "file" } else { "files" }, small.clone(), p.muted)) + 6.0;
    if total > 0 {
        x += widgets::text_at(ui, x, y, widgets::galley(ui, "·", small.clone(), p.muted.gamma_multiply(0.4))) + 6.0;
        widgets::text_at(ui, x, y, widgets::galley(ui, &format_bytes(total), small.clone(), p.muted));
    }
    if toggle {
        // With no folders at all this reads "Collapse all", as the web's does.
        let all_open = st.dirs.iter().all(|dir| st.open.contains(dir));
        let label = widgets::galley(ui, if all_open { "Collapse all" } else { "Expand all" }, small, Color32::WHITE);
        let rect = Rect::from_min_size(pos2(x0 + 268.0 - label.size().x - 12.0, strip + 12.0), vec2(label.size().x + 12.0, 20.5));
        let response = ui.interact(rect, ui.id().with("every-folder"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Expand or collapse every folder");
        if response.hovered() {
            ui.painter().rect_filled(rect, 4.0, p.hover);
        }
        ui.painter().galley_with_override_text_color(pos2(rect.left() + 6.0, (rect.center().y - label.size().y / 2.0).round()), label, if response.hovered() { p.text } else { p.muted });
        if response.clicked() {
            act = Some(Act::ToggleAll(all_open));
        }
    }
    let top = strip + 12.0 + line + 8.0;

    // Download, said in words, under everything.
    let bottom = if count > 0 { full.bottom() - 53.0 } else { full.bottom() };
    if count > 0 {
        ui.painter().hline(full.x_range(), bottom + 0.5, rule);
        let rect = Rect::from_min_size(pos2(x0 + 9.0, bottom + 9.0), vec2(WIDTH - 17.0, 36.0));
        let response = ui.interact(rect, ui.id().with("download-all"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Download everything as a .zip");
        let t = widgets::fade(ui, response.id, response.hovered());
        ui.painter().rect(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t), Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), StrokeKind::Inside);
        let ink = widgets::lerp(p.text2, p.text, t);
        let words = widgets::galley(ui, "Download all files", theme::font(12.0, W::Medium), ink);
        let number = widgets::galley(ui, &format!("({count})"), theme::font(12.0, W::Medium), p.muted);
        let mut x = rect.center().x - (13.0 + 8.0 + words.size().x + 8.0 + number.size().x) / 2.0;
        icons::paint(ui, icons::DOWNLOAD_TRAY.stroke(1.8), pos2(x + 6.5, rect.center().y), 13.0, ink);
        x += 13.0 + 8.0;
        x += widgets::text_at(ui, x, rect.center().y, words) + 8.0;
        widgets::text_at(ui, x, rect.center().y, number);
        if response.clicked() {
            act = Some(Act::Download);
        }
    }

    let mut body = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(x0, top), pos2(full.right(), bottom))));
    egui::ScrollArea::vertical().id_salt(("workspace-rail", st.history_on)).auto_shrink(false).show(&mut body, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        if st.history_on {
            if st.snapshots.is_empty() {
                empty(ui, "No earlier versions yet.", "One is saved before each message.");
            }
            for snapshot in &st.snapshots {
                history_row(ui, snapshot, &mut act);
            }
        } else if count == 0 {
            empty(ui, "No files yet.", "Ask for one and it appears here.");
        } else {
            tree_rows(ui, &st.tree, 0, st, &mut act);
        }
        ui.add_space(12.0);
    });

    match act {
        None => {}
        Some(Act::Close) => {
            app.settings.workspace_open = false;
            app.settings.save();
        }
        Some(Act::History) => (app.ws.history_on, app.ws.snapshots_for) = (!app.ws.history_on, None),
        Some(Act::Import) => app.ws.import = Some(Default::default()),
        Some(Act::Download) => download(app),
        Some(Act::Github) => app.ws.github = Some(github::open(&app.conv)),
        Some(Act::ToggleAll(true)) => app.ws.open.clear(),
        Some(Act::ToggleAll(false)) => app.ws.open = app.ws.dirs.iter().cloned().collect(),
        Some(Act::Toggle(path)) => {
            if !app.ws.open.remove(&path) {
                app.ws.open.insert(path);
            }
        }
        Some(Act::Open(path)) => open(app, path),
        Some(Act::Restore(id, taken)) => restore(app, &id, &taken),
    }
}

/// `.sidebar-icon-btn`: 38 square and muted, a bordered tile under the pointer. A disabled one is at 40% and dead.
fn head_btn(ui: &mut egui::Ui, rect: Rect, n: usize, icon: icons::Icon, size: f32, tip: &str, enabled: bool) -> bool {
    let p = p();
    let response = ui.interact(rect, ui.id().with(("workspace-head", n)), if enabled { Sense::click() } else { Sense::hover() }).on_hover_cursor(if enabled { CursorIcon::PointingHand } else { CursorIcon::NotAllowed });
    let t = widgets::fade(ui, response.id, response.hovered());
    let dim = if enabled { 1.0 } else { 0.4 };
    ui.painter().rect(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, p.bg3, t).gamma_multiply(dim), Stroke::new(1.0, widgets::lerp(Color32::TRANSPARENT, p.border, t).gamma_multiply(dim)), StrokeKind::Inside);
    icons::paint(ui, icon, rect.center(), size, widgets::lerp(p.muted, p.text, t).gamma_multiply(dim));
    response.on_hover_text(tip).clicked()
}

/// Two centred lines where a list would be.
fn empty(ui: &mut egui::Ui, first: &str, second: &str) {
    let (left, top) = (ui.max_rect().left(), ui.cursor().top());
    for (i, line) in [first, second].into_iter().enumerate() {
        let text = widgets::galley(ui, line, theme::font(12.0, W::Regular), p().muted);
        widgets::text_at(ui, left + 140.5 - text.size().x / 2.0, top + 24.0 + 19.5 * i as f32 + 9.75, text);
    }
    ui.advance_cursor_after_rect(Rect::from_min_size(pos2(left, top), vec2(WIDTH, 24.0 + 39.0 + 24.0)));
}

/// `.list-row`: the strip under the pointer, there at once and fading out. Returns how far lit it is.
fn row_light(ui: &egui::Ui, rect: Rect, id: egui::Id, hovered: bool) -> f32 {
    let t = widgets::fade(ui, id, hovered);
    ui.painter().rect_filled(rect, 8.0, p().hover.gamma_multiply(if hovered { 1.0 } else { t }));
    t
}

/// One row per file or folder, indented by depth; an open folder's own rows follow it.
fn tree_rows(ui: &mut egui::Ui, nodes: &[Node], depth: usize, st: &State, act: &mut Option<Act>) {
    let p = p();
    for node in nodes {
        // `w-full` with the row's -8px margin: 255 wide, starting 5px into the panel and stopping 20 short of its edge.
        let rect = Rect::from_min_size(pos2(ui.max_rect().left() + 5.0, ui.cursor().top()), vec2(255.0, 30.0));
        ui.advance_cursor_after_rect(rect);
        let open = node.is_dir && st.open.contains(&node.path);
        if ui.is_rect_visible(rect) {
            let response = ui.interact(rect, ui.id().with(("row", &node.path, node.is_dir)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
            let hovered = response.hovered();
            let t = row_light(ui, rect, response.id, hovered);
            let ink = if hovered { p.text } else { p.text2 };
            let (mid, right) = (rect.center().y, rect.right() - 8.0);
            if node.is_dir {
                let left = rect.left() + depth as f32 * 12.0;
                let turn = ui.ctx().animate_bool_with_time(response.id.with("open"), open, 0.15);
                icons::paint_turned(ui, icons::CHEVRON_RIGHT.stroke(2.4), pos2(left + 5.5, mid), 11.0, p.muted, turn * std::f32::consts::FRAC_PI_2);
                icons::paint(ui, icons::FOLDER_PLAIN, pos2(left + 17.0 + 6.5, mid), 13.0, p.muted);
                let files = widgets::galley(ui, &node.file_count.to_string(), theme::font(11.0, W::Regular), p.muted);
                let files_left = right - files.size().x;
                widgets::text_at(ui, files_left, mid, files);
                widgets::text_at(ui, left + 36.0, mid, widgets::clipped(ui, &node.name, theme::font(12.0, W::Regular), ink, files_left - 6.0 - (left + 36.0)));
                if response.on_hover_text(node.path.as_str()).clicked() {
                    *act = Some(Act::Toggle(node.path.clone()));
                }
            } else {
                let left = rect.left() + depth as f32 * 12.0 + 8.0;
                let tile = Rect::from_min_size(pos2(left, mid - 9.0), vec2(22.0, 18.0));
                ui.painter().rect(tile, 4.0, p.bg3, Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), StrokeKind::Inside);
                let letters = badge_text(ui, badge(&node.path, true), true);
                widgets::text_at(ui, tile.center().x - letters.size().x / 2.0, mid, letters);
                // The size is always there and only shows under the pointer, so the name never moves.
                let size = widgets::galley(ui, &format_bytes(node.size), theme::font(11.0, W::Regular), p.muted.gamma_multiply(t));
                let size_left = right - size.size().x;
                widgets::text_at(ui, size_left, mid, size);
                let ink = if st.is_changed(&node.path) { p.accent_light } else { ink };
                widgets::text_at(ui, left + 30.0, mid, widgets::clipped(ui, &node.name, theme::mono(12.0), ink, size_left - 8.0 - (left + 30.0)));
                if response.on_hover_text(node.path.as_str()).clicked() {
                    *act = Some(Act::Open(node.path.clone()));
                }
            }
        }
        if open {
            tree_rows(ui, &node.children, depth + 1, st, act);
        }
    }
}

/// One restore point: what it was saved before, when, how many files, and Restore under the pointer.
fn history_row(ui: &mut egui::Ui, snapshot: &SnapshotInfo, act: &mut Option<Act>) {
    let p = p();
    // A block row: its -8px margins widen it on both sides.
    let rect = Rect::from_min_size(pos2(ui.max_rect().left() + 5.0, ui.cursor().top()), vec2(271.0, 54.5));
    ui.advance_cursor_after_rect(rect);
    if !ui.is_rect_visible(rect) {
        return;
    }
    let id = ui.id().with(("snapshot", &snapshot.id));
    let t = row_light(ui, rect, id, ui.rect_contains_pointer(rect));
    let (left, right) = (rect.left() + 8.0, rect.right() - 8.0);
    let label = Rect::from_min_size(pos2(left, rect.top() + 6.0), vec2(right - left, 18.0));
    widgets::text_at(ui, left, label.center().y, widgets::clipped(ui, &snapshot.label, theme::font(12.0, W::Regular), p.text2, label.width()));
    ui.interact(label, id.with("label"), Sense::hover()).on_hover_text(snapshot.label.as_str());
    let files = snapshot.file_count;
    let when = format!("{} · {files} file{}", local_time(&snapshot.created_at, "%H:%M"), if files == 1 { "" } else { "s" });
    let mid = rect.top() + 6.0 + 18.0 + 2.0 + 11.25;
    widgets::text_at(ui, left, mid, widgets::galley(ui, &when, theme::font(11.0, W::Regular), p.muted));

    let words = widgets::galley(ui, "Restore", theme::font(11.0, W::Regular), Color32::WHITE);
    let button = Rect::from_min_size(pos2(right - words.size().x - 14.0, mid - 11.25), vec2(words.size().x + 14.0, 22.5));
    let response = ui.interact(button, id.with("restore"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
    let lit = widgets::fade(ui, response.id, response.hovered());
    if t > 0.0 {
        ui.painter().rect_stroke(button, 8.0, Stroke::new(1.0, widgets::lerp(p.border, alpha(p.accent, 40.0), lit).gamma_multiply(t)), StrokeKind::Inside);
        ui.painter().galley_with_override_text_color(pos2(button.left() + 7.0, (mid - words.size().y / 2.0).round()), words, widgets::lerp(p.text2, p.text, lit).gamma_multiply(t));
    }
    if response.clicked() {
        *act = Some(Act::Restore(snapshot.id.clone(), snapshot.created_at.clone()));
    }
}

/// Puts the workspace back to a restore point, after asking. What was there is saved first, so it can be undone.
fn restore(app: &mut App, id: &str, taken: &str) {
    let when = local_time(taken, "%-d/%-m/%Y, %H:%M:%S");
    if !confirm(&format!("Put the workspace back to how it was at {when}?\n\nFiles changed since will be reverted and files created since will be removed. The current state is saved first, so this can be undone.")) {
        return;
    }
    // Whatever came of it, the lists are read again and show it.
    let _ = snapshots::restore(&app.conv.workspace(), id, None);
    app.ws.snapshots_for = None;
    app.files_stale = true;
}

/// Every file as one .zip, saved where the user says.
// ponytail: zipped on the window's own thread, so a huge workspace holds the window for a moment. Move it to a thread if that shows.
fn download(app: &mut App) {
    let Ok((name, bytes)) = snapshots::zip_workspace(&app.conv.workspace()) else { return };
    if let Some(path) = rfd::FileDialog::new().set_file_name(name).add_filter("Zip archive", &["zip"]).save_file() {
        let _ = std::fs::write(path, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_badges_follow_the_web() {
        // toFixed(1) rounds a tie up; whole KB round half up too.
        assert_eq!((format_bytes(1023).as_str(), format_bytes(1280).as_str(), format_bytes(1_572_864).as_str()), ("1023 B", "1.3 KB", "1.5 MB"));
        assert_eq!((format_size(1536).as_str(), format_size(2560).as_str(), format_size(1_048_576).as_str()), ("2 KB", "3 KB", "1.0 MB"));
        assert_eq!((badge("src/App.TSX", true), badge("a.b/Makefile", true), badge("py", true), badge("shot.png", true), badge("shot.png", false), badge("x.ini", false)), ("ts", "•", "py", "im", "•", "•"));
    }
}
