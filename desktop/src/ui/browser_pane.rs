//! The Browser pane: a card beside the chat showing the agent's browser live (`browser::live`), where the user can
//! watch each step, take over with the mouse and keyboard, or open a page or a workspace file themselves.

use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use crate::browser::live::{self, Input};
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct State {
    pub open: bool,
    /// What the address box holds while it is being edited.
    address: String,
    editing: bool,
    texture: Option<egui::TextureHandle>,
    seq: u64,
    /// The `driving` count the pane last opened itself for, so closing it holds until the agent browses again.
    seen_drive: bool,
    last_move: Option<Instant>,
    /// The layout size the pane wants and since when (or until when, once asked), so a drag of its edge relays the
    /// page out once it stops rather than on every frame.
    resize: Option<((u32, u32), Instant)>,
    /// The pane's width once open, kept here because it slides on a size of its own while it opens and closes.
    width: f32,
}

/// The chat header's height, so the two rows of buttons line up across the window.
const BAR: f32 = 56.0;

/// Opens a workspace file in the pane (the Preview of an .html file).
pub fn preview(app: &mut App, path: &std::path::Path) {
    let root = app.conv.workspace();
    live::view().root = Some(root);
    app.browser.open = true;
    let url = live::file_url(path);
    app.rt.spawn(live::act(Input::Go(url)));
}

/// Opens or closes the pane from the chat's header.
pub fn toggle(app: &mut App) {
    app.browser.open = !app.browser.open;
    let mut v = live::view();
    v.wanted = app.browser.open;
    if app.browser.open && v.root.is_none() {
        v.root = Some(app.conv.workspace());
    }
}

/// Opens itself when the agent starts browsing; drawn as a right panel. Returns whether it is on screen.
pub fn panel(app: &mut App, ui: &mut egui::Ui, right_gap: f32, top_gap: f32, gap: f32, round: f32) -> bool {
    {
        let mut v = live::view();
        let driving = v.driving > 0;
        if driving && v.wanted && !app.browser.seen_drive {
            app.browser.open = true;
        }
        app.browser.seen_drive = driving;
        if !app.browser.open {
            v.wanted = false;
        }
    }
    let shown = ui.ctx().animate_bool_with_time_and_easing(egui::Id::new("browser-open"), app.browser.open, 0.3, egui::emath::easing::cubic_out);
    if shown <= 0.0 {
        return false;
    }
    let window = ui.ctx().content_rect().width();
    let most = (window * 0.62).max(420.0);
    if app.browser.width == 0.0 {
        app.browser.width = (window * 0.42).clamp(420.0, 760.0);
    }
    let full = app.browser.width.clamp(380.0, most);
    let frame = egui::Frame::new().fill(p().bg2).inner_margin(egui::Margin { left: 0, right: right_gap as i8, top: top_gap as i8, bottom: gap as i8 });
    // It slides as the sidebar and the rail do, its content at full width and cut off at the window's edge: a fade at
    // full width left the chat to jump 600 points sideways in one frame. Resizable once it is all the way open.
    let panel = egui::Panel::right("browser-pane").show_separator_line(false).frame(frame);
    let panel = if shown < 1.0 { panel.exact_size((full * shown).round()).resizable(false) } else { panel.resizable(true).default_size(full).size_range(380.0..=most) };
    let shown_whole = shown >= 1.0;
    let drawn = panel.show(ui, |ui| {
        let visible = ui.max_rect();
        ui.set_clip_rect(visible.expand(1.0));
        let card = Rect::from_min_size(visible.min, vec2(full - right_gap, visible.height()));
        pane(app, ui, if shown_whole { visible } else { card }, round);
        // Claimed whole: a side panel keeps the width its content used, and painting uses none, so it shrank to
        // its narrowest.
        ui.allocate_rect(visible, Sense::hover());
    });
    if shown_whole {
        app.browser.width = drawn.response.rect.width();
    }
    true
}

