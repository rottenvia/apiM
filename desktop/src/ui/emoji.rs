//! Colour emoji from the Windows system font (Segoe UI Emoji, COLR v1 or v0), rasterised with tiny-skia.
//! egui's own text renderer draws the same glyphs in one colour.

use skrifa::color::{Brush, ColorPainter, ColorStop, CompositeMode, Extend};
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{OutlineGlyphCollection, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::raw::types::{BoundingBox, Point as FontPoint};
use skrifa::{FontRef, GlyphId, MetadataProvider};
use std::sync::OnceLock;
use tiny_skia::{BlendMode, Color, FillRule, GradientStop, LinearGradient, Mask, Paint, Path, PathBuilder, Pixmap};
use tiny_skia::{PixmapPaint, Point, RadialGradient, Rect, Shader, SpreadMode, Transform};

/// Premultiplied RGBA8 pixels of `text` drawn at a font size of `px` pixels (the em box is px x px), as
/// `(width, height, rgba)`, or None when the font is missing or has no colour glyph for the text.
///
/// The image is the box a browser lays the glyph out in: as wide as the advance and as tall as the
/// font's ascent + descent. For Segoe UI Emoji that is about 1.37 px by 1.33 px, because its drawings
/// are a little taller than the em box and would be cut off in a px-tall image. Centre the image on the
/// icon slot and it sits where the browser puts it.
///
/// `ink` is the text colour as straight (not premultiplied) RGBA, used for the palette's "foreground"
/// entry (0xFFFF). Feed the result to `egui::ColorImage::from_rgba_premultiplied`.
pub fn raster(text: &str, px: u32, ink: [u8; 4]) -> Option<(usize, usize, Vec<u8>)> {
    let font = font()?;
    let run = glyphs(&font, text)?;
    let metrics = font.metrics(Size::unscaled(), LocationRef::default());
    if px == 0 || metrics.units_per_em == 0 {
        return None;
    }
    let scale = px as f32 / metrics.units_per_em as f32;
    // The Windows metrics are the ones the drawings fit in, and the ones browsers on Windows use.
    let (ascent, descent) = match font.os2() {
        Ok(os2) => (os2.us_win_ascent() as f32, os2.us_win_descent() as f32),
        Err(_) => (metrics.ascent, -metrics.descent),
    };
    // Whole pixels, as a browser rounds them.
    let baseline = (ascent * scale).round();
    let width = (run.iter().map(|g| g.1).sum::<f32>() * scale).ceil() as u32;
    let height = (baseline + (descent * scale).round()) as u32;
    let mut everything = Mask::new(width, height)?;
    everything.data_mut().fill(255);
    let palettes = font.color_palettes();
    let palette = palettes.get(0);
    let mut painter = Painter {
        outlines: font.outline_glyphs(),
        palette: palette.as_ref().map(|p| p.colors()).unwrap_or_default(),
        ink: Color::from_rgba8(ink[0], ink[1], ink[2], ink[3]),
        size: Rect::from_xywh(0.0, 0.0, width as f32, height as f32)?,
        transforms: Vec::new(),
        clips: vec![everything],
        layers: vec![Pixmap::new(width, height)?],
    };
    let colour = font.color_glyphs();
    let mut x = 0.0;
    for (glyph, advance) in run {
        // Font units with y up, to pixels with y down.
        painter.transforms = vec![Transform::from_row(scale, 0.0, 0.0, -scale, x * scale, baseline)];
        colour.get(glyph)?.paint(LocationRef::default(), &mut painter).ok()?;
        x += advance;
    }
    Some((width as usize, height as usize, painter.layers.into_iter().next()?.take()))
}

/// True when `raster` would succeed for this string. One emoji costs a cmap and a COLR lookup; a
/// sequence is shaped first.
pub fn has(text: &str) -> bool {
    font().is_some_and(|font| glyphs(&font, text).is_some())
}

/// Segoe UI Emoji, read from disk once. None when the file is not there (other systems).
/// Draws `text` as a colour emoji of font size `px` centred on `center`, or as plain text in `ink` when the
/// system font has no colour glyph for it. Returns the width it took. Textures are made once per size.
pub fn paint(ui: &eframe::egui::Ui, text: &str, center: eframe::egui::Pos2, px: f32, ink: eframe::egui::Color32) -> f32 {
    use eframe::egui;
    let text = text.trim();
    let scale = ui.ctx().pixels_per_point();
    let id = egui::Id::new(("emoji", text, (px * scale).round() as u32));
    let known: Option<Option<egui::TextureHandle>> = ui.ctx().data(|d| d.get_temp(id));
    let texture = known.unwrap_or_else(|| {
        let made = raster(text, (px * scale).round() as u32, ink.to_array()).map(|(w, h, rgba)| ui.ctx().load_texture(format!("emoji {text}"), egui::ColorImage::from_rgba_premultiplied([w, h], &rgba), egui::TextureOptions::LINEAR));
        ui.ctx().data_mut(|d| d.insert_temp(id, made.clone()));
        made
    });
    match texture {
        Some(texture) => {
            let size = texture.size_vec2() / scale;
            ui.painter().image(texture.id(), egui::Rect::from_center_size(center, size), egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
            size.x
        }
        None => {
            let glyph = ui.painter().layout_no_wrap(text.to_string(), super::theme::font(px, super::theme::W::Regular), ink);
            let size = glyph.size();
            ui.painter().galley(center - size / 2.0, glyph, ink);
            size.x
        }
    }
}

/// How wide a browser lays one emoji out at font size `px`: Segoe UI Emoji advances 1.373 em.
pub const ADVANCE: f32 = 1.373;

fn font() -> Option<FontRef<'static>> {
    static BYTES: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    let bytes = BYTES.get_or_init(|| {
        let fonts = std::path::Path::new(&std::env::var_os("WINDIR")?).join("Fonts");
        std::fs::read(fonts.join("seguiemj.ttf")).ok()
    });
    FontRef::new(bytes.as_deref()?).ok()
}

/// The glyphs `text` is drawn with and their advances in font units. None unless every one is a colour
/// glyph, so plain letters, digits and flags (which this font draws as two letters) are left to egui.
fn glyphs(font: &FontRef, text: &str) -> Option<Vec<(GlyphId, f32)>> {
    // The "draw as emoji" selector changes nothing in an emoji font, and would hide a single emoji from
    // the cmap lookup.
    let text: String = text.chars().filter(|&c| c != '\u{FE0F}').collect();
    let mut chars = text.chars();
    let run = match (chars.next(), chars.next()) {
        (None, _) => return None,
        (Some(c), None) => {
            let glyph = font.charmap().map(c)?;
            vec![(glyph, font.glyph_metrics(Size::unscaled(), LocationRef::default()).advance_width(glyph)?)]
        }
        // Joined sequences (professions, families, skin tones, keycaps) are ligatures only a shaper finds.
        // ponytail: only the advances are kept. Emoji in this font are never shifted or stacked; carry
        // x_offset/y_offset through if another font is ever loaded here.
        _ => {
            let mut buffer = harfrust::UnicodeBuffer::new();
            // Drops the joiner when the font has no ligature, so the parts are drawn side by side, as a
            // browser does.
            buffer.set_flags(harfrust::BufferFlags::REMOVE_DEFAULT_IGNORABLES);
            buffer.push_str(&text);
            buffer.guess_segment_properties();
            let data = harfrust::ShaperData::new(font);
            let shaped = data.shaper(font).build().shape(buffer, harfrust::ShapeOptions::new());
            let glyphs = shaped.glyph_infos().iter().zip(shaped.glyph_positions());
            glyphs.map(|(info, pos)| (GlyphId::new(info.glyph_id), pos.x_advance as f32)).collect()
        }
    };
    let colour = font.color_glyphs();
    (!run.is_empty() && run.iter().all(|g| colour.get(g.0).is_some())).then_some(run)
}

/// Paints COLR glyphs onto a pixmap: skrifa walks the font's paint tree and calls back into this.
struct Painter<'a> {
    outlines: OutlineGlyphCollection<'a>,
    palette: &'a [skrifa::color::Color],
    ink: Color,
    /// The whole image, in pixels.
    size: Rect,
    /// Font units to pixels for the glyph being painted, then one entry per open transform.
    transforms: Vec<Transform>,
    /// Coverage masks. The last one is everything the open clips have in common.
    clips: Vec<Mask>,
    /// The image, then one pixmap per open layer.
    layers: Vec<Pixmap>,
}

