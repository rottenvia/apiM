//! How selected text looks, what keeps a selection in a long chat alive while it is scrolled, and a way to select
//! and copy in a self-portrait with no mouse.
//!
//! egui paints a selection as a square box inside each line of the text it belongs to. `round` runs when a frame
//! has been drawn: it empties those boxes and draws the same shape, with rounded corners, under the text.

use eframe::egui::{self, Color32, CornerRadius, Pos2, Rect, Shape, epaint::TextShape, layers::ShapeIdx};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

const RADIUS: u8 = 4;

/// The selected stretch of each line of one text, as egui left it: the last four points of the line's mesh, in
/// the selection's colour. They are made see-through, and their boxes come back in screen coordinates.
// ponytail: this reads how egui 0.36 builds its selection (`paint_text_selection`). An egui that builds it
// another way leaves the boxes square and nothing else changes: check this when the version moves.
fn take_boxes(text: &mut TextShape, fill: Color32, inked: (Color32, Color32)) -> Vec<Rect> {
    let selected = |points: &[egui::epaint::Vertex]| points.len() >= 4 && points[points.len() - 4..].iter().all(|v| v.color == fill);
    // Looked at before anything is copied: nearly every text on screen has no selection in it.
    if !text.galley.rows.iter().any(|placed| selected(&placed.row.visuals.mesh.vertices)) {
        return Vec::new();
    }
    let origin = text.pos.to_vec2();
    let mut boxes = Vec::new();
    for placed in &mut Arc::make_mut(&mut text.galley).rows {
        if !selected(&placed.row.visuals.mesh.vertices) {
            continue;
        }
        let points = &mut Arc::make_mut(&mut placed.row).visuals.mesh.vertices;
        let corners = points.len() - 4;
        boxes.push(Rect::from_min_max(points[corners].pos, points[corners + 3].pos).translate(placed.pos.to_vec2() + origin));
        points[corners..].iter_mut().for_each(|v| v.color = Color32::TRANSPARENT);
        // egui inks selected letters in the colour of the selection's outline, which is a border's grey here.
        points.iter_mut().filter(|v| v.color == inked.0).for_each(|v| v.color = inked.1);
    }
    boxes
}

/// The lines of one selection as a single rounded shape: a corner is round where its box stands out past the
/// line above or below, or has no line there.
fn rounded(boxes: &[Rect], fill: Color32) -> Vec<Shape> {
    let r = |round: bool| if round { RADIUS } else { 0 };
    (0..boxes.len())
        .map(|i| {
            let (b, above, below) = (boxes[i], i.checked_sub(1).map(|j| boxes[j]), boxes.get(i + 1));
            let radius = CornerRadius {
                nw: r(above.is_none_or(|a| b.left() < a.left() - 0.5)),
                ne: r(above.is_none_or(|a| b.right() > a.right() + 0.5)),
                sw: r(below.is_none_or(|n| b.left() < n.left() - 0.5)),
                se: r(below.is_none_or(|n| b.right() > n.right() + 0.5)),
            };
            Shape::rect_filled(b, radius, fill)
        })
        .collect()
}

/// Rounds every selection drawn this frame. Call it once everything has been drawn.
pub fn round(ctx: &egui::Context) {
    let visuals = &ctx.global_style().visuals;
    let (fill, inked) = (visuals.selection.bg_fill, (visuals.selection.stroke.color, super::theme::p().text));
    let layers: Vec<egui::LayerId> = std::iter::once(egui::LayerId::background()).chain(ctx.memory(|m| m.layer_ids().collect::<Vec<_>>())).collect();
    ctx.graphics_mut(|graphics| {
        for layer in layers {
            let Some(list) = graphics.get_mut(layer) else { continue };
            let texts: Vec<usize> = list.all_entries().enumerate().filter(|(_, entry)| matches!(entry.shape, Shape::Text(_))).map(|(i, _)| i).collect();
            for i in texts {
                list.mutate_shape(ShapeIdx(i), |entry| {
                    let Shape::Text(text) = &mut entry.shape else { return };
                    let boxes = take_boxes(text, fill, inked);
                    if !boxes.is_empty() {
                        let mut shapes = rounded(&boxes, fill);
                        shapes.push(std::mem::replace(&mut entry.shape, Shape::Noop));
                        entry.shape = Shape::Vec(shapes);
                    }
                });
            }
        }
    });
}

