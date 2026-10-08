//! The Sandbox dialog: sets up, checks or removes the private WSL2 Linux the agent runs things in.
//! The web's SandboxPanel.tsx, drawn with egui. `sandbox::setup` does the work; this shows what it reports.

use super::App;
use super::form::{self, Btn};
use super::overlay::{self, Card};
use super::settings::close_btn;
use super::theme::{self, W, p};
use crate::sandbox::setup::{self, Job, JobKind, Paths, SandboxStatus, Snapshot};
use crate::sandbox::wsl::{SANDBOX_DISTRO, WslDistro};
use eframe::egui::{self, Color32, Rect, Sense, Stroke, Ui, pos2, vec2};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;

// Tailwind's green-500, amber-500, red-500 and red-400 (the v4 palette the web draws with).
const GREEN_500: Color32 = Color32::from_rgb(0x00, 0xc9, 0x50);
const AMBER_500: Color32 = Color32::from_rgb(0xfe, 0x9a, 0x00);
const RED_500: Color32 = Color32::from_rgb(0xfb, 0x2c, 0x36);
const RED_400: Color32 = Color32::from_rgb(0xff, 0x64, 0x67);

const OFF_REASON: &str = "WSL is not turned on. From an administrator PowerShell run: wsl --install --no-distribution   then restart Windows once.";
const SAMPLE_LOG: &str = "Checking the install folder\nDownloading the sandbox image: 148 MB of 350 MB\n";

/// What a background thread hands back to the dialog.
enum Msg {
    /// A fresh status and job.
    Snap(Snapshot),
    /// An action ran (the Err is why it did not start) and the status after it.
    Acted(Option<String>, Snapshot),
}

/// What a click asks for. Carried out after the frame is drawn.
enum Do {
    Run(&'static str),
    Refresh,
}

pub struct State {
    /// None until the first status arrives: the dialog says "Checking…".
    snap: Option<Snapshot>,
    /// An action is running, so its buttons wait.
    busy: bool,
    /// Why the last action did not start: the red line under the job.
    error: String,
    started: bool,
    /// When the status was last read, so a running job is read once a second.
    polled: Option<Instant>,
    /// Sample data for the self-portrait: nothing is read or started.
    staged: bool,
    tx: mpsc::Sender<Msg>,
    rx: mpsc::Receiver<Msg>,
}

impl State {
    fn new() -> State {
        let (tx, rx) = mpsc::channel();
        State { snap: None, busy: false, error: String::new(), started: false, polled: None, staged: false, tx, rx }
    }
}

/// Whole percent of a 0..1 progress, rounded as the web's Math.round does.
fn percent(progress: f64) -> u32 {
    (progress * 100.0).round() as u32
}

/// Opens the dialog. Its status is read in the first frame, off the UI thread.
pub fn open(app: &mut App) {
    app.sandbox = Some(State::new());
}

/// The self-portrait's `sandbox…` states: sample data only, nothing is read or started.
pub fn stage(app: &mut App, token: &str) {
    app.sandbox = Some(State { snap: sample(token), staged: true, ..State::new() });
}

/// The sample a `sandbox…` token shows. None is the checking state.
fn sample(token: &str) -> Option<Snapshot> {
    let status = |installed: bool, set_up: bool, distros: Vec<WslDistro>, reason: Option<&str>| SandboxStatus {
        installed,
        distros,
        default_distro: installed.then(|| "Ubuntu".to_string()),
        reason: reason.map(Into::into),
        set_up,
        dir: r"C:\Users\mona\AppData\Local\apiM\sandbox".into(),
    };
    let distro = |version: f64| vec![WslDistro { name: SANDBOX_DISTRO.into(), state: "Stopped".into(), version, is_default: false }];
    let job = |kind: JobKind, phase: &str, progress: Option<f64>, done: Option<bool>, error: Option<&str>, hint: Option<&'static str>| Job {
        kind,
        phase: phase.into(),
        progress,
        log: SAMPLE_LOG.into(),
        started_at: 0,
        finished_at: done.map(|_| 1),
        ok: done,
        error: error.map(Into::into),
        hint,
    };
    let (platform, status, job) = match token {
        "sandbox" => return None,
        "sandbox-mac" => ("darwin", status(false, false, vec![], None), None),
        "sandbox-off" => ("win32", status(false, false, vec![], Some(OFF_REASON)), None),
        "sandbox-setup" => ("win32", status(true, false, vec![], None), None),
        "sandbox-job" => ("win32", status(true, false, vec![], None), Some(job(JobKind::Setup, "Downloading the sandbox image", Some(0.42), None, None, None))),
        "sandbox-failed" => ("win32", status(true, false, vec![], None), Some(job(JobKind::Setup, "Setting up", None, Some(false), Some("The virtual disk driver did not load. Restart Windows, then try again."), Some("enable-wsl1")))),
        "sandbox-done" => ("win32", status(true, true, distro(2.0), None), Some(job(JobKind::Setup, "Setting up", None, Some(true), None, None))),
        "sandbox-wsl1" => ("win32", status(true, true, distro(1.0), None), None),
        _ => ("win32", status(true, true, distro(2.0), None), None),
    };
    Some(Snapshot { platform: platform.into(), status, job })
}

