//! Form controls the web's dialogs share: the recipes of SettingsModal.tsx,
//! PluginsModal.tsx and their sub-panels, drawn by hand so sizes and colours match.

use super::icons::{self, Icon};
use super::theme::{self, W, alpha, p};
use super::{markdown, widgets};
use eframe::egui::{self, Color32, CursorIcon, Rect, Response, Sense, Stroke, StrokeKind, Ui, pos2, vec2};

// ------------------------------------------------------------------ text

/// A piece of inline text.
#[derive(Clone, Copy)]
pub enum Seg<'a> {
    T(&'a str),
    /// (label, address)
    Link(&'a str, &'a str),
    Code(&'a str),
    /// Semibold.
    B(&'a str),
    /// In another colour.
    C(&'a str, Color32),
}

/// Wrapping text with links, inline code and bold in it. Links open in the browser.
pub fn rich(ui: &mut Ui, size: f32, line: f32, color: Color32, segs: &[Seg]) -> Response {
    let p = p();
    let mut job = egui::text::LayoutJob::default();
    job.wrap.max_width = ui.available_width();
    let format = |font, color| egui::TextFormat { font_id: font, color, line_height: Some(line), ..Default::default() };
    let (mut links, mut codes) = (Vec::new(), Vec::new());
    let (mut at, mut after_code) = (0, false);
    for seg in segs {
        let (text, style, code) = match *seg {
            Seg::T(t) => (t, format(theme::font(size, W::Regular), color), false),
            Seg::B(t) => (t, format(theme::font(size, W::Semibold), color), false),
            Seg::C(t, c) => (t, format(theme::font(size, W::Regular), c), false),
            Seg::Link(t, _) => (t, format(theme::font(size, W::Regular), p.accent_light), false),
            Seg::Code(t) => (t, format(theme::mono(11.0), color), true),
        };
        let len = text.chars().count();
        match *seg {
            Seg::Link(_, url) => links.push((at..at + len, url)),
            Seg::Code(_) => codes.push(at..at + len),
            _ => {}
        }
        job.append(text, if code { 4.0 } else { 0.0 } + if after_code { 4.0 } else { 0.0 }, style);
        after_code = code;
        at += len;
    }
    let galley = ui.painter().layout_job(job);
    // Reserved now so the code boxes end up under the text.
    let under = ui.painter().add(egui::Shape::Noop);
    let response = ui.add(egui::Label::new(galley.clone()).selectable(false).sense(if links.is_empty() { Sense::hover() } else { Sense::click() }));
    let origin = response.rect.min.to_vec2();
    let row = galley.rows.first().map_or(line, |r| r.row.size.y);
    let boxes = markdown::runs(&galley, &codes).into_iter().map(|[left, right, top, _]| {
        let rect = Rect::from_x_y_ranges(left - 4.0..=right + 4.0, top + row / 2.0 - 9.0..=top + row / 2.0 + 9.0);
        egui::Shape::rect_filled(rect.translate(origin), 4.0, p.bg3)
    });
    let ranges: Vec<_> = links.iter().map(|(range, _)| range.clone()).collect();
    let lines = markdown::runs(&galley, &ranges).into_iter().map(|[left, right, _, baseline]| {
        let y = (baseline + 2.0).round() + 0.5;
        egui::Shape::line_segment([pos2(left, y) + origin, pos2(right, y) + origin], Stroke::new(1.0, p.accent_light))
    });
    ui.painter().set(under, egui::Shape::Vec(boxes.chain(lines).collect()));

    if let Some(at) = response.hover_pos() {
        let local = at - response.rect.min;
        let cursor = galley.cursor_from_pos(local);
        let caret = galley.pos_from_cursor(cursor);
        // The nearest caret can be far from the pointer (past a line's end): only a hit on the glyphs counts.
        if (caret.center().x - local.x).abs() <= size && local.y >= caret.top() && local.y <= caret.bottom() {
            if let Some((_, url)) = links.iter().find(|(range, _)| range.contains(&cursor.index.0)) {
                ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                if response.clicked() {
                    ui.ctx().open_url(egui::OpenUrl::new_tab(*url));
                }
            }
        }
    }
    response
}

/// One style of wrapping text.
pub fn para(ui: &mut Ui, text: &str, size: f32, line: f32, weight: W, color: Color32) -> Response {
    ui.add(egui::Label::new(widgets::lines(text, size, line, weight, color)).wrap().selectable(false))
}

/// One line, cut with an ellipsis when the room runs out.
pub fn line(ui: &mut Ui, text: &str, size: f32, line: f32, weight: W, color: Color32) -> Response {
    ui.add(egui::Label::new(widgets::lines(text, size, line, weight, color)).truncate().selectable(false))
}

/// FIELD-LABEL: 14/20 semibold, an optional muted hint after it.
pub fn label(ui: &mut Ui, text: &str, hint: &str) {
    let p = p();
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        ui.add(egui::Label::new(widgets::lines(text, 14.0, 20.0, W::Semibold, p.text)).selectable(false));
        if !hint.is_empty() {
            ui.add(egui::Label::new(widgets::lines(hint, 12.0, 20.0, W::Regular, p.muted)).selectable(false));
        }
    });
}

/// HELPER outside the Keys tab: 12px, relaxed, secondary.
pub fn helper(ui: &mut Ui, segs: &[Seg]) {
    rich(ui, 12.0, 19.5, p().text2, segs);
}

/// The small muted note under a control: 11px, relaxed.
pub fn note(ui: &mut Ui, text: &str) {
    para(ui, text, 11.0, 17.875, W::Regular, p().muted);
}

/// KEY-SAVED: a green dot and "Key saved".
pub fn key_saved(ui: &mut Ui) {
    let p = p();
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let (dot, _) = ui.allocate_exact_size(vec2(6.0, 16.0), Sense::hover());
        ui.painter().circle_filled(dot.center(), 3.0, p.success);
        ui.add(egui::Label::new(widgets::lines("Key saved", 12.0, 16.0, W::Regular, p.success)).selectable(false));
    });
}

