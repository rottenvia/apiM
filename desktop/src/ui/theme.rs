//! Colours, fonts and widget styling: the web app's warm dark palette.

use eframe::egui::{self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle};
use std::sync::Arc;

const fn rgb(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

pub const BG: Color32 = rgb(0x191715);
pub const BG_SIDEBAR: Color32 = rgb(0x141210);
pub const BG_TERTIARY: Color32 = rgb(0x201e1b);
pub const BG_ELEVATED: Color32 = rgb(0x2a2723);
pub const BG_HOVER: Color32 = rgb(0x33302a);
pub const BORDER: Color32 = rgb(0x2c2924);
pub const BORDER_LIGHT: Color32 = rgb(0x403c34);
pub const TEXT: Color32 = rgb(0xede9e2);
pub const TEXT_SECONDARY: Color32 = rgb(0xa29d92);
pub const TEXT_MUTED: Color32 = rgb(0x6d685d);
pub const ACCENT: Color32 = rgb(0xc96442);
pub const ACCENT_LIGHT: Color32 = rgb(0xd97f5d);
pub const SUCCESS: Color32 = rgb(0x7ba478);
pub const WARNING: Color32 = rgb(0xcfa25a);
pub const DANGER: Color32 = rgb(0xcf6a5f);
pub const SEARCH: Color32 = rgb(0x6ba3a0);

/// The heading face ("How can I help you today?").
pub fn serif() -> FontFamily {
    FontFamily::Name("serif".into())
}

/// Uses the fonts the system already has, so nothing is bundled. egui's built-in
/// fonts stay as the fallback, which also covers emoji.
// ponytail: no CJK font is loaded (the Windows ones are 20+ MB in memory). Add one to `candidates` if chats need it.
fn fonts() -> FontDefinitions {
    let mut defs = FontDefinitions::default();
    let serif_family = serif();
    defs.families.insert(serif_family.clone(), defs.families[&FontFamily::Proportional].clone());

    let win = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
    // (name, files to try, family, goes before the built-in fonts)
    let candidates: [(&str, &[String], FontFamily, bool); 5] = [
        ("ui", &[format!(r"{win}\Fonts\segoeui.ttf"), "/System/Library/Fonts/SFNS.ttf".into(), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf".into()], FontFamily::Proportional, true),
        ("mono", &[format!(r"{win}\Fonts\CascadiaMono.ttf"), format!(r"{win}\Fonts\consola.ttf"), "/System/Library/Fonts/Menlo.ttc".into(), "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf".into()], FontFamily::Monospace, true),
        ("serif", &[format!(r"{win}\Fonts\georgia.ttf"), "/System/Library/Fonts/Supplemental/Georgia.ttf".into(), "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf".into()], serif_family, true),
        ("symbols", &[format!(r"{win}\Fonts\seguisym.ttf")], FontFamily::Proportional, false),
        ("symbols-mono", &[format!(r"{win}\Fonts\seguisym.ttf")], FontFamily::Monospace, false),
    ];
    for (name, paths, family, front) in candidates {
        let Some(bytes) = paths.iter().find_map(|p| std::fs::read(p).ok()) else { continue };
        defs.font_data.insert(name.into(), Arc::new(FontData::from_owned(bytes)));
        let list = defs.families.entry(family).or_default();
        if front {
            list.insert(0, name.into());
        } else {
            list.push(name.into());
        }
    }
    defs
}

pub fn apply(ctx: &egui::Context) {
    ctx.set_fonts(fonts());
    ctx.set_theme(egui::Theme::Dark);
    ctx.all_styles_mut(|style| {
        style.text_styles = [
            (TextStyle::Heading, FontId::new(22.0, serif())),
            (TextStyle::Body, FontId::new(14.5, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(13.5, FontFamily::Proportional)),
            (TextStyle::Small, FontId::new(12.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(13.0, FontFamily::Monospace)),
        ]
        .into();
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 6.0);
        style.spacing.interact_size.y = 30.0;
        style.spacing.scroll.bar_width = 8.0;
        style.spacing.scroll.floating = true;
        style.interaction.selectable_labels = true;

        let v = &mut style.visuals;
        v.dark_mode = true;
        v.override_text_color = Some(TEXT);
        v.panel_fill = BG;
        v.window_fill = BG_ELEVATED;
        v.window_stroke = Stroke::new(1.0, BORDER_LIGHT);
        v.window_corner_radius = CornerRadius::same(12);
        v.menu_corner_radius = CornerRadius::same(10);
        v.extreme_bg_color = BG_SIDEBAR;
        v.faint_bg_color = BG_TERTIARY;
        v.code_bg_color = BG_ELEVATED;
        v.hyperlink_color = ACCENT_LIGHT;
        v.selection.bg_fill = ACCENT.gamma_multiply(0.38);
        v.selection.stroke = Stroke::new(1.0, ACCENT_LIGHT);
        v.warn_fg_color = WARNING;
        v.error_fg_color = DANGER;

        let radius = CornerRadius::same(8);
        let w = &mut v.widgets;
        for state in [&mut w.noninteractive, &mut w.inactive, &mut w.hovered, &mut w.active, &mut w.open] {
            state.corner_radius = radius;
            state.expansion = 0.0;
        }
        w.noninteractive.bg_fill = BG;
        w.noninteractive.weak_bg_fill = BG;
        w.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
        w.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_SECONDARY);
        w.inactive.bg_fill = BG_ELEVATED;
        w.inactive.weak_bg_fill = BG_TERTIARY;
        w.inactive.bg_stroke = Stroke::new(1.0, BORDER_LIGHT);
        w.inactive.fg_stroke = Stroke::new(1.0, TEXT_SECONDARY);
        w.hovered.bg_fill = BG_HOVER;
        w.hovered.weak_bg_fill = BG_HOVER;
        w.hovered.bg_stroke = Stroke::new(1.0, BORDER_LIGHT);
        w.hovered.fg_stroke = Stroke::new(1.0, TEXT);
        w.active.bg_fill = BG_HOVER;
        w.active.weak_bg_fill = BG_HOVER;
        w.active.bg_stroke = Stroke::new(1.0, ACCENT);
        w.active.fg_stroke = Stroke::new(1.0, TEXT);
        w.open.bg_fill = BG_HOVER;
        w.open.weak_bg_fill = BG_HOVER;
        w.open.bg_stroke = Stroke::new(1.0, BORDER_LIGHT);
        w.open.fg_stroke = Stroke::new(1.0, TEXT);
    });
}

/// A rounded card: the composer, prompts, user bubbles.
pub fn card(fill: Color32) -> egui::Frame {
    egui::Frame::new().fill(fill).stroke(Stroke::new(1.0, BORDER)).corner_radius(CornerRadius::same(12)).inner_margin(egui::Margin::same(12))
}

/// An on/off switch.
pub fn toggle(ui: &mut egui::Ui, on: &mut bool) -> egui::Response {
    let (rect, mut response) = ui.allocate_exact_size(egui::vec2(34.0, 18.0), egui::Sense::click());
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }
    response.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, ui.is_enabled(), *on, ""));
    if ui.is_rect_visible(rect) {
        let how_on = ui.ctx().animate_bool_responsive(response.id, *on);
        ui.painter().rect_filled(rect, 9.0, BORDER_LIGHT.lerp_to_gamma(ACCENT, how_on));
        let x = egui::lerp((rect.left() + 9.0)..=(rect.right() - 9.0), how_on);
        ui.painter().circle_filled(egui::pos2(x, rect.center().y), 6.5, TEXT);
    }
    response
}

pub fn muted(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).color(TEXT_MUTED).size(12.0)
}

pub fn secondary(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).color(TEXT_SECONDARY)
}
