//! The plan card inside a reply: the goal, how far along it is, and the steps
//! (src/components/PlanPanel.tsx, src/lib/plan-view.ts).

use super::form::Btn;
use super::theme::{self, W, alpha, p};
use super::{icons, widgets};
use crate::store::Plan;
use eframe::egui::{self, Color32, CursorIcon, Sense, Stroke, Ui, pos2, vec2};
use serde_json::Value;

pub struct Step {
    pub text: String,
    /// todo | doing | done | blocked
    pub state: String,
    pub verified: String,
    pub blocker: String,
}

pub struct View {
    pub goal: String,
    pub summary: String,
    pub steps: Vec<Step>,
}

pub enum Act {
    /// Blocked steps go back to "todo".
    Unblock,
    Clear,
}

/// A step as text, whatever shape the model gave it: a string, or an object with a title and a description.
fn step_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return if text.eq_ignore_ascii_case("[object Object]") { String::new() } else { text.to_string() };
    }
    let Some(item) = value.as_object() else { return String::new() };
    let field = |names: &[&str]| names.iter().find_map(|n| item.get(*n).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())).unwrap_or("").to_string();
    let same = |a: &str, b: &str| a.to_lowercase().split_whitespace().eq(b.to_lowercase().split_whitespace());
    let title = field(&["title", "name", "label", "step"]);
    let description = field(&["description", "details", "detail", "text", "task", "content", "action", "what", "work", "instruction", "body"]);
    if !title.is_empty() && !description.is_empty() && !same(&title, &description) {
        return format!("{title} — {description}");
    }
    if !title.is_empty() || !description.is_empty() {
        return if title.is_empty() { description } else { title };
    }
    const IGNORED: [&str; 11] = ["id", "index", "n", "num", "number", "state", "status", "done", "complete", "completed", "priority"];
    let rest: Vec<&str> = item.iter().filter(|(k, _)| !IGNORED.contains(&k.to_lowercase().as_str())).filter_map(|(_, v)| v.as_str().map(str::trim)).filter(|v| v.chars().count() >= 3).collect();
    rest.join(" — ")
}

/// The plan a message carries, as the web app stores it on the message.
pub fn from_value(plan: &Value) -> Option<View> {
    let steps = plan["steps"].as_array()?;
    let text = |v: &Value| v.as_str().unwrap_or("").trim().to_string();
    Some(View {
        goal: text(&plan["goal"]),
        summary: text(&plan["summary"]),
        steps: steps.iter().map(|s| Step { text: step_text(if s["text"].is_null() { s } else { &s["text"] }), state: text(&s["state"]), verified: text(&s["verified"]), blocker: text(&s["blocker"]) }).collect(),
    })
}

/// The chat's own plan. A step's note is how it was checked, or what blocks it.
pub fn from_plan(plan: &Plan) -> View {
    let note = |s: &crate::store::PlanStep, state: &str| if s.state == state { s.note.trim().to_string() } else { String::new() };
    View { goal: plan.goal.trim().to_string(), summary: String::new(), steps: plan.steps.iter().map(|s| Step { text: s.text.trim().to_string(), state: s.state.clone(), verified: note(s, "done"), blocker: note(s, "blocked") }).collect() }
}

fn or_untitled(text: &str) -> &str {
    if text.is_empty() { "Untitled step" } else { text }
}

