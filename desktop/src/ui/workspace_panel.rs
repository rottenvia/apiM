//! The Workspace files slide-over: every file of the chat down the left, and the
//! one picked on the right, as text to edit or as what its last write changed
//! (src/components/WorkspacePanel.tsx and DiffView.tsx).

use super::overlay;
use super::settings::part;
use super::theme::{self, W, alpha, p};
use super::widgets::{self, Chip};
use super::workspace::{confirm, format_size};
use super::{App, icons};
use crate::diff::{self, Diff, Kind};
use crate::snapshots;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, pos2, vec2};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Tailwind's own reds and greens. The web uses them here as they are, whatever the theme.
const RED_300: Color32 = Color32::from_rgb(0xff, 0xa2, 0xa2);
const RED_400: Color32 = Color32::from_rgb(0xff, 0x64, 0x67);
const RED_500: Color32 = Color32::from_rgb(0xfb, 0x2c, 0x36);
const GREEN_300: Color32 = Color32::from_rgb(0x7b, 0xf1, 0xa8);
const GREEN_400: Color32 = Color32::from_rgb(0x05, 0xdf, 0x72);
const GREEN_500: Color32 = Color32::from_rgb(0x00, 0xc9, 0x50);

/// How much of a file the editor loads, in the web's units (UTF-16 code units).
const MAX_READ_CHARS: usize = 400_000;
const PROTECTED: &str = "is inside a protected folder (.git, .history or .snapshots) and cannot be written, moved or deleted by the file tools";

#[derive(Default, PartialEq, Clone, Copy)]
enum Tab {
    #[default]
    File,
    Changes,
}

#[derive(Default)]
pub struct State {
    open: bool,
    selected: Option<String>,
    tab: Tab,
    /// The file before its last write, when one is kept: what Changes compares with and Undo write puts back.
    previous: Option<String>,
    /// The file as it is on disk.
    content: String,
    /// The text in the editor. It differs from `content` until it is saved.
    draft: String,
    /// Only the beginning was loaded, so saving is off.
    truncated: bool,
    error: Option<String>,
    copied: Option<Instant>,
    /// The Changes tab's rows, worked out once per version of the file.
    changes: Option<Changes>,
}

struct Changes {
    diff: Diff,
    /// The text width the rows were measured at, and where each row starts (one more entry than rows).
    width: f32,
    tops: Vec<f32>,
}

enum Act {
    Open(String),
    Delete(String),
    Save,
    Undo,
}

/// Opens the panel, on `path` when there is one.
pub fn open(app: &mut App, path: Option<String>) {
    app.ws.panel = State { open: true, ..Default::default() };
    if let Some(path) = path {
        open_file(app, &path);
    }
}