fn pane(app: &mut App, ui: &mut egui::Ui, card: Rect, round: f32) {
    let p = p();
    ui.painter().rect(card, round, p.bg, Stroke::new(1.0, alpha(p.border, 70.0)), StrokeKind::Inside);
    let (url, title, loading, driving, error, size, seq, running, viewport) = {
        let v = live::view();
        (v.url.clone(), v.title.clone(), v.loading, v.driving > 0, v.error.clone(), v.size, v.seq, v.running, v.viewport)
    };
    if seq != app.browser.seq && size[0] > 0 {
        app.browser.seq = seq;
        let rgba = live::view().rgba.clone();
        if rgba.len() == size[0] * size[1] * 4 {
            let image = egui::ColorImage::from_rgba_unmultiplied(size, &rgba);
            match &mut app.browser.texture {
                Some(t) => t.set(image, egui::TextureOptions::LINEAR),
                None => app.browser.texture = Some(ui.ctx().load_texture("browser-frame", image, egui::TextureOptions::LINEAR)),
            }
        }
    } else if !running && size[0] == 0 {
        app.browser.texture = None;
    }

    // The bar: back, forward, reload, the address, open outside, close.
    let bar = Rect::from_min_size(card.min, vec2(card.width(), BAR));
    ui.painter().hline(card.x_range().shrink(1.0), bar.bottom() - 0.5, Stroke::new(1.0, p.border));
    let mut x = bar.left() + 10.0;
    let button = |ui: &mut egui::Ui, x: &mut f32, icon: icons::Icon, tip: &str| {
        let rect = Rect::from_center_size(pos2(*x + 14.0, bar.center().y), vec2(28.0, 28.0));
        *x += 30.0;
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect));
        widgets::mini_btn(&mut child, icon, 28.0, 14.0, tip).clicked()
    };
    let mut go = None;
    if button(ui, &mut x, icons::CHEVRON_LEFT, "Back") {
        go = Some(Input::Back);
    }
    if button(ui, &mut x, icons::CHEVRON_RIGHT, "Forward") {
        go = Some(Input::Forward);
    }
    if button(ui, &mut x, if loading { icons::CLOSE } else { icons::REFRESH }, if loading { "Stop" } else { "Reload" }) {
        go = Some(if loading { Input::Stop } else { Input::Reload });
    }
    let close = Rect::from_center_size(pos2(bar.right() - 10.0 - 14.0, bar.center().y), vec2(28.0, 28.0));
    let outside = close.translate(vec2(-30.0, 0.0));
    if widgets::mini_btn(&mut ui.new_child(egui::UiBuilder::new().max_rect(close)), icons::CLOSE, 28.0, 14.0, "Close the browser pane").clicked() {
        app.browser.open = false;
        live::view().wanted = false;
    }
    let web = url.starts_with("http");
    if web && widgets::mini_btn(&mut ui.new_child(egui::UiBuilder::new().max_rect(outside)), icons::EXTERNAL, 28.0, 14.0, "Open in your own browser").clicked() {
        ui.ctx().open_url(egui::OpenUrl::new_tab(&url));
    }

    let end = if web { outside.left() } else { close.left() };
    let field = Rect::from_min_max(pos2(x + 4.0, bar.center().y - 15.0), pos2(end - 6.0, bar.center().y + 15.0));
    let id = ui.id().with("browser-address");
    let focused = ui.memory(|m| m.has_focus(id));
    ui.painter().rect(field, 8.0, if focused { p.bg2 } else { alpha(p.bg2, 70.0) }, Stroke::new(1.0, if focused { alpha(p.accent, 60.0) } else { p.border }), StrokeKind::Inside);
    if !app.browser.editing {
        app.browser.address = if url.is_empty() || url == "about:blank" { String::new() } else { url.clone() };
    }
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(field.shrink2(vec2(10.0, 0.0))).layout(egui::Layout::left_to_right(egui::Align::Center)));
    let edit = egui::TextEdit::singleline(&mut app.browser.address).id(id).frame(egui::Frame::NONE).font(theme::mono(12.0)).text_color(p.text2).hint_text("Search or type an address").desired_width(f32::INFINITY);
    let response = child.add(edit);
    app.browser.editing = response.has_focus();
    if response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !app.browser.address.trim().is_empty() {
        go = Some(Input::Go(live::address(&app.browser.address)));
    }
    if let Some(input) = go {
        app.rt.spawn(live::act(input));
    }

    // A thin line under the bar while a page loads.
    if loading {
        let t = (ui.input(|i| i.time) % 1.2 / 1.2) as f32;
        let span = card.width() * 0.3;
        let from = card.left() + (card.width() + span) * t - span;
        let line = Rect::from_min_max(pos2(from.max(card.left() + 1.0), bar.bottom() - 2.0), pos2((from + span).min(card.right() - 1.0), bar.bottom()));
        ui.painter().rect_filled(line, 1.0, p.accent);
        ui.ctx().request_repaint_after(Duration::from_millis(16));
    }

    let view = Rect::from_min_max(pos2(card.left() + 1.0, bar.bottom()), pos2(card.right() - 1.0, card.bottom() - 1.0));
    fit_page(app, ui, view, viewport, running && !driving);
    let Some(texture) = &app.browser.texture else {
        empty(ui, view, running);
        error_strip(ui, view, error.as_deref());
        return;
    };
    // The page fills the pane: it is laid out at the pane's size, and scaled up only past the widest layout.
    let tex = texture.size_vec2();
    let scale = (view.width() / tex.x).min(view.height() / tex.y);
    let image = Rect::from_min_size(pos2(view.center().x - tex.x * scale / 2.0, view.top()), tex * scale);
    // Where the picture reaches the card's bottom corners it takes their rounding, so the card stays round.
    let r = (round - 1.0) as u8;
    let low = image.bottom() >= view.bottom() - 0.5;
    let corner = |touches: bool| if low && touches { r } else { 0 };
    let radius = egui::CornerRadius { nw: 0, ne: 0, sw: corner(image.left() <= view.left() + 0.5), se: corner(image.right() >= view.right() - 0.5) };
    let uv = Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0));
    ui.painter().with_clip_rect(view).add(egui::epaint::RectShape::filled(image, radius, Color32::WHITE).with_texture(texture.id(), uv));

    let page_id = ui.id().with("browser-page");
    let hit = ui.interact(image, page_id, Sense::click()).on_hover_cursor(CursorIcon::Default);
    let at_page = |pos: egui::Pos2| {
        let (w, h) = viewport;
        ((pos.x - image.left()) / image.width() * w as f32, (pos.y - image.top()) / image.height() * h as f32)
    };
    if hit.clicked() {
        hit.request_focus();
        if let Some(pos) = hit.interact_pointer_pos() {
            let (x, y) = at_page(pos);
            app.rt.spawn(live::act(Input::Click(x, y)));
        }
    }
    if hit.hovered() {
        if let Some(pos) = hit.hover_pos() {
            let (dx, dy) = ui.input(|i| (i.smooth_scroll_delta.x, i.smooth_scroll_delta.y));
            let (x, y) = at_page(pos);
            if dx != 0.0 || dy != 0.0 {
                app.rt.spawn(live::act(Input::Wheel(x, y, -dx / scale, -dy / scale)));
            } else if app.browser.last_move.is_none_or(|at| at.elapsed() > Duration::from_millis(80)) && ui.input(|i| i.pointer.delta() != egui::Vec2::ZERO) {
                app.browser.last_move = Some(Instant::now());
                app.rt.spawn(live::act(Input::Move(x, y)));
            }
        }
    }
    if hit.has_focus() {
        keys(app, ui);
        ui.painter().rect_stroke(image.intersect(view), 0.0, Stroke::new(1.0, alpha(p.accent, 45.0)), StrokeKind::Inside);
    }
    error_strip(ui, view, error.as_deref());
    if driving {
        badge(ui, view, &title);
    }
}

