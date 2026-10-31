//! The Browser pane: a card beside the chat showing the chat's own page live (`browser::live`), where the user can
//! watch each step, take over with the mouse and keyboard, or open a page or a workspace file themselves. Stretched,
//! the page fills the window and its player fills the page.

use super::theme::{self, W, alpha, p};
use super::{App, icons, titlebar, widgets};
use crate::browser::live::{self, Input, Pointer};
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, pos2, vec2};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct State {
    /// What the address box holds while it is being edited.
    address: String,
    editing: bool,
    texture: Option<egui::TextureHandle>,
    /// The chat and the frame the texture holds.
    shown: (String, u64),
    last_move: Option<Instant>,
    /// The layout size last asked of the page, and when.
    resize: Option<((u32, u32), Instant)>,
    /// The pane's width once open, kept here because it slides on a size of its own while it opens and closes.
    width: f32,
    /// It was all the way open last frame.
    settled: bool,
    /// The chat (its workspace) whose page fills the window, its player filling the page. Kept by chat: a stretched
    /// page left behind in another chat stayed pinned there, and the next chat's page was drawn stretched instead.
    stretch: Option<std::path::PathBuf>,
    /// When the pointer last moved over the stretched page: its way back shows for a moment after.
    stirred: Option<Instant>,
}

/// The chat header's height, so the two rows of buttons line up across the window.
const BAR: f32 = 56.0;

/// The pane is open in the chat on screen. The workspace rail makes way for it.
pub fn open_here(app: &App) -> bool {
    live::with(&app.conv.workspace(), |v| v.wanted)
}

fn send(app: &App, input: Input) {
    let root = app.conv.workspace();
    app.rt.spawn(async move { live::act(&root, input).await });
}

/// Opens a workspace file in the pane (the Preview of an .html file).
pub fn preview(app: &mut App, path: &std::path::Path) {
    live::with(&app.conv.workspace(), |v| v.wanted = true);
    send(app, Input::Go(live::file_url(path)));
}

/// Opens or closes the pane from the chat's header.
pub fn toggle(app: &mut App) {
    if live::with(&app.conv.workspace(), |v| {
        v.wanted = !v.wanted;
        v.wanted
    }) {
        return;
    }
    unstretch(app);
}

pub fn close(app: &mut App) {
    live::with(&app.conv.workspace(), |v| v.wanted = false);
    unstretch(app);
}

pub fn stretch(app: &mut App) {
    app.browser.stretch = Some(app.conv.workspace());
    app.browser.stirred = Some(Instant::now());
    send(app, Input::Stretch(true));
}

/// Puts the stretched page back in its pane, in whichever chat it is.
fn unstretch(app: &mut App) {
    if let Some(root) = app.browser.stretch.take() {
        app.rt.spawn(async move { live::act(&root, Input::Stretch(false)).await });
    }
}

/// The pane's width once open, in a window `window` wide.
pub fn width(app: &App, window: f32) -> f32 {
    let width = if app.browser.width == 0.0 { (window * 0.42).clamp(420.0, 760.0) } else { app.browser.width };
    width.clamp(380.0, (window * 0.62).max(420.0))
}

