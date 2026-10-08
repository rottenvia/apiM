//! Files waiting in the message box, and what becomes of them on Send
//! (src/components/AttachmentChips.tsx, and the attach path of src/lib/attachments.ts).

use super::theme::{self, W, p};
use super::{App, icons, is_image, slash_menu, widgets};
use crate::media::attachments::{self as media, AttachStage, Attached, AttachedKind, Picture, Video, build_message_with_attachments};
use crate::media::ingest::{self, UploadDescription};
use crate::media::{ocr, vision::{self, VisionResult}};
use crate::models::Vision;
use crate::provider;
use crate::store::{Attachment, Settings};
use crate::tools::files;
use eframe::egui::{self, Color32, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A picture's description while its background job runs: `None` until the job has an answer.
type Described = Arc<Mutex<Option<VisionResult>>>;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Image,
    Video,
    File,
    Folder,
}

/// What a waiting attachment becomes in the message.
pub enum Body {
    /// A picture, and on a model that cannot see the description its job is making.
    Picture { picture: Picture, described: Option<Described> },
    /// A clip: sent as video on a native model, named on one that cannot watch.
    Clip(Video),
    /// A file or folder already copied into the workspace, with the text `ingest` read from it.
    Saved(UploadDescription),
}

pub struct Pending {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub kind: Kind,
    /// How many files a folder holds.
    pub files: Option<usize>,
    pub body: Body,
}

impl Pending {
    /// True while a picture is still being described.
    fn describing(&self) -> bool {
        matches!(&self.body, Body::Picture { described: Some(slot), .. } if slot.lock().is_ok_and(|s| s.is_none()))
    }

    /// Why a picture's description failed, once it has (the chip's hover says it).
    fn vision_error(&self) -> Option<String> {
        match &self.body {
            Body::Picture { described: Some(slot), .. } => slot.lock().ok()?.as_ref()?.error.clone(),
            _ => None,
        }
    }
}

/// What a clip's chip says under its name: its size, and how many stills it rides as when it rides as frames (the web's
/// "N frames" badge). A native clip has no stills and says only its size.
// ponytail: nothing samples stills yet, so every clip rides native. `media::video::extract_video_frames` is ready; the
// missing pieces are a background job per clip (it can take seconds on a long clip), a progress stage on the chip, and the
// native/frames switch the web's chip offers on a model that can watch video.
pub fn clip_detail(clip: &Video) -> String {
    let size = format_bytes(clip.size);
    match clip.frames.len() {
        0 => size,
        n => format!("{size} · {n} frame{}", if n == 1 { "" } else { "s" }),
    }
}

/// "12 KB", "3.4 MB": the size under a chip.
pub fn format_bytes(size: u64) -> String {
    match size {
        s if s >= 1 << 20 => format!("{:.1} MB", s as f64 / (1u64 << 20) as f64),
        s if s >= 1024 => format!("{} KB", (s as f64 / 1024.0).round()),
        s => format!("{s} B"),
    }
}

/// The vision mode of the model the next message goes to. A model with no route counts as one that cannot see.
pub fn model_vision(settings: &Settings) -> Vision {
    provider::resolve_target(&settings.model, settings).map_or(Vision::None, |t| t.model.vision)
}

/// Why the message must wait: a picture still being described holds the send, as on the web. None when all is ready.
pub fn waiting(pending: &[Pending]) -> Option<String> {
    let chips: Vec<(&str, Option<AttachStage>, bool)> = pending.iter().map(|a| (a.name.as_str(), None, a.describing())).collect();
    media::attachments_block_send(&chips)
}

/// Attaches a file or folder from the composer. Refusals and read errors go to the notice line, in the web's words.
pub fn add(app: &mut App, path: PathBuf) {
    if app.attachments.iter().any(|a| a.path == path) || !(path.is_file() || path.is_dir()) {
        return;
    }
    if let Some(problem) = media::too_many_files(app.attachments.len()) {
        return slash_menu::say(app, problem, true);
    }
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let (root, vision) = (app.conv.workspace(), model_vision(&app.settings));
    let (rt, key, model) = (app.rt.handle().clone(), app.settings.vision_key.clone(), app.settings.vision_model.clone());
    let describer = |url: &str| describe(&rt, &key, &model, url);
    match read_attachment(&root, path, name, vision, &describer) {
        Ok(pending) => app.attachments.push(pending),
        Err(problem) => slash_menu::say(app, problem, true),
    }
}

