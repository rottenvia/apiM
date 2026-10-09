//! How selected text looks, and a way to select and copy in a self-portrait with no mouse.
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

/// A self-portrait's `select-X1-Y1-X2-Y2`: the mouse goes down at one point, is dragged to the other and let
/// go, and Ctrl+C follows, one step a frame from 800 ms on (after an `up-N` has settled). Fed to the app as input: no real mouse moves.
pub fn replay(input: &mut egui::RawInput, at: Duration, from: Pos2, to: Pos2) {
    static STEP: AtomicU8 = AtomicU8::new(0);
    let button = |pos, pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() };
    let (step, ms) = (STEP.load(Ordering::Relaxed), at.as_millis());
    let events = match step {
        0 if ms >= 800 => vec![egui::Event::PointerMoved(from), button(from, true)],
        1 if ms >= 870 => vec![egui::Event::PointerMoved(from + (to - from) / 2.0)],
        2 if ms >= 940 => vec![egui::Event::PointerMoved(to)],
        3 if ms >= 1010 => vec![button(to, false)],
        4 if ms >= 1110 => vec![egui::Event::Copy],
        _ => return,
    };
    input.events.extend(events);
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
    fn the_selected_part_of_a_line_is_found_and_emptied() {
        let fill = Color32::from_rgb(1, 2, 3);
        let ctx = egui::Context::default();
        let mut galley = None;
        let _ = ctx.run_ui(Default::default(), |ui| galley = Some(ui.painter().layout_no_wrap("hello there".into(), egui::FontId::proportional(14.0), Color32::WHITE)));
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
