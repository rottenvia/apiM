//! The window's end of the phone link (`crate::remote`): what the chat on screen looks like to the phone, what the
//! phone asked for, and the Settings tab that pairs one. The phone mirrors the window: opening a chat there opens it
//! here, and a message sent there goes through the same message box as one typed here.

use super::form::{self, Seg, Switch};
use super::theme::{self, W, alpha, p};
use super::{App, Run, attachments, bubble, settings::part, widgets};
use crate::remote::{self as wire, Command, Remote};
use crate::store::{self, Part, Role};
use base64::Engine;
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How often a phone is sent the chat while it changes: a reply reads as smoothly as it types here, without a frame
/// for every few characters.
const EVERY: Duration = Duration::from_millis(120);
/// Messages sent from the end of the chat. Older ones stay on this computer and the phone says how many.
const SHOWN: usize = 80;
/// The end of a long thought: the phone shows thinking folded, and its last lines are the ones that say where it is.
const THOUGHT: usize = 4000;
/// A toast this recent rides to the phone: a message that was not sent says why there.
const TOAST: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct State {
    link: Option<Remote>,
    /// Why the link is not listening.
    error: Option<String>,
    config: Config,
    published: Option<Instant>,
    /// A message from the phone waiting for the photos it carried to be read.
    held: Option<String>,
    /// The pairing link and its QR code, made again when the addresses change.
    code: Option<(String, egui::TextureHandle)>,
    /// When this computer's addresses were last looked up (the tab is drawn every frame).
    looked: Option<(Instant, Vec<String>)>,
    /// The phones connected at the last frame: one that joins is said above the message box.
    phones: Vec<String>,
}

/// `remote.json` in the data folder: whether the link is on, and the secret phones were paired with.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    on: bool,
    secret: String,
}

fn config_path() -> PathBuf {
    store::data_dir().join("remote.json")
}

fn save(config: &Config) {
    let _ = std::fs::write(config_path(), serde_json::to_vec_pretty(config).unwrap_or_default());
}

/// The name the phone shows for this computer.
fn pc_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "PC".into())
}

