//! What keeps a long chat quick: a message, or a row of a long reply, is laid out only while it shows.
//! Off screen it keeps the height it was last measured at, and one never measured is measured out of
//! sight a few milliseconds a frame, so no frame waits on it.

use eframe::egui::{self, Rect, Ui, vec2};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

/// What a message took when it was last laid out.
#[derive(Clone, Copy)]
pub struct Measured {
    pub width: f32,
    pub height: f32,
    /// What its height depends on besides its width (`print`). A different one means measure again.
    pub print: u64,
    /// Every row of it was laid out, none guessed.
    pub exact: bool,
    /// A height measured out of sight this frame. The next frame takes it up, so nothing on screen moves.
    pub next: Option<f32>,
    /// It sat above the window when `next` was measured: the view must follow its change.
    pub above: bool,
}

/// Hashes whatever a height depends on.
pub fn print(of: impl Hash) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    of.hash(&mut hasher);
    hasher.finish()
}

/// The rows inside replies: their heights, and how long this frame may spend measuring ones that do not show.
pub struct Rows {
    heights: HashMap<egui::Id, (u64, f32)>,
    deadline: Instant,
    /// A row was given a guessed height since `begin`.
    pub guessed: bool,
}

impl Default for Rows {
    fn default() -> Self {
        Rows { heights: HashMap::new(), deadline: Instant::now(), guessed: false }
    }
}

impl Rows {
    pub fn clear(&mut self) {
        self.heights.clear();
    }

    /// Starts a frame: measuring out of sight stops `budget` from now.
    pub fn begin(&mut self, budget: Duration) {
        self.deadline = Instant::now() + budget;
    }

    pub fn has_time(&self) -> bool {
        Instant::now() < self.deadline
    }

    /// True when the row was given its room without being laid out: it does not show, and its height is
    /// known. A row never measured is only skipped (at `guess`) in a measuring pass that ran out of time;
    /// on screen it is laid out at once, so what the user sees never rests on a guess.
    pub fn skip(&mut self, ui: &mut Ui, key: egui::Id, print: u64, guess: f32) -> bool {
        let known = self.heights.get(&key).filter(|row| row.0 == print).map(|row| row.1);
        let room = vec2(ui.available_width(), known.unwrap_or(guess));
        if ui.is_rect_visible(Rect::from_min_size(ui.cursor().min, room)) || (known.is_none() && (ui.is_visible() || self.has_time())) {
            return false;
        }
        self.guessed |= known.is_none();
        ui.allocate_space(room);
        true
    }

    pub fn store(&mut self, key: egui::Id, print: u64, height: f32) {
        self.heights.insert(key, (print, height));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_out_of_sight_keeps_its_height_and_a_new_one_is_measured() {
        let ctx = egui::Context::default();
        let mut rows = Rows::default();
        let key = egui::Id::new("row");
        let mut seen = Vec::new();
        let mut out = ctx.run_ui(egui::RawInput { screen_rect: Some(Rect::from_min_size(egui::Pos2::ZERO, vec2(400.0, 300.0))), ..Default::default() }, |ui| {
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            // On screen: laid out, whatever is known.
            seen.push(rows.skip(ui, key, 1, 40.0));
            rows.store(key, 1, 50.0);
            // Far below the window: the measured height stands, and the cursor moves by it.
            ui.add_space(5000.0);
            let top = ui.cursor().top();
            seen.push(rows.skip(ui, key, 1, 40.0));
            assert_eq!(ui.cursor().top() - top, 50.0);
            // Something it depends on changed: it is laid out again, out of sight or not.
            seen.push(rows.skip(ui, key, 2, 40.0));
        });
        out.textures_delta.clear();
        assert_eq!(seen, [false, true, false]);
        assert!(!rows.guessed);
    }
}
