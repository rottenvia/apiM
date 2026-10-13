//! The loading screen of a start: the mark, a bar of how much of the chats is read, and how long is left.
//!
//! The window is up before the chats are: they are read on another thread (`store::Conversation::list_showing`)
//! and this covers the window until they are in, then fades over a window that is already in use.

use super::theme::{self, W, alpha, p};
use super::{App, chat, titlebar, widgets};
use crate::store::{ChatMeta, Conversation, Progress};
use eframe::egui::{self, Rect, Sense, emath::easing, pos2, vec2};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

/// The least the screen stays up: any shorter and it is a flicker, not a screen.
const LEAST: Duration = Duration::from_millis(260);
/// How long it takes to fade once the chats are in, and how long it first stays for its bar to be seen full.
const FADE: f32 = 0.24;
const FULL: Duration = Duration::from_millis(140);

/// The chats on their way in.
pub struct Boot {
    progress: Arc<Progress>,
    rx: mpsc::Receiver<Vec<ChatMeta>>,
    since: Instant,
    /// When they arrived.
    ready: Option<Instant>,
}

impl Boot {
    pub fn start(ctx: &egui::Context) -> Boot {
        let (progress, (tx, rx), wake) = (Arc::new(Progress::default()), mpsc::channel(), ctx.clone());
        let told = progress.clone();
        crate::background(move || {
            let started = Instant::now();
            let chats = Conversation::list_showing(Some(&told));
            if super::PERF.is_some() {
                eprintln!("{} chats listed in {:.0} ms, {:.0} MB read", chats.len(), started.elapsed().as_secs_f64() * 1000.0, told.megabytes());
            }
            let _ = tx.send(chats);
            wake.request_repaint();
        });
        Boot { progress, rx, since: Instant::now(), ready: None }
    }

    /// A self-portrait of the screen part way through: nothing is read and nothing arrives.
    pub fn staged() -> Boot {
        Boot { progress: Arc::new(Progress::staged(264 << 20, 150 << 20, 60 << 20)), rx: mpsc::channel().1, since: Instant::now(), ready: None }
    }

    /// The chats, the once they arrive.
    pub fn take(&mut self) -> Option<Vec<ChatMeta>> {
        let chats = self.rx.try_recv().ok()?;
        self.ready = Some(Instant::now());
        Some(chats)
    }

    pub fn loading(&self) -> bool {
        self.ready.is_none()
    }
}

/// "1.2s left": rounded up to a tenth of a second, so the figure counts down rather than flickers.
pub fn left(secs: f32) -> String {
    format!("{} left", chat::format_duration((secs * 10.0).ceil() as u64 * 100))
}

/// A thin bar filled to `share`, with a light that runs along what is filled while `busy`.
pub fn bar(ui: &egui::Ui, rect: Rect, share: f32, busy: bool, opacity: f32) {
    let p = p();
    let round = rect.height() / 2.0;
    ui.painter().rect_filled(rect, round, alpha(p.text, 9.0 * opacity));
    let filled = rect.with_max_x(rect.left() + (rect.width() * share.clamp(0.0, 1.0)).max(rect.height()));
    ui.painter().rect_filled(filled, round, p.accent.gamma_multiply(opacity));
    if busy {
        let at = (ui.input(|i| i.time) % 1.1 / 1.1) as f32;
        let light = Rect::from_center_size(pos2(filled.left() + filled.width() * at, rect.center().y), vec2(filled.width() * 0.35, rect.height()));
        ui.painter().with_clip_rect(filled).rect_filled(light, round, alpha(p.accent_light, 55.0 * opacity * (1.0 - (at - 0.5).abs() * 2.0)));
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let Some(boot) = app.boot.as_ref() else { return };
    let p = p();
    let gone = boot.ready.map_or(0.0, |at| (at + FULL).max(boot.since + LEAST).elapsed().as_secs_f32() / FADE);
    if gone >= 1.0 {
        app.boot = None;
        return;
    }
    let (loading, since) = (boot.loading(), boot.since.elapsed().as_secs_f32());
    let (share, secs) = if loading { boot.progress.eta() } else { (1.0, 0.0) };
    let megabytes = boot.progress.megabytes();
    // The mark and the bar come in over the first moments, and the whole screen goes out over the last.
    let come = easing::cubic_out((since / 0.2).min(1.0));
    let opacity = 1.0 - easing::cubic_in_out(gone);
    let screen = ctx.content_rect();
    let rect = screen.with_min_y(screen.top() + titlebar::HEIGHT);
    // While the chats are on their way nothing under it is to be clicked; once they are in, everything is.
    egui::Area::new(egui::Id::new("splash")).order(egui::Order::Foreground).fixed_pos(rect.min).interactable(loading).fade_in(false).show(ctx, |ui| {
        ui.allocate_rect(rect, if loading { Sense::click_and_drag() } else { Sense::hover() });
        ui.painter().rect_filled(rect, 0.0, p.bg2.gamma_multiply(opacity));
        let seen = opacity * come;
        let centre = rect.center() + vec2(0.0, -24.0 + 8.0 * (1.0 - come) - 10.0 * easing::cubic_in(gone));
        // The app's mark: three dots, the middle one raised. Each rises in its turn while the chats come in.
        let time = ui.input(|i| i.time) as f32;
        for dot in 0..3 {
            let wave = if loading { ((time * 4.2 - dot as f32 * 0.9).sin().max(0.0)).powi(2) } else { 0.0 };
            let at = centre + vec2((dot as f32 - 1.0) * 26.0, -36.0 - if dot == 1 { 8.0 } else { 0.0 } - 5.0 * wave);
            ui.painter().circle_filled(at, 9.0, p.accent.gamma_multiply(seen * (0.82 + 0.18 * wave)));
        }
        let name = widgets::galley(ui, "apiM", theme::serif(26.0), p.text.gamma_multiply(seen));
        ui.painter().galley(pos2(centre.x - name.size().x / 2.0, centre.y - 8.0), name, p.text);

        let track = Rect::from_center_size(centre + vec2(0.0, 44.0), vec2(240.0, 4.0));
        let shown = widgets::glide(ctx, egui::Id::new("splash-bar"), share, 0.12, true);
        bar(ui, track, shown, loading, seen);
        let small = |text: &str| widgets::galley(ui, text, theme::font(11.0, W::Regular), p.muted.gamma_multiply(seen));
        let doing = if megabytes >= 1.0 { format!("Reading chats · {megabytes:.0} MB") } else { "Starting".to_string() };
        ui.painter().galley(pos2(track.left(), track.bottom() + 10.0), small(&doing), p.muted);
        if loading && secs >= 0.1 {
            let wait = small(&left(secs));
            ui.painter().galley(pos2(track.right() - wait.size().x, track.bottom() + 10.0), wait, p.muted);
        }
    });
    ctx.request_repaint();
}
