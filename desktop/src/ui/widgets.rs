//! The web app's controls (.chip, .icon-btn, .send-btn, .conv-row ... in
//! src/app/globals.css), painted by hand so sizes, radii and colours match.

use super::icons::{self, Icon};
use super::theme::{self, W, alpha, p};
use eframe::egui::{self, Color32, CornerRadius, CursorIcon, FontId, Galley, Rect, Response, RichText, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use std::sync::Arc;

/// CSS `transition: 0.15s ease`: how far a hover (or any state) has faded in, 0..1.
pub fn fade(ui: &Ui, id: egui::Id, on: bool) -> f32 {
    ui.ctx().animate_bool_with_time(id, on, 0.15)
}

pub fn lerp(a: Color32, b: Color32, t: f32) -> Color32 {
    a.lerp_to_gamma(b, t)
}

pub fn galley(ui: &Ui, text: &str, font: FontId, color: Color32) -> Arc<Galley> {
    ui.painter().layout_no_wrap(text.to_string(), font, color)
}

/// One line, cut with an ellipsis at `width` (CSS `truncate`).
pub fn clipped(ui: &Ui, text: &str, font: FontId, color: Color32, width: f32) -> Arc<Galley> {
    let mut job = egui::text::LayoutJob::simple_singleline(text.to_string(), font, color);
    job.wrap = egui::text::TextWrapping { max_width: width.max(0.0), max_rows: 1, break_anywhere: true, overflow_character: Some('…') };
    ui.painter().layout_job(job)
}

/// Paints a one-line galley vertically centred on `y`, starting at `x`. Returns its width.
pub fn text_at(ui: &Ui, x: f32, y: f32, galley: Arc<Galley>) -> f32 {
    let size = galley.size();
    ui.painter().galley(pos2(x, (y - size.y / 2.0).round()), galley, Color32::PLACEHOLDER);
    size.x
}

/// `text_at` for words worth copying: they can be selected. True when they were clicked rather than dragged
/// over, so that a row drawn under them can act as if the click had reached it.
pub fn text_at_copy(ui: &mut Ui, x: f32, y: f32, galley: Arc<Galley>) -> (f32, bool) {
    let size = galley.size();
    let rect = egui::Rect::from_min_size(pos2(x, (y - size.y / 2.0).round()), size);
    let clicked = ui.new_child(egui::UiBuilder::new().max_rect(rect)).add(egui::Label::new(galley).selectable(true)).clicked();
    (size.x, clicked)
}

/// Text in the app's sans face.
pub fn text(s: impl Into<String>, size: f32, weight: W, color: Color32) -> RichText {
    RichText::new(s).font(theme::font(size, weight)).color(color)
}

/// Text with a CSS-style line height (`leading-5` is 20).
pub fn lines(s: impl Into<String>, size: f32, line_height: f32, weight: W, color: Color32) -> RichText {
    text(s, size, weight, color).line_height(Some(line_height))
}

fn clickable(ui: &mut Ui, size: egui::Vec2) -> (Rect, Response) {
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    (rect, response.on_hover_cursor(CursorIcon::PointingHand))
}

fn boxed(ui: &Ui, rect: Rect, radius: f32, fill: Color32, border: Color32) {
    ui.painter().rect(rect, CornerRadius::same(radius as u8), fill, Stroke::new(1.0, border), StrokeKind::Inside);
}

// ------------------------------------------------------------------ .chip

/// A composer control: 32 high, 8 radius, 13px medium.
#[derive(Default)]
pub struct Chip<'a> {
    pub icon: Option<Icon>,
    /// A progress ring in place of the icon: (percent, colour).
    pub ring: Option<(f32, Color32)>,
    pub text: &'a str,
    pub active: bool,
    pub open: bool,
    pub chevron: bool,
    /// A small status dot after the text.
    pub dot: Option<Color32>,
    /// Cuts the text with an ellipsis past this width. 0 means no limit.
    pub max_text: f32,
    /// Horizontal padding. 0 means the stock 10.
    pub pad: f32,
}

