//! The window's title bar in the app's own colours, so it reads as part of the app and not as a
//! stock Windows frame. Windows 11 lets a program choose its caption, title-text and edge colours;
//! older Windows ignores the request and keeps its own.

use eframe::egui::Color32;

/// Colours the title bar `bar`, the title `text` and the window edge `edge`. Cheap to call every
/// frame: Windows is asked only when a colour changed (a new theme) or the window was not there yet.
pub fn paint(bar: Color32, text: Color32, edge: Color32) {
    #[cfg(windows)]
    {
        static DONE: std::sync::Mutex<Option<[Color32; 3]>> = std::sync::Mutex::new(None);
        let mut done = DONE.lock().unwrap();
        if *done != Some([bar, text, edge]) && win::paint(bar, text, edge) {
            *done = Some([bar, text, edge]);
        }
    }
    #[cfg(not(windows))]
    let _ = (bar, text, edge);
}

/// 0x00BBGGRR, the way Windows writes a colour.
fn colorref(c: Color32) -> u32 {
    (c.b() as u32) << 16 | (c.g() as u32) << 8 | c.r() as u32
}

/// A dark bar gets light minimise, maximise and close glyphs.
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
    pub fn paint(bar: Color32, text: Color32, edge: Color32) -> bool {
        let Some(hwnd) = own_window() else { return false };
        // SAFETY: each attribute takes a 4-byte value, which `value` is for the length of the call.
        let set = |attribute: u32, value: u32| unsafe { DwmSetWindowAttribute(hwnd, attribute, (&raw const value).cast(), 4) };
        set(20, is_dark(bar) as u32); // DWMWA_USE_IMMERSIVE_DARK_MODE
        set(34, colorref(edge)); // DWMWA_BORDER_COLOR
        set(35, colorref(bar)); // DWMWA_CAPTION_COLOR
        set(36, colorref(text)); // DWMWA_TEXT_COLOR
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
}
