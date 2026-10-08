//! Files waiting in the message box, and what becomes of them on Send
//! (src/components/AttachmentChips.tsx).

use super::theme::{self, W, p};
use super::{App, icons, is_image, widgets};
use crate::store::Attachment;
use crate::tools::files;
use base64::Engine;
use eframe::egui::{self, Color32, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::path::{Path, PathBuf};

const MAX_ATTACHMENTS: usize = 10;
/// A picture larger than this is not sent: providers reject it, and it would bloat the saved chat.
const MAX_IMAGE_BYTES: u64 = 8 << 20;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Image,
    File,
    Folder,
}

pub struct Pending {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub kind: Kind,
    /// How many files a folder holds.
    pub files: Option<usize>,
}

/// "12 KB", "3.4 MB": the size under a chip.
pub fn format_bytes(size: u64) -> String {
    match size {
        s if s >= 1 << 20 => format!("{:.1} MB", s as f64 / (1u64 << 20) as f64),
        s if s >= 1024 => format!("{} KB", (s as f64 / 1024.0).round()),
        s => format!("{s} B"),
    }
}

pub fn add(app: &mut App, path: PathBuf) {
    if app.attachments.iter().any(|a| a.path == path) {
        return;
    }
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let mut size = std::fs::metadata(&path).map_or(0, |m| m.len());
    let mut count = None;
    let kind = if path.is_dir() {
        let inside = files::walk(&path, &path);
        size = inside.iter().map(|(_, bytes)| *bytes).sum();
        count = Some(inside.len());
        Kind::Folder
    } else if !path.is_file() {
        return;
    } else if is_image(&path) {
        Kind::Image
    } else {
        Kind::File
    };
    let problem = if app.attachments.len() >= MAX_ATTACHMENTS {
        Some(format!("You can attach up to {MAX_ATTACHMENTS} files"))
    } else if kind == Kind::Image && size > MAX_IMAGE_BYTES {
        Some(format!("{name} is {} — the image limit is 8 MB", format_bytes(size)))
    } else if count == Some(0) {
        Some(format!("{name} had no readable text or binary files in it"))
    } else {
        None
    };
    match problem {
        // Several refusals in one go read as one line.
        Some(problem) => app.attach_error = Some(app.attach_error.take().map_or(problem.clone(), |earlier| format!("{earlier} · {problem}"))),
        None => {
            app.attach_error = None;
            app.attachments.push(Pending { path, name, size, kind, files: count });
        }
    }
}