/// Reads one attached thing the way the web's composer does. Pictures are shrunk and capped, clips read whole, and files
/// and folders are copied into the workspace under a free name and read by `ingest`. A picture on a model that cannot see
/// starts its description through `describe`.
fn read_attachment(root: &Path, path: PathBuf, name: String, vision: Vision, describe: &dyn Fn(&str) -> Described) -> Result<Pending, String> {
    if path.is_dir() {
        let inside = files::walk(&path, &path);
        let total: u64 = inside.iter().map(|(_, bytes)| *bytes).sum();
        media::check_folder(&name, total, inside.len())?;
        let dest = ingest::free_name(root, &format!("uploads/{name}"))?;
        // ponytail: a file that fails to copy is skipped quietly; the description says how many arrived.
        for (rel, _) in &inside {
            let _ = ingest::save_upload(root, &path.join(rel), &format!("{dest}/{rel}"), media::MAX_BYTES);
        }
        let described = ingest::describe_folder(root, &dest)?;
        return Ok(Pending { path, name, size: total, kind: Kind::Folder, files: Some(inside.len()), body: Body::Saved(described) });
    }
    if is_image(&path) {
        let picture = media::read_image_file(&path)?;
        let described = (vision != Vision::Native).then(|| describe(picture.data_url.as_str()));
        return Ok(Pending { path, name, size: picture.size, kind: Kind::Image, files: None, body: Body::Picture { picture, described } });
    }
    if media::is_video_file("", &name) {
        let clip = media::read_video_file(&path)?;
        return Ok(Pending { path, name, size: clip.size, kind: Kind::Video, files: None, body: Body::Clip(clip) });
    }
    let dest = ingest::free_name(root, &format!("uploads/{name}"))?;
    let (saved, size) = ingest::save_upload(root, &path, &dest, media::MAX_BYTES)?;
    let described = ingest::ingest_upload(root, &saved, true)?;
    Ok(Pending { path, name, size, kind: Kind::File, files: None, body: Body::Saved(described) })
}

/// Starts describing a picture in the background: the vision model when a key is set, else local OCR.
fn describe(rt: &tokio::runtime::Handle, key: &str, model: &str, data_url: &str) -> Described {
    let slot: Described = Arc::new(Mutex::new(None));
    let (job, client, base) = (slot.clone(), provider::client(), vision::vision_base_url());
    let (key, model, url) = (key.trim().to_string(), vision::model_or_default(model).to_string(), data_url.to_string());
    let _ = rt.spawn(async move {
        let result = ocr::describe_image_with_fallback(&client, &base, ocr::TESSERACT, &url, (!key.is_empty()).then_some(key.as_str()), &model, None).await;
        *job.lock().unwrap() = Some(result);
    });
    slot
}