/// Lays the page out at the pane's size, as a browser window that size would: at a fixed desktop width a 660 pt pane
/// drew the page at half size, its body text about 8 pt, with half the pane empty under it. Asked for once the size has
/// held for a moment, and never while the agent is mid-step, so the points it read off a screenshot stay where they were.
fn fit_page(app: &mut App, ui: &egui::Ui, view: Rect, viewport: (u32, u32), may: bool) {
    let k = (live::WIDEST / view.width()).min(1.0);
    let want = ((view.width() * k).round().max(320.0) as u32, (view.height() * k).round().max(240.0) as u32);
    if !may || want == viewport {
        app.browser.resize = None;
        return;
    }
    match app.browser.resize {
        Some((asked, since)) if asked == want => {
            if since.elapsed() > Duration::from_millis(250) {
                app.rt.spawn(live::act(Input::Size(want.0, want.1)));
                // Not asked again for a second, while the browser answers.
                app.browser.resize = Some((want, Instant::now() + Duration::from_secs(1)));
            }
        }
        _ => app.browser.resize = Some((want, Instant::now())),
    }
    ui.ctx().request_repaint_after(Duration::from_millis(300));
}

/// What went wrong, over the top of the page: in its own row it moved the page down and changed the size it needs.
fn error_strip(ui: &egui::Ui, view: Rect, error: Option<&str>) {
    let Some(why) = error else { return };
    let p = p();
    let text = widgets::galley(ui, &first_line(why), theme::font(12.0, W::Regular), p.danger);
    let strip = Rect::from_min_size(view.min, vec2(view.width(), 30.0));
    ui.painter().rect_filled(strip, 0.0, p.bg);
    ui.painter().rect_filled(strip, 0.0, alpha(p.danger, 8.0));
    widgets::text_at(ui, strip.left() + 12.0, strip.center().y, text);
}

