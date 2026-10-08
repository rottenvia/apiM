//! The web app's icons: the same SVG paths, copied from its components, drawn
//! white and tinted at paint time.

use eframe::egui::{self, Color32, Pos2, Rect, Vec2};
use std::cell::RefCell;
use std::collections::HashMap;

/// The inside of a 24x24 `<svg>` and the stroke width it was drawn with.
/// A width of 0 means the shape is filled, not stroked.
#[derive(Clone, Copy, PartialEq)]
pub struct Icon {
    body: &'static str,
    stroke: f32,
    view: f32,
}

const fn line(body: &'static str, stroke: f32) -> Icon {
    Icon { body, stroke, view: 24.0 }
}
const fn solid(body: &'static str) -> Icon {
    Icon { body, stroke: 0.0, view: 24.0 }
}

impl Icon {
    /// The same shape with another stroke width (the web app varies it per place).
    pub const fn stroke(self, stroke: f32) -> Icon {
        Icon { stroke, ..self }
    }
}

thread_local! {
    static URIS: RefCell<HashMap<(usize, u32), String>> = RefCell::new(HashMap::new());
}

fn uri(ctx: &egui::Context, icon: Icon) -> String {
    let key = (icon.body.as_ptr() as usize, icon.stroke.to_bits());
    URIS.with_borrow_mut(|map| {
        map.entry(key)
            .or_insert_with(|| {
                let paint = if icon.stroke > 0.0 {
                    format!(r#"fill="none" stroke="white" stroke-width="{}""#, icon.stroke)
                } else {
                    r#"fill="white""#.to_string()
                };
                let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {v} {v}" {paint}>{}</svg>"#, icon.body, v = icon.view);
                let uri = format!("bytes://icon-{}-{}.svg", key.0, key.1);
                ctx.include_bytes(uri.clone(), svg.into_bytes());
                uri
            })
            .clone()
    })
}

/// Draws the icon centred on `center`, `size` points square.
pub fn paint(ui: &egui::Ui, icon: Icon, center: Pos2, size: f32, color: Color32) {
    let rect = Rect::from_center_size(center, Vec2::splat(size));
    egui::Image::from_uri(uri(ui.ctx(), icon)).tint(color).fit_to_exact_size(rect.size()).paint_at(ui, rect);
}

/// The same, turned `angle` radians clockwise about its centre (a chevron swinging open).
pub fn paint_turned(ui: &egui::Ui, icon: Icon, center: Pos2, size: f32, color: Color32, angle: f32) {
    let rect = Rect::from_center_size(center, Vec2::splat(size));
    egui::Image::from_uri(uri(ui.ctx(), icon)).tint(color).fit_to_exact_size(rect.size()).rotate(angle, Vec2::splat(0.5)).paint_at(ui, rect);
}

/// The icon as a widget, for use inside ordinary layouts.
pub fn show(ui: &mut egui::Ui, icon: Icon, size: f32, color: Color32) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), egui::Sense::hover());
    paint(ui, icon, rect.center(), size, color);
    response
}