// ------------------------------------------------------------------ inputs

/// A text box. The stock one is the Settings INPUT: 42 tall, 12 radius, on the tertiary surface.
#[derive(Clone, Copy)]
pub struct Input<'a> {
    pub hint: &'a str,
    pub password: bool,
    pub mono: bool,
    /// Lines of a multi-line box. 0 is a single line.
    pub rows: usize,
    pub size: f32,
    pub line: f32,
    pub pad: (i8, i8),
    pub radius: u8,
    pub fill: Color32,
    /// Border while focused, and the 1px ring outside it (transparent for none).
    pub focus: Color32,
    pub ring: Color32,
    pub center: bool,
    pub limit: usize,
}

impl<'a> Input<'a> {
    pub fn new(hint: &'a str) -> Input<'a> {
        let p = p();
        Input { hint, password: false, mono: false, rows: 0, size: 14.0, line: 20.0, pad: (16, 10), radius: 12, fill: p.bg3, focus: alpha(p.accent, 50.0), ring: alpha(p.accent, 25.0), center: false, limit: 0 }
    }
    /// With the eye that shows the text.
    pub fn password(self) -> Self {
        Input { password: true, ..self }
    }
    pub fn mono(self) -> Self {
        Input { mono: true, ..self }
    }
    /// The Tavily and Exa boxes focus in the search colour.
    pub fn search(self) -> Self {
        Input { focus: alpha(p().search, 50.0), ring: alpha(p().search, 25.0), ..self }
    }
    pub fn rows(self, rows: usize) -> Self {
        Input { rows, ..self }
    }
    pub fn text(self, size: f32, line: f32) -> Self {
        Input { size, line, ..self }
    }
    pub fn pad(self, x: i8, y: i8) -> Self {
        Input { pad: (x, y), ..self }
    }
    pub fn radius(self, radius: u8) -> Self {
        Input { radius, ..self }
    }
    pub fn fill(self, fill: Color32) -> Self {
        Input { fill, ..self }
    }
    /// A plain focus border, no ring.
    pub fn focus(self, focus: Color32) -> Self {
        Input { focus, ring: Color32::TRANSPARENT, ..self }
    }
    pub fn limit(self, limit: usize) -> Self {
        Input { limit, ..self }
    }

    pub fn show(self, ui: &mut Ui, id: impl std::hash::Hash + std::fmt::Debug, value: &mut String) -> Response {
        let p = p();
        let id = ui.make_persistent_id(id);
        let focused = ui.memory(|m| m.has_focus(id));
        let shown_id = id.with("shown");
        let mut shown = self.password && ui.data(|d| d.get_temp(shown_id)).unwrap_or(false);
        let frame = egui::Frame::new().fill(self.fill).stroke(Stroke::new(1.0, if focused { self.focus } else { p.border })).corner_radius(self.radius).inner_margin(egui::Margin::symmetric(self.pad.0, self.pad.1));
        let out = frame.show(ui, |ui| {
            let font = if self.mono { theme::mono(self.size) } else { theme::font(self.size, W::Regular) };
            let edit = if self.rows > 0 { egui::TextEdit::multiline(value).desired_rows(self.rows) } else { egui::TextEdit::singleline(value) };
            let edit = edit
                .id(id)
                .password(self.password && !shown)
                .hint_text(widgets::text(self.hint, self.size, W::Regular, p.muted))
                .font(font)
                .text_color(p.text)
                .desired_width(f32::INFINITY)
                .min_size(vec2(0.0, self.line))
                .vertical_align(if self.rows > 0 { egui::Align::Min } else { egui::Align::Center })
                .horizontal_align(if self.center { egui::Align::Center } else { egui::Align::Min })
                .frame(egui::Frame::NONE)
                .margin(egui::Margin::ZERO);
            ui.add(if self.limit > 0 { edit.char_limit(self.limit) } else { edit })
        });
        let rect = out.response.rect;
        if focused && self.ring != Color32::TRANSPARENT {
            ui.painter().rect_stroke(rect, self.radius, Stroke::new(1.0, self.ring), StrokeKind::Outside);
        }
        if self.password {
            let at = Rect::from_center_size(pos2(rect.right() - 12.0 - 8.0, rect.center().y), vec2(16.0, 16.0));
            let eye = ui.interact(at.expand(3.0), id.with("eye"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
            let t = widgets::fade(ui, eye.id, eye.hovered());
            icons::paint(ui, if shown { icons::EYE_OFF } else { icons::EYE }, at.center(), 16.0, widgets::lerp(p.muted, p.text2, t));
            if eye.clicked() {
                shown = !shown;
                ui.data_mut(|d| d.insert_temp(shown_id, shown));
            }
        }
        out.inner
    }
}

/// A native `<select>` dressed as an INPUT: the chosen option and a chevron; the list drops below.
pub fn select(ui: &mut Ui, id: impl std::hash::Hash + std::fmt::Debug, options: &[String], chosen: &mut usize, size: f32, pad: (f32, f32), radius: f32) -> bool {
    let p = p();
    let height = (size * 1.43).round() + pad.1 * 2.0 + 2.0;
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), height), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    ui.painter().rect(rect, radius, p.bg3, Stroke::new(1.0, p.border), StrokeKind::Inside);
    let shown = options.get(*chosen).map_or("", String::as_str);
    let text = widgets::clipped(ui, shown, theme::font(size, W::Regular), p.text, rect.width() - pad.0 * 2.0 - 18.0);
    widgets::text_at(ui, rect.left() + pad.0, rect.center().y, text);
    icons::paint(ui, icons::CHEVRON_DOWN, pos2(rect.right() - pad.0 - 4.0, rect.center().y), 12.0, p.text2);
    let mut changed = false;
    egui::Popup::menu(&response).id(ui.make_persistent_id(id)).width(rect.width()).frame(widgets::popover_frame(10).inner_margin(egui::Margin::same(4))).show(|ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 2.0);
        egui::ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
            for (i, option) in options.iter().enumerate() {
                let (row, hit) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), Sense::click());
                let t = widgets::fade(ui, hit.id, hit.hovered() || i == *chosen);
                ui.painter().rect_filled(row, 6.0, widgets::lerp(Color32::TRANSPARENT, p.hover, t));
                let text = widgets::clipped(ui, option, theme::font(13.0, W::Regular), widgets::lerp(p.text2, p.text, t), row.width() - 16.0);
                widgets::text_at(ui, row.left() + 8.0, row.center().y, text);
                if hit.clicked() {
                    changed = *chosen != i;
                    *chosen = i;
                    ui.close();
                }
            }
        });
    });
    changed
}

