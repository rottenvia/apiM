//! "Rewind" on a question: the chat goes back to before it, and the files too
//! if a restore point was taken (src/components/RewindPopover.tsx, src/lib/rewind.ts).

use super::form::Btn;
use super::theme::{W, p};
use super::{icons, widgets};
use crate::snapshots::RestorePoint;
use eframe::egui::{self, Color32, Rect, Ui, pos2, vec2};

/// What a rewind to one question would do, worked out when its popover opens.
pub struct Preview {
    /// The question.
    pub id: String,
    /// Messages that go: the question and everything after it.
    pub removed: usize,
    pub point: RestorePoint,
    /// Why the last try failed.
    pub error: String,
}

pub enum Choice {
    ChatAndFiles,
    ChatOnly,
    Cancel,
}

/// "the reply after it", "the 4 messages after it", or nothing when only the question goes.
fn later(removed: usize) -> String {
    match removed.saturating_sub(1) {
        0 => String::new(),
        1 => "the reply after it".into(),
        n => format!("the {n} messages after it"),
    }
}

/// The sentence about the files, and whether they can be rewound at all.
fn files_line(point: &RestorePoint) -> (String, bool) {
    match point {
        RestorePoint::Snapshot(snapshot) => {
            // ponytail: 24-hour clock; the web prints the time the way the browser's locale does.
            let at = chrono::DateTime::parse_from_rfc3339(&snapshot.created_at).map(|t| format!(" (restore point from {})", t.with_timezone(&chrono::Local).format("%H:%M"))).unwrap_or_default();
            (format!("Files go back to how they were before this message{at}. The current files are saved first, so that can be undone."), true)
        }
        RestorePoint::Empty => ("There were no files before this message, so rewinding the files removes them all. They are saved first, so that can be undone.".into(), true),
        RestorePoint::Missing => ("This message's file restore point has been pruned (only the newest are kept) — only the chat can rewind.".into(), false),
        RestorePoint::None => ("No file restore point was taken for this message — only the chat can rewind.".into(), false),
    }
}

/// The line the composer shows once a rewind is done.
pub fn done_text(removed: usize, files: Option<(usize, usize)>) -> String {
    let files = files.map_or(", files left as they are.".to_string(), |(restored, gone)| format!(", files put back ({restored} restored, {gone} removed)."));
    format!("Rewound — {removed} message{} removed{files} Edit the question and send it again.", if removed == 1 { "" } else { "s" })
}

/// The popover, right-aligned 4px under the bubble at `anchor`.
pub fn show(ui: &Ui, anchor: Rect, preview: &Preview) -> Option<Choice> {
    let p = p();
    let width = 320.0_f32.min(ui.ctx().content_rect().width() - 32.0);
    let mut choice = None;
    let area = egui::Area::new(egui::Id::new("rewind-popover")).order(egui::Order::Foreground).fixed_pos(pos2(anchor.right() - width, anchor.bottom() + 4.0)).show(ui.ctx(), |ui| {
        widgets::popover_frame(12).inner_margin(egui::Margin::same(12)).show(ui, |ui| {
            ui.set_width(width - 26.0);
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            let (title, _) = ui.allocate_exact_size(vec2(ui.available_width(), 19.5), egui::Sense::hover());
            icons::paint(ui, icons::REWIND, pos2(title.left() + 5.5, title.center().y), 11.0, p.text);
            widgets::text_at(ui, title.left() + 11.0 + 6.0, title.center().y, widgets::galley(ui, "Rewind to before this message", super::theme::font(13.0, W::Medium), p.text));
            ui.add_space(6.0);

            let line = |ui: &mut Ui, text: &str, colour: Color32| {
                ui.add(egui::Label::new(widgets::lines(text, 12.0, 20.0, W::Regular, colour)).wrap().selectable(false));
            };
            let later = later(preview.removed);
            line(ui, &format!("Removes this message{}. Its text goes back in the box to edit and resend.", if later.is_empty() { String::new() } else { format!(" and {later}") }), p.text2);
            ui.add_space(6.0);
            let (files, available) = files_line(&preview.point);
            line(ui, &files, if available { p.text2 } else { p.muted });
            if !preview.error.is_empty() {
                ui.add_space(6.0);
                line(ui, &preview.error, p.danger);
            }

            ui.add_space(12.0);
            let wide = ui.available_width();
            let button = |label| Btn::ghost(label).text(12.0, 16.0).weight(W::Medium).pad(12.0, 6.0).radius(8.0).width(wide);
            let primary = |label| button(label).ink(Color32::WHITE, Color32::WHITE).fill(p.accent, p.accent_light);
            if available {
                if primary("Rewind chat and files").show(ui).clicked() {
                    choice = Some(Choice::ChatAndFiles);
                }
                ui.add_space(6.0);
            }
            let chat_only = if available { button("Rewind chat only").ink(p.text, p.text).fill(Color32::TRANSPARENT, p.hover).border(p.border_light, p.border_light) } else { primary("Rewind chat only") };
            if chat_only.show(ui).clicked() {
                choice = Some(Choice::ChatOnly);
            }
            ui.add_space(6.0);
            if Btn::ghost("Cancel").text(11.0, 16.0).weight(W::Regular).pad(12.0, 4.0).radius(8.0).width(wide).ink(p.muted, p.text).fill(Color32::TRANSPARENT, p.hover).show(ui).clicked() {
                choice = Some(Choice::Cancel);
            }
        });
    });
    if choice.is_none() && (ui.input(|i| i.key_pressed(egui::Key::Escape)) || area.response.clicked_elsewhere()) {
        choice = Some(Choice::Cancel);
    }
    choice
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_what_goes_and_what_came_back() {
        assert_eq!((later(1), later(2), later(5)), (String::new(), "the reply after it".to_string(), "the 4 messages after it".to_string()));
        assert_eq!(done_text(1, None), "Rewound — 1 message removed, files left as they are. Edit the question and send it again.");
        assert_eq!(done_text(3, Some((2, 1))), "Rewound — 3 messages removed, files put back (2 restored, 1 removed). Edit the question and send it again.");
        assert!(!files_line(&RestorePoint::Missing).1 && files_line(&RestorePoint::Empty).1);
    }
}