macro_rules! path {
    ($d:literal) => {
        concat!(r#"<path stroke-linecap="round" stroke-linejoin="round" d=""#, $d, r#""/>"#)
    };
}

// ---- sidebar
pub const PLUS: Icon = line(path!("M12 5v14M5 12h14"), 1.8);
pub const ALERT_CIRCLE: Icon = line(concat!(r#"<circle cx="12" cy="12" r="9"/>"#, path!("M12 8v4M12 16h.01")), 2.0);
pub const DOTS: Icon = solid(r#"<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>"#);
pub const RENAME: Icon = line(path!("M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"), 1.7);
pub const SELECT: Icon = line(path!("M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"), 1.7);
pub const DOWNLOAD: Icon = line(path!("M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"), 1.7);
pub const CHEVRON_RIGHT: Icon = line(path!("M9 5l7 7-7 7"), 2.0);
pub const CHEVRON_DOWN: Icon = line(path!("M6 9l6 6 6-6"), 2.0);
pub const CHEVRON_UP: Icon = line(path!("M18 15l-6-6-6 6"), 2.0);
pub const ARCHIVE: Icon = line(path!("M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"), 1.7);
pub const TRASH: Icon = line(path!("M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"), 1.7);
pub const IMPORT: Icon = line(path!("M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"), 1.5);
pub const MCP: Icon = line(path!("M8 9l-4 3 4 3m8-6l4 3-4 3M13 5l-2 14"), 1.5);
pub const SETTINGS: Icon = line(
    concat!(
        path!("M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"),
        path!("M15 12a3 3 0 11-6 0 3 3 0 016 0z")
    ),
    1.5,
);

// ---- chat header
pub const SIDEBAR_LEFT: Icon = line(r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>"#, 1.6);
pub const PANEL_RIGHT: Icon = line(r#"<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>"#, 1.6);
pub const FIND: Icon = line(r#"<circle cx="10" cy="10" r="6"/><path stroke-linecap="round" d="M14.5 14.5L20 20"/><path stroke-linecap="round" d="M7.5 10h5"/>"#, 1.7);
pub const FULLSCREEN: Icon = line(path!("M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"), 1.6);
pub const FULLSCREEN_EXIT: Icon = line(path!("M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"), 1.6);
pub const ARROW_DOWN: Icon = line(path!("M12 5v14M5 12l7 7 7-7"), 2.0);
pub const WARNING: Icon = line(path!("M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"), 1.8);

// ---- composer
pub const UPLOAD: Icon = line(path!("M12 16V4m0 0L8 8m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"), 1.8);
pub const PAPERCLIP: Icon = line(path!("M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"), 1.7);
pub const FOLDER: Icon = line(path!("M3 7a2 2 0 012-2h3.9a2 2 0 011.6.8l1 1.4a2 2 0 001.6.8H19a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"), 1.7);
pub const FOLDER_PLAIN: Icon = line(path!("M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"), 1.6);
pub const CHIP: Icon = line(r#"<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path stroke-linecap="round" d="M15 2v2M15 20v2M9 2v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/>"#, 1.6);
pub const SPARKLES: Icon = line(concat!(path!("M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z"), path!("M18.5 15.5l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75.75-2z")), 1.6);
pub const GLOBE: Icon = line(r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z"/>"#, 1.6);
pub const PLUGINS: Icon = line(
    path!("M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"),
    1.6,
);
pub const NOTE: Icon = line(concat!(path!("M8 10h8M8 14h5"), path!("M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z")), 2.0);
pub const STOP: Icon = solid(r#"<rect x="7" y="7" width="10" height="10" rx="2"/>"#);
pub const SEND: Icon = line(path!("M12 19V5M5 12l7-7 7 7"), 2.0);
pub const PLAY: Icon = solid(r#"<path d="M8 5v14l11-7z"/>"#);
pub const KEY: Icon = line(path!("M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"), 1.8);

// ---- popovers and dialogs
pub const CLOSE: Icon = line(path!("M6 18L18 6M6 6l12 12"), 2.0);
pub const CHECK: Icon = line(path!("M5 13l4 4L19 7"), 2.2);

// ---- messages
pub const COPY: Icon = line(path!("M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"), 1.7);
pub const RETRY: Icon = line(path!("M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"), 1.7);
pub const REFRESH: Icon = RETRY;
pub const FILE: Icon = line(path!("M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zm0 0v5h5"), 1.6);
pub const CODE: Icon = line(path!("M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12"), 1.7);
pub const CHECK_THIN: Icon = line(path!("M20 6L9 17l-5-5"), 2.0);
pub const COPY_SMALL: Icon = line(concat!(r#"<rect x="9" y="9" width="11" height="11" rx="2"/>"#, path!("M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1")), 1.8);
pub const COPY_USER: Icon = line(concat!(r#"<rect x="9" y="9" width="11" height="11" rx="2"/>"#, path!("M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1")), 1.9);
pub const REWIND: Icon = line(concat!(path!("M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"), path!("M3 3v5h5")), 1.9);
pub const TRASH_SMALL: Icon = line(path!("M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16"), 1.9);
pub const REGENERATE: Icon = line(concat!(path!("M4 4v6h6M20 20v-6h-6"), path!("M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2")), 1.9);
pub const COMPARE: Icon = line(path!("M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4"), 1.9);
pub const FILE_SMALL: Icon = line(concat!(path!("M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"), path!("M14 2v6h6")), 1.7);
pub const SPARKLE: Icon = line(path!("M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z"), 2.2);
pub const SEARCH_SMALL: Icon = line(r#"<circle cx="11" cy="11" r="8"/><path stroke-linecap="round" d="M21 21l-4.35-4.35"/>"#, 2.2);
pub const CLOCK: Icon = line(r#"<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 7v5l3 2"/>"#, 2.2);
pub const LINES: Icon = line(path!("M4 6h16M4 12h16M4 18h10"), 2.2);
pub const EXTERNAL: Icon = line(path!("M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"), 2.0);
pub const INFO: Icon = line(r#"<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5m0-8h.01"/>"#, 2.0);
pub const THINK: Icon = line(concat!(path!("M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"), path!("M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z")), 1.9);

// ---- tool steps (src/components/ToolActivity.tsx), one per kind
pub const TOOL_READ: Icon = line(concat!(path!("M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"), path!("M14 3v5h5"), path!("M9 13h6M9 17h4")), 1.9);
pub const TOOL_WRITE: Icon = line(concat!(path!("M12 20h9"), path!("M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z")), 1.9);
pub const TOOL_DELETE: Icon = line(path!("M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13"), 1.9);
pub const TOOL_SEARCH: Icon = line(concat!(path!("M11 18a7 7 0 100-14 7 7 0 000 14z"), path!("M20 20l-4-4")), 1.9);
pub const TOOL_RUN: Icon = line(concat!(path!("M4 5h16v14H4z"), path!("M8 10l3 2-3 2M13 15h3")), 1.9);
pub const TOOL_WEB: Icon = line(concat!(path!("M12 21a9 9 0 100-18 9 9 0 000 18z"), path!("M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z")), 1.9);
pub const TOOL_PLAN: Icon = line(concat!(path!("M9 6h11M9 12h11M9 18h11"), path!("M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2")), 1.9);
pub const TOOL_GIT: Icon = line(concat!(path!("M6 3v12"), path!("M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6z"), path!("M18 9a9 9 0 01-9 9")), 1.9);
pub const TOOL_NOTE: Icon = line(path!("M5 4h14v16l-7-4-7 4z"), 1.9);
pub const TOOL_ASK: Icon = line(path!("M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z"), 1.9);
pub const TOOL_IMAGE: Icon = line(concat!(path!("M4 5h16v14H4z"), path!("M4 16l5-5 4 4 3-3 4 4"), path!("M15 9h.01")), 1.9);
pub const TOOL_DONE: Icon = line(path!("M5 12l5 5 9-10"), 1.9);
pub const TOOL_OTHER: Icon = line(path!("M13 2L4 14h7l-1 8 9-12h-7z"), 1.9);
pub const TERMINAL: Icon = line(path!("M8 9l3 3-3 3m5 0h3M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"), 1.7);
pub const HELP: Icon = line(concat!(r#"<circle cx="12" cy="12" r="9"/>"#, path!("M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01")), 1.7);
pub const PICTURE: Icon = line(concat!(r#"<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>"#, path!("M21 15l-5-5L5 21")), 1.7);
pub const GITHUB: Icon = solid(
    r#"<path d="M12 .8a11.2 11.2 0 00-3.5 21.9c.6.1.8-.3.8-.6V20c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.4 1.2-3.1-.1-.3-.5-1.6.1-3.1 0 0 1-.3 3.2 1.2a10.9 10.9 0 015.8 0C17.5 4.7 18.5 5 18.5 5c.6 1.5.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.1v3c0 .3.2.7.8.6A11.2 11.2 0 0012 .8z"/>"#,
);
pub const HISTORY: Icon = line(path!("M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 4v4h4M12 7v5l3 2"), 1.7);
pub const COPY_FILES: Icon = line(path!("M8 4h9a2 2 0 012 2v9M6 8h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z"), 1.7);
pub const DOWNLOAD_TRAY: Icon = line(path!("M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"), 1.7);
pub const UNDO: Icon = line(path!("M3 10h11a4 4 0 010 8h-1M3 10l4-4M3 10l4 4"), 1.7);
pub const CHEVRON_LEFT: Icon = line(path!("M15 19l-7-7 7-7"), 2.2);
pub const TOOL_FAILED: Icon = line(concat!(path!("M12 21a9 9 0 100-18 9 9 0 000 18z"), path!("M12 8v4M12 16h.01")), 1.9);

// ---- settings and the other dialogs
pub const EYE: Icon = line(concat!(path!("M15 12a3 3 0 11-6 0 3 3 0 016 0z"), path!("M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z")), 1.5);
pub const EYE_OFF: Icon = line(
    path!("M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"),
    1.5,
);
pub const TAB_KEYS: Icon = line(path!("M15 7a4 4 0 11-4 4m0 0L4 18v3h3l1-1v-2h2v-2h2l1.5-1.5"), 1.7);
pub const TAB_MODEL: Icon = line(path!("M12 3l2.2 5 5.3.5-4 3.5 1.2 5.2L12 14.5 7.3 17.2l1.2-5.2-4-3.5L9.8 8z"), 1.7);
pub const TAB_THEME: Icon = line(
    concat!(
        path!("M12 3a9 9 0 100 18c1.5 0 2-.9 2-2 0-1.4 1-2.2 2.4-2.2H18a4 4 0 004-4c0-4.97-4.5-9-10-9z"),
        r#"<circle cx="7.5" cy="11.5" r="1.3" fill="white" stroke="none"/><circle cx="10.5" cy="7.5" r="1.3" fill="white" stroke="none"/><circle cx="15" cy="7.5" r="1.3" fill="white" stroke="none"/>"#
    ),
    1.7,
);
pub const TAB_REPORTS: Icon = line(concat!(path!("M9 3h6l4 4v14H5V3h4zM9 3v5h6"), r#"<path stroke-linecap="round" d="M8.5 13h7M8.5 16.5h4.5"/>"#), 1.7);
pub const TAB_SAFETY: Icon = line(path!("M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"), 1.7);