/// A native range input: a 6px track and an accent thumb. True while it changed.
pub fn slider(ui: &mut Ui, value: &mut u32, min: u32, max: u32) -> bool {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 16.0), Sense::click_and_drag());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let (left, right) = (rect.left() + 8.0, rect.right() - 8.0);
    let before = *value;
    if let Some(at) = response.interact_pointer_pos().filter(|_| response.is_pointer_button_down_on()) {
        let t = ((at.x - left) / (right - left)).clamp(0.0, 1.0);
        *value = min + (t * (max - min) as f32).round() as u32;
    }
    ui.painter().rect_filled(Rect::from_center_size(rect.center(), vec2(rect.width(), 6.0)), 3.0, p.bg3);
    let t = (*value).clamp(min, max).saturating_sub(min) as f32 / (max - min).max(1) as f32;
    ui.painter().circle_filled(pos2(left + (right - left) * t, rect.center().y), 8.0, p.accent);
    *value != before
}

// ------------------------------------------------------------------ switches

/// The four switches the web app draws. All are 36 by 20 with a knob that slides 16.
#[derive(Clone, Copy, PartialEq)]
pub enum Switch {
    /// Tavily and Exa: green when on, a bordered well when off.
    A,
    /// Lessons and MCP servers: accent when on, the border colour when off.
    B,
    /// Plugins: a raised track with a small grey knob that turns white.
    D,
}

