//! Two versions of a regenerated reply, one above the other
//! (src/components/CompareVersions.tsx).

use super::overlay::{self, Card};
use super::theme::{self, W, alpha, p};
use super::{icons, markdown, widgets};
use eframe::egui::{self, Rect, Sense, Ui, pos2, vec2};
use serde_json::{Value, json};

pub struct Version {
    pub label: String,
    pub model: String,
    pub content: String,
}

pub struct State {
    pub versions: Vec<Version>,
    /// The upper pane's version; the lower one is the next.
    pub pair: usize,
}

/// What a reply being regenerated leaves behind on the one that replaces it: its
/// own earlier versions, then itself. None when it never said anything.
pub fn carried(earlier: Option<&Value>, content: &str, model: &str, created_at: &str) -> Option<Value> {
    if content.trim().is_empty() {
        return earlier.cloned();
    }
    let mut all = earlier.and_then(Value::as_array).cloned().unwrap_or_default();
    all.push(json!({ "content": content, "model": model, "createdAt": created_at }));
    Some(Value::Array(all))
}

/// The versions of a reply, oldest first, ending with the one on screen. None when it has no earlier ones.
pub fn open(earlier: Option<&Value>, content: &str, model: &str) -> Option<State> {
    let earlier = earlier?.as_array().filter(|a| !a.is_empty())?;
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut versions: Vec<Version> = earlier.iter().enumerate().map(|(i, v)| Version { label: format!("Version {}", i + 1), model: text(&v["model"]), content: text(&v["content"]) }).collect();
    versions.push(Version { label: "Current".into(), model: model.to_string(), content: content.to_string() });
    Some(State { pair: versions.len() - 2, versions })
}

/// Draws the dialog. False once it is closed.
pub fn show(state: &mut State, ctx: &egui::Context) -> bool {
    let p = p();
    let screen = ctx.content_rect();
    let pad = if screen.width() >= 640.0 { 32.0 } else { 16.0 };
    let card = Card { dim: 178, secs: 0.15, rise: 0.0, grow: 0.98, exit: true, border: p.border_light, ..Card::new("compare", 896.0_f32.min(screen.width() - pad * 2.0), (screen.height() * 0.88).min(screen.height() - pad * 2.0)) };
    let shown = card.show(ctx, |ui, close| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        let full = ui.max_rect();
        let (head, body) = full.split_top_bottom_at_y(full.top() + 49.0);
        ui.painter().rect_filled(Rect::from_min_size(pos2(head.left(), head.bottom() - 1.0), vec2(head.width(), 1.0)), 0.0, p.border);

        icons::paint(ui, icons::COMPARE.stroke(1.8), pos2(head.left() + 16.0 + 7.5, head.center().y), 15.0, p.accent_light);
        let title_width = widgets::text_at(ui, head.left() + 16.0 + 15.0 + 8.0, head.center().y, widgets::galley(ui, "Compare replies", theme::font(14.0, W::Semibold), p.text));
        widgets::text_at(ui, head.left() + 39.0 + title_width + 8.0, head.center().y, widgets::galley(ui, &format!("{} versions", state.versions.len()), theme::font(11.0, W::Regular), p.muted));

        let mut tools = ui.new_child(egui::UiBuilder::new().max_rect(head.shrink2(vec2(16.0, 0.0))).layout(egui::Layout::right_to_left(egui::Align::Center)));
        tools.spacing_mut().item_spacing.x = 4.0;
        if overlay::head_btn(&mut tools, icons::CLOSE, 28.0, 14.0, true, "Close (Esc)").clicked() {
            *close = true;
        }
        if state.versions.len() > 2 {
            let last = state.versions.len() - 2;
            tools.add_enabled_ui(state.pair < last, |ui| {
                if overlay::head_btn(ui, icons::CHEVRON_RIGHT.stroke(2.2), 28.0, 13.0, false, "Later pair").clicked() {
                    state.pair += 1;
                }
            });
            tools.add_enabled_ui(state.pair > 0, |ui| {
                if overlay::head_btn(ui, icons::CHEVRON_LEFT, 28.0, 13.0, false, "Earlier pair").clicked() {
                    state.pair -= 1;
                }
            });
        }

        // Two panes sharing the height, a hairline between them.
        let (upper, lower) = body.split_top_bottom_at_y(body.center().y);
        ui.painter().rect_filled(Rect::from_min_size(pos2(body.left(), upper.bottom() - 0.5), vec2(body.width(), 1.0)), 0.0, p.border);
        for (slot, rect) in [upper.with_max_y(upper.bottom() - 0.5), lower.with_min_y(lower.top() + 0.5)].into_iter().enumerate() {
            let Some(version) = state.versions.get(state.pair + slot) else { continue };
            pane(ui, rect, version, slot == 1);
        }
    });
    shown == overlay::State::Open
}

fn pane(ui: &mut Ui, rect: Rect, version: &Version, newer: bool) {
    let p = p();
    let mut ui = ui.new_child(egui::UiBuilder::new().max_rect(rect).id_salt(("pane", newer)).layout(egui::Layout::top_down(egui::Align::Min)));
    ui.set_clip_rect(rect.intersect(ui.clip_rect()));
    let (bar, _) = ui.allocate_exact_size(vec2(rect.width(), 34.0), Sense::hover());
    let label = widgets::galley(&ui, &version.label.to_uppercase(), theme::font(11.0, W::Semibold), if newer { p.accent_light } else { p.muted });
    let pill = Rect::from_min_size(pos2(bar.left() + 16.0, bar.center().y - 11.0), vec2(label.size().x + 12.0 + 0.275 * version.label.len() as f32, 22.0));
    ui.painter().rect_filled(pill, 8.0, if newer { alpha(p.accent, 15.0) } else { p.elevated });
    widgets::text_at(&ui, pill.left() + 6.0, pill.center().y, label);
    if !version.model.is_empty() {
        widgets::text_at(&ui, pill.right() + 8.0, bar.center().y, widgets::galley(&ui, &version.model, theme::font(11.0, W::Regular), p.muted));
    }
    egui::ScrollArea::vertical().id_salt(("scroll", newer)).auto_shrink(false).show(&mut ui, |ui| {
        egui::Frame::new().inner_margin(egui::Margin { left: 16, right: 16, top: 0, bottom: 16 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            let _ = markdown::show(ui, &version.content, p.text);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_pile_up_oldest_first() {
        let first = carried(None, "one", "glm", "t1").unwrap();
        let second = carried(Some(&first), "two", "glm", "t2").unwrap();
        assert_eq!(carried(Some(&second), "  ", "glm", "t3"), Some(second.clone()));
        let state = open(Some(&second), "three", "flash").unwrap();
        assert_eq!(state.versions.iter().map(|v| (v.label.as_str(), v.content.as_str())).collect::<Vec<_>>(), [("Version 1", "one"), ("Version 2", "two"), ("Current", "three")]);
        assert_eq!(state.pair, 1);
        assert!(open(None, "x", "m").is_none() && open(Some(&json!([])), "x", "m").is_none());
    }
}