/// Draws the dialog while it is open; a click outside or Esc closes it, as the web's does.
pub fn show(app: &mut App, ctx: &egui::Context) {
    let p = p();
    let App { sandbox, rt, .. } = &mut *app;
    let Some(st) = sandbox.as_mut() else { return };
    if !st.staged {
        if !std::mem::replace(&mut st.started, true) {
            read(st, rt, ctx);
        }
        while let Ok(msg) = st.rx.try_recv() {
            receive(st, msg);
        }
        // A running job is read again every second, so its log and bar move.
        if is_running(st) {
            ctx.request_repaint_after(Duration::from_secs(1));
            if st.polled.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                read(st, rt, ctx);
            }
        }
    }
    let mut act: Option<Do> = None;
    // The web's `max-w-2xl max-h-[85vh]`: it hugs its content up to 85% of the window.
    let card = Card { rise: 0.0, hug: true, border: p.border, ..Card::new("sandbox", 672.0, ctx.content_rect().height() * 0.85) };
    let shown = card.show(ctx, |ui, close| {
        let head = egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 16)).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 12.0;
                ui.vertical(|ui| {
                    form::line(ui, "Sandbox", 15.0, 22.5, W::Semibold, p.text);
                    form::line(ui, "A private Linux on this PC where the agent can run and test things you never see", 12.0, 16.0, W::Regular, p.muted);
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if close_btn(ui, 32.0, 8.0, 18.0, "Close").clicked() {
                        *close = true;
                    }
                });
            });
        });
        ui.painter().hline(head.response.rect.x_range(), head.response.rect.bottom() + 0.5, Stroke::new(1.0, p.border));
        ui.add_space(1.0);
        egui::ScrollArea::vertical().id_salt("sandbox-body").auto_shrink([false, true]).show(ui, |ui| {
            egui::Frame::new().inner_margin(egui::Margin::symmetric(20, 16)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.spacing_mut().item_spacing = vec2(0.0, 16.0);
                body(ui, st, &mut act);
            });
        });
    });
    if !st.staged {
        match act {
            Some(Do::Run(action)) => run(st, rt, ctx, action),
            Some(Do::Refresh) => read(st, rt, ctx),
            None => {}
        }
    }
    if shown == overlay::State::Gone {
        *sandbox = None;
    }
}