/// Opens itself when the agent starts browsing in this chat; drawn as a right panel, beside the rail `beside` wide (as
/// it slides, not rounded). Returns how far it is open: 0 when it is not on screen, 1 all the way open.
pub fn panel(app: &mut App, ui: &mut egui::Ui, beside: f32, right_gap: f32, top_gap: f32, gap: f32, round: f32) -> f32 {
    let open = open_here(app);
    let elsewhere = app.browser.stretch.as_ref().is_some_and(|root| live::key(root) != live::key(&app.conv.workspace()));
    if !open || elsewhere {
        unstretch(app);
    }
    let shown = ui.ctx().animate_bool_with_time_and_easing(egui::Id::new("browser-open"), open, 0.3, egui::emath::easing::cubic_out);
    if shown <= 0.0 {
        app.browser.settled = false;
        return 0.0;
    }
    let window = ui.ctx().content_rect().width();
    let most = (window * 0.62).max(420.0);
    let full = width(app, window);
    let frame = egui::Frame::new().fill(p().bg2).inner_margin(egui::Margin { left: 0, right: right_gap as i8, top: top_gap as i8, bottom: gap as i8 });
    // It slides as the sidebar and the rail do, its content at full width and cut off at the window's edge: a fade at
    // full width left the chat to jump 600 points sideways in one frame. Resizable once it is all the way open.
    let panel = egui::Panel::right("browser-pane").show_separator_line(false).frame(frame);
    // The first frame all the way open takes `full` exactly too. Left to the size egui kept from the slide's last
    // frame, a point short, the pane came out a point narrower every time it opened.
    let settled = shown >= 1.0 && app.browser.settled;
    // Rounded with the rail it makes way for, as one: each rounded on its own, the two at times came to a point more
    // than the frame before, and the chat's edge stepped back.
    let sliding = ((beside + full * shown).round() - beside.round()).max(0.0);
    let panel = if settled { panel.resizable(true).default_size(full).size_range(380.0..=most) } else { panel.exact_size(sliding).resizable(false) };
    let shown_whole = shown >= 1.0;
    app.browser.settled = shown_whole;
    let stretched = app.browser.stretch.is_some();
    let drawn = panel.show(ui, |ui| {
        let visible = ui.max_rect();
        ui.set_clip_rect(visible.expand(1.0));
        // Sliding, the card is as wide as it will be open (the rail it takes the place of is gone by then), so neither
        // its bar nor the page under it moves or is laid out again on the way.
        let card = if shown_whole { visible } else { Rect::from_min_size(visible.min, vec2(full - gap, visible.height())) };
        if stretched {
            // The page is in the stretched view; its card keeps its place underneath, empty.
            ui.painter().rect(card, round, p().bg, Stroke::new(1.0, alpha(p().border, 70.0)), StrokeKind::Inside);
        } else {
            // In a child that claims no room. Sliding, the card is wider than the panel, and what the card laid out
            // (the empty page's words) stretched the panel's own rect past the window's edge: egui put the chat's
            // card under the pane, the chat 110 points wider in the slide's first frame, then narrower in jumps.
            pane(app, &mut ui.new_child(egui::UiBuilder::new().max_rect(card)), card, round);
        }
        // Claimed whole: a side panel keeps the width its content used, and painting uses none, so it shrank to
        // its narrowest.
        ui.allocate_rect(visible, Sense::hover());
    });
    if shown_whole {
        app.browser.width = drawn.response.rect.width();
    }
    if stretched {
        stretch_view(app, ui.ctx());
    }
    shown
}

fn pane(app: &mut App, ui: &mut egui::Ui, card: Rect, round: f32) {
    let p = p();
    ui.painter().rect(card, round, p.bg, Stroke::new(1.0, alpha(p.border, 70.0)), StrokeKind::Inside);
    let (url, loading, has_page) = live::with(&app.conv.workspace(), |v| (v.url.clone(), v.loading, v.running && v.size[0] > 0));

    // The bar: back, forward, reload, the address, stretch, open outside, close.
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
    let close_rect = Rect::from_center_size(pos2(bar.right() - 10.0 - 14.0, bar.center().y), vec2(28.0, 28.0));
    let web = url.starts_with("http");
    let outside = close_rect.translate(vec2(-30.0, 0.0));
    let stretch_at = if web { outside.translate(vec2(-30.0, 0.0)) } else { outside };
    if widgets::mini_btn(&mut ui.new_child(egui::UiBuilder::new().max_rect(close_rect)), icons::CLOSE, 28.0, 14.0, "Close the browser pane").clicked() {
        close(app);
    }
    if web && widgets::mini_btn(&mut ui.new_child(egui::UiBuilder::new().max_rect(outside)), icons::EXTERNAL, 28.0, 14.0, "Open in your own browser").clicked() {
        ui.ctx().open_url(egui::OpenUrl::new_tab(&url));
    }
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(stretch_at));
    child.add_enabled_ui(has_page, |ui| {
        if widgets::mini_btn(ui, icons::STRETCH, 28.0, 14.0, "Stretch").clicked() {
            go = Some(Input::Stretch(true));
        }
    });

    let field = Rect::from_min_max(pos2(x + 4.0, bar.center().y - 15.0), pos2(stretch_at.left() - 6.0, bar.center().y + 15.0));
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
    match go {
        Some(Input::Stretch(true)) => stretch(app),
        Some(input) => send(app, input),
        None => {}
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
    page(app, ui, view, round, live::WIDEST, true);
}