impl Chip<'_> {
    pub fn show(self, ui: &mut Ui) -> Response {
        let p = p();
        let pad = if self.pad > 0.0 { self.pad } else { 10.0 };
        let font = theme::font(13.0, W::Medium);
        // Measured in a neutral colour; repainted in the state colour below.
        let label = (!self.text.is_empty()).then(|| if self.max_text > 0.0 { clipped(ui, self.text, font.clone(), p.text2, self.max_text) } else { galley(ui, self.text, font.clone(), p.text2) });

        let lead = if self.ring.is_some() { 16.0 } else if self.icon.is_some() { 14.0 } else { 0.0 };
        let mut parts: Vec<f32> = Vec::new();
        if lead > 0.0 {
            parts.push(lead);
        }
        if let Some(g) = &label {
            parts.push(g.size().x);
        }
        if self.dot.is_some() {
            parts.push(8.0);
        }
        if self.chevron {
            parts.push(11.0);
        }
        let content: f32 = parts.iter().sum::<f32>() + 6.0 * parts.len().saturating_sub(1) as f32;
        let (rect, response) = clickable(ui, vec2(content + pad * 2.0, 32.0));
        if !ui.is_rect_visible(rect) {
            return response;
        }

        let t = fade(ui, response.id, response.hovered() || self.open);
        let (fg, bg, border) = if self.active {
            (p.accent_light, lerp(alpha(p.accent, 10.0), alpha(p.accent, 16.0), t), lerp(alpha(p.accent, 32.0), alpha(p.accent, 44.0), t))
        } else {
            (lerp(p.text2, p.text, t), lerp(Color32::TRANSPARENT, p.hover, t), lerp(p.border, p.border_light, t))
        };
        boxed(ui, rect, 8.0, bg, border);

        let (mut x, y) = (rect.left() + pad, rect.center().y);
        if let Some((pct, colour)) = self.ring {
            ring(ui, pos2(x + 8.0, y), pct, colour);
            x += 16.0 + 6.0;
        } else if let Some(icon) = self.icon {
            icons::paint(ui, icon, pos2(x + 7.0, y), 14.0, fg);
            x += 14.0 + 6.0;
        }
        if let Some(g) = label {
            let job = if self.max_text > 0.0 { clipped(ui, self.text, font, fg, self.max_text) } else { galley(ui, self.text, font, fg) };
            let _ = g;
            x += text_at(ui, x, y, job) + 6.0;
        }
        if let Some(colour) = self.dot {
            ui.painter().circle_filled(pos2(x + 5.0, y), 3.0, colour);
            x += 8.0 + 6.0;
        }
        if self.chevron {
            let icon = if self.open { icons::CHEVRON_UP } else { icons::CHEVRON_DOWN };
            icons::paint(ui, icon, pos2(x + 5.5, y), 11.0, fg.gamma_multiply(0.6));
        }
        response
    }
}

/// The context meter's ring: a 16px circle, 2.2 stroke, filled clockwise from the top.
pub fn ring(ui: &Ui, center: egui::Pos2, pct: f32, colour: Color32) {
    let scale = 16.0 / 18.0;
    let radius = 7.0 * scale;
    let width = 2.2 * scale;
    ui.painter().circle_stroke(center, radius, Stroke::new(width, p().border_light));
    let sweep = (pct / 100.0).clamp(0.0, 1.0) * std::f32::consts::TAU;
    if sweep <= 0.0 {
        return;
    }
    let steps = ((sweep / 0.2).ceil() as usize).max(2);
    let points: Vec<egui::Pos2> = (0..=steps)
        .map(|i| {
            let a = -std::f32::consts::FRAC_PI_2 + sweep * i as f32 / steps as f32;
            center + radius * vec2(a.cos(), a.sin())
        })
        .collect();
    ui.painter().add(egui::Shape::line(points, Stroke::new(width, colour)));
}

// ------------------------------------------------------------------ buttons

/// `.icon-btn`: 34 square, 18px icon.
pub fn icon_btn(ui: &mut Ui, icon: Icon, tip: &str) -> Response {
    let p = p();
    let (rect, response) = clickable(ui, vec2(34.0, 34.0));
    let t = fade(ui, response.id, response.hovered());
    let pressed = if response.is_pointer_button_down_on() { 0.94 } else { 1.0 };
    ui.painter().rect_filled(Rect::from_center_size(rect.center(), rect.size() * pressed), 8.0, lerp(Color32::TRANSPARENT, p.hover, t));
    icons::paint(ui, icon, rect.center(), 18.0 * pressed, lerp(p.text2, p.text, t));
    response.on_hover_text(tip)
}

/// A small square icon button: `size` square, `icon_size` icon, muted until hovered.
pub fn mini_btn(ui: &mut Ui, icon: Icon, size: f32, icon_size: f32, tip: &str) -> Response {
    let p = p();
    let (rect, response) = clickable(ui, vec2(size, size));
    let t = fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, 8.0, lerp(Color32::TRANSPARENT, p.hover, t));
    icons::paint(ui, icon, rect.center(), icon_size, lerp(p.muted, p.text, t));
    if tip.is_empty() { response } else { response.on_hover_text(tip) }
}

#[derive(Clone, Copy, PartialEq)]
pub enum SendKind {
    Send { enabled: bool },
    Stop,
    Note,
}

