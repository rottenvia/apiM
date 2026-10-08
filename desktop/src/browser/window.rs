//! Captures a running native window, or the whole screen, to a PNG. Port of the Windows route in
//! screenshot.ts, using direct Win32 calls instead of a generated PowerShell script.
//!
//! ponytail: no hidden-desktop capture. This build has no hidden launch in start_process, so there is no off-screen desktop to read.
//! ponytail: macOS (screencapture) and Linux (import, xdotool) capture are not ported. Those platforms get the honest failure below.

use std::path::PathBuf;

pub struct Request {
    /// Window title, or a distinctive part of it. Matched loosely.
    pub title: Option<String>,
    /// Process id of a window the user or a tracked process owns. Takes precedence over the title.
    pub pid: Option<u32>,
    pub out: PathBuf,
    pub full_screen: bool,
}

#[derive(Debug, Default)]
pub struct Captured {
    /// The window actually captured, so a wrong aim can be seen.
    pub window_title: String,
    /// Other windows that matched the same title.
    pub also_matched: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// How the pixels were taken, so a surprising image can be explained.
    pub method: &'static str,
}

/// How well a window matches the title asked for: 0 exact, 1 process name, 2 prefix, 3 substring, None otherwise. Case-insensitive.
#[allow(dead_code)]
pub fn rank(needle: &str, title: &str, process: &str) -> Option<u8> {
    let (n, t, p) = (needle.to_lowercase(), title.to_lowercase(), process.to_lowercase());
    if t == n {
        Some(0)
    } else if p.contains(&n) {
        Some(1)
    } else if t.starts_with(&n) {
        Some(2)
    } else if t.contains(&n) {
        Some(3)
    } else {
        None
    }
}

/// Capture the window (or the screen) to `req.out`. The caller creates the parent folder.
pub fn capture(req: &Request) -> Result<Captured, String> {
    let has_title = req.title.as_deref().is_some_and(|t| !t.is_empty());
    if !req.full_screen && !has_title && req.pid.unwrap_or(0) == 0 {
        return Err("Give a window title or the pid of a process you started (or set full_screen). Use list_processes to find it.".into());
    }
    imp::capture(req)
}

#[cfg(windows)]
mod imp {
    use super::{Captured, Request, rank};
    use std::path::Path;

    type Hwnd = isize;
    type Hdc = isize;

