//! The app's own title bar. The system frame is switched off (see `ui::run`), so this draws the
//! bar across the top (the mark, the name, room to drag the window by, and minimise, maximise and
//! close) and makes the window's edges resize it, which nothing else does once the frame is gone.

use super::theme::{self, W, p};
use super::widgets;
use eframe::egui::{self, Color32, CursorIcon, PointerButton, Pos2, Rect, ResizeDirection, Sense, Stroke, StrokeKind, ViewportCommand, pos2, vec2};

pub const HEIGHT: f32 = 32.0;
/// Each of the three window buttons.
const BUTTON: f32 = 46.0;
/// How close to an edge the pointer grips it, and how far along an edge a corner reaches.
const EDGE: f32 = 4.0;
const CORNER: f32 = 12.0;
/// The red Windows itself puts under a hovered close button.
const CLOSE_RED: Color32 = Color32::from_rgb(0xc4, 0x2b, 0x1c);

/// Which edge or corner of the window a pointer at `at` grips, if any.
fn grip(window: Rect, at: Pos2) -> Option<ResizeDirection> {
    let (left, right, top, bottom) = (at.x - window.left(), window.right() - at.x, at.y - window.top(), window.bottom() - at.y);
    let corner = |a: f32, b: f32| a.min(b) < EDGE && a.max(b) < CORNER;
    use ResizeDirection::*;
    Some(match () {
        _ if corner(left, top) => NorthWest,
        _ if corner(right, top) => NorthEast,
        _ if corner(left, bottom) => SouthWest,
        _ if corner(right, bottom) => SouthEast,
        _ if left < EDGE => West,
        _ if right < EDGE => East,
        _ if top < EDGE => North,
        _ if bottom < EDGE => South,
        _ => return None,
    })
}

fn full_size(ctx: &egui::Context) -> bool {
    ctx.input(|i| i.viewport().maximized.unwrap_or(false) || i.viewport().fullscreen.unwrap_or(false))
}

/// A press that began on an edge is a resize: nothing under it should also take it as a click.
fn press_gripped(ctx: &egui::Context) -> bool {
    !full_size(ctx) && ctx.input(|i| i.pointer.press_origin()).is_some_and(|at| grip(ctx.content_rect(), at).is_some())
}

/// Lets the window be resized by its edges and corners. Call last in the frame, so its cursor wins.
pub fn edges(ctx: &egui::Context) {
    if full_size(ctx) {
        return;
    }
    let Some(direction) = ctx.input(|i| i.pointer.hover_pos()).and_then(|at| grip(ctx.content_rect(), at)) else { return };
    use ResizeDirection::*;
    ctx.set_cursor_icon(match direction {
        NorthWest | SouthEast => CursorIcon::ResizeNwSe,
        NorthEast | SouthWest => CursorIcon::ResizeNeSw,
        West | East => CursorIcon::ResizeHorizontal,
        North | South => CursorIcon::ResizeVertical,
    });
    if ctx.input(|i| i.pointer.primary_pressed()) {
        ctx.send_viewport_cmd(ViewportCommand::BeginResize(direction));
    }
}

/// Draws the bar over everything else, so the window can be moved, minimised and closed while a dialog is open.
/// `dim` is how dark that dialog made the window (0..255): the bar darkens with it.
pub fn show(ctx: &egui::Context, dim: u8) {
    let p = p();
    let window = ctx.content_rect();
    let maximized = ctx.input(|i| i.viewport().maximized.unwrap_or(false));
    let gripped = press_gripped(ctx);
    egui::Area::new(egui::Id::new("titlebar")).order(egui::Order::Tooltip).fixed_pos(window.min).show(ctx, |ui| {
        let (bar, held) = ui.allocate_exact_size(vec2(window.width(), HEIGHT), Sense::click_and_drag());
        ui.painter().rect_filled(bar, 0.0, p.bg2);
        if !gripped {
            if held.double_clicked() {
                ctx.send_viewport_cmd(ViewportCommand::Maximized(!maximized));
            } else if held.drag_started_by(PointerButton::Primary) {
                ctx.send_viewport_cmd(ViewportCommand::StartDrag);
            }
        }

        // The mark is the web app's three dots, the middle one mid-bounce.
        let middle = bar.center().y;
        for dot in 0..3 {
            let lift = if dot == 1 { 2.0 } else { 0.0 };
            ui.painter().circle_filled(pos2(bar.left() + 16.0 + dot as f32 * 7.0, middle + 1.0 - lift), 2.25, p.accent_light);
        }
        widgets::text_at(ui, bar.left() + 42.0, middle, widgets::galley(ui, "apiM", theme::font(12.0, W::Medium), p.text2));

        let buttons = [(ViewportCommand::Close, "close"), (ViewportCommand::Maximized(!maximized), "maximise"), (ViewportCommand::Minimized(true), "minimise")];
        for (place, (command, name)) in buttons.into_iter().enumerate() {
            let rect = Rect::from_min_size(pos2(bar.right() - BUTTON * (place + 1) as f32, bar.top()), vec2(BUTTON, HEIGHT));
            let button = ui.interact(rect, ui.id().with(name), Sense::click());
            let closing = name == "close";
            let hot = button.hovered() && !gripped;
            if hot {
                ui.painter().rect_filled(rect, 0.0, if closing { CLOSE_RED } else { p.hover });
            }
            let ink = Stroke::new(1.0, if hot && closing { Color32::WHITE } else if hot { p.text } else { p.text2 });
            let c = pos2(rect.center().x.round() + 0.5, rect.center().y.round() + 0.5);
            let painter = ui.painter();
            match name {
                "close" => {
                    painter.line_segment([c + vec2(-5.0, -5.0), c + vec2(5.0, 5.0)], ink);
                    painter.line_segment([c + vec2(-5.0, 5.0), c + vec2(5.0, -5.0)], ink);
                }
                "minimise" => {
                    painter.line_segment([c + vec2(-5.0, 0.0), c + vec2(5.0, 0.0)], ink);
                }
                // Two windows, one behind the other, when the next click puts it back.
                _ if maximized => {
                    let back = if hot { p.hover } else { p.bg2 };
                    painter.rect_stroke(Rect::from_center_size(c + vec2(1.5, -1.5), vec2(8.0, 8.0)), 1.5, ink, StrokeKind::Middle);
                    painter.rect(Rect::from_center_size(c + vec2(-1.5, 1.5), vec2(8.0, 8.0)), 1.5, back, ink, StrokeKind::Middle);
                }
                _ => {
                    painter.rect_stroke(Rect::from_center_size(c, vec2(10.0, 10.0)), 1.5, ink, StrokeKind::Middle);
                }
            }
            if button.clicked() && !gripped {
                ctx.send_viewport_cmd(command);
            }
        }
        if dim > 0 {
            ui.painter().rect_filled(bar, 0.0, Color32::from_black_alpha(dim));
        }
    });
}