impl Painter<'_> {
    fn transform(&self) -> Transform {
        self.transforms.last().copied().unwrap_or_default()
    }

    /// The outline of a glyph in font units. None for an empty glyph.
    fn path(&self, glyph: GlyphId) -> Option<Path> {
        let mut pen = Pen(PathBuilder::new());
        self.outlines.get(glyph)?.draw(Size::unscaled(), &mut pen).ok()?;
        pen.0.finish()
    }

    /// Narrows the clip to `path`, given in font units. No path means nothing may be drawn.
    fn clip(&mut self, path: Option<Path>) {
        let Some(mut mask) = self.clips.last().cloned() else { return };
        match path {
            Some(path) => mask.intersect_path(&path, FillRule::Winding, true, self.transform()),
            None => mask.clear(),
        }
        self.clips.push(mask);
    }

    /// A palette entry. 0xFFFF, the text colour, is never in the palette, so a missing entry is the ink.
    fn color(&self, index: u16, alpha: f32) -> Color {
        let mut color = match self.palette.get(index as usize) {
            Some(c) => Color::from_rgba8(c.red, c.green, c.blue, c.alpha),
            None => self.ink,
        };
        color.apply_opacity(alpha);
        color
    }

    /// Gradient stops, with their offsets passed through `place`.
    fn stops(&self, stops: &[ColorStop], place: impl Fn(f32) -> f32) -> Vec<GradientStop> {
        stops.iter().map(|s| GradientStop::new(place(s.offset), self.color(s.palette_index, s.alpha))).collect()
    }

    /// A brush as a tiny-skia shader. `transform` takes the brush's own coordinates to those of the path
    /// it will fill.
    fn shader(&self, brush: Brush<'_>, transform: Transform) -> Option<Shader<'static>> {
        let point = |p: FontPoint<f32>| Point::from_xy(p.x, p.y);
        let spread = |extend| match extend {
            Extend::Repeat => SpreadMode::Repeat,
            Extend::Reflect => SpreadMode::Reflect,
            _ => SpreadMode::Pad,
        };
        match brush {
            Brush::Solid { palette_index, alpha } => Some(Shader::SolidColor(self.color(palette_index, alpha))),
            Brush::LinearGradient { p0, p1, color_stops, extend } => {
                LinearGradient::new(point(p0), point(p1), self.stops(color_stops, |t| t), spread(extend), transform)
            }
            Brush::RadialGradient { c0, r0, c1, r1, color_stops, extend } => {
                // tiny-skia's radial gradient always starts at radius 0. For two circles with one centre
                // (all Segoe UI Emoji has, half of them with r0 > 0) that is the same picture with the
                // stops squeezed into r0/r1..1: inside the smaller circle it shows the first colour, which
                // is what "pad" (the only mode the font uses) asks for.
                // ponytail: with two centres r0 is taken as 0, and under repeat/reflect a start radius
                // changes the period. Both need a full two-point conical shader, which tiny-skia 0.11
                // does not have.
                let (from, to) = if c0 == c1 { (r0, r1) } else { (0.0, r1) };
                let radius = from.max(to);
                let mut stops = self.stops(color_stops, |t| (from + t * (to - from)) / radius);
                if from > to {
                    stops.reverse();
                }
                RadialGradient::new(point(c0), point(c1), radius, stops, spread(extend), transform)
            }
            // ponytail: a sweep gradient is painted as its first stop. tiny-skia has no conic shader and
            // Segoe UI Emoji has no sweeps; a font with them needs a per-pixel atan2 fill here.
            Brush::SweepGradient { color_stops, .. } => {
                color_stops.first().map(|s| Shader::SolidColor(self.color(s.palette_index, s.alpha)))
            }
        }
    }

    /// Fills `path` on the top layer, inside the clip.
    fn draw(&mut self, path: &Path, transform: Transform, shader: Option<Shader<'static>>) {
        if let (Some(shader), Some(layer)) = (shader, self.layers.last_mut()) {
            let paint = Paint { shader, ..Paint::default() };
            layer.fill_path(path, &paint, FillRule::Winding, transform, self.clips.last());
        }
    }
}

