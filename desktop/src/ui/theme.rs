//! Colours and fonts: the web app's design tokens (src/app/globals.css) and its
//! theme wall (src/lib/themes.ts), so both versions look the same.

use eframe::egui::{self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle};
use serde::Deserialize;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

/// The palette every widget paints with. Field names follow the CSS variables.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Palette {
    pub bg: Color32,
    pub bg2: Color32,
    pub bg3: Color32,
    pub elevated: Color32,
    pub hover: Color32,
    pub border: Color32,
    pub border_light: Color32,
    pub text: Color32,
    pub text2: Color32,
    pub muted: Color32,
    pub accent: Color32,
    pub accent_light: Color32,
    pub success: Color32,
    pub warning: Color32,
    pub danger: Color32,
    pub info: Color32,
    pub search: Color32,
    pub thinking: Color32,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ThemeDef {
    pub id: String,
    pub name: String,
    pub bg: String,
    pub surface: String,
    pub text: String,
    pub accent: String,
    #[serde(default)]
    pub overrides: HashMap<String, String>,
}

pub const DEFAULT_THEME: &str = "apim";
pub const CUSTOM_THEME: &str = "custom";

pub static THEMES: LazyLock<Vec<ThemeDef>> = LazyLock::new(|| serde_json::from_str(include_str!("../../assets/themes.json")).expect("themes.json"));

/// `#rrggbb` or `#rgb`. Anything else is None.
pub fn hex(text: &str) -> Option<Color32> {
    let h = text.trim().strip_prefix('#')?;
    let full: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.to_string() };
    if full.len() != 6 {
        return None;
    }
    let n = u32::from_str_radix(&full, 16).ok()?;
    Some(Color32::from_rgb((n >> 16) as u8, (n >> 8) as u8, n as u8))
}

pub fn to_hex(c: Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
}

fn to_oklab(c: Color32) -> [f32; 3] {
    let lin = |v: u8| {
        let v = v as f32 / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(c.r()), lin(c.g()), lin(c.b()));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn from_oklab([l, a, b]: [f32; 3]) -> Color32 {
    let l_ = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let m_ = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    let gamma = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        let out = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (out * 255.0).round() as u8
    };
    Color32::from_rgb(
        gamma(4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_),
        gamma(-1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_4 * s_),
        gamma(-0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_),
    )
}

/// CSS `color-mix(in oklab, a pct%, b)` for two opaque colours.
pub fn mix(a: Color32, pct: f32, b: Color32) -> Color32 {
    let (x, y, t) = (to_oklab(a), to_oklab(b), pct / 100.0);
    from_oklab([0, 1, 2].map(|i| x[i] * t + y[i] * (1.0 - t)))
}

/// CSS `color-mix(in oklab, c pct%, transparent)`, and Tailwind's `bg-x/NN`.
pub fn alpha(c: Color32, pct: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), (pct * 2.55).round().clamp(0.0, 255.0) as u8)
}

impl Palette {
    /// The recipe from `themeVars` in src/lib/themes.ts: four seeds, the rest derived.
    pub fn from_seeds(bg: Color32, surface: Color32, text: Color32, accent: Color32, overrides: &HashMap<String, String>) -> Palette {
        let rgb = |n: u32| Color32::from_rgb((n >> 16) as u8, (n >> 8) as u8, n as u8);
        let mut p = Palette {
            bg,
            bg2: mix(bg, 90.0, text),
            bg3: mix(bg, 78.0, surface),
            elevated: surface,
            hover: mix(surface, 80.0, text),
            border: mix(surface, 76.0, text),
            border_light: mix(surface, 60.0, text),
            text,
            text2: mix(text, 70.0, bg),
            muted: mix(text, 46.0, bg),
            accent,
            accent_light: mix(accent, 78.0, text),
            success: rgb(0x7ba478),
            warning: rgb(0xcfa25a),
            danger: rgb(0xcf6a5f),
            info: rgb(0x6f98bd),
            search: rgb(0x6ba3a0),
            thinking: rgb(0xcfa25a),
        };
        for (key, value) in overrides {
            let Some(colour) = hex(value) else { continue };
            let slot = match key.as_str() {
                "--color-bg-primary" => &mut p.bg,
                "--color-bg-secondary" => &mut p.bg2,
                "--color-bg-tertiary" => &mut p.bg3,
                "--color-bg-elevated" => &mut p.elevated,
                "--color-bg-hover" => &mut p.hover,
                "--color-border" => &mut p.border,
                "--color-border-light" => &mut p.border_light,
                "--color-text-primary" => &mut p.text,
                "--color-text-secondary" => &mut p.text2,
                "--color-text-muted" => &mut p.muted,
                "--color-accent" => &mut p.accent,
                "--color-accent-light" => &mut p.accent_light,
                "--color-success" => &mut p.success,
                "--color-warning" => &mut p.warning,
                "--color-danger" => &mut p.danger,
                "--color-info" => &mut p.info,
                "--color-search" => &mut p.search,
                "--color-thinking" => &mut p.thinking,
                _ => continue,
            };
            *slot = colour;
        }
        p
    }