/// Paints the switch and reports a click; the caller flips its own value.
pub fn switch(ui: &mut Ui, kind: Switch, on: bool) -> Response {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(vec2(36.0, 20.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    response.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, true, on, ""));
    let t = widgets::fade(ui, response.id.with("on"), on);
    let (off_fill, on_fill, off_border, on_border) = match kind {
        Switch::A => (p.bg3, alpha(p.success, 70.0), p.border, Color32::TRANSPARENT),
        Switch::B => (p.border, p.accent, Color32::TRANSPARENT, Color32::TRANSPARENT),
        Switch::D => (p.elevated, p.accent, p.border, p.accent),
    };
    ui.painter().rect(rect, 10.0, widgets::lerp(off_fill, on_fill, t), Stroke::new(1.0, widgets::lerp(off_border, on_border, t)), StrokeKind::Inside);
    let (start, radius, knob) = match kind {
        Switch::A => (11.0, 8.0, Color32::WHITE),
        Switch::B => (10.0, 8.0, Color32::WHITE),
        Switch::D => (10.0, 7.0, widgets::lerp(p.muted, Color32::WHITE, t)),
    };
    ui.painter().circle_filled(pos2(rect.left() + start + 16.0 * t, rect.center().y), radius, knob);
    response
}

// ------------------------------------------------------------------ choices

/// CHOICE-BUTTON: the box of a pickable card. Returns where it is, the click, and the ink for its text.
pub fn choice(ui: &mut Ui, size: egui::Vec2, selected: bool) -> (Rect, Response, Color32) {
    let p = p();
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    let (fill, border, ink) = if selected { (alpha(p.accent, 15.0), alpha(p.accent, 30.0), p.accent_light) } else { (p.bg3, widgets::lerp(p.border, p.border_light, t), p.text2) };
    ui.painter().rect(rect, 12.0, fill, Stroke::new(1.0, border), StrokeKind::Inside);
    (rect, response, ink)
}

/// A choice with one centred label (effort, spending limit).
pub fn choice_text(ui: &mut Ui, size: egui::Vec2, selected: bool, label: &str) -> Response {
    let (rect, response, ink) = choice(ui, size, selected);
    let text = widgets::galley(ui, label, theme::font(12.0, W::Medium), ink);
    widgets::text_at(ui, rect.center().x - text.size().x / 2.0, rect.center().y, text);
    response
}

