//! The panel on the right: this chat's files, plan and findings
//! (src/components/WorkspaceSidePanel.tsx).

use super::theme::{self, W, p};
use super::{App, Dialog, human_size, icons, open_in_file_manager, widgets};
use crate::tools::files;
use eframe::egui::{self, Sense, Stroke, vec2};

pub const WIDTH: f32 = 280.0;

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let p = p();
    let rect = ui.max_rect();
    ui.painter().vline(rect.left() + 0.5, rect.y_range(), Stroke::new(1.0, p.border));
    let root = app.conv.workspace();
    if std::mem::take(&mut app.files_stale) {
        app.files = if root.exists() { files::walk(&root, &root) } else { Vec::new() };
    }
    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);

    // Header: the same 56px band as the chat's.
    ui.allocate_ui_with_layout(vec2(ui.available_width(), 56.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
        ui.add_space(16.0);
        ui.label(widgets::text("Workspace", 14.0, W::Semibold, p.text));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(12.0);
            ui.spacing_mut().item_spacing.x = 4.0;
            if widgets::icon_btn(ui, icons::PANEL_RIGHT, "Hide the workspace panel").clicked() {
                app.settings.workspace_open = false;
                app.settings.save();
            }
            if widgets::icon_btn(ui, icons::REFRESH, "Refresh the list").clicked() {
                app.files_stale = true;
            }
            if widgets::icon_btn(ui, icons::FOLDER, "Open the folder").clicked() {
                let _ = std::fs::create_dir_all(&root);
                open_in_file_manager(&root);
            }
        });
    });
    widgets::rule(ui);

    egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 12)).show(ui, |ui| {
        let shown = root.display().to_string();
        ui.add(egui::Label::new(egui::RichText::new(shown.as_str()).font(theme::mono(11.0)).color(p.muted)).truncate()).on_hover_text(shown.as_str());
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let busy = app.running_here();
            if widgets::small_btn(ui, "Choose folder…", p.text, p.elevated, p.border).on_hover_text("Point this chat at a project on this PC. The agent reads and edits files inside it.").clicked() && !busy {
                if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                    app.conv.folder = Some(folder);
                    app.conv.save();
                    app.files_stale = true;
                }
            }
            if app.conv.folder.is_some() && widgets::small_btn(ui, "Use chat folder", p.text2, egui::Color32::TRANSPARENT, p.border).on_hover_text("Go back to this chat's own folder").clicked() && !busy {
                app.conv.folder = None;
                app.conv.save();
                app.files_stale = true;
            }
        });
    });
    widgets::rule(ui);

    let mut preview = None;
    egui::ScrollArea::vertical().id_salt("workspace-files").auto_shrink(false).show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        egui::Frame::new().inner_margin(egui::Margin::symmetric(12, 12)).show(ui, |ui| {
            if let Some(plan) = &app.conv.plan {
                section(ui, "Plan");
                ui.add(egui::Label::new(widgets::lines(plan.goal.as_str(), 13.0, 20.0, W::Regular, p.text2)).wrap());
                ui.add_space(6.0);
                for step in &plan.steps {
                    let (icon, colour) = match step.state.as_str() {
                        "done" => (icons::CHECK, p.success),
                        "doing" => (icons::PLAY, p.accent_light),
                        "blocked" => (icons::ALERT_CIRCLE, p.danger),
                        _ => (icons::CHEVRON_RIGHT, p.muted),
                    };
                    ui.horizontal_top(|ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;
                        ui.add_space(4.0);
                        icons::show(ui, icon, 14.0, colour);
                        ui.add(egui::Label::new(widgets::lines(step.text.as_str(), 12.5, 19.0, W::Regular, if step.state == "done" { p.muted } else { p.text })).wrap()).on_hover_text(step.note.as_str());
                    });
                    ui.add_space(2.0);
                }
                ui.add_space(12.0);
            }
            let active: Vec<_> = app.conv.findings.iter().filter(|f| f.active).collect();
            if !active.is_empty() {
                section(ui, &format!("Findings · {}", active.len()));
                for f in active {
                    ui.add(egui::Label::new(widgets::lines(format!("• {}", f.claim), 12.5, 19.0, W::Regular, p.text2)).wrap()).on_hover_text(f.evidence.as_str());
                    ui.add_space(2.0);
                }
                ui.add_space(12.0);
            }

            section(ui, &format!("Files · {}", app.files.len()));
            if app.files.is_empty() {
                ui.add_space(4.0);
                ui.label(widgets::lines("No files yet. Ask for one and it appears here.", 12.0, 18.0, W::Regular, p.muted));
            }
            // ponytail: a flat list, capped. Make it a collapsible tree if big projects are common.
            for (path, size) in app.files.iter().take(500) {
                let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), Sense::click());
                let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
                if response.hovered() {
                    ui.painter().rect_filled(row, 6.0, p.hover);
                }
                icons::paint(ui, icons::FILE, egui::pos2(row.left() + 14.0, row.center().y), 14.0, p.muted);
                let amount = widgets::galley(ui, &human_size(*size), theme::font(11.0, W::Regular), p.muted);
                let amount_width = amount.size().x;
                widgets::text_at(ui, row.right() - 8.0 - amount_width, row.center().y, amount);
                widgets::text_at(ui, row.left() + 28.0, row.center().y, widgets::clipped(ui, path, theme::font(12.5, W::Regular), p.text2, row.width() - 28.0 - amount_width - 20.0));
                if response.clicked() {
                    preview = Some(path.clone());
                }
            }
            if app.files.len() > 500 {
                ui.add_space(4.0);
                ui.label(widgets::text(format!("… and {} more", app.files.len() - 500), 12.0, W::Regular, p.muted));
            }
        });
    });
    if let Some(path) = preview {
        open(app, path);
    }
}

/// Shows a workspace file in the preview dialog.
pub fn open(app: &mut App, path: String) {
    let text = match files::read_text(&app.conv.workspace().join(&path)) {
        Ok(t) => t.chars().take(200_000).collect(),
        Err(e) => e,
    };
    app.dialog = Dialog::Preview(path, text);
}

fn section(ui: &mut egui::Ui, title: &str) {
    ui.label(widgets::lines(title.to_uppercase(), 11.0, 16.0, W::Semibold, p().muted).extra_letter_spacing(0.6));
    ui.add_space(6.0);
}
