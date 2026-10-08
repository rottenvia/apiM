//! Things that open over the whole window: the code viewer that slides in from
//! the right (src/components/ArtifactPanel.tsx) and the picture viewer
//! (ImageLightbox.tsx). Also the two frames other overlays are built from.

use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use eframe::egui::{self, Color32, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::time::Instant;

/// A long code block opened from a reply.
pub struct Artifact {
    pub title: String,
    pub language: String,
    pub code: String,
    pub copied: Option<Instant>,
}

/// What an overlay tells its owner after a frame.
#[derive(PartialEq)]
pub enum State {
    Open,
    /// Fully slid or faded out: drop it.
    Gone,
}

/// The shared mechanics: a dimmed window, something on top that animates in and
/// out, closed by Esc or a click on the dimmed part. `place` gets how far in it
/// is (0..1) and returns where the content goes; `add` may set its flag to close.
fn overlay(ctx: &egui::Context, name: &str, secs: f32, dim: u8, esc: bool, place: impl FnOnce(Rect, f32) -> Rect, add: impl FnOnce(&mut egui::Ui, &mut bool)) -> State {
    overlay_with(ctx, name, secs, dim, esc, true, place, add)
}

/// `exit: false` is the web's dialogs that vanish at once: the dim does not fade and closing skips the way out.
fn overlay_with(ctx: &egui::Context, name: &str, secs: f32, dim: u8, esc: bool, exit: bool, place: impl FnOnce(Rect, f32) -> Rect, add: impl FnOnce(&mut egui::Ui, &mut bool)) -> State {
    let id = egui::Id::new(name);
    let closing_id = id.with("closing");
    let mut closing: bool = ctx.data(|d| d.get_temp(closing_id)).unwrap_or(false);
    // egui starts a new animation at its target, so a fresh overlay is first told it is shut.
    let open_id = id.with("open");
    if !ctx.data(|d| d.get_temp::<bool>(open_id)).unwrap_or(false) {
        ctx.animate_bool_with_time(id.with("in"), false, 0.0);
        ctx.data_mut(|d| d.insert_temp(open_id, true));
    }
    let t = ctx.animate_bool_with_time_and_easing(id.with("in"), !closing, secs, egui::emath::easing::cubic_out);
    let screen = ctx.content_rect();
    let mut close = esc && ctx.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Escape));
    egui::Area::new(id).order(egui::Order::Foreground).fixed_pos(screen.min).show(ctx, |ui| {
        let scrim = ui.allocate_rect(screen, Sense::click());
        ui.painter().rect_filled(screen, 0.0, Color32::from_black_alpha((dim as f32 * if exit { t } else { 1.0 }) as u8));
        let content = place(screen, t);
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(content).layout(egui::Layout::top_down(egui::Align::Min)));
        child.set_clip_rect(content.intersect(screen));
        child.set_opacity(t.max(0.01));
        // Clicks on the content's own empty parts must not count as clicks outside it.
        child.interact(content, id.with("body"), Sense::click());
        add(&mut child, &mut close);
        if scrim.clicked() && scrim.interact_pointer_pos().is_some_and(|at| !content.contains(at)) {
            close = true;
        }
    });
    if close && !closing && exit {
        closing = true;
        ctx.data_mut(|d| d.insert_temp(closing_id, true));
    }
    if (close && !exit) || (closing && t <= 0.0) {
        ctx.data_mut(|d| {
            d.remove::<bool>(closing_id);
            d.remove::<bool>(open_id);
        });
        return State::Gone;
    }
    State::Open
}

/// A dialog card: the rounded box every modal of the web app is.
pub struct Card<'a> {
    pub name: &'a str,
    pub width: f32,
    /// Its height, or the most it may take when it hugs its content.
    pub height: f32,
    pub hug: bool,
    /// Distance from the window's top. None centres it.
    pub top: Option<f32>,
    pub dim: u8,
    pub secs: f32,
    /// How far it travels while fading in: positive comes up from below.
    pub rise: f32,
    /// The scale it starts from.
    pub grow: f32,
    /// Fades out on close (most of the web's dialogs just vanish).
    pub exit: bool,
    pub esc: bool,
    pub border: Color32,
}

