//! Pictures shown without the nothing around them. A screenshot of a small window on an empty desktop is mostly
//! desktop: the chat showed a black box with a stamp-sized window in it. The plain border is found once per file,
//! on another thread (a screenshot takes tens of milliseconds to decode), and only the rest is drawn.

use eframe::egui::{self, Rect, Vec2, pos2, vec2};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// Kept around the subject, in pixels.
const MARGIN: u32 = 12;
/// A pixel this close to the border's colour, per channel, is border.
const TOLERANCE: u8 = 8;
/// The subject must leave at least this share of the picture empty for the cut to be worth making.
const WORTH_IT: f32 = 0.3;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Trim {
    /// The part to show, as shares of the picture.
    pub uv: Rect,
    /// That part's size in pixels.
    pub size: Vec2,
}

#[derive(Clone, Copy)]
pub enum Look {
    /// Still being worked out: draw nothing yet.
    Pending,
    /// Not a picture this app reads.
    Unreadable,
    Ready(Trim),
}

static KNOWN: LazyLock<Mutex<HashMap<(PathBuf, Option<SystemTime>), Look>>> = LazyLock::new(Default::default);
static DONE: AtomicU64 = AtomicU64::new(0);

/// Goes up each time a picture has been looked at: what was laid out before then may have changed height.
pub fn generation() -> u64 {
    DONE.load(Ordering::Relaxed)
}

/// What to show of the picture at `path`. A file written again is looked at again.
pub fn of(ctx: &egui::Context, path: &Path) -> Look {
    let key = (path.to_path_buf(), std::fs::metadata(path).and_then(|m| m.modified()).ok());
    let mut known = KNOWN.lock().unwrap();
    if let Some(look) = known.get(&key) {
        return *look;
    }
    known.insert(key.clone(), Look::Pending);
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let look = image::open(&key.0).map_or(Look::Unreadable, |picture| {
            let picture = picture.to_rgba8();
            let (w, h) = (picture.width(), picture.height());
            let [x0, y0, x1, y1] = content_box(w, h, |x, y| picture.get_pixel(x, y).0);
            let share = |x: u32, y: u32| pos2(x as f32 / w.max(1) as f32, y as f32 / h.max(1) as f32);
            Look::Ready(Trim { uv: Rect::from_min_max(share(x0, y0), share(x1, y1)), size: vec2((x1 - x0) as f32, (y1 - y0) as f32) })
        });
        KNOWN.lock().unwrap().insert(key, look);
        DONE.fetch_add(1, Ordering::Relaxed);
        ctx.request_repaint();
    });
    Look::Pending
}

/// The box (left, top, right, bottom; the last two past the end) holding everything that is not the border's
/// colour, with a margin. The whole picture when its corners disagree on a border colour, when nothing stands
/// out from it, or when the border is too thin to matter.
fn content_box(w: u32, h: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> [u32; 4] {
    let whole = [0, 0, w, h];
    if w < 64 || h < 64 {
        return whole;
    }
    let border = pixel(0, 0);
    let is_border = |p: [u8; 4]| p.iter().zip(border).all(|(a, b)| a.abs_diff(b) <= TOLERANCE);
    if ![(w - 1, 0), (0, h - 1), (w - 1, h - 1)].into_iter().all(|(x, y)| is_border(pixel(x, y))) {
        return whole;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if !is_border(pixel(x, y)) {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
            }
        }
    }
    if x1 <= x0 {
        return whole;
    }
    let cut = [x0.saturating_sub(MARGIN), y0.saturating_sub(MARGIN), (x1 + MARGIN).min(w), (y1 + MARGIN).min(h)];
    let kept = ((cut[2] - cut[0]) as f32 * (cut[3] - cut[1]) as f32) / (w as f32 * h as f32);
    if kept > 1.0 - WORTH_IT { whole } else { cut }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_window_on_an_empty_desktop_is_cut_out() {
        const BLACK: [u8; 4] = [0, 0, 0, 255];
        // A 200x290 window at (190, 100) on a 1600x1000 black screen, as the sandbox captures it.
        let window = |x: u32, y: u32| if (190..390).contains(&x) && (100..390).contains(&y) { [40, 44, 52, 255] } else { BLACK };
        assert_eq!(content_box(1600, 1000, window), [178, 88, 402, 402]);
        // Nothing on it, a picture that fills its frame, and a subject too large to be worth cutting: left whole.
        assert_eq!(content_box(1600, 1000, |_, _| BLACK), [0, 0, 1600, 1000]);
        assert_eq!(content_box(800, 600, |x, y| [(x % 256) as u8, (y % 256) as u8, 90, 255]), [0, 0, 800, 600]);
        assert_eq!(content_box(800, 600, |x, y| if x > 20 && x < 780 && y > 20 { [200, 200, 200, 255] } else { BLACK }), [0, 0, 800, 600]);
        // A subject in a corner is the corner: there is no telling it from a border, so nothing is cut.
        let corner = |x: u32, y: u32| if x < 100 && y < 80 { [250, 250, 250, 255] } else { [3 + (x % 3) as u8, 2, 4, 255] };
        assert_eq!(content_box(1000, 800, corner), [0, 0, 1000, 800]);
        // One on an edge keeps that edge, and compression noise in the border is still border.
        let edge = |x: u32, y: u32| if x < 300 && (250..550).contains(&y) { [250, 250, 250, 255] } else { [3 + (x % 3) as u8, 2, 4, 255] };
        assert_eq!(content_box(1000, 800, edge), [0, 238, 312, 562]);
    }
}
