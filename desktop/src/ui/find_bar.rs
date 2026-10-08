//! Find in this chat (Ctrl+F): src/components/ChatSearchBar.tsx. The matching is `crate::find`;
//! `chat::messages` counts the matches and `markdown::Marks` paints them.

use super::theme::{self, W, alpha, p};
use super::{App, composer, icons, widgets};
use eframe::egui::{self, Color32, Rect, Sense, Stroke, pos2, vec2};

pub struct State {
    /// Whole words only, so "calc" does not match "calculator". The bar opens with it on.
    pub whole_word: bool,
    /// The focused match, counted across the whole chat.
    pub active: usize,
    /// Bring the focused match into view on the next frame.
    pub reveal: bool,
    /// Matches in the chat, as counted last frame.
    pub total: usize,
    was_open: bool,
    focus: bool,
    select: bool,
    /// The query and toggle the count belongs to: changing either starts again at the first match.
    seen: (String, bool),
}

impl Default for State {
    fn default() -> State {
        State { whole_word: true, active: 0, reveal: false, total: 0, was_open: false, focus: false, select: false, seen: (String::new(), true) }
    }
}

/// Opens the bar (Ctrl+F, `/find text`), with the text ready to be typed over.
pub fn open(app: &mut App, query: Option<String>) {
    app.find_open = true;
    app.finder.focus = true;
    app.finder.select = true;
    if let Some(query) = query {
        app.find = query;
    }
}

/// The bar open on `query` with match `active` focused, for a self-portrait.
pub fn stage(app: &mut App, query: String, whole_word: bool, active: usize) {
    app.find_open = true;
    app.finder = State { whole_word, active, reveal: true, seen: (query.clone(), whole_word), ..Default::default() };
    app.find = query;
}