/// The page over the whole window, below the title bar: no bar, no card, its player filling it. The way back shows at
/// the top right for a moment after the pointer moves, and Esc takes it too.
fn stretch_view(app: &mut App, ctx: &egui::Context) {
    let screen = ctx.content_rect();
    let top = if ctx.input(|i| i.viewport().fullscreen.unwrap_or(false)) { 0.0 } else { titlebar::HEIGHT };
    let rect = Rect::from_min_max(pos2(screen.left(), screen.top() + top), screen.max);
    egui::Area::new(egui::Id::new("browser-stretch")).order(egui::Order::Foreground).fixed_pos(rect.min).show(ctx, |ui| {
        ui.set_clip_rect(rect);
        ui.painter().rect_filled(rect, 0.0, Color32::BLACK);
        let back = Rect::from_min_size(pos2(rect.right() - 20.0 - 36.0, rect.top() + 20.0), vec2(36.0, 36.0));
        // The page takes every press but the one on the way back.
        let over_back = ui.rect_contains_pointer(back.expand(6.0));
        page(app, ui, rect, 0.0, live::WIDEST_STRETCHED, false);
        if ui.input(|i| i.pointer.delta() != egui::Vec2::ZERO) {
            app.browser.stirred = Some(Instant::now());
        }
        let lately = app.browser.stirred.is_some_and(|at| at.elapsed() < Duration::from_millis(2200));
        let shown = ctx.animate_bool_with_time(egui::Id::new("stretch-back"), lately || over_back, 0.2);
        if lately {
            ctx.request_repaint_after(Duration::from_millis(120));
        }
        if shown > 0.0 {
            let hit = ui.interact(back, egui::Id::new("stretch-back-hit"), Sense::click()).on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Back");
            let fill = Color32::from_black_alpha((150.0 * shown) as u8).lerp_to_gamma(Color32::from_white_alpha((60.0 * shown) as u8), if hit.hovered() { 0.35 } else { 0.0 });
            ui.painter().circle(back.center(), 18.0, fill, Stroke::new(1.0, Color32::from_white_alpha((40.0 * shown) as u8)));
            icons::paint(ui, icons::STRETCH_EXIT, back.center(), 16.0, Color32::from_white_alpha((235.0 * shown) as u8));
            if hit.clicked() {
                unstretch(app);
            }
        }
        if ui.input(|i| i.key_pressed(egui::Key::Escape)) {
            unstretch(app);
        }
    });
}