/// The column of the web's panel: status, first-time notes, the live job, the refusal and the buttons.
fn body(ui: &mut Ui, st: &State, act: &mut Option<Do>) {
    let p = p();
    let Some(snap) = &st.snap else {
        form::para(ui, "Checking…", 14.0, 20.0, W::Regular, p.muted);
        return;
    };
    if snap.platform != "win32" {
        form::boxed(ui, p.bg3, p.border, 12, (16, 12), |ui| {
            form::line(ui, "Windows only", 14.0, 20.0, W::Medium, p.text);
            ui.add_space(4.0);
            mixed(ui, 13.0, 19.5, p.muted, &[("The WSL2 sandbox runs the app on Windows. This copy is running on ", false), (snap.platform.as_str(), true), (", where the agent can already run things headlessly without it.", false)]);
        });
        return;
    }
    let status = &snap.status;
    let job = snap.job.as_ref();
    let running = is_running(st);
    let idle = !(running || st.busy);
    let free = !st.busy;
    let set_up = status.set_up;
    let version = status.distros.iter().find(|d| d.name == SANDBOX_DISTRO).map(|d| d.version);
    let kind = job.map(|j| j.kind);
    let hint = job.and_then(|j| j.hint);

    form::boxed(ui, p.bg3, p.border, 12, (16, 12), |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let (dot, title) = if set_up {
                let ready = match version {
                    Some(v) if v != 0.0 => format!("Sandbox ready (WSL {v})"),
                    _ => "Sandbox ready".to_string(),
                };
                (GREEN_500, ready)
            } else if status.installed {
                (AMBER_500, "WSL is on — sandbox not set up yet".to_string())
            } else {
                (RED_500, "WSL is not turned on".to_string())
            };
            let (dot_at, _) = ui.allocate_exact_size(vec2(10.0, 20.0), Sense::hover());
            ui.painter().circle_filled(dot_at.center(), 5.0, dot);
            form::line(ui, &title, 14.0, 20.0, W::Medium, p.text);
        });
        if let Some(reason) = status.reason.as_deref().filter(|_| !set_up) {
            ui.add_space(6.0);
            form::para(ui, reason, 13.0, 19.5, W::Regular, p.muted);
        }
        if !status.dir.is_empty() {
            ui.add_space(6.0);
            mixed(ui, 12.0, 18.0, p.muted, &[("Disk location: ", false), (status.dir.as_str(), true)]);
        }
        if set_up && version == Some(1.0) {
            ui.add_space(6.0);
            form::para(ui, "Running on WSL 1 because this PC cannot create virtual disks right now. Fix the drivers named in the log (see docs/restore-fsdepends.md), then click Upgrade to WSL 2.", 13.0, 19.5, W::Regular, p.muted);
        }
        if set_up {
            ui.add_space(6.0);
            mixed(ui, 13.0, 19.5, p.muted, &[("The agent can now use ", false), ("sandbox_run", true), (" and ", false), ("sandbox_screenshot", true), (". Each command still asks you to approve it.", false)]);
        }
    });

    // What it is, once, for the first-time user.
    if !set_up && job.is_none() {
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 4.0;
            for text in [
                "Runs entirely off-screen — no window, never steals focus, fine while gaming.",
                "Only this chat's files are shared in; Windows is sealed off from it.",
                "Sets up once (~350\u{a0}MB download). Remove it any time to reclaim the space.",
            ] {
                let row = ui.horizontal_top(|ui| {
                    ui.add_space(20.0);
                    form::para(ui, text, 13.0, 19.5, W::Regular, p.text2);
                });
                ui.painter().circle_filled(pos2(row.response.rect.left() + 9.0, row.response.rect.top() + 9.75), 2.0, p.text2);
            }
        });
    }

    if let Some(job) = job {
        form::boxed(ui, p.bg, p.border, 12, (16, 12), |ui| {
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            let live = job.finished_at.is_none();
            let title: String = if live {
                job.phase.clone()
            } else if job.ok == Some(true) {
                "Finished".into()
            } else {
                "Failed".into()
            };
            ui.horizontal(|ui| {
                form::line(ui, &title, 14.0, 20.0, W::Medium, p.text);
                if let Some(progress) = job.progress.filter(|_| live) {
                    let pct = format!("{}%", percent(progress));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| mixed(ui, 12.0, 16.0, p.muted, &[(pct.as_str(), true)]));
                }
            });
            if let Some(progress) = job.progress.filter(|_| live) {
                ui.add_space(8.0);
                let (bar, _) = ui.allocate_exact_size(vec2(ui.available_width(), 6.0), Sense::hover());
                ui.painter().rect_filled(bar, 3.0, p.bg3);
                // ponytail: the web eases the bar's width between polls; this one jumps.
                let fill = Rect::from_min_size(bar.min, vec2(bar.width() * percent(progress) as f32 / 100.0, 6.0));
                ui.painter().rect_filled(fill, 3.0, p.accent);
            }
            if let Some(error) = &job.error {
                ui.add_space(8.0);
                form::para(ui, error, 13.0, 19.5, W::Regular, RED_400);
            }
            if !job.log.is_empty() {
                ui.add_space(8.0);
                form::boxed(ui, p.bg3, Color32::TRANSPARENT, 8, (10, 8), |ui| {
                    egui::ScrollArea::vertical().id_salt("sandbox-log").max_height(192.0).auto_shrink([false, true]).stick_to_bottom(true).show(ui, |ui| {
                        // A <pre> does not show a final newline as a blank line.
                        mixed(ui, 11.0, 16.0, p.text2, &[(job.log.trim_end_matches('\n'), true)]);
                    });
                });
            }
        });
    }

    if !st.error.is_empty() {
        form::para(ui, &st.error, 13.0, 19.5, W::Regular, RED_400);
    }

    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(8.0, 8.0);
        if !status.installed && accent_btn(ui, "Turn on WSL", idle).clicked() {
            *act = Some(Do::Run("enable-wsl"));
        }
        if status.installed && !set_up {
            let label = if running { "Setting up…" } else { "Set up sandbox" };
            if accent_btn(ui, label, idle).clicked() {
                *act = Some(Do::Run("setup"));
            }
        }
        if hint == Some("enable-wsl1") && !running && accent_btn(ui, "Turn on WSL 1 support", free).clicked() {
            *act = Some(Do::Run("enable-wsl"));
        }
        if set_up && version == Some(1.0) {
            let label = if running && kind == Some(JobKind::Upgrade) { "Upgrading…" } else { "Upgrade to WSL 2" };
            if bordered_btn(ui, label, idle).clicked() {
                *act = Some(Do::Run("upgrade"));
            }
        }
        if set_up {
            let label = if running && kind == Some(JobKind::Check) { "Checking…" } else { "Check it works" };
            if bordered_btn(ui, label, idle).on_hover_text("Run one real command the way the agent does and report what works").clicked() {
                *act = Some(Do::Run("check"));
            }
            let label = if running && kind == Some(JobKind::Remove) { "Removing…" } else { "Remove sandbox" };
            if bordered_btn(ui, label, idle).clicked() {
                *act = Some(Do::Run("remove"));
            }
        }
        if Btn::ghost("Refresh").text(13.0, 19.5).pad(12.0, 8.0).dim(0.5).enabled(!running).show(ui).clicked() {
            *act = Some(Do::Refresh);
        }
    });
}