/// Typing into the page while it has the focus: text as text, the editing keys as keys.
fn keys(app: &mut App, ui: &mut egui::Ui) {
    let events = ui.input(|i| i.events.clone());
    for event in events {
        let input = match event {
            egui::Event::Text(t) | egui::Event::Paste(t) => Some(Input::Text(t)),
            egui::Event::Key { key, pressed: true, .. } => match key {
                egui::Key::Enter => Some(Input::Key("Enter", "Enter", 13)),
                egui::Key::Backspace => Some(Input::Key("Backspace", "Backspace", 8)),
                egui::Key::Tab => Some(Input::Key("Tab", "Tab", 9)),
                egui::Key::Delete => Some(Input::Key("Delete", "Delete", 46)),
                egui::Key::ArrowLeft => Some(Input::Key("ArrowLeft", "ArrowLeft", 37)),
                egui::Key::ArrowUp => Some(Input::Key("ArrowUp", "ArrowUp", 38)),
                egui::Key::ArrowRight => Some(Input::Key("ArrowRight", "ArrowRight", 39)),
                egui::Key::ArrowDown => Some(Input::Key("ArrowDown", "ArrowDown", 40)),
                egui::Key::Home => Some(Input::Key("Home", "Home", 36)),
                egui::Key::End => Some(Input::Key("End", "End", 35)),
                egui::Key::PageUp => Some(Input::Key("PageUp", "PageUp", 33)),
                egui::Key::PageDown => Some(Input::Key("PageDown", "PageDown", 34)),
                egui::Key::Escape => Some(Input::Key("Escape", "Escape", 27)),
                _ => None,
            },
            _ => None,
        };
        if let Some(input) = input {
            app.rt.spawn(live::act(input));
        }
    }
    // Tab and arrows stay with the page rather than moving egui's focus.
    ui.memory_mut(|m| m.set_focus_lock_filter(ui.id().with("browser-page"), egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: true }));
}

/// "apiM is browsing": the agent has the page right now.
fn badge(ui: &mut egui::Ui, view: Rect, title: &str) {
    let p = p();
    let words = if title.is_empty() { "apiM is browsing".to_string() } else { format!("apiM is browsing · {}", clip(title, 40)) };
    let text = widgets::galley(ui, &words, theme::font(11.5, W::Medium), p.text);
    let pill = Rect::from_min_size(pos2(view.left() + 12.0, view.bottom() - 12.0 - 26.0), vec2(text.size().x + 12.0 + 8.0 + 8.0 + 12.0, 26.0));
    ui.painter().rect(pill, 13.0, alpha(p.elevated, 92.0), Stroke::new(1.0, p.border_light), StrokeKind::Inside);
    let pulse = (ui.input(|i| i.time) * 2.4).sin() as f32 * 0.5 + 0.5;
    ui.painter().circle_filled(pos2(pill.left() + 12.0 + 4.0, pill.center().y), 4.0, alpha(p.accent, 55.0 + 45.0 * pulse));
    widgets::text_at(ui, pill.left() + 12.0 + 8.0 + 8.0, pill.center().y, text);
    ui.ctx().request_repaint_after(Duration::from_millis(33));
}

fn empty(ui: &mut egui::Ui, view: Rect, running: bool) {
    let p = p();
    let c = view.center();
    icons::paint(ui, icons::GLOBE, pos2(c.x, c.y - 30.0), 26.0, p.muted);
    let first = widgets::galley(ui, if running { "Opening…" } else { "Nothing open yet" }, theme::font(14.0, W::Medium), p.text2);
    widgets::text_at(ui, c.x - first.size().x / 2.0, c.y + 4.0, first);
    // Wrapped and centred: on one line it ran past a pane at its narrowest.
    let room = Rect::from_center_size(pos2(c.x, c.y + 44.0), vec2((view.width() - 48.0).min(420.0), 40.0));
    let hint = egui::RichText::new("Type an address above, preview an .html file, or ask the agent to open a page.").font(theme::font(12.0, W::Regular)).color(p.muted);
    ui.scope_builder(egui::UiBuilder::new().max_rect(room).layout(egui::Layout::top_down(egui::Align::Center)), |ui| ui.add(egui::Label::new(hint).wrap()));
}

fn first_line(text: &str) -> String {
    clip(text.lines().next().unwrap_or(""), 140)
}

fn clip(text: &str, n: usize) -> String {
    if text.chars().count() > n { format!("{}…", text.chars().take(n - 1).collect::<String>()) } else { text.to_string() }
}
