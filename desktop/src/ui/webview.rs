//! The Browser pane's real browser (`browser::live::real`): a WebView2 view for each chat that browses, a window of its
//! own inside apiM's, placed over the pane's page. The user's clicks and keys reach it as they reach any browser, so a
//! site's check for a person can tell a person is there; in the headless pane every click was put in by apiM, and
//! Cloudflare's check asked again after each one. Its DevTools port is open, and the agent drives it over that
//! (`browser::cdp`) as it drove the headless one.

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use std::cell::RefCell;
use std::num::NonZeroIsize;
use std::rc::Rc;
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::{NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

/// apiM's window, as the parent the views live in.
#[derive(Clone, Copy)]
pub struct Parent(NonZeroIsize);

impl Parent {
    pub fn of(handle: &impl HasWindowHandle) -> Option<Parent> {
        match handle.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(w) => Some(Parent(w.hwnd)),
            _ => None,
        }
    }
}

impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(self.0))) })
    }
}

/// WebView2 is installed: it comes with Windows 11, and with Edge on Windows 10.
pub fn available() -> bool {
    wry::webview_version().is_ok()
}

pub struct View {
    view: WebView,
    _context: WebContext,
    /// Where it is, in physical pixels of the window, and how round its bottom corners are.
    bounds: [i32; 4],
    corner: i32,
    /// A page the view was asked to open in a new window, to open in its place.
    opened: Rc<RefCell<Option<String>>>,
}

impl View {
    /// A view at `mark`, the address the agent's side finds it by (`live::page`), out of sight until the pane places it.
    pub fn new(parent: Parent, mark: &str, ctx: &eframe::egui::Context) -> Result<View, String> {
        let mut context = WebContext::new(Some(crate::store::data_dir().join("webview")));
        // wry's own defaults, which these arguments replace, and the DevTools port, which the browser writes to
        // `EBWebView/DevToolsActivePort` in the data folder. A view out of sight is beside the window, not hidden, and
        // Windows is not to count it as covered: either way it stopped drawing, and the agent's screenshot of it waited
        // for good.
        let args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required --remote-debugging-port=0";
        // A link for a new tab opens in the view itself, as a pane has no tabs: WebView2 put it in a window of its own,
        // outside apiM and out of the agent's reach. A popup the page gave a size to (a sign-in with another site)
        // keeps its window, since it reports back to the page that opened it.
        let opened: Rc<RefCell<Option<String>>> = Default::default();
        let (asked, ctx) = (opened.clone(), ctx.clone());
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(mark)
            .with_new_window_req_handler(move |url, features| {
                if features.size.is_some() {
                    return NewWindowResponse::Allow;
                }
                *asked.borrow_mut() = Some(url);
                ctx.request_repaint();
                NewWindowResponse::Deny
            })
            .with_additional_browser_args(args)
            .with_autoplay(true)
            .with_background_color((22, 22, 22, 255))
            .with_bounds(Rect { position: PhysicalPosition::new(-30_000, 0).into(), size: PhysicalSize::new(1280, 800).into() })
            .build_as_child(&parent)
            .map_err(|e| e.to_string())?;
        Ok(View { view, _context: context, bounds: [-30_000, 0, 1280, 800], corner: 0, opened })
    }

    /// Shows it at `[x, y, w, h]` with its bottom corners `corner` round, as the pane's card is, or puts it out of
    /// sight at the size it had. Called every frame, it also opens a page asked for in a new window.
    pub fn place(&mut self, at: Option<([i32; 4], i32)>) {
        let (b, corner) = at.unwrap_or(([-30_000, 0, self.bounds[2], self.bounds[3]], 0));
        if b != self.bounds {
            let _ = self.view.set_bounds(Rect { position: PhysicalPosition::new(b[0], b[1]).into(), size: PhysicalSize::new(b[2].max(1) as u32, b[3].max(1) as u32).into() });
        }
        if (b[2], b[3], corner) != (self.bounds[2], self.bounds[3], self.corner) {
            round(self.view.hwnd().0 as isize, b[2], b[3], corner);
        }
        (self.bounds, self.corner) = (b, corner);
        if let Some(url) = self.opened.borrow_mut().take() {
            let _ = self.view.load_url(&url);
        }
    }
}

/// Cuts the window's bottom corners round; nothing can be drawn over the view to round them. The top of the shape
/// is past the window's top, so its top corners stay square under the pane's bar.
fn round(hwnd: isize, w: i32, h: i32, corner: i32) {
    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateRoundRectRgn(x1: i32, y1: i32, x2: i32, y2: i32, w: i32, h: i32) -> isize;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowRgn(hwnd: isize, rgn: isize, redraw: i32) -> i32;
    }
    unsafe {
        // The window owns the shape once it is set.
        let shape = if corner > 0 { CreateRoundRectRgn(0, -2 * corner, w + 1, h + 1, 2 * corner, 2 * corner) } else { 0 };
        SetWindowRgn(hwnd, shape, 1);
    }
}