fn port() -> u16 {
    std::env::var("APIM_REMOTE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(wire::PORT)
}

/// At start: listens again if the link was left on.
pub fn boot(app: &mut App) {
    app.remote.config = std::fs::read(config_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    if app.remote.config.on {
        listen(app);
    }
}

/// (Re)opens the port with the kept secret, making one the first time. Every phone connected drops and reconnects.
fn listen(app: &mut App) {
    let st = &mut app.remote;
    st.link = None;
    let secret = wire::decode_secret(&st.config.secret).unwrap_or_else(|| {
        let secret = wire::new_secret();
        st.config.secret = wire::encode_secret(&secret);
        save(&st.config);
        secret
    });
    let (port, wake) = (port(), app.ctx.clone());
    match Remote::start(app.rt.handle(), port, secret, move || wake.request_repaint()) {
        Ok(link) => (st.link, st.error, st.published) = (Some(link), None, None),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            st.error = Some(format!("Port {port} is taken: another apiM, or another program. Close it, or start apiM with APIM_REMOTE_PORT set to a free port."))
        }
        Err(e) => st.error = Some(format!("Could not listen on port {port}: {e}")),
    }
}

/// Every frame (`logic`, so also while minimized): what the phones asked for, and what they should now show.
pub fn tick(app: &mut App) {
    let Some(link) = app.remote.link.as_mut() else { return };
    let commands = link.commands();
    let phones = link.phones();
    let connected = !phones.is_empty();
    // Said here, and not as a toast: a toast also rides to the phone, which knows it has connected.
    if let Some(joined) = phones.iter().find(|p| !app.remote.phones.contains(p)) {
        super::slash_menu::say(app, format!("{joined} connected. It can send messages and approve commands here."), false);
    }
    app.remote.phones = phones;
    for command in commands {
        act(app, command);
    }
    if app.remote.held.is_some() && attachments::waiting(&app.attachments).is_none() {
        let text = app.remote.held.take().unwrap_or_default();
        send(app, text);
    }
    if !connected {
        app.remote.published = None;
        return;
    }
    match app.remote.published.map(|at| at.elapsed()) {
        // Too soon after the last: come back for whatever changed in between, or the reply's last words wait for
        // something else to wake the window.
        Some(since) if since < EVERY => app.ctx.request_repaint_after(EVERY - since),
        _ => {
            let view = view(app);
            if let Some(link) = &app.remote.link {
                link.publish(view);
            }
            app.remote.published = Some(Instant::now());
        }
    }
}

/// The reply running in the chat on screen.
fn here(app: &mut App) -> Option<&mut Run> {
    let id = app.conv.id.clone();
    app.runs.iter_mut().find(|run| run.conv_id == id)
}

fn act(app: &mut App, command: Command) {
    match command {
        Command::Open { id } => app.open_chat(&id),
        Command::New => app.new_chat(),
        Command::Stop => app.stop(),
        Command::Allow { allow } => {
            if let Some(asked) = here(app).and_then(|run| run.approval.take()) {
                let _ = asked.reply.send(allow);
            }
        }
        Command::Answer { text } => {
            if let Some(asked) = here(app).and_then(|run| run.question.take()) {
                let _ = asked.reply.send(text);
            }
        }
        Command::Send { text, photos } if photos.is_empty() => send(app, text),
        Command::Send { text, photos } => {
            // Attached as if dropped on the window, so a model that cannot see gets them described like any other picture.
            // ponytail: the photos stay in `phone/` under the data folder; prune it if it grows.
            let folder = store::data_dir().join("phone");
            let _ = std::fs::create_dir_all(&folder);
            for (i, photo) in photos.iter().enumerate() {
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(photo.data.trim()) else { continue };
                let stem: String = photo.name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
                let path = folder.join(format!("{}-{i}-{}.jpg", store::now_ms(), if stem.is_empty() { "photo" } else { &stem }));
                if std::fs::write(&path, bytes).is_ok() {
                    attachments::add(app, path);
                }
            }
            app.remote.held = Some(text);
        }
        Command::Ping => {}
    }
}

/// Sends the phone's words as if typed here, through everything the Send button does: a command runs, a reply
/// already running reads them as a note. What was in the box here comes back after.
// ponytail: anything attached in the box here goes with the phone's message; keep the chips apart if that ever surprises.
fn send(app: &mut App, text: String) {
    let kept = std::mem::replace(&mut app.draft, text);
    let ctx = app.ctx.clone();
    app.submit(&ctx);
    app.draft = kept;
}

fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// The last `max` characters, for a thought.
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let at = text.char_indices().nth(count - max).map_or(0, |(at, _)| at);
    format!("…{}", &text[at..])
}

fn message(m: &store::Message) -> wire::Msg {
    let user = m.role == Role::User;
    let parts = if user {
        // The notes the app wrote about attached files are for the model; the phone shows the words and the file names.
        let whole = m.text();
        let text = if m.attachments.is_empty() { whole.as_str() } else { bubble::without_file_notes(&whole) };
        vec![wire::Piece::Text { text: text.trim().to_string() }]
    } else {
        m.parts
            .iter()
            .map(|part| match part {
                Part::Text(text) => wire::Piece::Text { text: text.clone() },
                Part::Thinking { text, ms } => wire::Piece::Think { text: tail(text, THOUGHT), ms: *ms },
                Part::Tool(t) => {
                    let (title, target, kind) = bubble::step_words(&t.name, &t.args, t.ok.is_some());
                    wire::Piece::Tool { id: t.id.clone(), kind: kind.into(), title, target: cut(&target, 300), ok: t.ok, summary: cut(&t.summary, 300) }
                }
                Part::Notice(text) => wire::Piece::Notice { text: text.clone() },
            })
            .collect()
    };
    wire::Msg {
        id: m.id.clone(),
        role: if user { "user" } else { "assistant" }.into(),
        parts,
        model: m.model.clone(),
        error: m.error.clone(),
        incomplete: m.incomplete,
        note: m.note,
        files: m.attachments.iter().map(|a| a.name.clone()).collect(),
        at: m.created_at,
    }
}