/// The web's accent button: filled, white text, half opacity when disabled.
fn accent_btn(ui: &mut Ui, label: &str, enabled: bool) -> egui::Response {
    Btn::accent(label).text(13.0, 19.5).pad(14.0, 8.0).dim(0.5).enabled(enabled).show(ui)
}

/// The web's bordered button: border, secondary text, half opacity when disabled.
fn bordered_btn(ui: &mut Ui, label: &str, enabled: bool) -> egui::Response {
    Btn::outline(label).text(13.0, 19.5).pad(14.0, 8.0).dim(0.5).enabled(enabled).show(ui)
}

/// Wrapping text where some pieces are monospace, as the web's font-mono spans are.
fn mixed(ui: &mut Ui, size: f32, line: f32, color: Color32, parts: &[(&str, bool)]) {
    let mut job = egui::text::LayoutJob::default();
    job.wrap.max_width = ui.available_width();
    for &(text, mono) in parts {
        let font = if mono { theme::mono(size) } else { theme::font(size, W::Regular) };
        job.append(text, 0.0, egui::TextFormat { font_id: font, color, line_height: Some(line), ..Default::default() });
    }
    ui.label(job);
}

fn is_running(st: &State) -> bool {
    st.snap.as_ref().and_then(|s| s.job.as_ref()).is_some_and(|j| j.finished_at.is_none())
}

/// Reads the status on a background thread; the result comes back through the channel.
fn read(st: &mut State, rt: &Runtime, ctx: &egui::Context) {
    st.polled = Some(Instant::now());
    let (tx, ctx) = (st.tx.clone(), ctx.clone());
    rt.spawn_blocking(move || {
        let _ = tx.send(Msg::Snap(setup::snapshot(&Paths::real())));
        ctx.request_repaint();
    });
}

/// Runs one action on a background thread, then reads the status it leaves behind.
fn run(st: &mut State, rt: &Runtime, ctx: &egui::Context, action: &'static str) {
    st.busy = true;
    st.error.clear();
    let (tx, ctx) = (st.tx.clone(), ctx.clone());
    rt.spawn_blocking(move || {
        let paths = Paths::real();
        let refused = setup::act(&paths, action).err();
        let _ = tx.send(Msg::Acted(refused, setup::snapshot(&paths)));
        ctx.request_repaint();
    });
}

fn receive(st: &mut State, msg: Msg) {
    match msg {
        Msg::Snap(snap) => st.snap = Some(snap),
        Msg::Acted(refused, snap) => {
            st.busy = false;
            st.error = refused.unwrap_or_default();
            st.snap = Some(snap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::percent;

    #[test]
    fn percent_rounds_like_the_web() {
        assert_eq!([percent(0.0), percent(0.5), percent(0.996)], [0, 50, 100]);
    }
}