/// Draws the card. `can_act` shows the footer that reopens or clears a blocked plan.
pub fn show(ui: &mut Ui, view: &View, can_act: bool) -> Option<Act> {
    let p = p();
    let total = view.steps.len();
    let done = view.steps.iter().filter(|s| s.state == "done").count();
    let blocked = view.steps.iter().filter(|s| s.state == "blocked").count();
    let complete = total > 0 && done == total;
    let current = view.steps.iter().find(|s| s.state == "doing").or_else(|| view.steps.iter().find(|s| s.state == "todo"));
    let open_id = ui.id().with("plan-open");
    // Short plans start open, long ones folded; after that the click decides.
    let mut open: bool = ui.data(|d| d.get_temp(open_id)).unwrap_or(total <= 6);
    let mut act = None;

    let frame = egui::Frame::new().fill(alpha(p.bg2, 60.0)).stroke(Stroke::new(1.0, p.border)).corner_radius(12);
    frame.show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        let width = ui.available_width();
        let (row, response) = ui.allocate_exact_size(vec2(width, if open { 40.0 } else { 58.0 }), Sense::click());
        let response = response.on_hover_cursor(CursorIcon::PointingHand);
        let t = widgets::fade(ui, response.id, response.hovered());
        let corners = if open || (blocked > 0 && can_act) { egui::CornerRadius { nw: 11, ne: 11, sw: 0, se: 0 } } else { egui::CornerRadius::same(11) };
        ui.painter().rect_filled(row.shrink(1.0), corners, alpha(p.hover, 40.0 * t));
        // ponytail: the chevron swaps instead of turning over 150 ms.
        icons::paint(ui, if open { icons::CHEVRON_DOWN } else { icons::CHEVRON_RIGHT }, pos2(row.left() + 12.0 + 6.5, row.center().y), 13.0, p.muted);

        // Right: the bar (wide windows only) and the count.
        let tone = if blocked > 0 { p.danger } else if complete { p.success } else { p.text2 };
        let count = widgets::galley(ui, &format!("{done}/{total} done"), theme::font(11.0, W::Medium), tone);
        let mut right = row.right() - 12.0 - count.size().x;
        widgets::text_at(ui, right, row.center().y, count);
        if ui.ctx().content_rect().width() >= 640.0 {
            right -= 8.0 + 64.0;
            let track = egui::Rect::from_min_size(pos2(right, row.center().y - 2.0), vec2(64.0, 4.0));
            ui.painter().rect_filled(track, 2.0, p.bg3);
            let share = if total == 0 { 0.0 } else { ui.ctx().animate_value_with_time(open_id.with("bar"), done as f32 / total as f32, 0.3) };
            ui.painter().rect_filled(egui::Rect::from_min_size(track.min, vec2(64.0 * share, 4.0)), 2.0, p.accent);
        }

        let left = row.left() + 12.0 + 13.0 + 10.0;
        let room = (right - 10.0 - left).max(0.0);
        let goal = widgets::clipped(ui, &view.goal, theme::font(13.0, W::Medium), p.text, room);
        widgets::text_at(ui, left, row.top() + 10.0 + 10.0, goal);
        if !open {
            let line = if complete { "All steps done".to_string() } else if let Some(step) = current { format!("Now: {}", or_untitled(&step.text)) } else { view.summary.clone() };
            let line = widgets::clipped(ui, &line, theme::font(11.0, W::Regular), p.muted, room);
            widgets::text_at(ui, left, row.top() + 10.0 + 20.0 + 2.0 + 8.0, line);
        }
        if response.clicked() {
            open = !open;
            ui.data_mut(|d| d.insert_temp(open_id, open));
        }

        let rule = |ui: &mut Ui| {
            let (line, _) = ui.allocate_exact_size(vec2(width, 1.0), Sense::hover());
            ui.painter().rect_filled(line, 0.0, p.border);
        };
        if open {
            rule(ui);
            egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
                ui.set_width(width - 24.0);
                for step in &view.steps {
                    ui.add_space(4.0);
                    ui.horizontal_top(|ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;
                        let (mark, colour) = match step.state.as_str() {
                            "done" => ("✓", p.success),
                            "doing" => ("▸", p.warning),
                            "blocked" => ("!", p.danger),
                            _ => ("·", p.muted),
                        };
                        let (cell, _) = ui.allocate_exact_size(vec2(12.0, 20.0), Sense::hover());
                        if mark == "▸" {
                            // The UI font has no such triangle, and the fallback's is a speck.
                            let c = pos2(cell.center().x, cell.top() + 2.0 + 9.0);
                            ui.painter().add(egui::Shape::convex_polygon(vec![c + vec2(-2.5, -4.0), c + vec2(3.5, 0.0), c + vec2(-2.5, 4.0)], colour, Stroke::NONE));
                        } else {
                            let glyph = widgets::galley(ui, mark, theme::font(12.0, W::Semibold), colour);
                            let glyph_width = glyph.size().x;
                            widgets::text_at(ui, cell.center().x - glyph_width / 2.0, cell.top() + 2.0 + 9.0, glyph);
                        }
                        ui.vertical(|ui| {
                            let is_done = step.state == "done";
                            let mut job = egui::text::LayoutJob::default();
                            job.wrap.max_width = ui.available_width();
                            job.append(or_untitled(&step.text), 0.0, egui::TextFormat { font_id: theme::font(12.0, W::Regular), color: if is_done { p.muted } else { p.text2 }, line_height: Some(20.0), strikethrough: if is_done { Stroke::new(1.0, alpha(p.muted, 40.0)) } else { Stroke::NONE }, ..Default::default() });
                            ui.add(egui::Label::new(job).selectable(false));
                            let small = |ui: &mut Ui, text: String, colour: Color32| {
                                ui.add_space(2.0);
                                ui.add(egui::Label::new(widgets::lines(text, 11.0, 16.0, W::Regular, colour)).wrap().selectable(false));
                            };
                            if is_done && !step.verified.is_empty() {
                                small(ui, format!("checked: {}", step.verified), p.muted);
                            }
                            if step.state == "blocked" && !step.blocker.is_empty() {
                                small(ui, format!("blocked: {}", step.blocker), alpha(p.danger, 80.0));
                            }
                        });
                    });
                    ui.add_space(4.0);
                }
            });
        }
        if blocked > 0 && can_act {
            rule(ui);
            egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
                ui.set_width(width - 24.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    if Btn::ghost("Reopen & retry").text(11.0, 16.0).weight(W::Medium).pad(10.0, 4.0).radius(8.0).ink(Color32::WHITE, Color32::WHITE).fill(alpha(p.accent, 90.0), p.accent).show(ui).clicked() {
                        act = Some(Act::Unblock);
                    }
                    if Btn::ghost("Clear plan").text(11.0, 16.0).weight(W::Medium).pad(10.0, 4.0).radius(8.0).ink(p.text2, p.text2).fill(Color32::TRANSPARENT, alpha(p.hover, 60.0)).border(p.border, p.border).show(ui).clicked() {
                        act = Some(Act::Clear);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.add(egui::Label::new(widgets::text("Blocked steps can always be cleared", 11.0, W::Regular, p.muted)).selectable(false));
                    });
                });
            });
        }
    });
    act
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn steps_read_whatever_shape_they_come_in() {
        assert_eq!(step_text(&json!(" Build it ")), "Build it");
        assert_eq!(step_text(&json!("[object Object]")), "");
        assert_eq!(step_text(&json!({"title": "Parse", "description": "Read the file"})), "Parse — Read the file");
        assert_eq!(step_text(&json!({"title": "Parse", "text": "parse"})), "Parse");
        assert_eq!(step_text(&json!({"id": 3, "status": "todo", "goal": "Ship the thing"})), "Ship the thing");
        let view = from_value(&json!({"goal": "G", "steps": [{"id": 1, "text": "a", "state": "done", "verified": "ran tests"}, {"id": 2, "text": {"title": "b"}, "state": "blocked", "blocker": "no key"}]})).unwrap();
        assert_eq!((view.steps[0].verified.as_str(), view.steps[1].text.as_str(), view.steps[1].blocker.as_str()), ("ran tests", "b", "no key"));
    }
}