impl<'a> Card<'a> {
    /// The web's MODAL-SHELL: 60% dim, rises 8px in 0.3s, gone at once.
    pub fn new(name: &'a str, width: f32, height: f32) -> Card<'a> {
        Card { name, width, height, hug: false, top: None, dim: 153, secs: 0.3, rise: 8.0, grow: 1.0, exit: false, esc: true, border: p().border_light }
    }

    pub fn show(self, ctx: &egui::Context, add: impl FnOnce(&mut egui::Ui, &mut bool)) -> State {
        let p = p();
        let screen = ctx.content_rect();
        let most = vec2(self.width.min(screen.width() - 32.0), self.height.min(screen.height() - 32.0));
        let memory = egui::Id::new(self.name).with("height");
        // A hugging card is as tall as what it held last frame.
        let last: f32 = if self.hug { ctx.data(|d| d.get_temp(memory)).unwrap_or(most.y).min(most.y) } else { most.y };
        let mut used = last;
        let state = overlay_with(
            ctx,
            self.name,
            self.secs,
            self.dim,
            self.esc,
            self.exit,
            |screen, t| {
                let size = vec2(most.x, last);
                let rect = match self.top {
                    Some(top) => Rect::from_min_size(pos2(screen.center().x - size.x / 2.0, screen.top() + top), size),
                    None => Rect::from_center_size(screen.center(), size),
                };
                let scale = self.grow + (1.0 - self.grow) * t;
                Rect::from_center_size(rect.center(), rect.size() * scale).translate(vec2(0.0, (self.rise * (1.0 - t)).round()))
            },
            |ui, close| {
                let rect = ui.max_rect();
                ui.painter().add(egui::Shadow { offset: [0, 25], blur: 50, spread: 0, color: Color32::from_black_alpha(if self.border == p.border_light { 128 } else { 64 }) }.as_shape(rect.shrink(12.0), 16));
                ui.painter().rect(rect, 16.0, p.bg2, Stroke::new(1.0, self.border), StrokeKind::Inside);
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                let room = Rect::from_min_size(rect.min, vec2(rect.width(), if self.hug { most.y } else { rect.height() })).shrink(1.0);
                let inner = ui.scope_builder(egui::UiBuilder::new().max_rect(room).layout(egui::Layout::top_down(egui::Align::Min)), |ui| {
                    ui.set_clip_rect(rect.shrink(1.0).intersect(ui.clip_rect()));
                    add(ui, close)
                });
                used = inner.response.rect.height() + 2.0;
            },
        );
        if self.hug && (used - last).abs() > 0.5 {
            ctx.data_mut(|d| d.insert_temp(memory, used));
            ctx.request_repaint();
        }
        state
    }
}

/// A panel as tall as the window that slides in from its right edge.
pub fn slide_over(ctx: &egui::Context, name: &str, width: f32, secs: f32, border: Color32, add: impl FnOnce(&mut egui::Ui, &mut bool)) -> State {
    let p = p();
    overlay(
        ctx,
        name,
        secs,
        128,
        true,
        |screen, t| {
            let width = width.min(screen.width());
            Rect::from_min_size(pos2(screen.right() - width * t, screen.top()), vec2(width, screen.height()))
        },
        |ui, close| {
            let rect = ui.max_rect();
            ui.painter().rect_filled(rect, 0.0, p.bg2);
            ui.painter().vline(rect.left() + 0.5, rect.y_range(), Stroke::new(1.0, border));
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            add(ui, close);
        },
    )
}

/// A box in the middle of the window that fades and grows in. `size` is the most it may take.
pub fn centred(ctx: &egui::Context, name: &str, size: egui::Vec2, dim: u8, add: impl FnOnce(&mut egui::Ui, &mut bool)) -> State {
    let p = p();
    let id = egui::Id::new(name).with("size");
    // Sized by what it held last frame, so it hugs its content.
    let last: egui::Vec2 = ctx.data(|d| d.get_temp(id)).unwrap_or(size);
    let mut used = last;
    let state = overlay(
        ctx,
        name,
        0.15,
        dim,
        true,
        |screen, t| Rect::from_center_size(screen.center(), last.min(size).min(screen.size() - vec2(24.0, 24.0)) * (0.97 + 0.03 * t)),
        |ui, close| {
            let rect = ui.max_rect();
            ui.painter().add(egui::Shadow { offset: [0, 28], blur: 80, spread: 0, color: Color32::from_black_alpha(153) }.as_shape(rect, 16));
            ui.painter().rect(rect, 16.0, p.bg2, Stroke::new(1.0, p.border_light), StrokeKind::Inside);
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            let inner = ui.scope_builder(egui::UiBuilder::new().max_rect(Rect::from_min_size(rect.min, size.min(ui.ctx().content_rect().size() - vec2(24.0, 24.0)))), |ui| add(ui, close));
            used = inner.response.rect.size();
        },
    );
    if used != last {
        ctx.data_mut(|d| d.insert_temp(id, used));
        ctx.request_repaint();
    }
    state
}

/// A square button of an overlay's header: an icon that lights up, red for Close.
pub fn head_btn(ui: &mut egui::Ui, icon: icons::Icon, size: f32, icon_size: f32, danger: bool, tip: &str) -> egui::Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(size, size), Sense::click());
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    let (fill, ink) = if danger { (alpha(p.danger, 15.0), p.danger) } else { (p.hover, p.text) };
    ui.painter().rect_filled(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, fill, t));
    icons::paint(ui, icon, rect.center(), icon_size, widgets::lerp(p.text2, ink, t));
    response.on_hover_text(tip)
}