    /// A preset by id, or the custom seeds (`[bg, surface, text, accent]`) when the id is "custom".
    pub fn for_theme(id: &str, custom: &[String; 4]) -> Palette {
        let seed = |s: &str, fallback: u32| hex(s).unwrap_or(Color32::from_rgb((fallback >> 16) as u8, (fallback >> 8) as u8, fallback as u8));
        if id == CUSTOM_THEME {
            return Palette::from_seeds(seed(&custom[0], 0x191715), seed(&custom[1], 0x2a2723), seed(&custom[2], 0xede9e2), seed(&custom[3], 0xc96442), &HashMap::new());
        }
        let def = THEMES.iter().find(|t| t.id == id).unwrap_or(&THEMES[0]);
        Palette::from_seeds(seed(&def.bg, 0x191715), seed(&def.surface, 0x2a2723), seed(&def.text, 0xede9e2), seed(&def.accent, 0xc96442), &def.overrides)
    }

    /// Light themes need dark shadows toned down and egui told the truth.
    pub fn is_dark(&self) -> bool {
        to_oklab(self.bg)[0] < 0.6
    }
}

thread_local! {
    static CURRENT: Cell<Option<Palette>> = const { Cell::new(None) };
}

/// The palette in use. Cheap: a copy of 18 colours.
pub fn p() -> Palette {
    CURRENT.get().unwrap_or_else(|| Palette::for_theme(DEFAULT_THEME, &Default::default()))
}

// ------------------------------------------------------------------ fonts

/// Font weight, as CSS names it. One variable font file serves all four.
#[derive(Clone, Copy, PartialEq)]
pub enum W {
    Regular,
    Medium,
    Semibold,
    Bold,
}

pub fn font(size: f32, weight: W) -> FontId {
    let family = match weight {
        W::Regular => FontFamily::Proportional,
        W::Medium => FontFamily::Name("medium".into()),
        W::Semibold => FontFamily::Name("semibold".into()),
        W::Bold => FontFamily::Name("bold".into()),
    };
    FontId::new(size, family)
}

pub fn mono(size: f32) -> FontId {
    FontId::new(size, FontFamily::Monospace)
}

/// Source Serif 4: the welcome heading.
pub fn serif(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name("serif".into()))
}

