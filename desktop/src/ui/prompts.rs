//! Cards inside a running reply that wait for the user: run a command, answer a
//! question (src/components/ApprovalPrompt.tsx, QuestionPrompt.tsx).

use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use eframe::egui::{self, Color32, Sense, Stroke, StrokeKind, vec2};

/// A text button of the cards' footers. `fill` and `border` are for the resting state.
fn button(ui: &mut egui::Ui, label: &str, size: f32, weight: W, pad: f32, fg: Color32, fill: Color32, hover_fill: Color32, border: Color32, enabled: bool) -> egui::Response {
    let p = p();
    let text = widgets::galley(ui, label, theme::font(size, weight), Color32::WHITE);
    let (rect, response) = ui.allocate_exact_size(vec2(text.size().x + pad * 2.0, size * 1.5 + 12.0), Sense::click());
    let response = if enabled { response.on_hover_cursor(egui::CursorIcon::PointingHand) } else { response.on_hover_cursor(egui::CursorIcon::NotAllowed) };
    let t = widgets::fade(ui, response.id, response.hovered() && enabled);
    let dim = if enabled { 1.0 } else { 0.4 };
    ui.painter().rect(rect, 8.0, widgets::lerp(fill, hover_fill, t).gamma_multiply(dim), Stroke::new(1.0, border), StrokeKind::Inside);
    let colour = if fg == p.text2 || fg == p.muted { widgets::lerp(fg, p.text, t) } else { fg };
    ui.painter().galley_with_override_text_color(egui::pos2(rect.left() + pad, (rect.center().y - text.size().y / 2.0).round()), text, colour.gamma_multiply(dim));
    response
}

/// The frame both cards share: an accent-tinted box with a head and a ruled-off foot.
fn card(ui: &mut egui::Ui, icon: icons::Icon, title: &str, detail: &str, body: impl FnOnce(&mut egui::Ui), foot: impl FnOnce(&mut egui::Ui)) {
    let p = p();
    egui::Frame::new().fill(alpha(p.accent, 5.0)).stroke(Stroke::new(1.0, alpha(p.accent, 30.0))).corner_radius(12).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 10, bottom: 0 }).show(ui, |ui| {
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 10.0;
                ui.vertical(|ui| {
                    ui.add_space(2.0);
                    icons::show(ui, icon, 15.0, p.accent_light);
                });
                ui.vertical(|ui| {
                    ui.add(egui::Label::new(widgets::lines(title, 13.0, 20.0, W::Medium, p.text)).wrap().selectable(false));
                    if !detail.is_empty() {
                        ui.add_space(2.0);
                        ui.add(egui::Label::new(widgets::lines(detail, 12.0, 16.0, W::Regular, p.muted)).wrap().selectable(false));
                    }
                });
            });
        });
        body(ui);
        ui.add_space(8.0);
        let (line, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
        ui.painter().rect_filled(line, 0.0, alpha(p.accent, 15.0));
        egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                foot(ui);
            });
        });
    });
}