/// A selection in the transcript, kept as places in it: the message each is in and how far down that message.
/// egui lets a selection go in any frame that does not lay out both its ends, and a long chat lays out only what
/// shows: scrolled while selecting, the start went out of sight and the selection with it. What lies between the
/// start and the window the selection was last dragged in is laid out for as long as it lasts, off screen too
/// (`chat::messages`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
    /// Where the mouse went down.
    pub from: (usize, f32),
    /// The window's top and bottom when the selection was last dragged. Its other end is in there: under the
    /// mouse, or, with the mouse between texts or past an edge, on the last text it crossed. egui finds that text
    /// where it was a frame ago, so a wheel that moved the view a long way took it out of sight of a point.
    pub view: [(usize, f32); 2],
}

impl Span {
    /// The stretch of message `i`, its top at `top` on screen, that has to be laid out: none outside the selection.
    /// Nothing past the window: egui takes a text laid out below the window, with the mouse below it, as dragged
    /// over, and the selection would run to the end of the chat at once.
    pub fn keep(&self, i: usize, top: f32) -> Option<(f32, f32)> {
        let (a, b) = (if self.from < self.view[0] { self.from } else { self.view[0] }, if self.from > self.view[1] { self.from } else { self.view[1] });
        (a.0 <= i && i <= b.0).then(|| (if i == a.0 { top + a.1 } else { f32::NEG_INFINITY }, if i == b.0 { top + b.1 } else { f32::INFINITY }))
    }
}

/// How far a selection held at height `y` scrolls a view from `top` to `bottom` in `dt` seconds: not at all inside
/// it, and past an edge towards it, the faster the further past, as a browser does.
pub fn edge_scroll(y: f32, top: f32, bottom: f32, dt: f32) -> f32 {
    let past = (y - bottom).max(0.0) + (y - top).min(0.0);
    if past == 0.0 { 0.0 } else { past.signum() * (60.0 + past.abs() * 10.0).min(3000.0) * dt }
}

/// A self-portrait's `select-X1-Y1-X2-Y2`: the mouse goes down at one point, is dragged to the other and let
/// go, and Ctrl+C follows, one step a frame from 800 ms on, or `late-MS` later (an `up-N` glides for a while). With
/// `wheel-N` the wheel turns N points down halfway there, with `hold-MS` the mouse stays down at the other point
/// that long before it is let go (past an edge, the view scrolls meanwhile), and with `away-N` the wheel turns N
/// points down once it is let go, before Ctrl+C. Fed to the app as input: no real mouse moves.
pub fn replay(input: &mut egui::RawInput, at: Duration, from: Pos2, to: Pos2, [wheel, away]: [f32; 2], hold: u128, late: u128) {
    static STEP: AtomicU8 = AtomicU8::new(0);
    let button = |pos, pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() };
    let turn = |points: f32| if points == 0.0 { vec![] } else { vec![egui::Event::MouseWheel { unit: egui::MouseWheelUnit::Point, delta: egui::vec2(0.0, -points), phase: egui::TouchPhase::Move, modifiers: Default::default() }] };
    let (turned, gone) = (if wheel == 0.0 { 0 } else { 700 }, if away == 0.0 { 0 } else { 700 });
    let plan = [
        (800, vec![egui::Event::PointerMoved(from), button(from, true)]),
        (870, vec![egui::Event::PointerMoved(from + (to - from) / 2.0)]),
        (900, turn(wheel)),
        (940 + turned, vec![egui::Event::PointerMoved(to)]),
        (1010 + turned + hold, vec![button(to, false)]),
        (1060 + turned + hold, turn(away)),
        (1110 + turned + hold + gone, vec![egui::Event::Copy]),
    ];
    let step = STEP.load(Ordering::Relaxed) as usize;
    let Some((due, events)) = plan.into_iter().nth(step) else { return };
    if at.as_millis() >= due + late {
        input.events.extend(events);
        STEP.store(step as u8 + 1, Ordering::Relaxed);
    }
}

/// A self-portrait's `click-X-Y`: the mouse comes to rest on the point, goes down 400 ms in and comes up 70 ms
/// later, as a hand does it. Fed to the app as input: no real mouse moves.
pub fn click(input: &mut egui::RawInput, at: Duration, on: Pos2, which: egui::PointerButton) {
    static STEP: AtomicU8 = AtomicU8::new(0);
    let button = |pressed| egui::Event::PointerButton { pos: on, button: which, pressed, modifiers: Default::default() };
    let (step, ms) = (STEP.load(Ordering::Relaxed), at.as_millis());
    let event = match step {
        0 if ms >= 250 => egui::Event::PointerMoved(on),
        1 if ms >= 400 => button(true),
        2 if ms >= 470 => button(false),
        _ => return,
    };
    input.events.push(event);
    STEP.store(step + 1, Ordering::Relaxed);
}