/// The bar, floating over the top of the transcript. Called every frame, so its fade starts from shut.
pub fn show(app: &mut App, ui: &egui::Ui, area: Rect) {
    let ctx = ui.ctx().clone();
    let t = ctx.animate_bool_with_time(egui::Id::new("find-bar-in"), app.find_open, 0.3);
    if !app.find_open {
        // Closing clears the query, so the marks go with the bar.
        if std::mem::take(&mut app.finder.was_open) {
            app.find.clear();
        }
        return;
    }
    if !std::mem::replace(&mut app.finder.was_open, true) {
        app.finder.focus = true;
        app.finder.select = true;
    }
    let key = (app.find.clone(), app.finder.whole_word);
    if app.finder.seen != key {
        app.finder.seen = key;
        app.finder.active = 0;
        app.finder.reveal = true;
    }

    let p = p();
    // Centred in the message column, which keeps 16 clear on its right.
    let gutter = if area.width() >= 640.0 { 24.0 } else { 16.0 };
    let column = (area.width() - gutter * 2.0).min(composer::column_width(ui, app.fullscreen));
    let width = (column - 16.0).min(448.0);
    let left = area.center().x - column / 2.0 + (column - 16.0 - width) / 2.0;
    let total = app.finder.total;
    let blank = app.find.trim().is_empty();
    let (mut step, mut close) = (0i32, false);
    egui::Area::new(egui::Id::new("find-bar")).order(egui::Order::Middle).fixed_pos(pos2(left, area.top() + 8.0 + 8.0 * (1.0 - t))).show(&ctx, |ui| {
        ui.set_opacity(t);
        let (rect, _) = ui.allocate_exact_size(vec2(width, 38.0), Sense::hover());
        ui.painter().add(egui::Shadow { offset: [0, 10], blur: 32, spread: 0, color: Color32::from_black_alpha(115) }.as_shape(rect, egui::CornerRadius::same(12)));
        // ponytail: the web's bar is 95% opaque over a blur. egui cannot blur what is behind, and sharp text
        // showing through reads as a glitch, so the bar is solid.
        ui.painter().rect(rect, 12.0, p.elevated, Stroke::new(1.0, p.border_light), egui::StrokeKind::Inside);
        let mut row = ui.new_child(egui::UiBuilder::new().max_rect(rect.shrink2(vec2(9.0, 7.0))).layout(egui::Layout::left_to_right(egui::Align::Center)));
        let ui = &mut row;
        ui.spacing_mut().item_spacing = vec2(6.0, 0.0);
        ui.add_space(4.0);
        icons::show(ui, icons::SEARCH_SMALL.stroke(2.0), 14.0, p.muted);
        // The right side first, so the text field gets what is left.
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            close = widgets::mini_btn(ui, icons::CLOSE.stroke(2.2), 24.0, 13.0, "Close (Esc)").clicked();
            ui.scope(|ui| {
                if total == 0 {
                    ui.multiply_opacity(0.3);
                }
                if widgets::mini_btn(ui, icons::CHEVRON_DOWN.stroke(2.2), 24.0, 13.0, "Next match (Enter)").clicked() {
                    step = 1;
                }
                if widgets::mini_btn(ui, icons::CHEVRON_UP.stroke(2.2), 24.0, 13.0, "Previous match (Shift+Enter)").clicked() {
                    step = -1;
                }
            });
            ui.add_space(2.0);
            let (line, _) = ui.allocate_exact_size(vec2(1.0, 16.0), Sense::hover());
            ui.painter().rect_filled(line, 0.0, p.border);
            ui.add_space(2.0);

            let on = app.finder.whole_word;
            let label = widgets::galley(ui, "ab|", theme::mono(11.0), Color32::WHITE);
            let (rect, response) = ui.allocate_exact_size(vec2(label.size().x + 12.0, 24.0), Sense::click());
            let response = response.on_hover_cursor(egui::CursorIcon::PointingHand).on_hover_text(if on { "Whole words only — “calc” won’t match “calculator”" } else { "Partial matches — “calc” will match “calculator”" });
            let hover = widgets::fade(ui, response.id, response.hovered());
            ui.painter().rect_filled(rect, 8.0, if on { alpha(p.accent, 15.0) } else { widgets::lerp(Color32::TRANSPARENT, p.hover, hover) });
            ui.painter().galley_with_override_text_color(pos2(rect.left() + 6.0, (rect.center().y - label.size().y / 2.0).round()), label, if on { p.accent_light } else { widgets::lerp(p.muted, p.text, hover) });
            if response.clicked() {
                app.finder.whole_word = !on;
            }

            if !blank {
                let (count, colour) = if total == 0 { ("0/0".to_string(), p.danger) } else { (format!("{}/{total}", app.finder.active + 1), p.muted) };
                ui.add_space(4.0);
                ui.add(egui::Label::new(egui::RichText::new(count).font(theme::mono(11.0)).color(colour)).selectable(false));
                ui.add_space(4.0);
            }

            let id = egui::Id::new("find-input");
            let edit = ui.add(
                egui::TextEdit::singleline(&mut app.find)
                    .id(id)
                    .hint_text(widgets::text("Find in this chat…", 14.0, W::Regular, p.muted))
                    .font(theme::font(14.0, W::Regular))
                    .text_color(p.text)
                    .desired_width(ui.available_width())
                    .frame(egui::Frame::NONE)
                    .margin(egui::Margin::ZERO),
            );
            // A one-line field lets go of the focus on Enter and on Esc: that is how both are heard here.
            if edit.lost_focus() {
                let (enter, shift, escape) = ui.input(|i| (i.key_pressed(egui::Key::Enter), i.modifiers.shift, i.key_pressed(egui::Key::Escape)));
                if enter {
                    step = if shift { -1 } else { 1 };
                    app.finder.focus = true;
                }
                close |= escape;
            }
            if std::mem::take(&mut app.finder.focus) {
                edit.request_focus();
            }
            if std::mem::take(&mut app.finder.select) {
                if let Some(mut state) = egui::TextEdit::load_state(ui.ctx(), id) {
                    state.cursor.set_char_range(Some(egui::text::CCursorRange::two(egui::text::CCursor::new(0), egui::text::CCursor::new(app.find.chars().count()))));
                    egui::TextEdit::store_state(ui.ctx(), id, state);
                }
            }
        });
    });
    if step != 0 && total > 0 {
        app.finder.active = (app.finder.active as i32 + step).rem_euclid(total as i32) as usize;
        app.finder.reveal = true;
    }
    if close {
        app.find_open = false;
    }
}