/// Draws whatever the running reply of this chat is waiting on. Returns true when it drew something.
pub fn show(app: &mut App, ui: &mut egui::Ui) -> bool {
    let p = p();
    let conv_id = app.conv.id.clone();
    let Some(run) = app.run.as_mut().filter(|r| r.conv_id == conv_id) else { return false };
    let mut drew = false;

    if let Some(pending) = &run.approval {
        drew = true;
        // (approved, remember)
        let mut verdict = None;
        let command = pending.command.clone();
        card(
            ui,
            icons::TERMINAL,
            "Run this command?",
            &pending.reason,
            |ui| {
                ui.add_space(8.0);
                egui::Frame::new().outer_margin(egui::Margin::symmetric(12, 0)).fill(p.bg).stroke(Stroke::new(1.0, p.border)).corner_radius(8).inner_margin(egui::Margin::symmetric(10, 8)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    egui::ScrollArea::horizontal().id_salt("command").show(ui, |ui| {
                        let mut job = egui::text::LayoutJob::default();
                        let format = |colour| egui::TextFormat { font_id: theme::mono(12.0), color: colour, line_height: Some(18.0), ..Default::default() };
                        job.append("$ ", 0.0, format(p.muted));
                        job.append(&command.replace('\n', " "), 0.0, format(p.text2));
                        ui.add(egui::Label::new(job).extend().selectable(true));
                    });
                });
            },
            |ui| {
                if button(ui, "Run", 13.0, W::Medium, 12.0, Color32::WHITE, p.accent, p.accent_light, Color32::TRANSPARENT, true).clicked() {
                    verdict = Some((true, false));
                }
                let skip = button(ui, "Skip", 13.0, W::Medium, 12.0, p.text2, Color32::TRANSPARENT, p.hover, p.border, true);
                // Focus starts on Skip, so a stray Enter never runs anything.
                if ui.memory(|m| m.focused().is_none()) {
                    skip.request_focus();
                }
                if skip.clicked() {
                    verdict = Some((false, false));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let always = button(ui, "Always allow this", 12.0, W::Regular, 10.0, p.muted, Color32::TRANSPARENT, Color32::TRANSPARENT, Color32::TRANSPARENT, true);
                    if always.on_hover_text(format!("Run this, and don't ask again for \"{command}\" in this chat")).clicked() {
                        verdict = Some((true, true));
                    }
                });
            },
        );
        if let Some((approved, remember)) = verdict {
            if let Some(pending) = run.approval.take() {
                if remember {
                    app.always_allow.entry(conv_id.clone()).or_default().insert(pending.command.clone());
                }
                let _ = pending.reply.send(approved);
            }
        }
    }

    let Some(run) = app.run.as_mut().filter(|r| r.conv_id == conv_id) else { return drew };
    if let Some(pending) = run.question.as_mut() {
        if drew {
            ui.add_space(10.0);
        }
        drew = true;
        // Both halves of the card can answer, so the slot is shared.
        let answer = std::cell::RefCell::new(None);
        let options = pending.options.clone();
        let draft = &mut pending.answer;
        card(
            ui,
            icons::HELP,
            &pending.question,
            &pending.context,
            |ui| {
                if options.is_empty() {
                    return;
                }
                egui::Frame::new().inner_margin(egui::Margin { left: 12, right: 12, top: 10, bottom: 0 }).show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
                        for option in &options {
                            let text = widgets::galley(ui, option, theme::font(13.0, W::Regular), Color32::WHITE);
                            let (rect, response) = ui.allocate_exact_size(vec2(text.size().x + 20.0, 19.5 + 12.0 + 2.0), Sense::click());
                            let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
                            let t = widgets::fade(ui, response.id, response.hovered());
                            ui.painter().rect(rect, 8.0, p.bg, Stroke::new(1.0, widgets::lerp(p.border, alpha(p.accent, 40.0), t)), StrokeKind::Inside);
                            ui.painter().galley_with_override_text_color(egui::pos2(rect.left() + 10.0, (rect.center().y - text.size().y / 2.0).round()), text, widgets::lerp(p.text2, p.text, t));
                            if response.clicked() {
                                *answer.borrow_mut() = Some(option.clone());
                            }
                        }
                    });
                });
            },
            |ui| {
                let can_send = !draft.trim().is_empty();
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let send = button(ui, "Send", 13.0, W::Medium, 12.0, Color32::WHITE, p.accent, p.accent_light, Color32::TRANSPARENT, can_send);
                    let hint = if options.is_empty() { "Type your answer…" } else { "Or type your own answer…" };
                    let id = ui.id().with("answer");
                    let focused = ui.memory(|m| m.has_focus(id));
                    let field = egui::Frame::new()
                        .fill(p.bg)
                        .stroke(Stroke::new(1.0, if focused { p.border_light } else { p.border }))
                        .corner_radius(8)
                        .inner_margin(egui::Margin::symmetric(10, 6))
                        .show(ui, |ui| ui.add(egui::TextEdit::singleline(draft).id(id).hint_text(widgets::text(hint, 13.0, W::Regular, p.muted)).font(theme::font(13.0, W::Regular)).text_color(p.text).desired_width(f32::INFINITY).frame(egui::Frame::NONE).margin(egui::Margin::ZERO)))
                        .inner;
                    if ui.memory(|m| m.focused().is_none()) {
                        field.request_focus();
                    }
                    let entered = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if (send.clicked() || entered) && can_send {
                        *answer.borrow_mut() = Some(draft.trim().to_string());
                    }
                });
            },
        );
        if let Some(text) = answer.into_inner() {
            if let Some(question) = run.question.take() {
                let _ = question.reply.send(text);
            }
        }
    }
    drew
}