impl ColorPainter for Painter<'_> {
    fn push_transform(&mut self, t: skrifa::color::Transform) {
        self.transforms.push(self.transform().pre_concat(matrix(t)));
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph: GlyphId) {
        self.clip(self.path(glyph));
    }

    fn push_clip_box(&mut self, b: BoundingBox<f32>) {
        self.clip(Rect::from_ltrb(b.x_min, b.y_min, b.x_max, b.y_max).map(PathBuilder::from_rect));
    }

    fn pop_clip(&mut self) {
        if self.clips.len() > 1 {
            self.clips.pop();
        }
    }

    /// The clip does the shaping here, so the brush covers the whole image.
    fn fill(&mut self, brush: Brush<'_>) {
        self.draw(&PathBuilder::from_rect(self.size), Transform::identity(), self.shader(brush, self.transform()));
    }

    /// The common case, a glyph outline filled with one brush: drawn directly, not through a clip mask.
    fn fill_glyph(&mut self, glyph: GlyphId, brush_transform: Option<skrifa::color::Transform>, brush: Brush<'_>) {
        if let Some(path) = self.path(glyph) {
            let shader = self.shader(brush, brush_transform.map(matrix).unwrap_or_default());
            self.draw(&path, self.transform(), shader);
        }
    }

    fn push_layer(&mut self, _: CompositeMode) {
        self.layers.extend(Pixmap::new(self.size.width() as u32, self.size.height() as u32));
    }

    /// Merges the top layer into the one below. skrifa repeats the mode here, so `push_layer` keeps none.
    fn pop_layer_with_mode(&mut self, mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        if let (Some(top), Some(below)) = (self.layers.pop(), self.layers.last_mut()) {
            let paint = PixmapPaint { blend_mode: blend(mode), ..PixmapPaint::default() };
            below.draw_pixmap(0, 0, top.as_ref(), &paint, Transform::identity(), None);
        }
    }
}