/// `.send-btn`: the round button at the end of the composer.
pub fn send_btn(ui: &mut Ui, kind: SendKind, tip: &str) -> Response {
    let p = p();
    let enabled = kind != SendKind::Send { enabled: false };
    let (rect, response) = ui.allocate_exact_size(vec2(32.0, 32.0), if enabled { Sense::click() } else { Sense::hover() });
    let response = response.on_hover_cursor(if enabled { CursorIcon::PointingHand } else { CursorIcon::NotAllowed });
    let t = fade(ui, response.id, response.hovered());
    let radius = if response.is_pointer_button_down_on() && enabled { 16.0 * 0.94 } else { 16.0 };
    let painter = ui.painter();
    match kind {
        SendKind::Send { enabled: true } => {
            painter.circle_filled(rect.center(), radius, lerp(p.accent, p.accent_light, t));
            icons::paint(ui, icons::SEND, rect.center(), 16.0, Color32::WHITE);
        }
        SendKind::Send { enabled: false } => {
            painter.circle_filled(rect.center(), radius, p.elevated);
            icons::paint(ui, icons::SEND, rect.center(), 16.0, p.muted);
        }
        SendKind::Stop => {
            painter.circle_filled(rect.center(), radius, p.elevated);
            painter.circle_filled(rect.center(), radius, lerp(Color32::TRANSPARENT, alpha(p.danger, 16.0), t));
            painter.circle_stroke(rect.center(), radius - 0.5, Stroke::new(1.0, alpha(p.danger, 35.0)));
            icons::paint(ui, icons::STOP, rect.center(), 12.0, p.danger);
        }
        SendKind::Note => {
            painter.circle_filled(rect.center(), radius, lerp(theme::mix(p.search, 88.0, Color32::BLACK), p.search, t));
            icons::paint(ui, icons::NOTE, rect.center(), 16.0, Color32::WHITE);
        }
    }
    response.on_hover_text(tip)
}

/// `.btn-primary`: 40 high, 12 radius, accent.
pub fn btn_primary(ui: &mut Ui, icon: Option<Icon>, label: &str) -> Response {
    let p = p();
    let g = galley(ui, label, theme::font(14.0, W::Medium), Color32::WHITE);
    let lead = if icon.is_some() { 16.0 + 8.0 } else { 0.0 };
    let (rect, response) = clickable(ui, vec2(g.size().x + lead + 36.0, 40.0));
    let t = fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, 12.0, lerp(p.accent, p.accent_light, t));
    let mut x = rect.left() + 18.0;
    if let Some(icon) = icon {
        icons::paint(ui, icon, pos2(x + 8.0, rect.center().y), 16.0, Color32::WHITE);
        x += 24.0;
    }
    text_at(ui, x, rect.center().y, g);
    response
}

/// A compact button: `fill` background, 8 radius, 12px medium. Used in bars and dialogs.
pub fn small_btn(ui: &mut Ui, label: &str, fg: Color32, fill: Color32, border: Color32) -> Response {
    let p = p();
    let g = galley(ui, label, theme::font(12.0, W::Medium), fg);
    let (rect, response) = clickable(ui, vec2(g.size().x + 20.0, 26.0));
    let t = fade(ui, response.id, response.hovered());
    let fill = if fill == Color32::TRANSPARENT { lerp(fill, p.hover, t) } else { lerp(fill.gamma_multiply(0.9), fill, t) };
    boxed(ui, rect, 8.0, fill, border);
    text_at(ui, rect.left() + 10.0, rect.center().y, g);
    response
}

/// `.new-chat-btn`: the sidebar's one primary action, full width.
pub fn new_chat_btn(ui: &mut Ui) -> Response {
    let p = p();
    let (rect, response) = clickable(ui, vec2(ui.available_width(), 38.0));
    let t = fade(ui, response.id, response.hovered());
    boxed(ui, rect, 8.0, lerp(p.elevated, p.hover, t), lerp(Color32::TRANSPARENT, p.border_light, t));
    icons::paint(ui, icons::PLUS, pos2(rect.left() + 12.0 + 7.5, rect.center().y), 15.0, lerp(p.text2, p.text, t));
    text_at(ui, rect.left() + 12.0 + 15.0 + 8.0, rect.center().y, galley(ui, "New chat", theme::font(13.5, W::Medium), p.text));
    response
}