/// `.option-item` with a title, an optional badge after it, and a line of small print.
pub fn option_item(ui: &mut Ui, active: bool, title: &str, badge: &str, blurb: &str) -> Response {
    let p = p();
    let width = ui.available_width();
    let small = {
        let mut job = egui::text::LayoutJob::simple(blurb.to_string(), theme::font(11.0, W::Regular), p.muted, width - 24.0);
        job.sections[0].format.line_height = Some(16.0);
        ui.painter().layout_job(job)
    };
    let (rect, response) = ui.allocate_exact_size(vec2(width, 10.0 + 20.0 + 2.0 + small.size().y + 10.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect_filled(rect, 8.0, if active { alpha(p.accent, 8.0) } else { widgets::lerp(Color32::TRANSPARENT, p.hover, t) });
    let name = widgets::galley(ui, title, theme::font(13.0, W::Medium), if active { p.accent_light } else { p.text });
    widgets::text_at(ui, rect.left() + 12.0, rect.top() + 20.0, name);
    if !badge.is_empty() {
        let badge = widgets::galley(ui, badge, theme::font(11.0, W::Regular), p.accent_light);
        widgets::text_at(ui, rect.right() - 12.0 - badge.size().x, rect.top() + 20.0, badge);
    }
    ui.painter().galley(pos2(rect.left() + 12.0, rect.top() + 32.0), small, p.muted);
    response
}

// ------------------------------------------------------------------ buttons

/// A text button. The three constructors are the three looks the dialogs use; the rest tunes size.
#[derive(Clone, Copy)]
pub struct Btn<'a> {
    pub label: &'a str,
    pub size: f32,
    pub line: f32,
    pub weight: W,
    pub pad: (f32, f32),
    pub radius: f32,
    pub ink: Color32,
    pub ink_hover: Color32,
    pub fill: Color32,
    pub fill_hover: Color32,
    pub border: Color32,
    pub border_hover: Color32,
    pub enabled: bool,
    /// Opacity when disabled.
    pub dim: f32,
    pub mono: bool,
    pub icon: Option<(Icon, f32)>,
    /// Stretch to this width, label centred. 0 hugs the label.
    pub width: f32,
    pub dashed: bool,
}

impl<'a> Btn<'a> {
    fn base(label: &'a str) -> Btn<'a> {
        let p = p();
        Btn { label, size: 12.0, line: 16.0, weight: W::Medium, pad: (10.0, 6.0), radius: 8.0, ink: p.text2, ink_hover: p.text, fill: Color32::TRANSPARENT, fill_hover: Color32::TRANSPARENT, border: Color32::TRANSPARENT, border_hover: Color32::TRANSPARENT, enabled: true, dim: 0.4, mono: false, icon: None, width: 0.0, dashed: false }
    }
    /// Bordered: `border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary`.
    pub fn outline(label: &'a str) -> Btn<'a> {
        let p = p();
        Btn { fill_hover: p.hover, border: p.border, border_hover: p.border, ..Btn::base(label) }
    }
    /// Filled with the accent, white ink.
    pub fn accent(label: &'a str) -> Btn<'a> {
        let p = p();
        Btn { ink: Color32::WHITE, ink_hover: Color32::WHITE, fill: p.accent, fill_hover: p.accent_light, ..Btn::base(label) }
    }
    /// No box: muted text that lights up.
    pub fn ghost(label: &'a str) -> Btn<'a> {
        let p = p();
        Btn { ink: p.muted, ink_hover: p.text, weight: W::Regular, ..Btn::base(label) }
    }
    pub fn text(self, size: f32, line: f32) -> Self {
        Btn { size, line, ..self }
    }
    pub fn weight(self, weight: W) -> Self {
        Btn { weight, ..self }
    }
    pub fn pad(self, x: f32, y: f32) -> Self {
        Btn { pad: (x, y), ..self }
    }
    pub fn radius(self, radius: f32) -> Self {
        Btn { radius, ..self }
    }
    pub fn ink(self, ink: Color32, hover: Color32) -> Self {
        Btn { ink, ink_hover: hover, ..self }
    }
    pub fn fill(self, fill: Color32, hover: Color32) -> Self {
        Btn { fill, fill_hover: hover, ..self }
    }
    pub fn border(self, border: Color32, hover: Color32) -> Self {
        Btn { border, border_hover: hover, ..self }
    }
    pub fn enabled(self, enabled: bool) -> Self {
        Btn { enabled, ..self }
    }
    pub fn dim(self, dim: f32) -> Self {
        Btn { dim, ..self }
    }
    pub fn icon(self, icon: Icon, size: f32) -> Self {
        Btn { icon: Some((icon, size)), ..self }
    }
    pub fn width(self, width: f32) -> Self {
        Btn { width, ..self }
    }
    pub fn dashed(self) -> Self {
        Btn { dashed: true, ..self }
    }

    pub fn show(self, ui: &mut Ui) -> Response {
        let font = if self.mono { theme::mono(self.size) } else { theme::font(self.size, self.weight) };
        let text = widgets::galley(ui, self.label, font, Color32::WHITE);
        let lead = self.icon.map_or(0.0, |(_, size)| size + 6.0);
        let edge = if self.border == Color32::TRANSPARENT && self.border_hover == Color32::TRANSPARENT { 0.0 } else { 2.0 };
        let hug = text.size().x + lead + self.pad.0 * 2.0 + edge;
        let (rect, response) = ui.allocate_exact_size(vec2(self.width.max(hug), self.line + self.pad.1 * 2.0 + edge), if self.enabled { Sense::click() } else { Sense::hover() });
        let response = response.on_hover_cursor(if self.enabled { CursorIcon::PointingHand } else { CursorIcon::NotAllowed });
        if !ui.is_rect_visible(rect) {
            return response;
        }
        let t = widgets::fade(ui, response.id, response.hovered() && self.enabled);
        let dim = if self.enabled { 1.0 } else { self.dim };
        let border = widgets::lerp(self.border, self.border_hover, t).gamma_multiply(dim);
        ui.painter().rect(rect, self.radius, widgets::lerp(self.fill, self.fill_hover, t).gamma_multiply(dim), Stroke::new(1.0, if self.dashed { Color32::TRANSPARENT } else { border }), StrokeKind::Inside);
        if self.dashed {
            // One closed path round the rounded box, so the corners are dashed too.
            let (r, radius) = (rect.shrink(0.5), self.radius - 0.5);
            let mut path = Vec::with_capacity(33);
            for (corner, centre) in [r.left_top() + vec2(radius, radius), r.right_top() + vec2(-radius, radius), r.right_bottom() - vec2(radius, radius), r.left_bottom() + vec2(radius, -radius)].into_iter().enumerate() {
                for step in 0..=7 {
                    let angle = std::f32::consts::PI * (1.0 + (corner as f32 + step as f32 / 7.0) / 2.0);
                    path.push(centre + radius * vec2(angle.cos(), angle.sin()));
                }
            }
            path.push(path[0]);
            ui.painter().extend(egui::Shape::dashed_line(&path, Stroke::new(1.0, border), 3.0, 3.0));
        }
        let ink = widgets::lerp(self.ink, self.ink_hover, t).gamma_multiply(dim);
        let mut x = rect.center().x - (text.size().x + lead) / 2.0;
        if let Some((icon, size)) = self.icon {
            icons::paint(ui, icon, pos2(x + size / 2.0, rect.center().y), size, ink);
            x += lead;
        }
        ui.painter().galley_with_override_text_color(pos2(x, (rect.center().y - text.size().y / 2.0).round()), text, ink);
        response
    }
}

/// A native `<details>`: a summary line with a small triangle that opens what is under it.
pub fn details(ui: &mut Ui, id: impl std::hash::Hash + std::fmt::Debug, summary: &str, size: f32, color: Color32, add: impl FnOnce(&mut Ui)) {
    let id = ui.make_persistent_id(id);
    let mut open: bool = ui.data(|d| d.get_temp(id)).unwrap_or(false);
    let text = widgets::galley(ui, summary, theme::font(size, W::Medium), color);
    let (rect, response) = ui.allocate_exact_size(vec2(text.size().x + 14.0, (size * 1.5).round()), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let c = pos2(rect.left() + 4.0, rect.center().y);
    let points = if open { vec![c + vec2(-3.5, -2.0), c + vec2(3.5, -2.0), c + vec2(0.0, 3.0)] } else { vec![c + vec2(-2.0, -3.5), c + vec2(3.0, 0.0), c + vec2(-2.0, 3.5)] };
    ui.painter().add(egui::Shape::convex_polygon(points, color, Stroke::NONE));
    widgets::text_at(ui, rect.left() + 14.0, rect.center().y, text);
    if response.clicked() {
        open = !open;
        ui.data_mut(|d| d.insert_temp(id, open));
    }
    if open {
        add(ui);
    }
}

/// A row of things that wraps, with `gap` between them both ways.
pub fn wrap_row(ui: &mut Ui, gap: f32, add: impl FnOnce(&mut Ui)) {
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(gap, gap);
        add(ui);
    });
}

/// Lays `count` equal cells out in `columns` columns with `gap` between them. `cell` gets the index and the cell width.
pub fn grid(ui: &mut Ui, columns: usize, gap: f32, count: usize, mut cell: impl FnMut(&mut Ui, usize, f32)) {
    let width = ((ui.available_width() - gap * (columns as f32 - 1.0)) / columns as f32).floor();
    for row in 0..count.div_ceil(columns) {
        if row > 0 {
            ui.add_space(gap);
        }
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = gap;
            for i in row * columns..((row + 1) * columns).min(count) {
                cell(ui, i, width);
            }
        });
    }
}

/// A coloured box with a border and its own padding, as wide as the room it is given.
pub fn boxed<R>(ui: &mut Ui, fill: Color32, border: Color32, radius: u8, pad: (i8, i8), add: impl FnOnce(&mut Ui) -> R) -> R {
    egui::Frame::new()
        .fill(fill)
        .stroke(Stroke::new(1.0, border))
        .corner_radius(radius)
        .inner_margin(egui::Margin::symmetric(pad.0, pad.1))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            add(ui)
        })
        .inner
}