/// The self-portrait's states for this panel.
pub fn stage(app: &mut App, token: &str) {
    let root = app.conv.workspace();
    let first = || snapshots::list_files(&root).into_iter().map(|file| file.0);
    // `APIM_SHOT_FILE` picks the file; otherwise the first one, or the first with an earlier version to compare.
    let named = std::env::var("APIM_SHOT_FILE").ok();
    match token {
        "ws-panel-empty" => open(app, None),
        "ws-panel" | "ws-panel-dirty" => {
            open(app, named.or_else(|| first().next()));
            if token == "ws-panel-dirty" {
                app.ws.panel.draft.insert_str(0, "# edited here\n");
            }
        }
        "ws-panel-changes" => {
            open(app, named.or_else(|| first().find(|path| snapshots::history_depth(&root, path) > 0)).or_else(|| first().next()));
            let st = &mut app.ws.panel;
            // Where no file was ever rewritten, a made-up earlier version gives the tab something to show.
            if st.previous.is_none() {
                st.previous = Some(st.content.lines().filter(|line| !line.contains("print(")).map(|line| line.replace("files", "sizes") + "
").collect());
            }
            st.tab = Tab::Changes;
        }
        "ws-panel-error" => open(app, Some("no/such/file.txt".into())),
        _ => {}
    }
}

/// The start of `text` that fits in `max` UTF-16 units, cut between lines, and whether anything was left out.
/// A first line longer than the whole budget is cut inside rather than giving nothing.
fn clip_lines(text: &str, max: usize) -> (String, bool) {
    let (mut used, mut end) = (0, 0);
    for (i, line) in text.split('\n').enumerate() {
        let cost = line.encode_utf16().count() + usize::from(i > 0);
        if used + cost > max {
            return (if i == 0 { snapshots::clip_utf16(text, max) } else { text[..end].to_string() }, true);
        }
        used += cost;
        end += line.len() + usize::from(i > 0);
    }
    (text.to_string(), false)
}

/// A file as the editor shows it: its text, and whether only the beginning was loaded.
// ponytail: a .docx or .pdf opens as its raw bytes; the web shows the text it extracts from them.
fn read_for_editor(root: &Path, rel: &str) -> Result<(String, bool), String> {
    let path = snapshots::resolve_inside(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|_| format!("No such file: {rel}"))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {rel}"));
    }
    if meta.len() > snapshots::MAX_FILE_BYTES {
        return Err(format!("{rel} is too large to read ({}KB)", (meta.len() as f64 / 1024.0).round()));
    }
    // No character takes more than four bytes, so this much always holds everything the editor may show.
    let mut bytes = Vec::new();
    std::fs::File::open(&path).and_then(|file| file.take(MAX_READ_CHARS as u64 * 4 + 4).read_to_end(&mut bytes)).map_err(|_| "Couldn't open that file".to_string())?;
    let (text, clipped) = clip_lines(&String::from_utf8_lossy(&bytes), MAX_READ_CHARS);
    Ok((text, clipped || meta.len() > bytes.len() as u64))
}

/// Saves the editor's text over the file. What was there is kept first, for Changes and Undo write.
fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    if snapshots::is_protected_path(rel) {
        return Err(format!("{rel} {PROTECTED}"));
    }
    let path = snapshots::resolve_inside(root, rel)?;
    if content.len() as u64 > snapshots::MAX_FILE_BYTES {
        return Err("File is too large to write".into());
    }
    if let Ok(old) = std::fs::read(&path) {
        snapshots::record_previous(root, rel, &old);
    }
    let failed = |_| "Workspace request failed".to_string();
    std::fs::create_dir_all(path.parent().unwrap_or(root)).map_err(failed)?;
    std::fs::write(&path, content).map_err(failed)
}

/// Deletes a file, keeping a copy the way a write does.
fn delete_file(root: &Path, rel: &str) -> Result<(), String> {
    if snapshots::is_protected_path(rel) {
        return Err(format!("{rel} {PROTECTED}"));
    }
    let path = snapshots::resolve_inside(root, rel)?;
    if let Ok(old) = std::fs::read(&path) {
        snapshots::record_previous(root, rel, &old);
    }
    std::fs::remove_file(&path).map_err(|_| format!("No such file: {rel}"))
}