/// The row of chips above the text: pictures first, then files. Draws nothing when nothing is attached.
pub fn chips(app: &mut App, ui: &mut egui::Ui) {
    if app.attachments.is_empty() {
        return;
    }
    let p = p();
    let mut remove = None;
    let mut enlarge = None;
    egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 12, bottom: 0 }).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
            for (i, a) in app.attachments.iter().enumerate().filter(|(_, a)| a.kind == Kind::Image) {
                let (rect, response) = ui.allocate_exact_size(vec2(66.0, 66.0), Sense::click());
                let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(format!("{} — click to enlarge", a.name));
                let over = ui.rect_contains_pointer(rect);
                ui.painter().rect(rect, 8.0, p.elevated, Stroke::new(1.0, p.border), StrokeKind::Inside);
                let uri = super::file_uri(&a.path);
                // Cropped to the square like `object-cover`, and a touch larger under the pointer.
                let grow = 1.0 + 0.05 * widgets::fade(ui, response.id, over);
                let inner = rect.shrink(1.0);
                let picture = egui::Image::new(uri.clone()).corner_radius(7);
                let size = picture.load_and_calc_size(ui, vec2(f32::INFINITY, f32::INFINITY)).unwrap_or(vec2(64.0, 64.0));
                let scale = (64.0 / size.x.max(1.0)).max(64.0 / size.y.max(1.0)) * grow;
                let mut clipped = ui.new_child(egui::UiBuilder::new().max_rect(inner));
                clipped.set_clip_rect(inner.intersect(ui.clip_rect()));
                picture.paint_at(&clipped, Rect::from_center_size(inner.center(), size * scale));
                let close = Rect::from_min_size(pos2(rect.right() - 2.0 - 16.0, rect.top() + 2.0), vec2(16.0, 16.0));
                let shown = widgets::fade(ui, response.id.with("x"), over);
                let x = ui.interact(close, response.id.with("remove"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
                if shown > 0.0 {
                    ui.painter().rect_filled(close, 4.0, if x.hovered() { p.danger } else { Color32::from_black_alpha(166) }.gamma_multiply(shown));
                    icons::paint(ui, icons::CLOSE.stroke(3.0), close.center(), 9.0, Color32::WHITE.gamma_multiply(shown));
                }
                if x.clicked() {
                    remove = Some(i);
                } else if response.clicked() {
                    enlarge = Some((a.name.clone(), uri));
                }
            }
            for (i, a) in app.attachments.iter().enumerate().filter(|(_, a)| a.kind != Kind::Image) {
                let name = widgets::clipped(ui, &a.name, theme::font(12.0, W::Regular), p.text, 240.0 - 8.0 - 13.0 - 8.0 - 8.0 - 20.0 - 4.0 - 2.0);
                let size = widgets::galley(ui, &format_bytes(a.size), theme::font(11.0, W::Regular), p.text2);
                let count = a.files.map(|n| widgets::galley(ui, &format!(" · {n} file{}", if n == 1 { "" } else { "s" }), theme::font(11.0, W::Regular), p.accent_light));
                let text_width = name.size().x.max(size.size().x + count.as_ref().map_or(0.0, |c| c.size().x));
                let width = 1.0 + 8.0 + 13.0 + 8.0 + text_width + 8.0 + 20.0 + 4.0 + 1.0;
                let (rect, response) = ui.allocate_exact_size(vec2(width, 38.0), Sense::hover());
                response.on_hover_text(a.name.as_str());
                ui.painter().rect(rect, 8.0, p.elevated, Stroke::new(1.0, p.border), StrokeKind::Inside);
                icons::paint(ui, icons::FILE_SMALL.stroke(1.7), pos2(rect.left() + 9.0 + 6.5, rect.center().y), 13.0, p.muted);
                let x = rect.left() + 9.0 + 13.0 + 8.0;
                widgets::text_at(ui, x, rect.top() + 5.0 + 8.0, name);
                let after = x + widgets::text_at(ui, x, rect.top() + 5.0 + 16.0 + 6.0, size);
                if let Some(count) = count {
                    widgets::text_at(ui, after, rect.top() + 5.0 + 16.0 + 6.0, count);
                }
                let close = Rect::from_center_size(pos2(rect.right() - 5.0 - 10.0, rect.center().y), vec2(20.0, 20.0));
                let x = ui.interact(close, ui.id().with(("remove", i)), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand);
                let t = widgets::fade(ui, x.id, x.hovered());
                ui.painter().rect_filled(close, 4.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t));
                icons::paint(ui, icons::CLOSE.stroke(2.4), close.center(), 11.0, widgets::lerp(p.muted, p.danger, t));
                if x.clicked() {
                    remove = Some(i);
                }
            }
        });
    });
    if let Some(i) = remove {
        app.attachments.remove(i);
        app.attach_error = None;
    }
    if let Some((name, uri)) = enlarge {
        app.lightbox = Some((name, uri));
    }
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// What the attached things become when the message is sent: pictures travel with it,
/// anything else is copied into the workspace for the tools to read. The second value
/// is the lines added to the message so the model knows where they went.
pub fn take(pending: Vec<Pending>, workspace: &Path) -> (Vec<Attachment>, String) {
    let uploads = workspace.join("uploads");
    let (mut out, mut notes) = (Vec::new(), String::new());
    for a in pending {
        match a.kind {
            Kind::Image => match std::fs::read(&a.path) {
                Ok(bytes) => {
                    let url = format!("data:{};base64,{}", mime(&a.path), base64::engine::general_purpose::STANDARD.encode(bytes));
                    out.push(Attachment { name: a.name, kind: "image".into(), data_url: Some(url), ..Default::default() });
                }
                Err(e) => notes.push_str(&format!("\n\n[Could not attach {}: {e}]", a.name)),
            },
            Kind::File => {
                let copied = std::fs::create_dir_all(&uploads).and_then(|_| std::fs::copy(&a.path, uploads.join(&a.name)));
                notes.push_str(&match copied {
                    Ok(_) => format!("\n\n[Attached file saved in the workspace: uploads/{}]", a.name),
                    Err(e) => format!("\n\n[Could not attach {}: {e}]", a.name),
                });
                out.push(Attachment { name: a.name, kind: "text".into(), ..Default::default() });
            }
            Kind::Folder => {
                // The same walk the tools use, so build output and dependency folders stay behind.
                let mut copied = 0;
                for (rel, _) in files::walk(&a.path, &a.path) {
                    let to = uploads.join(&a.name).join(&rel);
                    let done = to.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::copy(a.path.join(&rel), &to));
                    copied += usize::from(done.is_ok());
                }
                notes.push_str(&format!("\n\n[Attached folder saved in the workspace: uploads/{}/ ({copied} files)]", a.name));
                out.push(Attachment { name: format!("{}/", a.name), kind: "text".into(), ..Default::default() });
            }
        }
    }
    (out, notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_copies_files_and_inlines_pictures() {
        let dir = std::env::temp_dir().join(format!("apim-attach-{}", crate::store::new_id()));
        let (src, workspace) = (dir.join("src"), dir.join("ws"));
        std::fs::create_dir_all(src.join("proj")).unwrap();
        std::fs::write(src.join("notes.txt"), "hello").unwrap();
        std::fs::write(src.join("pic.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(src.join("proj").join("main.rs"), "fn main() {}").unwrap();
        let pending = |name: &str, kind| Pending { path: src.join(name), name: name.into(), size: 0, kind, files: None };
        assert_eq!((format_bytes(900), format_bytes(1536), format_bytes(3 << 20)), ("900 B".into(), "2 KB".into(), "3.0 MB".into()));
        let (attached, notes) = take(vec![pending("notes.txt", Kind::File), pending("pic.png", Kind::Image), pending("proj", Kind::Folder)], &workspace);
        assert_eq!(attached.iter().map(|a| a.kind.as_str()).collect::<Vec<_>>(), ["text", "image", "text"]);
        assert_eq!(attached[1].data_url.as_deref(), Some("data:image/png;base64,AQID"));
        assert!(notes.contains("uploads/notes.txt") && notes.contains("uploads/proj/ (1 files)"));
        assert_eq!(std::fs::read_to_string(workspace.join("uploads/proj/main.rs")).unwrap(), "fn main() {}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
