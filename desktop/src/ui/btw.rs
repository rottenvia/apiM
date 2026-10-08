//! A "btw" note on its way to the reply being written: the dock above the message box
//! (src/components/BtwDock.tsx) and the notes still waiting to be read.

use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use crate::store::Message;
use eframe::egui::{self, Color32, Rect, Sense, Stroke, pos2, vec2};
use std::time::{Duration, Instant};

struct Entry {
    note: String,
    /// Names of what was attached to it.
    files: Vec<String>,
    /// The step the reply read it at, once it has.
    round: Option<usize>,
    /// When it was passed, or read: the dock leaves a moment after.
    since: Instant,
    born: Instant,
}

#[derive(Default)]
pub struct State {
    /// The note on show. A newer one takes its place; both still reach the reply.
    entry: Option<Entry>,
    /// Notes the reply has not read yet: the text it will get, and the chip the transcript shows once it has.
    waiting: Vec<(String, Message)>,
}

impl State {
    /// A note was handed to the running reply.
    pub fn pass(&mut self, wire: String, chip: Message) {
        let now = Instant::now();
        self.entry = Some(Entry { note: chip.text(), files: chip.attachments.iter().map(|a| a.name.clone()).collect(), round: None, since: now, born: now });
        self.waiting.push((wire, chip));
    }

    /// The reply took a note in before step `round`. Returns its chip for the transcript.
    pub fn read(&mut self, wire: &str, round: usize) -> Option<Message> {
        let at = self.waiting.iter().position(|(text, _)| text == wire)?;
        let (_, chip) = self.waiting.remove(at);
        if let Some(entry) = self.entry.as_mut().filter(|e| e.note == chip.text()) {
            entry.round = Some(round);
            entry.since = Instant::now();
        }
        Some(chip)
    }

    /// The reply ended: the notes it never read, to be kept in the transcript all the same.
    pub fn flush(&mut self) -> Vec<Message> {
        self.waiting.drain(..).map(|(_, chip)| chip).collect()
    }
}

/// A note on show that never leaves, for a self-portrait.
pub fn sample(read: bool) -> State {
    let now = Instant::now();
    State { entry: Some(Entry { note: "also keep the old tests green".into(), files: vec!["notes.md".into()], round: read.then_some(3), since: now + Duration::from_secs(3600), born: now }), waiting: Vec::new() }
}