/// Shows a file in the editor. Unsaved edits to the one open are asked about first.
fn open_file(app: &mut App, path: &str) {
    let root = app.conv.workspace();
    let st = &mut app.ws.panel;
    if st.draft != st.content && !confirm("Discard unsaved changes?") {
        return;
    }
    (st.selected, st.tab, st.error, st.changes) = (Some(path.to_string()), Tab::File, None, None);
    match read_for_editor(&root, path) {
        Ok((text, truncated)) => {
            (st.content, st.draft, st.truncated) = (text.clone(), text, truncated);
            // Read with the file, so the Changes tab is there at once.
            st.previous = snapshots::previous_version(&root, path);
        }
        Err(why) => {
            st.error = Some(why);
            (st.content, st.draft, st.truncated, st.previous) = (String::new(), String::new(), false, None);
        }
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    if !app.ws.panel.open {
        return;
    }
    let p = p();
    let root = app.conv.workspace();
    let mut act = None;
    let shown = overlay::slide_over(ctx, "workspace-files", 736.0, 0.15, p.border, |ui, close| {
        let App { ws, files, .. } = &mut *app;
        let st = &mut ws.panel;
        let dirty = st.draft != st.content;
        // Esc and a click outside arrive here already asking to close.
        if *close && dirty && !confirm("You have unsaved changes. Close anyway?") {
            *close = false;
        }
        // Everything sits inside the 1px left border.
        let rect = ui.max_rect().with_min_x(ui.max_rect().left() + 1.0);
        let rule = Stroke::new(1.0, p.border);

        let mut y = rect.top();
        widgets::text_at(ui, rect.left() + 16.0, y + 22.0, widgets::galley(ui, "Workspace files", theme::font(13.0, W::Semibold), p.text));
        let folder = root.display().to_string();
        let line = Rect::from_min_size(pos2(rect.left() + 16.0, y + 34.0), vec2(rect.width() - 16.0 - 12.0 - 26.0 - 16.0, 16.0));
        widgets::text_at(ui, line.left(), line.center().y, widgets::clipped(ui, &folder, theme::mono(11.0), p.muted, line.width()));
        ui.interact(line, ui.id().with("folder"), Sense::hover()).on_hover_text(folder.as_str());
        let x = part(ui, Rect::from_min_size(pos2(rect.right() - 16.0 - 26.0, y + 12.0), vec2(26.0, 26.0)), widgets::popover_close);
        if x.clicked() && (!dirty || confirm("You have unsaved changes. Close anyway?")) {
            *close = true;
        }
        y += 63.0;
        ui.painter().hline(rect.x_range(), y - 0.5, rule);

        if let Some(why) = &st.error {
            let mut job = egui::text::LayoutJob::simple(why.clone(), theme::font(12.0, W::Regular), RED_300, rect.width() - 32.0);
            job.sections[0].format.line_height = Some(18.0);
            let text = ui.painter().layout_job(job);
            let bar = Rect::from_min_size(pos2(rect.left(), y), vec2(rect.width(), text.size().y + 17.0));
            ui.painter().rect_filled(bar, 0.0, alpha(RED_500, 7.0));
            ui.painter().hline(bar.x_range(), bar.bottom() - 0.5, Stroke::new(1.0, alpha(RED_500, 20.0)));
            ui.painter().galley(pos2(bar.left() + 16.0, bar.top() + 8.0), text, RED_300);
            y = bar.bottom();
        }

        let (list, editor) = Rect::from_min_max(pos2(rect.left(), y), rect.max).split_left_right_at_x(rect.left() + 240.0);
        ui.painter().vline(list.right() - 0.5, list.y_range(), rule);
        part(ui, list.with_max_x(list.right() - 1.0), |ui| file_list(ui, files, st, &mut act));
        part(ui, editor, |ui| editor_column(ui, st, dirty, &mut act));
    });
    if shown == overlay::State::Gone {
        app.ws.panel = State::default();
        app.files_stale = true;
        return;
    }
    let Some(act) = act else { return };
    let selected = app.ws.panel.selected.clone();
    match (act, selected) {
        (Act::Open(path), _) => open_file(app, &path),
        (Act::Delete(path), selected) => {
            if !confirm(&format!("Delete {path}? This cannot be undone.")) {
                return;
            }
            match delete_file(&root, &path) {
                Ok(()) if selected.as_deref() == Some(path.as_str()) => app.ws.panel = State { open: true, error: app.ws.panel.error.take(), ..Default::default() },
                Ok(()) => {}
                Err(why) => app.ws.panel.error = Some(why),
            }
            app.files_stale = true;
        }
        (Act::Save, Some(path)) => {
            let st = &mut app.ws.panel;
            st.error = write_file(&root, &path, &st.draft).err();
            if st.error.is_none() {
                (st.content, st.changes) = (st.draft.clone(), None);
                app.files_stale = true;
            }
        }
        (Act::Undo, Some(path)) => {
            if !confirm(&format!("Restore the previous version of {path}? The current contents become the new undo point, so this can be undone again.")) {
                return;
            }
            match snapshots::restore_previous(&root, &path) {
                // Opened again, so the editor, the changes and the list all show what was put back.
                Ok(()) => open_file(app, &path),
                Err(why) => app.ws.panel.error = Some(why),
            }
            app.files_stale = true;
        }
        _ => {}
    }
}

/// The left column: every file by its full path, with its size under it and a bin that shows under the pointer.
fn file_list(ui: &mut egui::Ui, files: &[(String, u64)], st: &State, act: &mut Option<Act>) {
    let p = p();
    egui::ScrollArea::vertical().id_salt("workspace-files-list").auto_shrink(false).show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        let left = ui.max_rect().left();
        if files.is_empty() {
            let mut job = egui::text::LayoutJob::simple("No files yet. Ask the assistant to create one.".into(), theme::font(12.0, W::Regular), p.muted, 239.0 - 12.0 - 16.0);
            job.sections[0].format.line_height = Some(19.5);
            ui.painter().galley(pos2(left + 14.0, ui.cursor().top() + 18.0), ui.painter().layout_job(job), p.muted);
            return;
        }
        ui.add_space(6.0);
        for (path, size) in files {
            let rect = Rect::from_min_size(pos2(left + 6.0, ui.cursor().top()), vec2(227.0, 52.5));
            ui.advance_cursor_after_rect(rect);
            if !ui.is_rect_visible(rect) {
                continue;
            }
            let id = ui.id().with(("file", path));
            let row = ui.interact(rect, id, Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
            let bin = Rect::from_center_size(pos2(rect.right() - 4.0 - 10.5, rect.center().y), vec2(21.0, 21.0));
            let delete = ui.interact(bin, id.with("delete"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
            let t = widgets::fade(ui, id, ui.rect_contains_pointer(rect));
            let picked = st.selected.as_deref() == Some(path.as_str());
            ui.painter().rect_filled(rect, 8.0, if picked { p.hover } else { p.hover.gamma_multiply(0.6 * t) });
            let name = widgets::clipped(ui, path, theme::mono(12.0), if picked { p.accent_light } else { p.text2 }, 188.0);
            widgets::text_at(ui, rect.left() + 10.0, rect.top() + 8.0 + 9.0, name);
            widgets::text_at(ui, rect.left() + 10.0, rect.top() + 8.0 + 18.0 + 2.0 + 8.25, widgets::galley(ui, &format_size(*size), theme::font(11.0, W::Regular), p.muted));
            if t > 0.0 {
                icons::paint(ui, icons::TOOL_DELETE.stroke(1.8), bin.center(), 13.0, if delete.hovered() { RED_400 } else { p.muted }.gamma_multiply(t));
            }
            if delete.on_hover_text("Delete").clicked() {
                *act = Some(Act::Delete(path.clone()));
            } else if row.on_hover_text(path.as_str()).clicked() {
                *act = Some(Act::Open(path.clone()));
            }
        }
        ui.add_space(6.0);
    });
}

/// The right column: the file's name with Copy and Save, the File / Changes switch when there is an
/// earlier version, and under them the text or the changes.
fn editor_column(ui: &mut egui::Ui, st: &mut State, dirty: bool, act: &mut Option<Act>) {
    let p = p();
    let rect = ui.max_rect();
    let rule = Stroke::new(1.0, p.border);
    let Some(path) = st.selected.clone() else {
        let words = widgets::galley(ui, "Select a file to view and edit it.", theme::font(13.0, W::Regular), p.muted);
        widgets::text_at(ui, rect.center().x - words.size().x / 2.0, rect.center().y, words);
        return;
    };

    let bar = Rect::from_min_size(rect.min, vec2(rect.width(), 49.0));
    ui.painter().hline(bar.x_range(), bar.bottom() - 0.5, rule);
    let mut chips = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(bar.left() + 12.0, bar.top() + 8.0), pos2(bar.right() - 12.0, bar.top() + 40.0))).layout(egui::Layout::right_to_left(egui::Align::Center)));
    chips.spacing_mut().item_spacing.x = 6.0;
    // Save without changes keeps its look and takes no click, as a disabled `.chip` does.
    let save = Chip { text: "Save", active: dirty, pad: 11.0, ..Default::default() }.show(&mut chips);
    let save = if dirty { save } else { save.on_hover_cursor(CursorIcon::NotAllowed) };
    if save.on_hover_text(if dirty { "Save changes" } else { "No changes to save" }).clicked() && dirty {
        *act = Some(Act::Save);
    }
    let fresh = st.copied.is_some_and(|at| at.elapsed() < Duration::from_millis(1600));
    if (Chip { text: if fresh { "Copied" } else { "Copy" }, pad: 11.0, ..Default::default() }).show(&mut chips).on_hover_text("Copy file contents").clicked() {
        ui.ctx().copy_text(st.draft.clone());
        st.copied = Some(Instant::now());
    }
    if fresh {
        ui.ctx().request_repaint_after(Duration::from_millis(100));
    }
    // The name gives way to the chips; the dot of unsaved edits follows it.
    let dot = widgets::galley(ui, "•", theme::mono(12.0), p.accent_light);
    let room = chips.min_rect().left() - 8.0 - (bar.left() + 12.0) - if dirty { 6.0 + dot.size().x } else { 0.0 };
    let name = Rect::from_min_size(pos2(bar.left() + 12.0, bar.top() + 15.0), vec2(room.max(0.0), 18.0));
    let end = name.left() + widgets::text_at(ui, name.left(), name.center().y, widgets::clipped(ui, &path, theme::mono(12.0), p.text2, name.width()));
    ui.interact(name, ui.id().with("name"), Sense::hover()).on_hover_text(path.as_str());
    if dirty {
        widgets::text_at(ui, end + 6.0, name.center().y, dot);
    }
    let mut y = bar.bottom();

    // Only when there is an earlier version: a new file has nothing to compare with or go back to.
    if st.previous.is_some() {
        let row = Rect::from_min_size(pos2(rect.left(), y), vec2(rect.width(), 45.0));
        ui.painter().hline(row.x_range(), row.bottom() - 0.5, rule);
        let mut tabs = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(pos2(row.left() + 12.0, row.top() + 6.0), pos2(row.right() - 12.0, row.top() + 38.0))).layout(egui::Layout::left_to_right(egui::Align::Center)));
        tabs.spacing_mut().item_spacing.x = 6.0;
        if (Chip { text: "File", active: st.tab == Tab::File, pad: 11.0, ..Default::default() }).show(&mut tabs).clicked() {
            st.tab = Tab::File;
        }
        if (Chip { text: "Changes", active: st.tab == Tab::Changes, pad: 11.0, ..Default::default() }).show(&mut tabs).on_hover_text("What the last write changed").clicked() {
            st.tab = Tab::Changes;
        }
        tabs.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if (Chip { icon: Some(icons::UNDO), text: "Undo write", pad: 11.0, ..Default::default() }).show(ui).on_hover_text("Restore the version from before the last write").clicked() {
                *act = Some(Act::Undo);
            }
        });
        y = row.bottom();
    }

    if st.truncated {
        let mut job = egui::text::LayoutJob::simple("This file is too large to show in full — only the beginning is loaded. Saving would truncate it, so saving is disabled.".into(), theme::font(11.0, W::Regular), p.muted, rect.width() - 24.0);
        job.sections[0].format.line_height = Some(16.5);
        let text = ui.painter().layout_job(job);
        let strip = Rect::from_min_size(pos2(rect.left(), y), vec2(rect.width(), text.size().y + 13.0));
        ui.painter().rect_filled(strip, 0.0, alpha(p.hover, 40.0));
        ui.painter().hline(strip.x_range(), strip.bottom() - 0.5, rule);
        ui.painter().galley(pos2(strip.left() + 12.0, strip.top() + 6.0), text, p.muted);
        y = strip.bottom();
    }

    let area = Rect::from_min_max(pos2(rect.left(), y), rect.max);
    if st.tab == Tab::Changes && st.previous.is_some() {
        part(ui, area, |ui| changes(ui, st));
    } else {
        ui.painter().rect_filled(area, 0.0, p.bg);
        part(ui, area, |ui| text_area(ui, st, &path));
    }
}