/// Feeds a glyph outline into a tiny-skia path.
struct Pen(PathBuilder);

impl OutlinePen for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.0.quad_to(cx, cy, x, y);
    }
    fn curve_to(&mut self, ax: f32, ay: f32, bx: f32, by: f32, x: f32, y: f32) {
        self.0.cubic_to(ax, ay, bx, by, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

fn matrix(t: skrifa::color::Transform) -> Transform {
    Transform::from_row(t.xx, t.yx, t.xy, t.yy, t.dx, t.dy)
}

/// COLR composite modes line up one to one with tiny-skia's blend modes. An unknown one is a plain overlay.
fn blend(mode: CompositeMode) -> BlendMode {
    use {BlendMode as B, CompositeMode as C};
    match mode {
        C::Clear => B::Clear,
        C::Src => B::Source,
        C::Dest => B::Destination,
        C::DestOver => B::DestinationOver,
        C::SrcIn => B::SourceIn,
        C::DestIn => B::DestinationIn,
        C::SrcOut => B::SourceOut,
        C::DestOut => B::DestinationOut,
        C::SrcAtop => B::SourceAtop,
        C::DestAtop => B::DestinationAtop,
        C::Xor => B::Xor,
        C::Plus => B::Plus,
        C::Screen => B::Screen,
        C::Overlay => B::Overlay,
        C::Darken => B::Darken,
        C::Lighten => B::Lighten,
        C::ColorDodge => B::ColorDodge,
        C::ColorBurn => B::ColorBurn,
        C::HardLight => B::HardLight,
        C::SoftLight => B::SoftLight,
        C::Difference => B::Difference,
        C::Exclusion => B::Exclusion,
        C::Multiply => B::Multiply,
        C::HslHue => B::Hue,
        C::HslSaturation => B::Saturation,
        C::HslColor => B::Color,
        C::HslLuminosity => B::Luminosity,
        _ => B::SourceOver,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How many of twelve 30-degree hue bands hold a real share of the opaque, clearly coloured pixels.
    fn hues(rgba: &[u8]) -> usize {
        let mut bands = [0; 12];
        for p in rgba.as_chunks::<4>().0.iter().filter(|p| p[3] == 255) {
            let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
            let (max, min) = (r.max(g).max(b), r.min(g).min(b));
            if max - min < 64.0 {
                continue; // grey
            }
            let sextant = match max {
                m if m == r => (g - b) / (max - min),
                m if m == g => 2.0 + (b - r) / (max - min),
                _ => 4.0 + (r - g) / (max - min),
            };
            bands[(sextant * 2.0).rem_euclid(12.0) as usize % 12] += 1;
        }
        bands.iter().filter(|&&n| n >= 8).count()
    }

    #[test]
    fn colour_emoji() {
        if font().is_none() {
            return; // no Segoe UI Emoji on this machine
        }
        for emoji in ["🚀", "🎨"] {
            let (w, h, rgba) = raster(emoji, 36, [0, 0, 0, 255]).expect(emoji);
            assert_eq!(rgba.len(), w * h * 4);
            let hues = hues(&rgba);
            assert!(w >= 36 && h >= 36 && hues >= 3, "{emoji}: {w}x{h} with {hues} hues");
        }
        assert!(has("✨") && has("🛠️") && has("👨‍💻") && has("👍🏽"));
    }

    #[test]
    fn plain_text() {
        assert!(!has("A") && !has("") && raster("plain", 36, [0, 0, 0, 255]).is_none());
    }
}