/// Tells Windows the colours of what little frame is left (the hairline edge and the line the shadow
/// needs along the top) and to round the corners. Cheap to call every frame: Windows is asked only
/// when a colour changed (a new theme) or the window was not there yet. Windows 11; ignored before.
pub fn frame(bar: Color32, edge: Color32) {
    #[cfg(windows)]
    {
        static DONE: std::sync::Mutex<Option<[Color32; 2]>> = std::sync::Mutex::new(None);
        let mut done = DONE.lock().unwrap();
        if *done != Some([bar, edge]) && win::frame(bar, edge) {
            *done = Some([bar, edge]);
        }
    }
    #[cfg(not(windows))]
    let _ = (bar, edge);
}

/// 0x00BBGGRR, the way Windows writes a colour.
fn colorref(c: Color32) -> u32 {
    (c.b() as u32) << 16 | (c.g() as u32) << 8 | c.r() as u32
}

fn is_dark(c: Color32) -> bool {
    (c.r() as u32 * 299 + c.g() as u32 * 587 + c.b() as u32 * 114) / 1000 < 128
}

#[cfg(windows)]
mod win {
    use super::{Color32, colorref, is_dark};

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const core::ffi::c_void, size: u32) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowExW(parent: isize, after: isize, class: *const u16, title: *const u16) -> isize;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    }

    /// This program's own "apiM" window: another copy of the app may be open under the same title.
    fn own_window() -> Option<isize> {
        let title: Vec<u16> = "apiM\0".encode_utf16().collect();
        let mut hwnd = 0;
        loop {
            // SAFETY: the title is NUL-terminated and outlives the call; a null class matches any.
            hwnd = unsafe { FindWindowExW(0, hwnd, std::ptr::null(), title.as_ptr()) };
            if hwnd == 0 {
                return None;
            }
            let mut pid = 0;
            // SAFETY: `hwnd` came from the system a moment ago and `pid` is a valid out-pointer.
            if unsafe { GetWindowThreadProcessId(hwnd, &mut pid) } != 0 && pid == std::process::id() {
                return Some(hwnd);
            }
        }
    }

    /// False while the window does not exist yet.
    pub fn frame(bar: Color32, edge: Color32) -> bool {
        let Some(hwnd) = own_window() else { return false };
        // SAFETY: each attribute takes a 4-byte value, which `value` is for the length of the call.
        let set = |attribute: u32, value: u32| unsafe { DwmSetWindowAttribute(hwnd, attribute, (&raw const value).cast(), 4) };
        set(20, is_dark(bar) as u32); // DWMWA_USE_IMMERSIVE_DARK_MODE
        set(33, 2); // DWMWA_WINDOW_CORNER_PREFERENCE: DWMWCP_ROUND
        set(34, colorref(edge)); // DWMWA_BORDER_COLOR
        set(35, colorref(bar)); // DWMWA_CAPTION_COLOR
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_written_the_windows_way() {
        assert_eq!(colorref(Color32::from_rgb(0x14, 0x12, 0x10)), 0x0010_1214);
        assert!(is_dark(Color32::from_rgb(0x14, 0x12, 0x10)) && !is_dark(Color32::from_rgb(0xf4, 0xf1, 0xea)));
    }

    #[test]
    fn edges_and_corners_grip_and_the_middle_does_not() {
        let window = Rect::from_min_size(pos2(0.0, 0.0), vec2(800.0, 600.0));
        let at = |x: f32, y: f32| grip(window, pos2(x, y));
        assert_eq!((at(1.0, 300.0), at(799.0, 300.0), at(400.0, 1.0), at(400.0, 599.0)), (Some(ResizeDirection::West), Some(ResizeDirection::East), Some(ResizeDirection::North), Some(ResizeDirection::South)));
        // A corner reaches further along its two edges than an edge is thick.
        assert_eq!((at(2.0, 10.0), at(790.0, 2.0), at(10.0, 598.0), at(798.0, 590.0)), (Some(ResizeDirection::NorthWest), Some(ResizeDirection::NorthEast), Some(ResizeDirection::SouthWest), Some(ResizeDirection::SouthEast)));
        // The close button sits 16px in from the corner at its nearest: a click on it is a click.
        assert_eq!((at(400.0, 300.0), at(777.0, 16.0), at(10.0, 10.0)), (None, None, None));
    }
}