/// The bare text box of the File tab, over text that can be changed or text that cannot.
fn editor<'t>(text: &'t mut dyn egui::TextBuffer, fill: egui::Vec2, layouter: &'t mut dyn FnMut(&egui::Ui, &dyn egui::TextBuffer, f32) -> Arc<egui::Galley>) -> egui::TextEdit<'t> {
    egui::TextEdit::multiline(text).desired_width(f32::INFINITY).min_size(fill).frame(egui::Frame::NONE.inner_margin(egui::Margin::same(12))).layouter(layouter)
}

/// The file as plain text in one box: no line numbers and no colours, as the web's `<textarea>`.
// ponytail: the whole text is laid out as one galley, like the code viewer. Draw only the visible rows if files near the 400,000 character cap stutter.
fn text_area(ui: &mut egui::Ui, st: &mut State, path: &str) {
    let ink = p().text2;
    let mut layouter = |ui: &egui::Ui, text: &dyn egui::TextBuffer, wrap: f32| -> Arc<egui::Galley> {
        let mut job = egui::text::LayoutJob::simple(text.as_str().to_string(), theme::mono(13.0), ink, wrap);
        job.sections.iter_mut().for_each(|s| s.format.line_height = Some(21.125));
        ui.painter().layout_job(job)
    };
    egui::ScrollArea::vertical().id_salt(("workspace-editor", path)).auto_shrink(false).show(ui, |ui| {
        let fill = vec2(0.0, ui.available_height());
        // A file that was cut short can be read and copied, not changed.
        if st.truncated {
            ui.add(editor(&mut st.draft.as_str(), fill, &mut layouter));
        } else {
            ui.add(editor(&mut st.draft, fill, &mut layouter));
        }
    });
}