/// The dock, above the message box whose left edge and width are given.
// ponytail: handing a note over happens inside this process and cannot fail, so the web's "sending" and
// error states (and "skipped N waiting approvals") have nothing to show here.
pub fn dock(app: &mut App, ui: &mut egui::Ui, left: f32, width: f32) {
    let Some(entry) = &app.btw.entry else { return };
    // It leaves on its own a moment after the note was passed, and again after it was read.
    if entry.since.elapsed() > Duration::from_millis(1800) {
        app.btw.entry = None;
        return;
    }
    ui.ctx().request_repaint_after(Duration::from_millis(100));
    let p = p();
    let pad = if ui.ctx().content_rect().width() >= 640.0 { 16.0 } else { 12.0 };
    let card = (width - pad * 2.0).min(768.0);
    let top = ui.cursor().top();
    // `.btw-enter`. The web also lifts it 6px; here that would nudge the message box, so it only fades.
    let t = (entry.born.elapsed().as_secs_f32() / 0.3).min(1.0);
    let mut dismiss = false;
    let used = ui
        .scope_builder(egui::UiBuilder::new().max_rect(Rect::from_min_size(pos2(left + (width - card) / 2.0, top), vec2(card, f32::INFINITY))), |ui| {
            ui.set_opacity(t);
            egui::Frame::new().fill(alpha(p.search, 6.0)).stroke(Stroke::new(1.0, alpha(p.search, 25.0))).corner_radius(12).show(ui, |ui| {
                ui.set_width(card - 2.0);
                ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                let (row, _) = ui.allocate_exact_size(vec2(card - 2.0, 36.5), Sense::hover());
                let y = row.center().y;

                let mut job = egui::text::LayoutJob::simple_singleline("btw".into(), theme::font(11.0, W::Semibold), p.search);
                job.sections[0].format.extra_letter_spacing = 0.275;
                let word = ui.painter().layout_job(job);
                let pill = Rect::from_min_size(pos2(row.left() + 12.0, y - 10.25), vec2(word.size().x + 12.0, 20.5));
                ui.painter().rect_filled(pill, 8.0, alpha(p.search, 15.0));
                widgets::text_at(ui, pill.left() + 6.0, y, word);

                let close = Rect::from_center_size(pos2(row.right() - 12.0 - 10.0, y), vec2(20.0, 20.0));
                let response = ui.interact(close, ui.id().with("btw-dismiss"), Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text("Dismiss");
                let hover = widgets::fade(ui, response.id, response.hovered());
                ui.painter().rect_filled(close, 8.0, widgets::lerp(Color32::TRANSPARENT, alpha(p.search, 10.0), hover));
                icons::paint(ui, icons::CLOSE.stroke(2.4), close.center(), 12.0, widgets::lerp(p.muted, p.search, hover));
                dismiss = response.clicked();

                let (status, colour) = match entry.round {
                    Some(round) => (format!("read by the task at step {round}"), p.search),
                    None => ("passed — the task folds it in at its next thinking step".to_string(), alpha(p.search, 70.0)),
                };
                let status = widgets::galley(ui, &status, theme::font(11.0, W::Regular), colour);
                let status_left = close.left() - 8.0 - status.size().x;
                widgets::text_at(ui, status_left, y, status);

                // The note on one line, cut where the status begins, with what was attached after it.
                let mut job = egui::text::LayoutJob::default();
                job.append(&entry.note.replace('\n', " "), 0.0, egui::TextFormat { font_id: theme::font(13.0, W::Regular), color: p.text2, ..Default::default() });
                if !entry.files.is_empty() {
                    job.append(&format!(" · {}", entry.files.join(", ")), 0.0, egui::TextFormat { font_id: theme::font(13.0, W::Regular), color: p.muted, ..Default::default() });
                }
                job.wrap = egui::text::TextWrapping { max_width: (status_left - 8.0 - pill.right() - 8.0).max(0.0), max_rows: 1, break_anywhere: true, overflow_character: Some('…') };
                widgets::text_at(ui, pill.right() + 8.0, y, ui.painter().layout_job(job));

                let (line, _) = ui.allocate_exact_size(vec2(card - 2.0, 1.0), Sense::hover());
                ui.painter().rect_filled(line, 0.0, alpha(p.search, 12.0));
                let about = if entry.round.is_some() { "The task was not interrupted — it read your note mid-run. It is part of the conversation now." } else { "The task keeps running exactly as it was; your note joins its thinking at the next step." };
                egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 6)).show(ui, |ui| {
                    ui.add(egui::Label::new(widgets::lines(about, 11.0, 16.0, W::Regular, p.muted)).wrap().selectable(false));
                });
            });
        })
        .response
        .rect;
    ui.advance_cursor_after_rect(Rect::from_min_max(pos2(left, top), pos2(left + width, used.bottom() + 6.0)));
    if dismiss {
        app.btw.entry = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Role;

    #[test]
    fn a_note_waits_until_the_reply_reads_it() {
        let mut state = State::default();
        let mut chip = Message::new(Role::User, "use tabs");
        chip.note = true;
        state.pass("use tabs\n\n[Attached file saved in the workspace: uploads/a.txt]".into(), chip.clone());
        assert!(state.read("something else", 2).is_none());
        assert_eq!(state.read("use tabs\n\n[Attached file saved in the workspace: uploads/a.txt]", 2), Some(chip));
        assert_eq!(state.entry.as_ref().and_then(|e| e.round), Some(2));
        // A reply that ends first leaves its unread notes for the transcript.
        state.pass("later".into(), Message::new(Role::User, "later"));
        assert_eq!(state.flush().len(), 1);
        assert!(state.flush().is_empty());
    }
}