/// Prints what a self-portrait copied and keeps it from the real clipboard.
pub struct Told;

impl egui::plugin::Plugin for Told {
    fn debug_name(&self) -> &'static str {
        "told"
    }

    fn output_hook(&mut self, _ctx: &egui::Context, output: &mut egui::FullOutput) {
        output.platform_output.commands.retain(|command| match command {
            egui::OutputCommand::CopyText(text) => {
                eprintln!("copied: {text:?}");
                false
            }
            _ => true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eframe::egui::pos2;

    #[test]
    fn a_selection_over_three_lines_is_round_where_it_stands_out() {
        // Starts mid-line, runs the full second line, ends mid-line.
        let boxes = [Rect::from_min_max(pos2(40.0, 0.0), pos2(200.0, 20.0)), Rect::from_min_max(pos2(0.0, 20.0), pos2(200.0, 40.0)), Rect::from_min_max(pos2(0.0, 40.0), pos2(90.0, 60.0))];
        let corners: Vec<CornerRadius> = rounded(&boxes, Color32::WHITE).into_iter().map(|shape| if let Shape::Rect(rect) = shape { rect.corner_radius } else { unreachable!() }).collect();
        let c = |nw, ne, sw, se| CornerRadius { nw, ne, sw, se };
        assert_eq!(corners, [c(RADIUS, RADIUS, 0, 0), c(RADIUS, 0, 0, RADIUS), c(0, 0, RADIUS, RADIUS)]);
    }

    #[test]
    fn a_span_keeps_what_lies_between_its_start_and_the_window() {
        // Started 30 points into message 2, last dragged with the window from 50 points into message 4 to 10 into 6.
        let span = Span { from: (2, 30.0), view: [(4, 50.0), (6, 10.0)] };
        assert_eq!(span.keep(1, 0.0), None);
        assert_eq!(span.keep(2, 100.0), Some((130.0, f32::INFINITY)));
        assert_eq!(span.keep(4, 900.0), Some((f32::NEG_INFINITY, f32::INFINITY)));
        assert_eq!(span.keep(6, 2000.0), Some((f32::NEG_INFINITY, 2010.0)));
        assert_eq!(span.keep(7, 0.0), None);
        // Dragged up from below the window, and from inside it.
        assert_eq!(Span { from: (8, 40.0), view: [(4, 50.0), (6, 10.0)] }.keep(4, 900.0), Some((950.0, f32::INFINITY)));
        assert_eq!(Span { from: (5, 20.0), view: [(5, 0.0), (5, 600.0)] }.keep(5, 0.0), Some((0.0, 600.0)));
    }

    #[test]
    fn a_selection_scrolls_only_past_an_edge() {
        let at = |y| edge_scroll(y, 100.0, 700.0, 0.5);
        assert_eq!([at(100.0), at(400.0), at(700.0)], [0.0; 3]);
        assert_eq!(at(710.0), 80.0, "just past the bottom: slow, down");
        assert_eq!(at(90.0), -80.0, "just past the top: slow, up");
        assert!(at(800.0) > at(710.0) * 5.0, "further past, faster");
        assert_eq!(at(5000.0), 1500.0, "never faster than 3000 points a second");
    }

    #[test]
    fn the_selected_part_of_a_line_is_found_and_emptied() {
        let fill = Color32::from_rgb(1, 2, 3);
        let ctx = egui::Context::default();
        let mut galley = None;
        // The font picture the frame made is thrown away here: a debug build of egui panics on one dropped unseen.
        ctx.run_ui(Default::default(), |ui| galley = Some(ui.painter().layout_no_wrap("hello there".into(), egui::FontId::proportional(14.0), Color32::WHITE))).textures_delta.clear();
        let mut text = TextShape::new(pos2(10.0, 100.0), galley.unwrap(), Color32::WHITE);
        let inked = (Color32::from_rgb(9, 9, 9), Color32::WHITE);
        assert!(take_boxes(&mut text, fill, inked).is_empty());
        // What egui does to a line with a selection in it.
        let row = Arc::make_mut(&mut Arc::make_mut(&mut text.galley).rows[0].row);
        row.visuals.mesh.add_colored_rect(Rect::from_min_max(pos2(5.0, 0.0), pos2(30.0, 17.0)), fill);
        assert_eq!(take_boxes(&mut text, fill, inked), [Rect::from_min_max(pos2(15.0, 100.0), pos2(40.0, 117.0))]);
        assert!(take_boxes(&mut text, fill, inked).is_empty());
    }
}