/// A bordered text button with an icon, 32 tall (Copy in the code viewer).
pub fn outline_btn(ui: &mut egui::Ui, icon: icons::Icon, label: &str, ink: Option<Color32>) -> egui::Response {
    let p = p();
    let text = widgets::galley(ui, label, theme::font(12.0, W::Medium), Color32::WHITE);
    let (rect, response) = ui.allocate_exact_size(vec2(11.0 + 14.0 + 6.0 + text.size().x + 11.0, 32.0), Sense::click());
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect(rect, 8.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t), Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), StrokeKind::Inside);
    let colour = ink.unwrap_or_else(|| widgets::lerp(p.text2, p.text, t));
    icons::paint(ui, icon, pos2(rect.left() + 11.0 + 7.0, rect.center().y), 14.0, colour);
    ui.painter().galley_with_override_text_color(pos2(rect.left() + 11.0 + 14.0 + 6.0, (rect.center().y - text.size().y / 2.0).round()), text, colour);
    response
}

/// The file extension a language is saved under.
fn extension(language: &str) -> &'static str {
    match language.to_lowercase().as_str() {
        "javascript" | "js" => "js",
        "jsx" => "jsx",
        "typescript" | "ts" => "ts",
        "tsx" => "tsx",
        "python" | "py" => "py",
        "html" => "html",
        "css" => "css",
        "json" => "json",
        "markdown" | "md" => "md",
        "bash" | "sh" | "shell" => "sh",
        "sql" => "sql",
        "yaml" | "yml" => "yml",
        "go" => "go",
        "rust" | "rs" => "rs",
        "java" => "java",
        "c" => "c",
        "cpp" => "cpp",
        "csharp" => "cs",
        "php" => "php",
        "ruby" | "rb" => "rb",
        _ => "txt",
    }
}

/// "My Page!.html" for a title and a language: what Download suggests.
fn file_name(title: &str, language: &str) -> String {
    let slug = regex::Regex::new(r"[^\w.-]+").unwrap().replace_all(title, "-").to_lowercase();
    format!("{}.{}", if slug.is_empty() { "snippet" } else { &slug }, extension(language))
}