/// The row of chips above the text: pictures first, then files. Draws nothing when nothing is attached.
pub fn chips(app: &mut App, ui: &mut egui::Ui) {
    if app.attachments.is_empty() {
        return;
    }
    // A description arrives from a background task, which cannot wake the window: look again shortly while one is out.
    if app.attachments.iter().any(|a| matches!(&a.body, Body::Picture { described: Some(slot), .. } if slot.lock().unwrap().is_none())) {
        ui.ctx().request_repaint_after(std::time::Duration::from_millis(200));
    }
    let p = p();
    let mut remove = None;
    let mut enlarge = None;
    egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 12, bottom: 0 }).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
            for (i, a) in app.attachments.iter().enumerate().filter(|(_, a)| a.kind == Kind::Image) {
                let (rect, response) = ui.allocate_exact_size(vec2(66.0, 66.0), Sense::click());
                let hover = a.vision_error().map_or_else(|| format!("{} — click to enlarge", a.name), |e| format!("{} — {e}", a.name));
                let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(hover);
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
                // While the description is being made the chip says so, as the web's stage label does.
                if a.describing() {
                    let band = Rect::from_min_max(pos2(rect.left(), rect.bottom() - 16.0), rect.right_bottom());
                    ui.painter().rect_filled(band, 0.0, Color32::from_black_alpha(166));
                    widgets::text_at(ui, band.left() + 4.0, band.top() + 2.0, widgets::galley(ui, "Looking…", theme::font(10.0, W::Regular), Color32::WHITE));
                }
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
                // What `ingest` says is inside a file or folder replaces its size, as the web's chip does.
                let detail = match &a.body {
                    Body::Saved(d) if !d.label.is_empty() => d.label.clone(),
                    Body::Clip(clip) => clip_detail(clip),
                    _ => format_bytes(a.size),
                };
                let size = widgets::clipped(ui, &detail, theme::font(11.0, W::Regular), p.text2, 220.0);
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

/// The message the model gets and the attachments the chat keeps. Pictures travel as data URLs (and as `<image>` descriptions
/// on a model that cannot see), clips as video, and files as the text `ingest` read from their workspace copy.
pub fn message(text: &str, pending: Vec<Pending>, vision: Vision) -> (String, Vec<Attachment>) {
    let (mut stored, mut blocks) = (Vec::new(), Vec::new());
    for a in pending {
        match a.body {
            Body::Picture { picture, described } => {
                let done = described.and_then(|slot| slot.lock().ok().and_then(|s| s.clone()));
                let description = done.as_ref().and_then(|d| d.description.clone());
                let source = done.as_ref().and_then(|d| d.source).map(str::to_string);
                stored.push(Attachment { name: a.name.clone(), kind: "image".into(), data_url: Some(picture.data_url), description: description.clone(), description_source: source, ..Default::default() });
                blocks.push(Attached { name: a.name, size: picture.size, kind: AttachedKind::Image, description, ..Default::default() });
            }
            Body::Clip(clip) => {
                let timed = clip.duration_sec > 0.0;
                stored.push(Attachment { name: a.name.clone(), kind: "video".into(), data_url: clip.data_url.clone(), frames: clip.frames, duration_sec: timed.then_some(clip.duration_sec), frame_interval_sec: timed.then_some(clip.frame_interval_sec), ..Default::default() });
                blocks.push(Attached { name: a.name, size: clip.size, kind: AttachedKind::Video, ..Default::default() });
            }
            Body::Saved(desc) => {
                let name = if a.kind == Kind::Folder { format!("{}/", a.name) } else { a.name.clone() };
                stored.push(Attachment { name: name.clone(), kind: "text".into(), ..Default::default() });
                blocks.push(Attached { name, size: a.size, content: desc.text, preformatted: true, kind: AttachedKind::Text, ..Default::default() });
            }
        }
    }
    (build_message_with_attachments(text, &blocks, vision), stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clip_says_its_size_and_how_many_stills_it_rides_as() {
        use crate::media::video::Frame;
        let clip = |stills: usize| Video { name: "clip.mp4".into(), size: 2048, data_url: None, frames: (0..stills).map(|i| Frame { data_url: format!("data:image/jpeg;base64,{i}"), t: i as f64 }).collect(), duration_sec: 4.0, frame_interval_sec: 2.0 };
        assert_eq!(clip_detail(&clip(0)), "2 KB");
        assert_eq!(clip_detail(&clip(1)), "2 KB · 1 frame");
        assert_eq!(clip_detail(&clip(3)), "2 KB · 3 frames");
    }

    #[test]
    fn attachments_are_copied_once_and_read_into_the_message() {
        let dir = std::env::temp_dir().join(format!("apim-attach-{}", crate::store::new_id()));
        let (src, root) = (dir.join("src"), dir.join("ws"));
        std::fs::create_dir_all(src.join("proj")).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(src.join("notes.txt"), "hello").unwrap();
        std::fs::write(src.join("pic.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(src.join("proj").join("main.rs"), "fn main() {}").unwrap();
        let no_model = |_: &str| -> Described { Arc::new(Mutex::new(None)) };
        let mut pending: Vec<Pending> = ["notes.txt", "pic.png", "proj"].iter().map(|name| read_attachment(&root, src.join(name), name.to_string(), Vision::Native, &no_model).unwrap()).collect();
        // A second copy of a file takes a free name, so the first is never overwritten.
        pending.push(read_attachment(&root, src.join("notes.txt"), "notes.txt".into(), Vision::Native, &no_model).unwrap());
        assert!(root.join("uploads/notes-2.txt").is_file());
        let (text, stored) = message("look", pending, Vision::Native);
        assert_eq!(stored.iter().map(|a| a.kind.as_str()).collect::<Vec<_>>(), ["text", "image", "text", "text"]);
        assert_eq!(stored[1].data_url.as_deref(), Some("data:image/png;base64,AQID"));
        assert_eq!(stored[2].name, "proj/");
        // A file's text is inlined; a folder is described by its tree, as the web does.
        assert!(text.contains("hello") && text.contains("uploads/proj/ — 1 files") && text.ends_with("look"), "{text}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