/// The web app's three faces, built in. Symbols and emoji they lack fall back to
/// Segoe UI Symbol when the system has it, then to egui's own fonts.
// ponytail: no CJK font is loaded (the Windows ones are 20+ MB in memory). Add one to `fallbacks` if chats need it.
fn fonts() -> FontDefinitions {
    let mut defs = FontDefinitions::default();
    let sans: &'static [u8] = include_bytes!("../../assets/fonts/InstrumentSans.ttf");
    let serif: &'static [u8] = include_bytes!("../../assets/fonts/SourceSerif4.ttf");
    let mono: &'static [u8] = include_bytes!("../../assets/fonts/JetBrainsMono.ttf");

    let mut fallbacks = defs.families[&FontFamily::Proportional].clone();
    let win = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
    if let Ok(bytes) = std::fs::read(format!(r"{win}\Fonts\seguisym.ttf")) {
        defs.font_data.insert("symbols".into(), Arc::new(FontData::from_owned(bytes)));
        fallbacks.insert(0, "symbols".into());
    }

    // (font name, file, weight, family)
    let faces: [(&str, &'static [u8], f32, FontFamily); 6] = [
        ("sans", sans, 400.0, FontFamily::Proportional),
        ("sans-medium", sans, 500.0, FontFamily::Name("medium".into())),
        ("sans-semibold", sans, 600.0, FontFamily::Name("semibold".into())),
        ("sans-bold", sans, 700.0, FontFamily::Name("bold".into())),
        ("serif", serif, 500.0, FontFamily::Name("serif".into())),
        ("mono", mono, 400.0, FontFamily::Monospace),
    ];
    for (name, bytes, weight, family) in faces {
        let tweak = egui::FontTweak { coords: egui::epaint::text::VariationCoords::new([("wght", weight)]), ..Default::default() };
        defs.font_data.insert(name.into(), Arc::new(FontData::from_static(bytes).tweak(tweak)));
        let mut list = vec![name.to_string()];
        list.extend(fallbacks.iter().cloned());
        defs.families.insert(family, list);
    }
    defs
}

/// Call once at startup.
pub fn install_fonts(ctx: &egui::Context) {
    ctx.set_fonts(fonts());
}

/// Switches the palette and restyles egui's own widgets (text boxes, scroll bars, menus) to match.
pub fn apply(ctx: &egui::Context, palette: Palette) {
    CURRENT.set(Some(palette));
    let p = palette;
    ctx.set_theme(if p.is_dark() { egui::Theme::Dark } else { egui::Theme::Light });
    ctx.all_styles_mut(|style| {
        style.text_styles = [
            (TextStyle::Heading, serif(30.0)),
            (TextStyle::Body, font(14.0, W::Regular)),
            (TextStyle::Button, font(13.0, W::Medium)),
            (TextStyle::Small, font(11.0, W::Regular)),
            (TextStyle::Monospace, mono(13.0)),
        ]
        .into();
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 6.0);
        style.spacing.interact_size.y = 28.0;
        style.spacing.scroll = egui::style::ScrollStyle::thin();
        style.spacing.scroll.floating = true;
        style.spacing.scroll.bar_width = 6.0;
        style.spacing.scroll.floating_width = 6.0;
        style.spacing.scroll.floating_allocated_width = 0.0;
        style.spacing.scroll.dormant_handle_opacity = 0.0;
        style.spacing.scroll.active_handle_opacity = 1.0;
        style.spacing.scroll.interact_handle_opacity = 1.0;
        style.spacing.scroll.dormant_background_opacity = 0.0;
        style.spacing.scroll.active_background_opacity = 0.0;
        style.spacing.scroll.interact_background_opacity = 0.0;
        style.interaction.selectable_labels = true;

        let v = &mut style.visuals;
        v.dark_mode = p.is_dark();
        v.override_text_color = Some(p.text);
        v.panel_fill = p.bg;
        v.window_fill = p.elevated;
        v.window_stroke = Stroke::new(1.0, p.border_light);
        v.window_corner_radius = CornerRadius::same(16);
        v.menu_corner_radius = CornerRadius::same(12);
        v.extreme_bg_color = p.bg;
        v.text_edit_bg_color = Some(p.bg);
        v.faint_bg_color = p.bg3;
        v.code_bg_color = p.elevated;
        v.hyperlink_color = p.accent_light;
        v.selection.bg_fill = alpha(p.accent, 32.0);
        v.selection.stroke = Stroke::new(1.0, p.border_light);
        v.warn_fg_color = p.warning;
        v.error_fg_color = p.danger;

        let radius = CornerRadius::same(8);
        let w = &mut v.widgets;
        for state in [&mut w.noninteractive, &mut w.inactive, &mut w.hovered, &mut w.active, &mut w.open] {
            state.corner_radius = radius;
            state.expansion = 0.0;
        }
        w.noninteractive.bg_fill = p.bg;
        w.noninteractive.weak_bg_fill = p.bg;
        w.noninteractive.bg_stroke = Stroke::new(1.0, p.border);
        w.noninteractive.fg_stroke = Stroke::new(1.0, p.text2);
        // The scroll bar handle takes these fills, so they stay quiet (the web's is `border` on nothing).
        w.inactive.bg_fill = p.border;
        w.inactive.weak_bg_fill = p.bg3;
        w.inactive.bg_stroke = Stroke::new(1.0, p.border);
        w.inactive.fg_stroke = Stroke::new(1.0, p.text2);
        w.hovered.bg_fill = p.border_light;
        w.hovered.weak_bg_fill = p.hover;
        w.hovered.bg_stroke = Stroke::new(1.0, p.border_light);
        w.hovered.fg_stroke = Stroke::new(1.0, p.text);
        w.active.bg_fill = p.border_light;
        w.active.weak_bg_fill = p.hover;
        w.active.bg_stroke = Stroke::new(1.0, p.border_light);
        w.active.fg_stroke = Stroke::new(1.0, p.text);
        w.open.bg_fill = p.hover;
        w.open.weak_bg_fill = p.hover;
        w.open.bg_stroke = Stroke::new(1.0, p.border_light);
        w.open.fg_stroke = Stroke::new(1.0, p.text);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_matches_the_stylesheet() {
        // The stock theme is spelled out in full, so it must come back exactly.
        let p = Palette::for_theme(DEFAULT_THEME, &Default::default());
        assert_eq!((to_hex(p.bg2), to_hex(p.hover), to_hex(p.muted), to_hex(p.accent_light)), ("#141210".into(), "#33302a".into(), "#6d685d".into(), "#d97f5d".into()));
        // A derived theme: mixing a colour with itself changes nothing, and 50% grey sits between.
        let white = Color32::WHITE;
        assert_eq!(mix(white, 30.0, white), white);
        let mid = mix(Color32::BLACK, 50.0, white);
        assert!(mid.r() > 90 && mid.r() < 110, "oklab midpoint of black and white is about #636363, got {mid:?}");
        assert_eq!(hex("#abc"), Some(Color32::from_rgb(0xaa, 0xbb, 0xcc)));
        assert!(THEMES.len() > 5 && Palette::for_theme("nord", &Default::default()).bg == hex("#2e3440").unwrap());
    }
}