/// `.segmented`: one track, equal items, the chosen one raised. Returns the item clicked.
pub fn segmented(ui: &mut Ui, items: &[(&str, usize)], active: usize) -> Option<usize> {
    let p = p();
    let (track, _) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::hover());
    ui.painter().rect_filled(track, 8.0, p.bg3);
    let inner = track.shrink(2.0);
    let width = (inner.width() - 2.0 * (items.len() as f32 - 1.0)) / items.len() as f32;
    let mut clicked = None;
    for (i, (label, count)) in items.iter().enumerate() {
        let rect = Rect::from_min_size(pos2(inner.left() + i as f32 * (width + 2.0), inner.top()), vec2(width, 26.0));
        let response = ui.interact(rect, ui.id().with(("segmented", i)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
        let on = i == active;
        let t = fade(ui, response.id, response.hovered());
        let fg = if on { p.text } else { lerp(p.muted, p.text2, t) };
        if on {
            ui.painter().add(egui::Shadow { offset: [0, 1], blur: 2, spread: 0, color: Color32::from_black_alpha(64) }.as_shape(rect, CornerRadius::same(8)));
            ui.painter().rect_filled(rect, 8.0, p.elevated);
        }
        let name = galley(ui, label, theme::font(12.0, W::Medium), fg);
        let number = (*count > 0).then(|| galley(ui, &count.to_string(), theme::font(12.0, W::Medium), fg.gamma_multiply(0.55)));
        let total = name.size().x + number.as_ref().map_or(0.0, |n| n.size().x + 5.0);
        let mut x = rect.center().x - total / 2.0;
        x += text_at(ui, x, rect.center().y, name) + 5.0;
        if let Some(n) = number {
            text_at(ui, x, rect.center().y, n);
        }
        if response.clicked() {
            clicked = Some(i);
        }
    }
    clicked
}

/// A sidebar footer link: icon, label, full width, 12 radius.
pub fn side_link(ui: &mut Ui, icon: Icon, label: &str, tip: &str) -> Response {
    let p = p();
    let (rect, response) = clickable(ui, vec2(ui.available_width(), 40.0));
    let t = fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, 12.0, lerp(Color32::TRANSPARENT, p.bg3, t));
    let fg = lerp(p.text2, p.text, t);
    icons::paint(ui, icon, pos2(rect.left() + 12.0 + 8.0, rect.center().y), 16.0, fg);
    text_at(ui, rect.left() + 12.0 + 16.0 + 10.0, rect.center().y, galley(ui, label, theme::font(14.0, W::Regular), fg));
    if tip.is_empty() { response } else { response.on_hover_text(tip) }
}

/// A row in a dropdown menu: 14px icon, 13px label.
pub fn menu_item(ui: &mut Ui, icon: Icon, label: &str, danger: bool) -> Response {
    let p = p();
    let (rect, response) = clickable(ui, vec2(ui.available_width(), 32.0));
    let t = fade(ui, response.id, response.hovered());
    let (fg, bg) = if danger { (p.danger, lerp(Color32::TRANSPARENT, alpha(p.danger, 12.0), t)) } else { (lerp(p.text2, p.text, t), lerp(Color32::TRANSPARENT, p.hover, t)) };
    ui.painter().rect_filled(rect, 8.0, bg);
    icons::paint(ui, icon, pos2(rect.left() + 10.0 + 7.0, rect.center().y), 14.0, fg);
    text_at(ui, rect.left() + 10.0 + 14.0 + 10.0, rect.center().y, galley(ui, label, theme::font(13.0, W::Regular), fg));
    response
}

/// `.popover-card` and menus: raised surface, light border, deep shadow.
pub fn popover_frame(radius: u8) -> egui::Frame {
    let p = p();
    egui::Frame::new()
        .fill(p.elevated)
        .stroke(Stroke::new(1.0, p.border_light))
        .corner_radius(CornerRadius::same(radius))
        .shadow(egui::Shadow { offset: [0, 18], blur: 48, spread: 0, color: Color32::from_black_alpha(if p.is_dark() { 128 } else { 50 }) })
}

/// `.popover-close`: the 26px X in a popover header.
pub fn popover_close(ui: &mut Ui) -> Response {
    mini_btn(ui, icons::CLOSE, 26.0, 13.0, "")
}

/// A 1px rule across the available width.
pub fn rule(ui: &mut Ui) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
    ui.painter().rect_filled(rect, 0.0, p().border);
}

/// An on/off switch.
pub fn toggle(ui: &mut Ui, on: &mut bool) -> Response {
    let p = p();
    let (rect, mut response) = clickable(ui, vec2(36.0, 20.0));
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }
    response.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *on, ""));
    if ui.is_rect_visible(rect) {
        let how_on = fade(ui, response.id, *on);
        ui.painter().rect_filled(rect, 10.0, lerp(p.border_light, p.accent, how_on));
        let x = egui::lerp((rect.left() + 10.0)..=(rect.right() - 10.0), how_on);
        ui.painter().circle_filled(pos2(x, rect.center().y), 7.0, Color32::WHITE);
    }
    response
}