/// The page itself, at `view`: its frame, the clicks, wheel and keys that go to it, the agent's pointer, and what
/// went wrong. Shared by the pane and the stretched view.
fn page(app: &mut App, ui: &mut egui::Ui, view: Rect, round: f32, widest: f32, in_pane: bool) {
    let p = p();
    let root = app.conv.workspace();
    let key = live::key(&root);
    let (title, driving, error, size, seq, running, viewport, pointer, url, check) = live::with(&root, |v| (v.title.clone(), v.driving > 0, v.error.clone(), v.size, v.seq, v.running, v.viewport, v.pointer.clone(), v.url.clone(), v.check));
    if (key.as_str(), seq) != (app.browser.shown.0.as_str(), app.browser.shown.1) {
        let rgba = live::with(&root, |v| v.rgba.clone());
        if size[0] > 0 && rgba.len() == size[0] * size[1] * 4 {
            let image = egui::ColorImage::from_rgba_unmultiplied(size, &rgba);
            match &mut app.browser.texture {
                Some(t) => t.set(image, egui::TextureOptions::LINEAR),
                None => app.browser.texture = Some(ui.ctx().load_texture("browser-frame", image, egui::TextureOptions::LINEAR)),
            }
        } else if size[0] == 0 {
            app.browser.texture = None;
        }
        app.browser.shown = (key, seq);
    }
    fit_page(app, ui, view, viewport, running, widest);
    let Some(texture) = &app.browser.texture else {
        empty(ui, view, running);
        error_strip(ui, view, error.as_deref());
        return;
    };
    // The page fills the view: it is laid out at the view's size. Until a new size has come back from the browser
    // (a drag of the pane's edge, the stretch), the last frame is fitted inside it.
    let tex = texture.size_vec2();
    let scale = (view.width() / tex.x).min(view.height() / tex.y);
    let size_now = tex * scale;
    let image = Rect::from_min_size(pos2(view.center().x - size_now.x / 2.0, if in_pane { view.top() } else { view.center().y - size_now.y / 2.0 }), size_now);
    // Where the picture reaches the card's bottom corners it takes their rounding, so the card stays round.
    let r = (round - 1.0).max(0.0) as u8;
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
    let css = image.width() / viewport.0.max(1) as f32;
    if hit.clicked() {
        hit.request_focus();
        if let Some(pos) = hit.interact_pointer_pos() {
            let (x, y) = at_page(pos);
            send(app, Input::Click(x, y));
        }
    }
    if hit.hovered() {
        if let Some(pos) = hit.hover_pos() {
            let (dx, dy) = ui.input(|i| (i.smooth_scroll_delta.x, i.smooth_scroll_delta.y));
            let (x, y) = at_page(pos);
            if dx != 0.0 || dy != 0.0 {
                send(app, Input::Wheel(x, y, -dx / css, -dy / css));
            } else if app.browser.last_move.is_none_or(|at| at.elapsed() > Duration::from_millis(80)) && ui.input(|i| i.pointer.delta() != egui::Vec2::ZERO) {
                app.browser.last_move = Some(Instant::now());
                send(app, Input::Move(x, y));
            }
        }
    }
    if hit.has_focus() {
        keys(app, ui, !in_pane);
        if in_pane {
            ui.painter().rect_stroke(image.intersect(view), 0.0, Stroke::new(1.0, alpha(p.accent, 45.0)), StrokeKind::Inside);
        }
    }
    if let Some(pointer) = pointer {
        agent_pointer(ui, view, image, viewport, &pointer, driving);
    }
    error_strip(ui, view, error.as_deref());
    if window_note(ui, view, &url, &title, check) {
        app.rt.spawn(live::in_window(root.clone(), url.clone()));
    }
    if driving && in_pane {
        badge(ui, view, &title);
    }
}

/// Some pages turn away a browser that is headless or driven by a program, and this one is both: the agent drives it.
/// Google's sign-in ("This browser or app may not be secure"), and the checks for a person in front of a site
/// (Cloudflare's "Just a moment…"), which took a click here, thought, and asked again, round and round. The browser is
/// not dressed up as an ordinary one to get past them, which would also hide what the agent's browser is from every
/// other site. The pane says so and offers the page in an ordinary window of the same browser on the same profile
/// (`live::in_window`), where the user signs in or passes the check, and that holds here too once the window is
/// closed. The user's own browser, offered before for signing in, signed them in there and not here. Returns whether
/// the window was asked for.
fn window_note(ui: &mut egui::Ui, view: Rect, url: &str, title: &str, check: bool) -> bool {
    let host = url.split("://").nth(1).and_then(|rest| rest.split(['/', '?', '#']).next()).unwrap_or("");
    // A check a person can pass; a site's outright "access denied" is not one.
    let check = check || crate::browser::page::detect_challenge(title, "").or(url.contains("__cf_chl").then_some("Cloudflare")).is_some_and(|who| who != "an edge block");
    let (head, body, label) = if host == "accounts.google.com" {
        ("Google won't sign you in here", "It turns away browsers that a program drives, like this one.\nSign in in a window of its own: close it when you're done, and the pane is signed in too.", "Open a sign-in window")
    } else if check {
        ("This site wants to see a person", "Its check turns away browsers that a program drives, like this one.\nPass it in its own window, then close it: the page comes back here.", "Open in a window")
    } else {
        return false;
    };
    let p = p();
    let inner = view.shrink(12.0);
    // Stretched over the window, a card the page's width would leave the button far from the words.
    let width = inner.width().min(620.0);
    let button_w = widgets::galley(ui, label, theme::font(12.0, W::Medium), p.text).size().x + 20.0;
    let text_w = (width - 28.0 - button_w - 14.0).max(120.0);
    let head = ui.painter().layout(head.into(), theme::font(12.5, W::Semibold), p.text, text_w);
    let body = ui.painter().layout(body.into(), theme::font(11.5, W::Regular), p.text2, text_w);
    let height = 14.0 + head.size().y + 3.0 + body.size().y + 14.0;
    let card = Rect::from_min_size(pos2(inner.center().x - width / 2.0, inner.bottom() - height), vec2(width, height));
    let painter = ui.painter().with_clip_rect(view);
    painter.rect_filled(card.translate(vec2(0.0, 4.0)).expand(2.0), 14.0, Color32::from_black_alpha(if p.is_dark() { 70 } else { 24 }));
    painter.rect(card, 12.0, p.elevated, Stroke::new(1.0, p.border_light), StrokeKind::Inside);
    let top = card.top() + 14.0;
    let head_h = head.size().y;
    painter.galley(pos2(card.left() + 14.0, top), head, p.text);
    painter.galley(pos2(card.left() + 14.0, top + head_h + 3.0), body, p.text2);
    // On top of the page's own hit area, so a click on the card's words does not reach the page under it.
    ui.interact(card, ui.id().with("signin-note"), Sense::click());
    let button = Rect::from_center_size(pos2(card.right() - 14.0 - button_w / 2.0, card.center().y), vec2(button_w, 26.0));
    let mut child = ui.new_child(egui::UiBuilder::new().max_rect(button));
    widgets::small_btn(&mut child, label, p.text, p.hover, p.border_light).clicked()
}