    const SRCCOPY: u32 = 0x00CC_0020;
    const PW_RENDERFULLCONTENT: u32 = 2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(cb: extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowTextW(h: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(h: Hwnd) -> i32;
        fn GetWindowRect(h: Hwnd, r: *mut Rect) -> i32;
        fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
        fn PrintWindow(h: Hwnd, hdc: Hdc, flags: u32) -> i32;
        fn GetDC(h: Hwnd) -> Hdc;
        fn ReleaseDC(h: Hwnd, hdc: Hdc) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn CreateCompatibleBitmap(hdc: Hdc, w: i32, h: i32) -> isize;
        fn SelectObject(hdc: Hdc, obj: isize) -> isize;
        fn BitBlt(dst: Hdc, x: i32, y: i32, w: i32, h: i32, src: Hdc, sx: i32, sy: i32, rop: u32) -> i32;
        fn GetDIBits(hdc: Hdc, bmp: isize, start: u32, lines: u32, bits: *mut u8, info: *mut BitmapInfo, usage: u32) -> i32;
        fn DeleteObject(obj: isize) -> i32;
        fn DeleteDC(hdc: Hdc) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }

    struct Found {
        hwnd: Hwnd,
        title: String,
        pid: u32,
    }

    extern "system" fn collect(h: Hwnd, lparam: isize) -> i32 {
        // SAFETY: lparam is the &mut Vec<Found> that capture() passed to EnumWindows, live for the whole call.
        let out = unsafe { &mut *(lparam as *mut Vec<Found>) };
        if unsafe { IsWindowVisible(h) } != 0 {
            let mut buf = [0u16; 512];
            let n = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) };
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, &mut pid) };
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            out.push(Found { hwnd: h, title, pid });
        }
        1
    }

    /// The executable's file name without its extension, which is what Get-Process calls ProcessName.
    fn process_name(pid: u32) -> String {
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h == 0 {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) };
        unsafe { CloseHandle(h) };
        if ok == 0 {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        Path::new(&full).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// BGRA pixels of a `w` x `h` area. PrintWindow first (works behind other windows), then a screen copy.
    fn grab(window: Option<Hwnd>, x: i32, y: i32, w: i32, h: i32) -> Result<(Vec<u8>, &'static str), String> {
        unsafe {
            let screen = GetDC(0);
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp);
            let printed = window.is_some_and(|hwnd| PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT) != 0);
            if !printed {
                BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);
            }
            let mut info = BitmapInfo {
                header: BitmapInfoHeader { size: 40, width: w, height: -h, planes: 1, bit_count: 32, ..Default::default() },
                colors: [0],
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let rows = GetDIBits(mem, bmp, 0, h as u32, pixels.as_mut_ptr(), &mut info, 0);
            SelectObject(mem, old);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(0, screen);
            if rows == 0 {
                return Err("the screen could not be read".into());
            }
            Ok((pixels, if printed { "PrintWindow" } else { "screen copy" }))
        }
    }

    pub fn capture(req: &Request) -> Result<Captured, String> {
        let (pixels, method, title, also, (w, h)) = if req.full_screen {
            let (x, y, w, h) = unsafe { (GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)) };
            let (px, m) = grab(None, x, y, w, h)?;
            (px, m, String::new(), Vec::new(), (w, h))
        } else {
            let mut windows: Vec<Found> = Vec::new();
            unsafe { EnumWindows(collect, &mut windows as *mut Vec<Found> as isize) };
            let (hwnd, title, also) = match req.pid.filter(|p| *p > 0) {
                Some(pid) => {
                    let f = windows.iter().find(|w| w.pid == pid).ok_or_else(|| format!("process {pid} has no main window (still starting, or it draws none)"))?;
                    (f.hwnd, f.title.clone(), Vec::new())
                }
                None => {
                    let needle = req.title.clone().unwrap_or_default();
                    let mut ranked: Vec<(u8, &Found)> = windows
                        .iter()
                        .filter(|w| !w.title.is_empty())
                        .filter_map(|w| rank(&needle, &w.title, &process_name(w.pid)).map(|score| (score, w)))
                        .collect();
                    // Stable sort, so equal scores keep the order Windows enumerated them in.
                    ranked.sort_by_key(|c| c.0);
                    let (_, first) = ranked.first().ok_or_else(|| format!("no window matching '{needle}'"))?;
                    let also = ranked[1..].iter().map(|c| c.1.title.clone()).collect();
                    (first.hwnd, first.title.clone(), also)
                }
            };
            let mut r = Rect::default();
            if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
                return Err("could not read the window's position".into());
            }
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            if w <= 0 || h <= 0 {
                return Err("window has no size (minimised?)".into());
            }
            let (px, m) = grab(Some(hwnd), r.left, r.top, w, h)?;
            (px, m, title, also, (w, h))
        };

        let mut rgba = pixels;
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or("the pixel buffer did not match the size")?;
        img.save_with_format(&req.out, image::ImageFormat::Png).map_err(|e| format!("could not write the PNG: {e}"))?;
        let bytes = std::fs::metadata(&req.out).map(|m| m.len()).unwrap_or(0);
        Ok(Captured { window_title: title, also_matched: also, width: w as u32, height: h as u32, bytes, method })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Captured, Request};

    pub fn capture(_: &Request) -> Result<Captured, String> {
        Err("Window capture is only built for Windows in this desktop, so no image was taken.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_prefers_exact_then_process_then_prefix_then_substring() {
        assert_eq!(rank("Notepad", "notepad", "x"), Some(0));
        assert_eq!(rank("apim", "Settings", "apim"), Some(1));
        assert_eq!(rank("night", "nightfall - Everything", "everything"), Some(2));
        assert_eq!(rank("fall", "nightfall - Everything", "everything"), Some(3));
        assert_eq!(rank("zzz", "nightfall", "everything"), None);
    }

    #[test]
    fn no_target_is_refused_before_any_capture() {
        let req = Request { title: Some(String::new()), pid: None, out: PathBuf::from("x.png"), full_screen: false };
        assert!(capture(&req).unwrap_err().starts_with("Give a window title or the pid"));
    }
}