/// The Changes tab: what the last write did to the file, as one column of removed and added lines
/// with three unchanged lines either side and the rest folded away.
// ponytail: the rows are painted, so they cannot be selected. Copy from the File tab.
fn changes(ui: &mut egui::Ui, st: &mut State) {
    let p = p();
    let rect = ui.max_rect();
    let Some(previous) = &st.previous else { return };
    let shown = st.changes.get_or_insert_with(|| Changes { diff: diff::diff(previous, &st.content), width: 0.0, tops: Vec::new() });
    let (added, removed) = (shown.diff.added, shown.diff.removed);
    if added + removed == 0 {
        let words = widgets::galley(ui, "No changes.", theme::font(12.0, W::Regular), p.muted);
        widgets::text_at(ui, rect.center().x - words.size().x / 2.0, rect.top() + 16.0 + 9.0, words);
        return;
    }
    let bar = Rect::from_min_size(rect.min, vec2(rect.width(), 31.0));
    ui.painter().hline(bar.x_range(), bar.bottom() - 0.5, Stroke::new(1.0, p.border));
    let (mut x, y) = (bar.left() + 12.0, bar.top() + 15.0);
    for (words, ink) in [(format!("+{added}"), GREEN_400), (format!("−{removed}"), RED_400), (shown.diff.summary(), p.muted)] {
        x += widgets::text_at(ui, x, y, widgets::galley(ui, &words, theme::font(12.0, W::Regular), ink)) + 12.0;
    }

    // Two 40px number gutters and a 16px sign, then the line, wrapped anywhere, with 12px to spare on the right.
    let width = (rect.width() - 96.0 - 12.0).max(40.0);
    let wrapped = |ui: &egui::Ui, text: &str, ink: Color32| {
        let mut job = egui::text::LayoutJob::simple(if text.is_empty() { " ".into() } else { text.replace('\t', "  ") }, theme::mono(12.0), ink, width);
        job.wrap.break_anywhere = true;
        job.sections[0].format.line_height = Some(18.0);
        ui.painter().layout_job(job)
    };
    if shown.width != width {
        let mut top = 0.0;
        shown.tops.clear();
        for row in &shown.diff.rows {
            shown.tops.push(top);
            top += if row.kind == Kind::Skipped { 26.5 } else { wrapped(ui, &row.text, p.text2).size().y };
        }
        shown.tops.push(top);
        shown.width = width;
    }
    let (rows, tops) = (&shown.diff.rows, &shown.tops);
    part(ui, rect.with_min_y(bar.bottom()), |ui| {
        egui::ScrollArea::vertical().id_salt("workspace-changes").auto_shrink(false).show_viewport(ui, |ui, view| {
            ui.set_height(*tops.last().unwrap_or(&0.0));
            let origin = ui.max_rect().min;
            let number = |ui: &egui::Ui, n: Option<usize>, right: f32, top: f32| {
                if let Some(n) = n {
                    let digits = widgets::galley(ui, &n.to_string(), theme::mono(11.0), alpha(p.muted, 70.0));
                    widgets::text_at(ui, right - digits.size().x, top + 8.25, digits);
                }
            };
            // Only the rows in view are laid out and painted.
            for i in tops.partition_point(|top| *top < view.top()).saturating_sub(1)..rows.len() {
                if tops[i] > view.bottom() {
                    break;
                }
                let row = &rows[i];
                let line = Rect::from_min_max(pos2(origin.x, origin.y + tops[i]), pos2(origin.x + rect.width(), origin.y + tops[i + 1]));
                if row.kind == Kind::Skipped {
                    let edge = Stroke::new(1.0, alpha(p.border, 60.0));
                    ui.painter().rect_filled(line, 0.0, alpha(p.hover, 30.0));
                    ui.painter().hline(line.x_range(), line.top() + 0.5, edge);
                    ui.painter().hline(line.x_range(), line.bottom() - 0.5, edge);
                    widgets::text_at(ui, line.left() + 12.0, line.center().y, widgets::galley(ui, &row.text, theme::mono(11.0), p.muted));
                    continue;
                }
                let (fill, ink) = match row.kind {
                    Kind::Added => (alpha(GREEN_500, 9.0), GREEN_300),
                    Kind::Removed => (alpha(RED_500, 9.0), RED_300),
                    _ => (Color32::TRANSPARENT, p.text2),
                };
                ui.painter().rect_filled(line, 0.0, fill);
                number(ui, row.old, line.left() + 34.0, line.top());
                number(ui, row.new, line.left() + 74.0, line.top());
                let sign = widgets::galley(ui, row.kind.sign(), theme::mono(12.0), ink);
                widgets::text_at(ui, line.left() + 88.0 - sign.size().x / 2.0, line.top() + 9.0, sign);
                ui.painter().galley(pos2(line.left() + 96.0, line.top()), wrapped(ui, &row.text, ink), ink);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_file_is_cut_between_lines() {
        assert_eq!(clip_lines("one\ntwo\nthree", 100), ("one\ntwo\nthree".to_string(), false));
        // "one\ntwo" is seven units; the third line would not fit in ten.
        assert_eq!(clip_lines("one\ntwo\nthree", 10), ("one\ntwo".to_string(), true));
        assert_eq!(clip_lines("one\ntwo\n", 8), ("one\ntwo\n".to_string(), false));
        // A single line over the budget is cut inside rather than returned empty.
        assert_eq!(clip_lines("abcdefgh", 3), ("abc".to_string(), true));
        assert_eq!(clip_lines("abcdefgh\nmore", 3), ("abc".to_string(), true));
    }

    #[test]
    fn saving_keeps_the_previous_version_and_undo_brings_it_back() {
        // A throwaway workspace: nothing here touches a real chat.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch").join(format!("panel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "first\n").unwrap();

        assert_eq!(read_for_editor(&root, "src/a.txt"), Ok(("first\n".to_string(), false)));
        assert_eq!(snapshots::previous_version(&root, "src/a.txt"), None);
        write_file(&root, "src/a.txt", "second\n").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "second\n");
        assert_eq!(snapshots::previous_version(&root, "src/a.txt").as_deref(), Some("first\n"));
        snapshots::restore_previous(&root, "src/a.txt").unwrap();
        assert_eq!(read_for_editor(&root, "src/a.txt").unwrap().0, "first\n");

        // Deleting keeps a copy too, and the bookkeeping folders and anything outside are refused.
        delete_file(&root, "src/a.txt").unwrap();
        assert!(!root.join("src/a.txt").exists());
        assert_eq!(snapshots::previous_version(&root, "src/a.txt").as_deref(), Some("first\n"));
        assert_eq!(read_for_editor(&root, "src/a.txt"), Err("No such file: src/a.txt".to_string()));
        assert!(write_file(&root, ".history/x", "no").is_err() && write_file(&root, "../escape.txt", "no").is_err());
        assert_eq!(delete_file(&root, "src/a.txt"), Err("No such file: src/a.txt".to_string()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