/// Lays the page out at the view's size, as a browser window that size would: at a fixed desktop width a 660 pt pane
/// drew the page at half size, its body text about 8 pt, with half the pane empty under it. Asked again at most every
/// 70 ms while the size changes, so the page follows a drag of the pane's edge as it goes. It waited for the edge to
/// stop, which a drag never does until it is let go: the page sat shrunk in the middle of the pane until then.
fn fit_page(app: &mut App, ui: &egui::Ui, view: Rect, viewport: (u32, u32), running: bool, widest: f32) {
    let k = (widest / view.width()).min(1.0);
    let want = ((view.width() * k).round().max(320.0) as u32, (view.height() * k).round().max(240.0) as u32);
    if !running || want == viewport {
        app.browser.resize = None;
        return;
    }
    let due = match app.browser.resize {
        // A new size goes as soon as the last one has had its moment; the same size is asked again only if no
        // answer came.
        Some((asked, at)) => (asked != want && at.elapsed() > Duration::from_millis(70)) || at.elapsed() > Duration::from_millis(700),
        None => true,
    };
    if due {
        send(app, Input::Size(want.0, want.1));
        app.browser.resize = Some((want, Instant::now()));
    }
    ui.ctx().request_repaint_after(Duration::from_millis(80));
}

/// The agent's pointer: it glides to where the agent clicks or types, a ring spreads where a click lands, and a label
/// says what it is doing. Steps that were only selectors before ("click #search-input > input") are seen as a hand
/// would make them. It fades a moment after the agent's last step.
fn agent_pointer(ui: &egui::Ui, view: Rect, image: Rect, viewport: (u32, u32), pointer: &Pointer, driving: bool) {
    let p = p();
    let age = pointer.when.elapsed().as_secs_f32();
    let fade = if driving { 1.0 } else { 1.0 - ((age - 2.5) / 0.5).clamp(0.0, 1.0) };
    if fade <= 0.0 {
        return;
    }
    const GLIDE: f32 = 0.3;
    let t = emath_ease((age / GLIDE).min(1.0));
    let css = (pointer.from.0 + (pointer.to.0 - pointer.from.0) * t, pointer.from.1 + (pointer.to.1 - pointer.from.1) * t);
    let at = pos2(image.left() + css.0 / viewport.0.max(1) as f32 * image.width(), image.top() + css.1 / viewport.1.max(1) as f32 * image.height());
    let painter = ui.painter().with_clip_rect(view);
    if pointer.click && (GLIDE..GLIDE + 0.55).contains(&age) {
        let k = (age - GLIDE) / 0.55;
        painter.circle_stroke(at, 5.0 + 17.0 * k, Stroke::new(2.0, alpha(p.accent, 90.0 * (1.0 - k) * fade)));
        painter.circle_filled(at, 5.0 * (1.0 - k), alpha(p.accent, 60.0 * (1.0 - k) * fade));
    }
    // An arrow, tip at the point: white with a dark edge, so it reads on any page.
    let arrow = [(0.0, 0.0), (0.0, 16.5), (4.2, 12.6), (7.4, 19.4), (10.0, 18.2), (6.9, 11.6), (12.4, 11.6)];
    let points: Vec<egui::Pos2> = arrow.iter().map(|(x, y)| at + vec2(*x, *y)).collect();
    let shadow: Vec<egui::Pos2> = points.iter().map(|q| *q + vec2(0.0, 1.5)).collect();
    painter.add(egui::Shape::convex_polygon(shadow, Color32::from_black_alpha((60.0 * fade) as u8), Stroke::NONE));
    painter.add(egui::Shape::convex_polygon(points[..3].iter().copied().chain([points[6]]).collect(), Color32::from_white_alpha((255.0 * fade) as u8), Stroke::NONE));
    painter.add(egui::Shape::convex_polygon(vec![points[2], points[3], points[4], points[5]], Color32::from_white_alpha((255.0 * fade) as u8), Stroke::NONE));
    painter.add(egui::Shape::closed_line(points, Stroke::new(1.1, Color32::from_black_alpha((200.0 * fade) as u8))));
    // What it is doing, beside it, kept inside the page.
    let words = widgets::galley(ui, &pointer.what, theme::font(11.5, W::Medium), alpha(p.text, 100.0 * fade));
    let size = vec2(words.size().x + 20.0, 24.0);
    let mut pill = Rect::from_min_size(at + vec2(16.0, 18.0), size);
    if pill.right() > view.right() - 6.0 {
        pill = pill.translate(vec2(view.right() - 6.0 - pill.right(), 0.0));
    }
    if pill.bottom() > view.bottom() - 6.0 {
        pill = pill.translate(vec2(0.0, -(pill.height() + 30.0)));
    }
    let come = (age / 0.2).min(1.0) * fade;
    painter.rect(pill, 12.0, alpha(p.elevated, 94.0 * come), Stroke::new(1.0, alpha(p.border_light, 100.0 * come)), StrokeKind::Inside);
    painter.galley(pos2(pill.left() + 10.0, pill.center().y - words.size().y / 2.0), words, Color32::WHITE);
    if age < 3.2 || driving {
        ui.ctx().request_repaint_after(Duration::from_millis(16));
    }
}