fn view(app: &App) -> wire::View {
    let run = app.runs.iter().find(|run| run.conv_id == app.conv.id);
    let skip = app.conv.messages.len().saturating_sub(SHOWN);
    let notice = match (&app.toast, &app.slash.notice) {
        (Some((text, at)), _) if at.elapsed() < TOAST => text.clone(),
        (_, Some(notice)) if notice.error && notice.since.elapsed() < TOAST => notice.text.clone(),
        _ => String::new(),
    };
    wire::View {
        pc: pc_name(),
        model: crate::models::resolve(&app.settings.model, &app.settings.custom_models).label,
        chats: app.chats.iter().filter(|c| !c.archived).take(300).map(|c| wire::ChatRow { id: c.id.clone(), title: c.title.clone(), updated: c.updated_at, running: app.runs.iter().any(|run| run.conv_id == c.id) }).collect(),
        chat: wire::ChatView { id: app.conv.id.clone(), title: app.conv.title.clone(), earlier: skip, messages: app.conv.messages[skip..].iter().map(message).collect() },
        run: wire::RunView {
            running: run.is_some(),
            status: run.map_or("", |run| run.status).to_string(),
            approval: run.and_then(|run| run.approval.as_ref()).map(|a| wire::Approval { command: a.command.clone(), reason: a.reason.clone() }),
            question: run.and_then(|run| run.question.as_ref()).map(|q| wire::Question { question: q.question.clone(), options: q.options.clone(), context: q.context.clone() }),
        },
        notice,
    }
}

// ------------------------------------------------------------------ Settings > Phone

pub fn settings(app: &mut App, ui: &mut Ui) {
    let p = p();
    form::label(ui, "Remote control", "");
    ui.add_space(8.0);
    form::helper(
        ui,
        &[Seg::T(
            "Drive this app from the apiM app on your iPhone: read your chats, send messages and photos, approve commands and stop a reply. The phone talks to this computer directly over your network, encrypted with a key only the two of them hold.",
        )],
    );
    ui.add_space(10.0);

    let on = app.remote.config.on;
    let (row, response) = ui.allocate_exact_size(vec2(ui.available_width(), 58.0), Sense::click());
    let response = response.on_hover_cursor(CursorIcon::PointingHand);
    let t = widgets::fade(ui, response.id, response.hovered());
    ui.painter().rect(row, 12.0, p.bg3, Stroke::new(1.0, widgets::lerp(p.border, p.border_light, t)), StrokeKind::Inside);
    widgets::text_at(ui, row.left() + 13.0, row.top() + 20.75, widgets::galley(ui, if on { "On" } else { "Off" }, theme::font(13.0, W::Medium), p.text));
    let small = match (&app.remote.link, &app.remote.error) {
        (Some(link), _) => format!("Listening on port {}", link.port),
        (None, Some(_)) if on => "Not listening: see below".to_string(),
        _ => "Nothing listens, so no phone can connect".to_string(),
    };
    widgets::text_at(ui, row.left() + 13.0, row.top() + 39.25, widgets::galley(ui, &small, theme::font(11.0, W::Regular), p.text2));
    part(ui, Rect::from_min_size(pos2(row.right() - 49.0, row.center().y - 10.0), vec2(36.0, 20.0)), |ui| form::switch(ui, Switch::B, on));
    if response.clicked() {
        app.remote.config.on = !on;
        save(&app.remote.config);
        if on {
            (app.remote.link, app.remote.error) = (None, None);
        } else {
            listen(app);
        }
    }

    if let Some(error) = app.remote.error.clone().filter(|_| app.remote.config.on) {
        ui.add_space(10.0);
        form::boxed(ui, alpha(p.danger, 7.0), alpha(p.danger, 30.0), 12, (12, 10), |ui| form::para(ui, &error, 12.0, 16.0, W::Regular, p.text2));
    }
    if app.remote.link.is_none() {
        return;
    }

    ui.add_space(20.0);
    form::label(ui, "Pair a phone", "");
    ui.add_space(10.0);
    let link = pairing_code(app, ui.ctx());
    let side = 176.0;
    let (card, _) = ui.allocate_exact_size(vec2(ui.available_width(), side), Sense::hover());
    let code = Rect::from_min_size(card.min, vec2(side, side));
    ui.painter().rect_filled(code, 14.0, Color32::WHITE);
    if let Some((_, texture)) = &app.remote.code {
        ui.painter().image(texture.id(), code.shrink(10.0), Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0)), Color32::WHITE);
    }
    let text = Rect::from_min_max(pos2(code.right() + 20.0, card.top() + 2.0), card.max);
    part(ui, text, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        let steps = [
            "Install apiM on your iPhone.",
            "Point the iPhone's Camera at this code, or tap Scan in the app.",
            "Leave this app running. Minimized is fine.",
        ];
        for (i, step) in steps.iter().enumerate() {
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (dot, _) = ui.allocate_exact_size(vec2(18.0, 18.0), Sense::hover());
                ui.painter().circle_filled(dot.center(), 9.0, alpha(p.accent, 22.0));
                ui.painter().text(dot.center(), egui::Align2::CENTER_CENTER, (i + 1).to_string(), theme::font(11.0, W::Semibold), p.accent);
                form::para(ui, step, 12.5, 18.0, W::Regular, p.text);
            });
            ui.add_space(8.0);
        }
        ui.add_space(6.0);
        let phones = app.remote.link.as_ref().map(Remote::phones).unwrap_or_default();
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 7.0;
            let (dot, _) = ui.allocate_exact_size(vec2(8.0, 18.0), Sense::hover());
            ui.painter().circle_filled(dot.center(), 4.0, if phones.is_empty() { p.muted } else { p.success });
            let said = if phones.is_empty() { "No phone connected".to_string() } else { format!("Connected: {}", phones.join(", ")) };
            form::line(ui, &said, 12.0, 18.0, W::Medium, if phones.is_empty() { p.text2 } else { p.text });
        });
    });

    ui.add_space(14.0);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        if widgets::small_btn(ui, "Copy pairing link", p.text, p.bg3, p.border).on_hover_text("For a phone that cannot scan: open the link on it. Anyone holding it can drive this app.").clicked() {
            ui.ctx().copy_text(link);
            app.toast("Pairing link copied. Anyone holding it can drive this app, so send it only to your own phone.");
        }
        if widgets::small_btn(ui, "Unpair all phones", p.danger, Color32::TRANSPARENT, alpha(p.danger, 40.0)).on_hover_text("Makes a new key: every phone paired so far is cut off and has to scan the new code.").clicked() {
            app.remote.config.secret.clear();
            app.remote.code = None;
            listen(app);
            app.toast("Every paired phone was unpaired. Scan the new code to pair again.");
        }
    });
    ui.add_space(14.0);
    form::note(
        ui,
        "The first time, Windows may ask whether apiM can use the network: allow it on private networks, or the phone cannot reach it. The phone and this computer must be on the same Wi-Fi, or both on Tailscale to reach it from anywhere.",
    );
}