pub fn artifact(app: &mut App, ctx: &egui::Context) {
    let Some(shown) = app.artifact.as_mut() else { return };
    let p = p();
    let width = if ctx.content_rect().width() < 640.0 { f32::INFINITY } else { 860.0 };
    let state = slide_over(ctx, "artifact", width, 0.3, p.border_light, |ui, close| {
        let rect = ui.max_rect();
        ui.painter().add(egui::Shadow { offset: [-24, 0], blur: 60, spread: 0, color: Color32::from_black_alpha(115) }.as_shape(rect, 0));
        ui.painter().rect_filled(rect, 0.0, p.bg2);
        ui.painter().vline(rect.left() + 0.5, rect.y_range(), Stroke::new(1.0, p.border_light));
        egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 10)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                let (tile, _) = ui.allocate_exact_size(vec2(32.0, 32.0), Sense::hover());
                ui.painter().rect_filled(tile, 8.0, p.elevated);
                icons::paint(ui, icons::CODE, tile.center(), 15.0, p.accent_light);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    if head_btn(ui, icons::CLOSE, 32.0, 15.0, true, "Close (Esc)").clicked() {
                        *close = true;
                    }
                    if head_btn(ui, icons::DOWNLOAD.stroke(1.7), 32.0, 15.0, false, "Download").clicked() {
                        if let Some(path) = rfd::FileDialog::new().set_file_name(file_name(&shown.title, &shown.language)).save_file() {
                            let _ = std::fs::write(path, &shown.code);
                        }
                    }
                    let fresh = shown.copied.is_some_and(|at| at.elapsed().as_secs() < 2);
                    let copy = if fresh { outline_btn(ui, icons::CHECK_THIN, "Copied", Some(p.success)) } else { outline_btn(ui, icons::COPY_SMALL.stroke(1.7), "Copy", None) };
                    if copy.clicked() {
                        ui.ctx().copy_text(shown.code.clone());
                        shown.copied = Some(Instant::now());
                    }
                    ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                        ui.add(egui::Label::new(widgets::lines(shown.title.as_str(), 14.0, 20.0, W::Semibold, p.text)).truncate().selectable(false));
                        let language = if shown.language.is_empty() { "text" } else { &shown.language };
                        ui.add(egui::Label::new(widgets::lines(format!("{language} · {} lines", shown.code.split('\n').count()), 11.0, 16.5, W::Regular, p.muted)).selectable(false));
                    });
                });
            });
        });
        widgets::rule(ui);
        egui::ScrollArea::both().id_salt("artifact-code").auto_shrink(false).show(ui, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 14)).show(ui, |ui| {
                // ponytail: the whole file is one label. Draw only the visible rows if huge files stutter.
                let mut job = egui::text::LayoutJob::simple(shown.code.replace('\t', "  "), theme::mono(13.0), p.text, f32::INFINITY);
                job.sections[0].format.line_height = Some(21.125);
                ui.add(egui::Label::new(job).selectable(true).extend());
            });
        });
    });
    if state == State::Gone {
        app.artifact = None;
    }
}

pub fn lightbox(app: &mut App, ctx: &egui::Context) {
    let Some((name, uri)) = app.lightbox.clone() else { return };
    let p = p();
    let screen = ctx.content_rect().size();
    let state = centred(ctx, "lightbox", screen, 191, |ui, close| {
        // The box is as wide as the picture, so its size has to be known before the header is laid out.
        let most = vec2(screen.x - 64.0, screen.y - 128.0);
        let picture = egui::Image::new(uri.as_str()).max_size(most).corner_radius(8);
        let size = picture.load_and_calc_size(ui, most).unwrap_or(vec2(320.0, 240.0));
        ui.set_width((size.x + 16.0).max(260.0));
        egui::Frame::new().inner_margin(egui::Margin::symmetric(14, 10)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 12.0;
                icons::show(ui, icons::PICTURE, 15.0, p.accent_light);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // ponytail: no "OCR text" pane; it needs the vision helper, which is not ported.
                    if head_btn(ui, icons::CLOSE, 32.0, 15.0, true, "Close (Esc)").clicked() {
                        *close = true;
                    }
                    ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                        ui.add(egui::Label::new(widgets::lines(name.as_str(), 14.0, 20.0, W::Medium, p.text)).truncate().selectable(false));
                    });
                });
            });
        });
        widgets::rule(ui);
        egui::Frame::new().fill(Color32::from_rgb(0x0e, 0x0d, 0x0c)).inner_margin(egui::Margin::same(8)).corner_radius(egui::CornerRadius { nw: 0, ne: 0, sw: 15, se: 15 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.vertical_centered(|ui| ui.add(picture));
        });
    });
    if state == State::Gone {
        app.lightbox = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names() {
        assert_eq!(file_name("My Page!", "html"), "my-page-.html");
        assert_eq!(file_name("", "TypeScript"), "snippet.ts");
        assert_eq!(file_name("notes.v2", "weird"), "notes.v2.txt");
    }
}