fn emath_ease(t: f32) -> f32 {
    egui::emath::easing::cubic_out(t)
}

/// Typing into the page while it has the focus: text as text, the editing keys as keys. Stretched, Esc is the way back
/// and stays with the app.
fn keys(app: &mut App, ui: &mut egui::Ui, stretched: bool) {
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
                egui::Key::Space => None,
                egui::Key::Escape if !stretched => Some(Input::Key("Escape", "Escape", 27)),
                _ => None,
            },
            _ => None,
        };
        if let Some(input) = input {
            send(app, input);
        }
    }
    // Tab and arrows stay with the page rather than moving egui's focus.
    ui.memory_mut(|m| m.set_focus_lock_filter(ui.id().with("browser-page"), egui::EventFilter { tab: true, horizontal_arrows: true, vertical_arrows: true, escape: !stretched }));
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
    let away = live::in_window_now();
    let first = widgets::galley(ui, if away { "Open in a window" } else if running { "Opening…" } else { "Nothing open yet" }, theme::font(14.0, W::Medium), p.text2);
    widgets::text_at(ui, c.x - first.size().x / 2.0, c.y + 4.0, first);
    // Wrapped and centred: on one line it ran past a pane at its narrowest.
    let room = Rect::from_center_size(pos2(c.x, c.y + 44.0), vec2((view.width() - 48.0).min(420.0), 40.0));
    let hint = if away { "Finish in the browser window that opened, then close it: the page comes back here, with what you did there." } else { "Type an address above, preview an .html file, or ask the agent to open a page." };
    let hint = egui::RichText::new(hint).font(theme::font(12.0, W::Regular)).color(p.muted);
    ui.scope_builder(egui::UiBuilder::new().max_rect(room).layout(egui::Layout::top_down(egui::Align::Center)), |ui| ui.add(egui::Label::new(hint).wrap()));
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

fn first_line(text: &str) -> String {
    clip(text.lines().next().unwrap_or(""), 140)
}

fn clip(text: &str, n: usize) -> String {
    if text.chars().count() > n { format!("{}…", text.chars().take(n - 1).collect::<String>()) } else { text.to_string() }
}