/// The pairing link for this computer's addresses now, and its QR code as a texture drawn pixel for pixel.
fn pairing_code(app: &mut App, ctx: &egui::Context) -> String {
    let st = &mut app.remote;
    if st.looked.as_ref().is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(5)) {
        st.looked = Some((Instant::now(), wire::addresses()));
    }
    let addresses = st.looked.as_ref().map(|(_, a)| a.clone()).unwrap_or_default();
    let (Some(link), Some(secret)) = (st.link.as_ref(), wire::decode_secret(&st.config.secret)) else { return String::new() };
    let text = wire::pairing_link(&pc_name(), link.port, &addresses, &secret);
    if st.code.as_ref().is_none_or(|(made, _)| *made != text) {
        let image = qr_image(&text);
        st.code = Some((text.clone(), ctx.load_texture("remote-pairing", image, egui::TextureOptions::NEAREST)));
    }
    text
}

/// Dark modules on white with the four-module quiet zone scanners need.
fn qr_image(text: &str) -> egui::ColorImage {
    let Ok(qr) = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium) else { return egui::ColorImage::new([1, 1], vec![Color32::WHITE]) };
    let quiet = 4;
    let n = qr.size() + 2 * quiet;
    let ink = Color32::from_rgb(0x19, 0x17, 0x15);
    let pixels = (0..n * n).map(|i| if qr.get_module(i % n - quiet, i / n - quiet) { ink } else { Color32::WHITE }).collect();
    egui::ColorImage::new([n as usize, n as usize], pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_thought_keeps_its_end() {
        assert_eq!(tail("abcdef", 3), "…def");
        assert_eq!(tail("abc", 3), "abc");
        assert_eq!(cut("ééééé", 2), "éé…", "cut on characters, not bytes");
    }

    #[test]
    fn the_code_has_its_quiet_zone() {
        let image = qr_image("apim://pair?v=1&n=PC&p=47100&h=192.168.1.5&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let n = image.size[0];
        assert!(n >= 21 + 8, "version 1 at least, plus the border");
        assert!((0..n).all(|i| image.pixels[i] == Color32::WHITE && image.pixels[i * n] == Color32::WHITE), "top row and left column are blank");
        // A finder pattern's dark corner sits right inside the quiet zone.
        assert_ne!(image.pixels[4 * n + 4], Color32::WHITE);
    }
}
