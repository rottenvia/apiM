//! The user's own screen, mouse and keyboard, for the Computer toggle (`tools::computer`). Windows only: elsewhere
//! every call says it is not built.

/// A window on the screen, in screen pixels.
#[derive(Debug, Clone, Default)]
pub struct Win {
    pub hwnd: isize,
    pub title: String,
    /// The executable's name without `.exe`.
    pub process: String,
    pub pid: u32,
    pub rect: (i32, i32, i32, i32),
    pub minimized: bool,
    pub foreground: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// A key by its name ("enter", "f5", "a", "ctrl"), as (virtual-key code, extended key).
pub fn key_code(name: &str) -> Option<(u16, bool)> {
    let name = name.trim().to_ascii_lowercase();
    let code = match name.as_str() {
        "enter" | "return" => (0x0D, false),
        "tab" => (0x09, false),
        "esc" | "escape" => (0x1B, false),
        "space" => (0x20, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, true),
        "insert" | "ins" => (0x2D, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" | "pgup" => (0x21, true),
        "pagedown" | "pgdn" => (0x22, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        "shift" => (0xA0, false),
        "ctrl" | "control" => (0xA2, false),
        "alt" => (0xA4, false),
        "win" | "windows" | "meta" | "super" | "cmd" => (0x5B, true),
        "capslock" => (0x14, false),
        "printscreen" | "prtsc" => (0x2C, true),
        "menu" | "apps" => (0x5D, true),
        "minus" | "-" => (0xBD, false),
        "plus" | "equal" | "=" => (0xBB, false),
        "comma" | "," => (0xBC, false),
        "period" | "." => (0xBE, false),
        "slash" | "/" => (0xBF, false),
        "backslash" | "\\" => (0xDC, false),
        "semicolon" | ";" => (0xBA, false),
        "quote" | "'" => (0xDE, false),
        "grave" | "backquote" | "`" => (0xC0, false),
        "bracketleft" | "[" => (0xDB, false),
        "bracketright" | "]" => (0xDD, false),
        f if f.len() > 1 && f.starts_with('f') && f[1..].parse::<u16>().is_ok_and(|n| (1..=24).contains(&n)) => (0x6F + f[1..].parse::<u16>().unwrap(), false),
        c if c.len() == 1 && c.as_bytes()[0].is_ascii_alphanumeric() => (c.as_bytes()[0].to_ascii_uppercase() as u16, false),
        _ => return None,
    };
    Some(code)
}

/// "ctrl+shift+s" as its keys, modifiers first. Err names the part that is not a key.
pub fn combo(text: &str) -> Result<Vec<(u16, bool)>, String> {
    let text = text.trim();
    // "ctrl++" and a bare "+" mean the plus key.
    let parts: Vec<&str> = if text == "+" {
        vec!["plus"]
    } else if let Some(head) = text.strip_suffix("++") {
        head.split('+').chain(["plus"]).collect()
    } else {
        text.split('+').collect()
    };
    parts.iter().map(|part| key_code(part).ok_or_else(|| format!("\"{part}\" is not a key name"))).collect()
}

pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::{Button, Win};
    use std::ffi::c_void;

    type Hwnd = isize;
    type Hdc = isize;
    type Handle = isize;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
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

    /// BITMAPINFO, shaped as `browser::window` declares it: two declarations of one function must agree.
    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeybdInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }

    #[repr(C)]
    union InputData {
        mouse: MouseInput,
        key: KeybdInput,
    }

    #[repr(C)]
    struct Input {
        kind: u32,
        data: InputData,
    }

    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        hwnd: Hwnd,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        inst_app: isize,
        id_list: *mut c_void,
        class: *const u16,
        hkey_class: isize,
        hot_key: u32,
        icon: isize,
        process: Handle,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetDC(h: Hwnd) -> Hdc;
        fn ReleaseDC(h: Hwnd, hdc: Hdc) -> i32;
        fn EnumWindows(cb: extern "system" fn(Hwnd, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowTextW(h: Hwnd, buf: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(h: Hwnd) -> i32;
        fn IsIconic(h: Hwnd) -> i32;
        fn GetWindowRect(h: Hwnd, r: *mut Rect) -> i32;
        fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
        fn GetForegroundWindow() -> Hwnd;
        fn SetForegroundWindow(h: Hwnd) -> i32;
        fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
        fn GetCursorPos(p: *mut Point) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn MapVirtualKeyW(code: u32, kind: u32) -> u32;
        fn AttachThreadInput(attach: u32, to: u32, on: i32) -> i32;
        fn SetProcessDpiAwarenessContext(context: isize) -> i32;
        fn BringWindowToTop(h: Hwnd) -> i32;
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
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn GetProcessId(h: Handle) -> u32;
        fn QueryFullProcessImageNameW(process: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn GetCurrentThreadId() -> u32;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmGetWindowAttribute(h: Hwnd, attribute: u32, value: *mut c_void, size: u32) -> i32;
    }

    const SRCCOPY: u32 = 0x00CC_0020;
    /// Layered windows (menus, tooltips, overlays) are in the copy too.
    const CAPTUREBLT: u32 = 0x4000_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const DWMWA_CLOAKED: u32 = 14;
    const INPUT_MOUSE: u32 = 0;
    const INPUT_KEYBOARD: u32 = 1;
    const MOUSE_MOVE: u32 = 0x0001;
    const MOUSE_WHEEL: u32 = 0x0800;
    const MOUSE_HWHEEL: u32 = 0x1000;
    const MOUSE_ABSOLUTE: u32 = 0x8000;
    const MOUSE_VIRTUALDESK: u32 = 0x4000;
    const KEY_EXTENDED: u32 = 0x0001;
    const KEY_UP: u32 = 0x0002;
    const KEY_UNICODE: u32 = 0x0004;

    /// Real pixels from here on. The window is DPI-aware through winit; terminal mode is not, and on a scaled display it
    /// would be told a smaller desktop, shown a blurred one, and given window places that do not match either. Asking
    /// again where it already is fails and changes nothing.
    fn aware() {
        static AWARE: std::sync::Once = std::sync::Once::new();
        AWARE.call_once(|| unsafe {
            SetProcessDpiAwarenessContext(-4);
        });
    }

    /// The whole desktop across every monitor: (left, top, width, height), in real pixels.
    pub fn screen() -> (i32, i32, i32, i32) {
        aware();
        unsafe { (GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78).max(1), GetSystemMetrics(79).max(1)) }
    }

    /// Every monitor's pixels as they are on screen now.
    pub fn capture() -> Result<image::RgbaImage, String> {
        let (x, y, w, h) = screen();
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let rows = unsafe {
            let screen = GetDC(0);
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp);
            BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
            let mut info = BitmapInfo { header: BitmapInfoHeader { size: 40, width: w, height: -h, planes: 1, bit_count: 32, ..Default::default() }, colors: [0] };
            let rows = GetDIBits(mem, bmp, 0, h as u32, pixels.as_mut_ptr(), &mut info, 0);
            SelectObject(mem, old);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(0, screen);
            rows
        };
        if rows == 0 {
            return Err("the screen could not be read (a locked or secure desktop is not readable)".into());
        }
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        image::RgbaImage::from_raw(w as u32, h as u32, pixels).ok_or_else(|| "the pixel buffer did not match the screen's size".into())
    }

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
        std::path::Path::new(&full).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }

    extern "system" fn collect(h: Hwnd, lparam: isize) -> i32 {
        // SAFETY: lparam is the &mut Vec<Win> that windows() passed to EnumWindows, live for the whole call.
        let out = unsafe { &mut *(lparam as *mut Vec<Win>) };
        if unsafe { IsWindowVisible(h) } == 0 {
            return 1;
        }
        // A cloaked window (a suspended store app, another virtual desktop's) is "visible" but not on screen.
        let mut cloaked = 0u32;
        unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4) };
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) };
        if cloaked != 0 || n <= 0 {
            return 1;
        }
        let (mut r, mut pid) = (Rect::default(), 0u32);
        unsafe {
            GetWindowRect(h, &mut r);
            GetWindowThreadProcessId(h, &mut pid);
        }
        let minimized = unsafe { IsIconic(h) } != 0;
        if !minimized && (r.right - r.left <= 1 || r.bottom - r.top <= 1) {
            return 1;
        }
        out.push(Win { hwnd: h, title: String::from_utf16_lossy(&buf[..n as usize]), process: String::new(), pid, rect: (r.left, r.top, r.right, r.bottom), minimized, foreground: false });
        1
    }

    /// The windows on screen, front to back.
    pub fn windows() -> Vec<Win> {
        aware();
        let mut found: Vec<Win> = Vec::new();
        unsafe { EnumWindows(collect, &mut found as *mut Vec<Win> as isize) };
        let front = unsafe { GetForegroundWindow() };
        for w in &mut found {
            w.process = process_name(w.pid);
            w.foreground = w.hwnd == front;
        }
        found
    }

    /// Brings a window to the front, restoring it when minimized. False when Windows kept another one in front.
    pub fn focus(w: &Win) -> bool {
        unsafe {
            if IsIconic(w.hwnd) != 0 {
                ShowWindow(w.hwnd, 9);
            }
            if SetForegroundWindow(w.hwnd) != 0 && GetForegroundWindow() == w.hwnd {
                return true;
            }
            // Windows keeps a program the user is not using from taking the front. Joined for a moment to the input of
            // the window in front, this thread counts as that window's, and the change is let through.
            let front = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
            let me = GetCurrentThreadId();
            let joined = front != 0 && front != me && AttachThreadInput(me, front, 1) != 0;
            BringWindowToTop(w.hwnd);
            SetForegroundWindow(w.hwnd);
            if joined {
                AttachThreadInput(me, front, 0);
            }
            GetForegroundWindow() == w.hwnd
        }
    }

    pub fn cursor() -> (i32, i32) {
        aware();
        let mut p = Point::default();
        unsafe { GetCursorPos(&mut p) };
        (p.x, p.y)
    }

    fn send(inputs: &[Input]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            // A window of an elevated program refuses input from one that is not.
            Err("Windows did not take the input: the window in front may belong to a program run as administrator, or the screen is locked".into())
        }
    }

    fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> Input {
        Input { kind: INPUT_MOUSE, data: InputData { mouse: MouseInput { dx, dy, data, flags, time: 0, extra: 0 } } }
    }

    fn key_input(vk: u16, scan: u16, flags: u32) -> Input {
        Input { kind: INPUT_KEYBOARD, data: InputData { key: KeybdInput { vk, scan, flags, time: 0, extra: 0 } } }
    }

    /// Puts the pointer on a screen pixel, as a real move: programs see it travel there.
    pub fn move_to(x: i32, y: i32) -> Result<(), String> {
        let (vx, vy, vw, vh) = screen();
        let norm = |at: i32, origin: i32, size: i32| ((at - origin) as i64 * 65535 / (size - 1).max(1) as i64) as i32;
        send(&[mouse(MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK, norm(x, vx, vw), norm(y, vy, vh), 0)])?;
        // The normalised scale can land a pixel off on a wide desktop: the last pixel is set exactly.
        let (cx, cy) = cursor();
        if (cx - x).abs() > 0 || (cy - y).abs() > 0 {
            unsafe { SetCursorPos(x, y) };
        }
        Ok(())
    }

    pub fn press(button: Button, down: bool) -> Result<(), String> {
        let flags = match (button, down) {
            (Button::Left, true) => 0x0002,
            (Button::Left, false) => 0x0004,
            (Button::Right, true) => 0x0008,
            (Button::Right, false) => 0x0010,
            (Button::Middle, true) => 0x0020,
            (Button::Middle, false) => 0x0040,
        };
        send(&[mouse(flags, 0, 0, 0)])
    }

    /// Wheel notches where the pointer is: positive away from the user (up) or to the right.
    pub fn wheel(notches: i32, horizontal: bool) -> Result<(), String> {
        send(&[mouse(if horizontal { MOUSE_HWHEEL } else { MOUSE_WHEEL }, 0, 0, (notches * 120) as u32)])
    }

    /// One key down or up, by virtual-key code. The scan code goes with it: games read keys by scan code.
    pub fn key((vk, extended): (u16, bool), down: bool) -> Result<(), String> {
        let scan = unsafe { MapVirtualKeyW(vk as u32, 0) } as u16;
        let flags = if extended { KEY_EXTENDED } else { 0 } | if down { 0 } else { KEY_UP };
        send(&[key_input(vk, scan, flags)])
    }

    /// Text as typed characters, whatever the keyboard layout. A line break is the Enter key, a tab the Tab key.
    pub fn text(text: &str) -> Result<(), String> {
        for c in text.chars() {
            match c {
                '\n' => tap((0x0D, false))?,
                '\t' => tap((0x09, false))?,
                '\r' => {}
                c => {
                    let mut units = [0u16; 2];
                    let inputs: Vec<Input> = c.encode_utf16(&mut units).iter().flat_map(|&u| [key_input(0, u, KEY_UNICODE), key_input(0, u, KEY_UNICODE | KEY_UP)]).collect();
                    send(&inputs)?;
                }
            }
            // Some programs drop characters that come faster than a fast typist.
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
        Ok(())
    }

    fn tap(code: (u16, bool)) -> Result<(), String> {
        key(code, true)?;
        key(code, false)
    }

    /// Opens a program, file, folder, link or `scheme://` address as a double-click would, with `params` as its
    /// command line. The process it started, when Windows says which (a link handed to a running program has none).
    pub fn open(target: &str, params: &str) -> Result<Option<u32>, String> {
        let (target, params) = (target.to_string(), params.to_string());
        // On a thread of its own: the shell wants COM set up on the thread that asks, and a tokio worker is not one to change.
        std::thread::spawn(move || {
            let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
            let (verb, file, args) = (wide("open"), wide(&target), wide(&params));
            let mut info = ShellExecuteInfo {
                size: std::mem::size_of::<ShellExecuteInfo>() as u32,
                // NOCLOSEPROCESS | NOASYNC | FLAG_NO_UI
                mask: 0x40 | 0x100 | 0x400,
                hwnd: 0,
                verb: verb.as_ptr(),
                file: file.as_ptr(),
                parameters: if params.is_empty() { std::ptr::null() } else { args.as_ptr() },
                directory: std::ptr::null(),
                show: 1,
                inst_app: 0,
                id_list: std::ptr::null_mut(),
                class: std::ptr::null(),
                hkey_class: 0,
                hot_key: 0,
                icon: 0,
                process: 0,
            };
            unsafe {
                let com = CoInitializeEx(std::ptr::null_mut(), 0x2 | 0x4);
                let ok = ShellExecuteExW(&mut info);
                if com >= 0 {
                    CoUninitialize();
                }
                if ok == 0 {
                    return Err(format!("Windows could not open \"{target}\": {}", std::io::Error::last_os_error()));
                }
                if info.process == 0 {
                    return Ok(None);
                }
                let pid = GetProcessId(info.process);
                CloseHandle(info.process);
                Ok(Some(pid).filter(|p| *p > 0))
            }
        })
        .join()
        .unwrap_or_else(|_| Err("opening it failed inside Windows".into()))
    }

    /// Every running process as (pid, its executable's name without `.exe`).
    pub fn processes() -> Vec<(u32, String)> {
        let all = crate::winproc::processes().unwrap_or_default();
        all.into_iter().map(|p| (p.pid, p.name.strip_suffix(".exe").or_else(|| p.name.strip_suffix(".EXE")).unwrap_or(&p.name).to_string())).collect()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Button, Win};
    const NOT_BUILT: &str = "Computer use is only built for Windows in this desktop.";

    pub fn screen() -> (i32, i32, i32, i32) {
        (0, 0, 1, 1)
    }
    pub fn capture() -> Result<image::RgbaImage, String> {
        Err(NOT_BUILT.into())
    }
    pub fn windows() -> Vec<Win> {
        Vec::new()
    }
    pub fn focus(_: &Win) -> bool {
        false
    }
    pub fn cursor() -> (i32, i32) {
        (0, 0)
    }
    pub fn move_to(_: i32, _: i32) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    pub fn press(_: Button, _: bool) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    pub fn wheel(_: i32, _: bool) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    pub fn key(_: (u16, bool), _: bool) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    pub fn text(_: &str) -> Result<(), String> {
        Err(NOT_BUILT.into())
    }
    pub fn open(_: &str, _: &str) -> Result<Option<u32>, String> {
        Err(NOT_BUILT.into())
    }
    pub fn processes() -> Vec<(u32, String)> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_combos_are_read_by_name() {
        assert_eq!(key_code("Enter"), Some((0x0D, false)));
        assert_eq!(key_code("f5"), Some((0x74, false)));
        assert_eq!(key_code("f24"), Some((0x87, false)));
        assert_eq!(key_code("w"), Some((0x57, false)));
        assert_eq!(key_code("7"), Some((0x37, false)));
        assert_eq!(key_code("left"), Some((0x25, true)));
        assert_eq!(key_code("f25"), None);
        assert_eq!(combo("ctrl+shift+s").unwrap(), [(0xA2, false), (0xA0, false), (0x53, false)]);
        assert_eq!(combo("ctrl++").unwrap(), [(0xA2, false), (0xBB, false)]);
        assert!(combo("ctrl+banana").unwrap_err().contains("banana"));
    }
}
