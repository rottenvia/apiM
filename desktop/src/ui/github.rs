//! The GitHub connector (src/components/GitHubConnector.tsx): sign in with a token, pick a repository and a branch,
//! then watch what the workspace changes and open its pull request. Opened from the rail's GitHub button.
//!
//! GitHub and git are never called on the window's thread: each job runs on the app's runtime and posts its
//! result to the dialog's inbox.
// ponytail: the "Continue with GitHub" OAuth button is not here (no registered app on the desktop), the repository
// grid is always two columns, the description box has no resize handle, and the chevrons turn without easing.

use super::form::{self, Btn, Input};
use super::overlay::{self, Card};
use super::settings::{close_btn, part};
use super::theme::{self, W, alpha, p};
use super::{App, icons, widgets};
use crate::git_agent::{self, PrStatus};
use crate::github::{self, Api, Changes, Connect, Connection, Repo, Ws};
use crate::store::{Conversation, Settings};
use eframe::egui::{self, Color32, CursorIcon, Rect, Sense, Stroke, StrokeKind, Ui, pos2, vec2};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;

/// Tailwind's own greens and reds. The web uses them here as they are, whatever the theme.
const GREEN_400: Color32 = Color32::from_rgb(0x05, 0xdf, 0x72);
const GREEN_500: Color32 = Color32::from_rgb(0x00, 0xc9, 0x50);
const RED_400: Color32 = Color32::from_rgb(0xff, 0x64, 0x67);
const RED_500: Color32 = Color32::from_rgb(0xfb, 0x2c, 0x36);

const NOT_CONNECTED: &str = "GitHub is not connected";

/// What a background job hands back.
enum Msg {
    /// Who the token belongs to (None: not signed in) and their repositories.
    Account(Option<String>, Result<Vec<Repo>, String>),
    /// A typed token was tried: it is saved only when `login` is Ok.
    Verified { token: String, login: Result<String, String>, repos: Result<Vec<Repo>, String> },
    /// The branches of the repository named.
    Branches(String, Result<Vec<String>, String>),
    Connected(Result<Connection, String>),
    /// None when the clone could not be read: the last summary stays.
    Changes(Option<Changes>),
    Pr(Option<PrStatus>, Option<(String, String, usize)>),
    PrOpened(Result<(), String>),
}

struct Inbox(mpsc::Sender<Msg>, mpsc::Receiver<Msg>);

impl Default for Inbox {
    fn default() -> Inbox {
        let (tx, rx) = mpsc::channel();
        Inbox(tx, rx)
    }
}

#[derive(Default)]
pub struct State {
    ws: Ws,
    /// Sample data for the self-portrait: nothing is loaded, polled or sent.
    staged: bool,
    started: bool,
    loading: bool,
    /// A token is at hand without typing one.
    configured: bool,
    /// Signed in to an account.
    connected: bool,
    login: String,
    repos: Vec<Repo>,
    query: String,
    selected: Option<Repo>,
    branches: Vec<String>,
    /// The base branch.
    branch: String,
    connection: Option<Connection>,
    busy: bool,
    error: String,
    pat: String,
    show_pat: bool,
    changes: Option<Changes>,
    changes_open: bool,
    diff_open: bool,
    /// Continue an existing branch instead of starting a fresh `apim/` one.
    continuing: bool,
    task: String,
    continue_branch: String,
    pr: Option<PrStatus>,
    /// (title, body, commits) for the pull request form.
    suggestion: Option<(String, String, usize)>,
    pr_form: bool,
    pr_title: String,
    pr_body: String,
    pr_draft: bool,
    polled: Option<Instant>,
    inbox: Inbox,
}

/// What a click asks for. Carried out after the frame is drawn.
enum Do {
    Verify,
    SignOut,
    Choose(Repo),
    Connect,
    TurnOff,
    ToggleChanges,
    RefreshPr,
    OpenPrForm,
    CreatePr,
    Link(String),
}

fn handle(conv: &Conversation) -> Ws {
    Ws { id: conv.state_dir().file_name().unwrap_or_default().to_string_lossy().into_owned(), root: conv.workspace(), data: crate::store::data_dir() }
}

/// The dialog for this chat, still to load.
pub fn open(conv: &Conversation) -> State {
    State { ws: handle(conv), loading: true, ..Default::default() }
}

/// The self-portrait's states for this dialog.
pub fn stage(app: &mut App, token: &str) {
    let Some(kind) = token.strip_prefix("github") else { return };
    let repo = |name: &str, private: bool, branch: &str| Repo { full_name: name.into(), private, default_branch: branch.into() };
    let repos = vec![repo("octo-labs/apim-demo", true, "main"), repo("octo-labs/landing-page", false, "main"), repo("octo-labs/billing-service", true, "develop"), repo("mona/dotfiles", false, "master"), repo("mona/advent-of-code", false, "main"), repo("octo-labs/design-tokens", true, "main")];
    let connection = Connection { repo: "octo-labs/apim-demo".into(), base_branch: "main".into(), working_branch: "apim/fix-login-redirect-k3x9qa".into(), ..Default::default() };
    let file = |path: &str, status: char, additions: u32, deletions: u32| github::FileChange { path: path.into(), status, additions, deletions };
    let diff = "diff --git a/src/auth/login.ts b/src/auth/login.ts\nindex 4f1c2aa..9b7d310 100644\n--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -12,7 +12,9 @@ export async function login(req: Request) {\n   const session = await createSession(user);\n-  return redirect(\"/login\");\n+  // Send the user back to where they came from, never to the login page itself.\n+  const next = safeRedirect(req.query.next);\n+  return redirect(next ?? \"/\");\n }\n";
    let changes = Changes { connection: Some(connection.clone()), ahead: 2, files: vec![file("src/auth/login.ts", 'M', 18, 6), file("src/auth/redirect.ts", 'A', 42, 0), file("src/legacy/session.js", 'D', 0, 31), file("tests/login.test.ts", 'M', 27, 3)], total_additions: 87, total_deletions: 40, diff: diff.into(), uncommitted: 1 };
    let pr = PrStatus { pr: git_agent::Pr { number: 42, url: "https://github.com/octo-labs/apim-demo/pull/42".into(), state: "open".into(), title: "Fix the login redirect loop".into(), ..Default::default() }, mergeable: Some(true), checks: git_agent::Checks { total: 5, passed: 4, pending: 1, ..Default::default() }, review_comments: 2, ..Default::default() };
    let signed_in = State { connected: true, login: "mona".into(), repos, ..Default::default() };
    let picked = |st: State| State { selected: st.repos.first().cloned(), branch: "main".into(), branches: vec!["main".into(), "develop".into(), "apim/fix-login-redirect-k3x9qa".into()], ..st };
    let project = State { connection: Some(connection), changes: Some(changes), ..Default::default() };
    let st = match kind {
        "" => State::default(),
        "-token" => State { show_pat: true, ..Default::default() },
        "-verifying" => State { show_pat: true, busy: true, pat: "ghp_sampleSampleSampleSample0000".into(), ..Default::default() },
        "-error" => State { show_pat: true, pat: "ghp_sampleSampleSampleSample0000".into(), error: "That token did not authenticate with GitHub. Check it has the repo scope.".into(), ..Default::default() },
        "-loading" => State { loading: true, ..Default::default() },
        "-repos" => State { query: "octo".into(), ..signed_in },
        "-repo" => State { task: "Fix the login redirect".into(), ..picked(signed_in) },
        "-cloning" => State { continuing: true, continue_branch: "apim/fix-login-redirect-k3x9qa".into(), busy: true, ..picked(signed_in) },
        "-connected" => project,
        "-changes" => State { changes_open: true, diff_open: true, ..project },
        "-pr" => State { connection: project.connection.clone().map(|c| Connection { pr_url: Some(pr.pr.url.clone()), pr_number: Some(42), pr_branch: Some(c.working_branch.clone()), ..c }), pr: Some(pr), ..project },
        "-pr-form" => State { pr_form: true, pr_title: "Fix the login redirect loop".into(), pr_body: "## Changes\n\n- Send the user back to where they came from\n- Cover the redirect with tests\n".into(), ..project },
        _ => return,
    };
    app.ws.github = Some(State { ws: handle(&app.conv), staged: true, started: true, ..st });
}

fn spawn(rt: &Runtime, ctx: &egui::Context, st: &State, work: impl std::future::Future<Output = Msg> + Send + 'static) {
    let (tx, ctx) = (st.inbox.0.clone(), ctx.clone());
    rt.spawn(async move {
        let _ = tx.send(work.await);
        ctx.request_repaint();
    });
}

/// The token for a request: what is typed in the box, else the saved one, else the environment's.
fn token(st: &State, settings: &Settings) -> Result<Option<String>, String> {
    github::resolve_token(if st.pat.trim().is_empty() { &settings.github_token } else { &st.pat })
}

/// Reads the clone only: no token, no network.
fn load_changes(st: &mut State, rt: &Runtime, ctx: &egui::Context) {
    st.polled = Some(Instant::now());
    let ws = st.ws.clone();
    spawn(rt, ctx, st, async move { Msg::Changes(github::changes(&ws).await.ok()) });
}

/// The pull request's state comes from GitHub, so it is read on open and after actions, not on the poll.
fn load_pr(st: &State, settings: &Settings, rt: &Runtime, ctx: &egui::Context) {
    let (ws, token) = (st.ws.clone(), token(st, settings).ok().flatten());
    spawn(rt, ctx, st, async move {
        let suggestion = git_agent::suggest_pr(&ws).await.ok();
        let pr = match token {
            Some(token) => git_agent::pr_status(&ws, &Api::new(&token)).await.ok().flatten(),
            None => None,
        };
        Msg::Pr(pr, suggestion)
    });
}

fn load(st: &mut State, settings: &Settings, rt: &Runtime, ctx: &egui::Context) {
    st.pat = settings.github_token.trim().to_string();
    st.configured = !st.pat.is_empty() || github::env_token().is_some();
    st.connection = github::read_connection(&st.ws);
    if st.connection.is_some() {
        load_changes(st, rt, ctx);
        load_pr(st, settings, rt, ctx);
    }
    let token = token(st, settings).ok().flatten();
    spawn(rt, ctx, st, async move {
        let Some(token) = token else { return Msg::Account(None, Ok(Vec::new())) };
        let api = Api::new(&token);
        match github::login(&api).await {
            Ok(login) => Msg::Account(Some(login), github::list_repos(&api).await),
            Err(_) => Msg::Account(None, Ok(Vec::new())),
        }
    });
}

fn receive(st: &mut State, msg: Msg, settings: &mut Settings, files_stale: &mut bool, rt: &Runtime, ctx: &egui::Context) {
    fn listed(st: &mut State, repos: Result<Vec<Repo>, String>) {
        match repos {
            Ok(repos) => st.repos = repos,
            Err(error) => st.error = error,
        }
    }
    match msg {
        Msg::Account(login, repos) => {
            (st.loading, st.connected, st.login) = (false, login.is_some(), login.unwrap_or_default());
            listed(st, repos);
        }
        Msg::Verified { token, login, repos } => {
            st.busy = false;
            match login {
                Ok(login) => {
                    // Kept with the other keys in the settings file; the agent's tools read it from there.
                    settings.github_token = token;
                    settings.save();
                    (st.login, st.connected) = (login, true);
                    listed(st, repos);
                }
                Err(error) => st.error = error,
            }
        }
        Msg::Branches(repo, result) if st.selected.as_ref().is_some_and(|s| s.full_name == repo) => match result {
            Ok(list) => {
                if !list.contains(&st.branch) && let Some(first) = list.first() {
                    st.branch = first.clone();
                }
                st.branches = list;
            }
            Err(error) => st.error = error,
        },
        Msg::Branches(..) => {}
        Msg::Connected(result) => {
            st.busy = false;
            match result {
                Ok(connection) => {
                    st.connection = Some(connection);
                    *files_stale = true;
                    load_changes(st, rt, ctx);
                    load_pr(st, settings, rt, ctx);
                }
                Err(error) => st.error = error,
            }
        }
        Msg::Changes(changes) if st.connection.is_some() => st.changes = changes.or(st.changes.take()),
        Msg::Pr(pr, suggestion) if st.connection.is_some() => (st.pr, st.suggestion) = (pr, suggestion),
        Msg::Changes(_) | Msg::Pr(..) => {}
        Msg::PrOpened(result) => {
            st.busy = false;
            match result {
                Ok(()) => {
                    st.pr_form = false;
                    load_pr(st, settings, rt, ctx);
                    load_changes(st, rt, ctx);
                }
                Err(error) => st.error = error,
            }
        }
    }
}

fn perform(st: &mut State, act: Do, settings: &mut Settings, files_stale: &mut bool, rt: &Runtime, ctx: &egui::Context) {
    match act {
        Do::Verify => {
            let token = st.pat.trim().to_string();
            st.error.clear();
            if token.is_empty() {
                st.error = "Paste a GitHub Personal Access token first.".into();
                return;
            }
            st.busy = true;
            spawn(rt, ctx, st, async move {
                // Something that is not token-shaped is never sent anywhere.
                let login = if github::looks_like_token(&token) { github::login(&Api::new(&token)).await } else { Err(String::new()) };
                match login {
                    Ok(login) => Msg::Verified { repos: github::list_repos(&Api::new(&token)).await, token, login: Ok(login) },
                    Err(_) => Msg::Verified { token, login: Err("That token did not authenticate with GitHub. Check it has the repo scope.".into()), repos: Ok(Vec::new()) },
                }
            });
        }
        Do::SignOut => {
            settings.github_token.clear();
            settings.save();
            st.pat.clear();
            st.repos.clear();
            (st.connected, st.selected) = (false, None);
        }
        Do::Choose(repo) => {
            st.branch = repo.default_branch.clone();
            st.branches.clear();
            st.continue_branch.clear();
            st.error.clear();
            let name = repo.full_name.clone();
            st.selected = Some(repo);
            match token(st, settings) {
                Ok(Some(token)) => spawn(rt, ctx, st, async move { Msg::Branches(name.clone(), github::list_branches(&Api::new(&token), &name).await) }),
                Ok(None) => st.error = NOT_CONNECTED.into(),
                Err(error) => st.error = error,
            }
        }
        Do::Connect => {
            let Some(repo) = st.selected.clone().filter(|_| !st.branch.is_empty() && !st.busy) else { return };
            if st.continuing && st.continue_branch.is_empty() {
                st.error = "Pick the branch to continue.".into();
                return;
            }
            st.error.clear();
            let opt = Connect { repo: repo.full_name, base_branch: st.branch.clone(), task: if st.continuing { String::new() } else { st.task.trim().chars().take(200).collect() }, continue_branch: if st.continuing { st.continue_branch.clone() } else { String::new() } };
            match token(st, settings) {
                Ok(Some(token)) => {
                    st.busy = true;
                    let ws = st.ws.clone();
                    spawn(rt, ctx, st, async move { Msg::Connected(github::connect(&ws, &Api::new(&token), &opt).await) });
                }
                Ok(None) => st.error = "GitHub is not connected — add a Personal Access Token or sign in with GitHub OAuth.".into(),
                Err(error) => st.error = error,
            }
        }
        // Off: the files stay put and nothing more is pushed.
        Do::TurnOff => {
            github::clear_connection(&st.ws);
            (st.connection, st.changes, st.pr, st.suggestion, st.selected) = (None, None, None, None, None);
            *files_stale = true;
        }
        Do::ToggleChanges => {
            st.changes_open = !st.changes_open;
            if st.changes_open {
                load_changes(st, rt, ctx);
            }
        }
        Do::RefreshPr => load_pr(st, settings, rt, ctx),
        Do::OpenPrForm => {
            let (title, body, _) = st.suggestion.clone().unwrap_or_default();
            (st.pr_title, st.pr_body, st.pr_form) = (title, body, true);
        }
        // The click is the approval: the branch is pushed if needed, then the pull request opened (or the open one found).
        Do::CreatePr => {
            if st.pr_title.trim().is_empty() || st.busy {
                return;
            }
            st.error.clear();
            match token(st, settings) {
                Ok(Some(token)) => {
                    st.busy = true;
                    let (ws, title, body, draft) = (st.ws.clone(), st.pr_title.trim().to_string(), st.pr_body.clone(), st.pr_draft);
                    spawn(rt, ctx, st, async move { Msg::PrOpened(git_agent::create_pr(&ws, &Api::new(&token), &title, &body, draft).await.map(|_| ())) });
                }
                Ok(None) => st.error = NOT_CONNECTED.into(),
                Err(error) => st.error = error,
            }
        }
        Do::Link(url) => ctx.open_url(egui::OpenUrl::new_tab(url)),
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let p = p();
    let App { ws, settings, rt, files_stale, .. } = &mut *app;
    let Some(st) = ws.github.as_mut() else { return };
    if !st.staged {
        if !std::mem::replace(&mut st.started, true) {
            load(st, settings, rt, ctx);
        }
        while let Ok(msg) = st.inbox.1.try_recv() {
            receive(st, msg, settings, files_stale, rt, ctx);
        }
        // The agent may be editing while this is open: the change summary is read again every five seconds.
        if st.connection.is_some() {
            if st.polled.is_none_or(|at| at.elapsed() >= Duration::from_secs(5)) {
                load_changes(st, rt, ctx);
            }
            ctx.request_repaint_after(Duration::from_secs(5));
        }
    }
    let mut act = None;
    // `h-[min(85vh,44rem)] max-w-2xl` over a 65% scrim, with no entrance of its own.
    let card = Card { dim: 166, rise: 0.0, ..Card::new("github", 672.0, (ctx.content_rect().height() * 0.85).min(704.0)) };
    let shown = card.show(ctx, |ui, close| {
        let rect = ui.max_rect();
        widgets::text_at(ui, rect.left() + 16.0, rect.top() + 19.75, widgets::galley(ui, "GitHub", theme::font(15.0, W::Semibold), p.text));
        let sub = if st.connection.is_some() { "Connected project" } else { "Connect a repository to this chat" };
        widgets::text_at(ui, rect.left() + 16.0, rect.top() + 39.25, widgets::galley(ui, sub, theme::font(11.0, W::Regular), p.muted));
        if part(ui, Rect::from_min_size(pos2(rect.right() - 48.0, rect.top() + 12.0), vec2(32.0, 32.0)), |ui| close_btn(ui, 32.0, 8.0, 18.0, "Close")).clicked() {
            *close = true;
        }
        ui.painter().hline(rect.x_range(), rect.top() + 55.5, Stroke::new(1.0, p.border));
        part(ui, rect.with_min_y(rect.top() + 56.0), |ui| {
            egui::ScrollArea::vertical().id_salt("github-body").auto_shrink(false).show(ui, |ui| {
                egui::Frame::new().inner_margin(egui::Margin::same(16)).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
                    act = if st.loading {
                        let room = row(ui, 147.5);
                        let words = widgets::galley(ui, "Loading GitHub…", theme::font(13.0, W::Regular), p.muted);
                        widgets::text_at(ui, room.center().x - words.size().x / 2.0, room.center().y, words);
                        None
                    } else if st.connection.is_some() {
                        project(ui, st)
                    } else if !st.connected {
                        signed_out(ui, st)
                    } else {
                        choose(ui, st)
                    };
                    if !st.error.is_empty() {
                        ui.add_space(12.0);
                        form::boxed(ui, alpha(p.danger, 8.0), alpha(p.danger, 25.0), 8, (12, 8), |ui| form::para(ui, &st.error, 12.0, 18.0, W::Regular, p.danger));
                    }
                });
            });
        });
    });
    if let Some(act) = act.filter(|_| !st.staged) {
        perform(st, act, settings, files_stale, rt, ctx);
    }
    if shown == overlay::State::Gone {
        ws.github = None;
    }
}

/// A full-width strip of the flow, `height` tall, to paint into.
fn row(ui: &mut Ui, height: f32) -> Rect {
    ui.allocate_exact_size(vec2(ui.available_width(), height), Sense::hover()).0
}

/// `border-t border-border`.
fn rule(ui: &mut Ui) {
    let line = row(ui, 1.0);
    ui.painter().rect_filled(line, 0.0, p().border);
}

fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

#[derive(Clone, Copy)]
enum Face {
    Sans,
    Mono,
    Bold,
}

/// A wrapping paragraph whose pieces differ in face: the `<code>` and `<b>` runs of the web's text.
/// `centre` is the widest it may be when it sits centred; None runs it from the left edge.
fn mixed(ui: &mut Ui, size: f32, line: f32, color: Color32, centre: Option<f32>, parts: &[(&str, Face)]) {
    let mut job = egui::text::LayoutJob::default();
    for (text, face) in parts {
        let font_id = match face {
            Face::Sans => theme::font(size, W::Regular),
            Face::Mono => theme::mono(size),
            Face::Bold => theme::font(size, W::Bold),
        };
        job.append(text, 0.0, egui::TextFormat { font_id, color, line_height: Some(line), ..Default::default() });
    }
    let width = ui.available_width();
    job.wrap.max_width = centre.map_or(width, |most| most.min(width));
    job.halign = if centre.is_some() { egui::Align::Center } else { egui::Align::Min };
    let galley = ui.painter().layout_job(job);
    let room = row(ui, galley.size().y);
    ui.painter().galley(pos2(if centre.is_some() { room.center().x } else { room.left() }, room.top()), galley, Color32::PLACEHOLDER);
}

/// A line of text that is a button. `x` is its left edge, or its right edge when `from_right`.
/// It underlines under the pointer when it has no second colour to turn to.
fn link(ui: &mut Ui, id: &str, (x, cy): (f32, f32), from_right: bool, text: &str, font: egui::FontId, ink: Color32, hover: Color32) -> egui::Response {
    let words = widgets::galley(ui, text, font, Color32::WHITE);
    let rect = Rect::from_min_size(pos2(if from_right { x - words.size().x } else { x }, (cy - words.size().y / 2.0).round()), words.size());
    let hit = ui.interact(rect, ui.id().with(id), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
    let colour = widgets::lerp(ink, hover, widgets::fade(ui, hit.id, hit.hovered()));
    ui.painter().galley_with_override_text_color(rect.min, words, colour);
    if ink == hover && hit.hovered() {
        ui.painter().hline(rect.x_range(), rect.bottom() - 1.0, Stroke::new(1.0, colour));
    }
    hit
}

/// `rounded-full px-1.5 py-0.5 text-[11px] font-semibold`, from its left edge along the centre line `cy`. Gives back its box.
fn pill(ui: &Ui, left: f32, cy: f32, text: &str, ink: Color32, fill: Color32) -> Rect {
    let words = widgets::galley(ui, text, theme::font(11.0, W::Semibold), ink);
    let rect = Rect::from_min_size(pos2(left, cy - 10.25), vec2(words.size().x + 12.0, 20.5));
    ui.painter().rect_filled(rect, 10.25, fill);
    widgets::text_at(ui, left + 6.0, cy, words);
    rect
}

/// The 12px chevron of a disclosure: points right, turns down when open.
fn chevron(ui: &Ui, at: egui::Pos2, open: bool) {
    icons::paint_turned(ui, icons::CHEVRON_RIGHT.stroke(2.4), at, 12.0, p().muted, if open { std::f32::consts::FRAC_PI_2 } else { 0.0 });
}

/// `rounded-lg bg-accent font-semibold text-white disabled:opacity-50`. The web gives these no hover colour.
fn accent(label: &str, size: f32, pad: (f32, f32)) -> Btn<'_> {
    let p = p();
    Btn::accent(label).text(size, size * 1.5).weight(W::Semibold).pad(pad.0, pad.1).fill(p.accent, p.accent).dim(0.5)
}

/// `rounded-lg border border-border font-medium text-text-secondary`, 12px.
fn outline(label: &str, pad: (f32, f32)) -> Btn<'_> {
    Btn::outline(label).text(12.0, 18.0).pad(pad.0, pad.1).fill(Color32::TRANSPARENT, Color32::TRANSPARENT).dim(0.5)
}

/// `rounded-lg border border-border px-3 py-2 text-[13px] focus:border-border-light` on the given surface.
fn field(hint: &str, fill: Color32) -> Input<'_> {
    Input::new(hint).text(13.0, 19.5).pad(12, 8).radius(8).fill(fill).focus(p().border_light)
}

/// `overflow-hidden rounded-xl border border-border`: a box whose rows run edge to edge.
fn section(ui: &mut Ui, add: impl FnOnce(&mut Ui)) {
    egui::Frame::new().stroke(Stroke::new(1.0, p().border)).corner_radius(12).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        add(ui);
    });
}

/// The fill behind a section's row: all four corners rounded, or only the top when rows follow.
fn band(ui: &Ui, rect: Rect, more_below: bool) {
    let foot = if more_below { 0 } else { 11 };
    ui.painter().rect_filled(rect, egui::CornerRadius { nw: 11, ne: 11, sw: foot, se: foot }, alpha(p().bg3, 40.0));
}

/// Signed out: what connecting does, and the token box tucked into a disclosure.
fn signed_out(ui: &mut Ui, st: &mut State) -> Option<Do> {
    let p = p();
    let mut act = None;
    ui.add_space(32.0);
    let tile = Rect::from_center_size(row(ui, 48.0).center(), vec2(48.0, 48.0));
    ui.painter().rect(tile, 12.0, p.bg3, Stroke::new(1.0, p.border), StrokeKind::Inside);
    icons::paint(ui, icons::GITHUB, tile.center(), 20.0, p.text);
    ui.add_space(16.0);
    let title = row(ui, 22.5);
    let words = widgets::galley(ui, "Connect GitHub", theme::font(15.0, W::Semibold), p.text);
    widgets::text_at(ui, title.center().x - words.size().x / 2.0, title.center().y, words);
    ui.add_space(4.0);
    mixed(ui, 12.0, 20.0, p.muted, Some(384.0), &[("Click below, authorize apiM on GitHub, and pick a repository and branch. The repo is cloned into this workspace and the agent pushes only a dedicated ", Face::Sans), ("apim/…", Face::Mono), (" branch.", Face::Sans)]);
    ui.add_space(48.0);

    let host = if st.configured { ", or ask the host to set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET" } else { "" };
    form::boxed(ui, alpha(p.warning, 8.0), alpha(p.warning, 30.0), 12, (12, 12), |ui| form::para(ui, &format!("This apiM instance has no GitHub OAuth app registered. Use a Personal Access Token below{host}."), 12.0, 20.0, W::Regular, p.text2));
    ui.add_space(16.0);

    section(ui, |ui| {
        let (head, hit) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::click());
        let hit = hit.on_hover_cursor(CursorIcon::PointingHand);
        let ink = widgets::lerp(p.text2, p.text, widgets::fade(ui, hit.id, hit.hovered()));
        widgets::text_at(ui, head.left() + 12.0, head.center().y, widgets::galley(ui, "Use a Personal Access Token instead", theme::font(12.0, W::Medium), ink));
        chevron(ui, pos2(head.right() - 18.0, head.center().y), st.show_pat);
        if hit.clicked() {
            st.show_pat = !st.show_pat;
        }
        if !st.show_pat {
            return;
        }
        rule(ui);
        egui::Frame::new().inner_margin(egui::Margin::same(12)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            mixed(ui, 11.0, 16.0, p.muted, None, &[("GitHub → Settings → Developer settings → Personal access tokens → Fine-grained, with ", Face::Sans), ("Contents: read & write", Face::Bold), (" on the repos you want.", Face::Sans)]);
            ui.add_space(8.0);
            let line = row(ui, 36.0);
            part(ui, line, |ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing = vec2(8.0, 0.0);
                    if accent(if st.busy { "Verifying…" } else { "Verify" }, 12.0, (12.0, 9.0)).enabled(!st.busy).show(ui).clicked() {
                        act = Some(Do::Verify);
                    }
                    // A bare password box: masked and monospace, without the eye the Settings key boxes have.
                    let id = ui.make_persistent_id("github-pat");
                    let edge = if ui.memory(|m| m.has_focus(id)) { p.border_light } else { p.border };
                    egui::Frame::new().fill(p.bg).stroke(Stroke::new(1.0, edge)).corner_radius(8).inner_margin(egui::Margin::symmetric(12, 8)).show(ui, |ui| {
                        let hint = egui::RichText::new("github_pat_… or ghp_…").font(theme::mono(12.0)).color(p.muted);
                        ui.add(egui::TextEdit::singleline(&mut st.pat).id(id).password(true).hint_text(hint).font(theme::mono(12.0)).text_color(p.text).desired_width(f32::INFINITY).min_size(vec2(0.0, 18.0)).vertical_align(egui::Align::Center).frame(egui::Frame::NONE).margin(egui::Margin::ZERO));
                    });
                });
            });
        });
    });
    act
}

/// Signed in: find a repository, pick its base branch, name the work.
fn choose(ui: &mut Ui, st: &mut State) -> Option<Do> {
    let p = p();
    let mut act = None;
    let top = row(ui, 18.0);
    let x = top.left() + widgets::text_at(ui, top.left(), top.center().y, widgets::galley(ui, "Connected as ", theme::font(12.0, W::Regular), p.muted));
    widgets::text_at(ui, x, top.center().y, widgets::galley(ui, &st.login, theme::font(12.0, W::Regular), p.text2));
    if link(ui, "github-sign-out", (top.right(), top.center().y), true, "Sign out", theme::font(11.0, W::Regular), p.muted, p.danger).clicked() {
        act = Some(Do::SignOut);
    }
    ui.add_space(12.0);
    field("Find a repository…", p.bg).show(ui, "github-find", &mut st.query);
    ui.add_space(12.0);

    let query = st.query.trim().to_lowercase();
    let visible: Vec<&Repo> = st.repos.iter().filter(|repo| repo.full_name.to_lowercase().contains(&query)).collect();
    let chosen = st.selected.as_ref().map(|repo| repo.full_name.as_str());
    egui::ScrollArea::vertical().id_salt("github-repos").max_height(288.0).auto_shrink([false, true]).show(ui, |ui| {
        ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
        if visible.is_empty() {
            let none = row(ui, 66.0);
            let words = widgets::galley(ui, "No repositories match.", theme::font(12.0, W::Regular), p.muted);
            widgets::text_at(ui, none.center().x - words.size().x / 2.0, none.center().y, words);
        }
        form::grid(ui, 2, 4.0, visible.len(), |ui, i, width| {
            let repo = visible[i];
            let (cell, hit) = ui.allocate_exact_size(vec2(width, 66.0), Sense::click());
            let hit = hit.on_hover_cursor(CursorIcon::PointingHand);
            let t = widgets::fade(ui, hit.id, hit.hovered());
            let (fill, edge) = if chosen == Some(repo.full_name.as_str()) { (alpha(p.accent, 8.0), alpha(p.accent, 50.0)) } else { (p.hover.gamma_multiply(t), widgets::lerp(p.border, p.border_light, t)) };
            ui.painter().rect(cell, 8.0, fill, Stroke::new(1.0, edge), StrokeKind::Inside);
            widgets::text_at(ui, cell.left() + 13.0, cell.top() + 22.75, widgets::clipped(ui, &repo.full_name, theme::font(13.0, W::Medium), p.text, cell.width() - 26.0));
            let about = format!("{} · {}", if repo.private { "Private" } else { "Public" }, repo.default_branch);
            widgets::text_at(ui, cell.left() + 13.0, cell.top() + 45.25, widgets::clipped(ui, &about, theme::font(11.0, W::Regular), p.muted, cell.width() - 26.0));
            if hit.clicked() {
                act = Some(Do::Choose(repo.clone()));
            }
        });
    });

    let Some(repo) = st.selected.clone() else { return act };
    ui.add_space(16.0);
    form::boxed(ui, alpha(p.bg, 50.0), p.border, 12, (12, 12), |ui| {
        let label = row(ui, 16.5);
        widgets::text_at(ui, label.left(), label.center().y, widgets::galley(ui, "Base branch", theme::font(11.0, W::Medium), p.text2));
        ui.add_space(4.0);
        let bases = if st.branches.is_empty() { vec![st.branch.clone()] } else { st.branches.clone() };
        let mut at = bases.iter().position(|b| *b == st.branch).unwrap_or(0);
        if form::select(ui, "github-base", &bases, &mut at, 13.0, (12.0, 8.0), 8.0) {
            st.branch = bases[at].clone();
        }
        ui.add_space(12.0);

        // New branch | Continue existing branch.
        let switch = row(ui, 36.0);
        ui.painter().rect(switch, 8.0, p.bg3, Stroke::new(1.0, p.border), StrokeKind::Inside);
        let half = (switch.width() - 10.0) / 2.0;
        for (i, label) in ["New branch", "Continue existing branch"].into_iter().enumerate() {
            let tab = Rect::from_min_size(pos2(switch.left() + 3.0 + i as f32 * (half + 4.0), switch.top() + 3.0), vec2(half, 30.0));
            let hit = ui.interact(tab, ui.id().with(("github-mode", i)), Sense::click()).on_hover_cursor(CursorIcon::PointingHand);
            let active = st.continuing == (i == 1);
            if active {
                ui.painter().add(egui::Shadow { offset: [0, 1], blur: 2, spread: 0, color: Color32::from_black_alpha(13) }.as_shape(tab, 8));
                ui.painter().rect_filled(tab, 8.0, p.bg2);
            }
            let ink = if active { p.text } else { widgets::lerp(p.muted, p.text2, widgets::fade(ui, hit.id, hit.hovered())) };
            let words = widgets::galley(ui, label, theme::font(12.0, W::Medium), ink);
            widgets::text_at(ui, tab.center().x - words.size().x / 2.0, tab.center().y, words);
            if hit.clicked() {
                st.continuing = i == 1;
            }
        }
        ui.add_space(8.0);

        let base = if st.branch.is_empty() { "the base".to_string() } else { st.branch.clone() };
        if st.continuing {
            let mut others = vec!["Choose a branch to continue…".to_string()];
            others.extend(st.branches.iter().filter(|b| **b != st.branch).cloned());
            let mut at = others.iter().position(|b| *b == st.continue_branch).unwrap_or(0);
            if form::select(ui, "github-continue", &others, &mut at, 13.0, (12.0, 8.0), 8.0) {
                st.continue_branch = if at == 0 { String::new() } else { others[at].clone() };
            }
            ui.add_space(8.0);
            mixed(ui, 11.0, 16.0, p.muted, None, &[(&format!("The branch is checked out tracking origin; commits and pull requests continue on it, targeting {base}."), Face::Sans)]);
        } else {
            field("What is this work? (names the branch, optional)", p.bg3).show(ui, "github-task", &mut st.task);
            ui.add_space(8.0);
            mixed(ui, 11.0, 16.0, p.muted, None, &[(&format!("apiM branches off {base} into a dedicated "), Face::Sans), ("apim/…", Face::Mono), (" branch. The base branch is never pushed directly.", Face::Sans)]);
        }
        ui.add_space(12.0);
        let ready = !st.busy && !st.branch.is_empty() && !(st.continuing && st.continue_branch.is_empty());
        let label = if st.busy { "Cloning repository…".to_string() } else { format!("Connect {}", repo.full_name) };
        if accent(&label, 13.0, (12.0, 10.0)).width(ui.available_width()).enabled(ready).show(ui).clicked() {
            act = Some(Do::Connect);
        }
    });
    act
}

/// A repository is connected: where it stands, what changed against the base, and the pull request.
fn project(ui: &mut Ui, st: &mut State) -> Option<Do> {
    let p = p();
    let mut act = None;
    let stored = st.connection.as_ref()?;
    // The agent can switch branches mid-run; the changes poll carries the latest stored connection, so the header follows it.
    let view = st.changes.as_ref().and_then(|c| c.connection.clone()).unwrap_or_else(|| stored.clone());
    let ahead = st.changes.as_ref().map_or(0, |c| c.ahead);
    let pr = st.pr.clone();
    let remembered = view.pr_url.clone().filter(|_| view.pr_branch.as_deref() == Some(view.working_branch.as_str()));
    let pr_link = pr.as_ref().map(|s| s.pr.url.clone()).or(remembered).unwrap_or_default();

    // The project card: repository · branch ↑ahead, the base, the pull request, and the switch.
    let inner_height = f32::max(44.5 + if pr_link.is_empty() { 0.0 } else { 26.5 }, 56.5);
    let card = row(ui, inner_height + 34.0);
    ui.painter().rect(card, 12.0, alpha(p.bg3, 50.0), Stroke::new(1.0, p.border), StrokeKind::Inside);
    let inner = card.shrink(17.0);
    let on = widgets::galley(ui, "On", theme::font(11.0, W::Semibold), p.success);
    let lamp = Rect::from_min_size(pos2(inner.right() - on.size().x - 28.0, inner.top()), vec2(on.size().x + 28.0, 20.5));
    ui.painter().rect_filled(lamp, 10.25, alpha(p.success, 10.0));
    ui.painter().circle_filled(pos2(lamp.left() + 11.0, lamp.center().y), 3.0, p.success);
    widgets::text_at(ui, lamp.left() + 20.0, lamp.center().y, on);
    let off_width = widgets::galley(ui, "Turn off", theme::font(12.0, W::Medium), p.text2).size().x + 22.0;
    let off = Rect::from_min_size(pos2(inner.right() - off_width, inner.top() + 28.5), vec2(off_width, 28.0));
    if part(ui, off, |ui| outline("Turn off", (10.0, 4.0)).ink(p.text2, p.danger).border(p.border, alpha(p.danger, 40.0)).enabled(!st.busy).show(ui)).clicked() {
        act = Some(Do::TurnOff);
    }
    let room = inner.width() - off_width.max(lamp.width()) - 12.0;

    let cy = inner.top() + 11.25;
    let up = format!("↑{ahead}");
    let up_width = if ahead > 0 { widgets::galley(ui, &up, theme::font(11.0, W::Semibold), p.text).size().x + 18.0 } else { 0.0 };
    let dot = widgets::galley(ui, "·", theme::font(15.0, W::Semibold), p.muted);
    let mut x = inner.left();
    x += widgets::text_at(ui, x, cy, widgets::clipped(ui, &view.repo, theme::font(15.0, W::Semibold), p.text, (room - up_width - dot.size().x - 12.0) * 0.6)) + 6.0;
    x += widgets::text_at(ui, x, cy, dot) + 6.0;
    x += widgets::text_at(ui, x, cy, widgets::clipped(ui, &view.working_branch, theme::mono(13.0), p.success, inner.left() + room - x - up_width)) + 6.0;
    if ahead > 0 {
        let badge = pill(ui, x, cy, &up, p.accent_light, alpha(p.accent, 15.0));
        ui.interact(badge, ui.id().with("github-ahead"), Sense::hover()).on_hover_text(format!("{ahead} commit{} ahead of {}", plural(ahead.into()), view.base_branch));
    }
    let x = inner.left() + widgets::text_at(ui, inner.left(), inner.top() + 35.5, widgets::galley(ui, "Base ", theme::font(12.0, W::Regular), p.muted));
    widgets::text_at(ui, x, inner.top() + 35.5, widgets::clipped(ui, &view.base_branch, theme::mono(12.0), p.muted, inner.left() + room - x));
    if !pr_link.is_empty() {
        let state = pr.as_ref().map_or("open", |s| if s.pr.draft && s.pr.state == "open" { "draft" } else { s.pr.state.as_str() });
        let (name, ink, fill) = match state {
            "merged" => ("Merged", p.accent_light, alpha(p.accent, 15.0)),
            "closed" => ("Closed", p.danger, alpha(p.danger, 10.0)),
            "draft" => ("Draft", p.muted, p.hover),
            _ => ("Open", p.success, alpha(p.success, 10.0)),
        };
        let cy = inner.top() + 60.75;
        let badge = pill(ui, inner.left(), cy, name, ink, fill);
        let number = pr.as_ref().map(|s| s.pr.number).or(view.pr_number).filter(|n| *n > 0);
        let label = number.map_or("Pull request".to_string(), |n| format!("Pull request #{n}"));
        if link(ui, "github-pr-link", (badge.right() + 6.0, cy), false, &label, theme::font(12.0, W::Medium), p.accent_light, p.accent_light).clicked() {
            act = Some(Do::Link(pr_link.clone()));
        }
    }
    ui.add_space(12.0);

    // What exactly changes against the base branch.
    let listed = st.changes.as_ref().filter(|c| !c.files.is_empty());
    section(ui, |ui| {
        let (head, hit) = ui.allocate_exact_size(vec2(ui.available_width(), 43.5), Sense::click());
        let hit = hit.on_hover_cursor(CursorIcon::PointingHand);
        band(ui, head, st.changes_open);
        widgets::text_at(ui, head.left() + 16.0, head.center().y, widgets::clipped(ui, &format!("Changes vs {}", view.base_branch), theme::font(13.0, W::Semibold), p.text, head.width() - 180.0));
        match listed {
            Some(c) => {
                chevron(ui, pos2(head.right() - 22.0, head.center().y), st.changes_open);
                let minus = widgets::galley(ui, &format!("−{}", c.total_deletions), theme::font(12.0, W::Regular), RED_400);
                let plus = widgets::galley(ui, &format!("+{}", c.total_additions), theme::font(12.0, W::Regular), GREEN_400);
                let at = head.right() - 36.0 - minus.size().x;
                widgets::text_at(ui, at - 8.0 - plus.size().x, head.center().y, plus);
                widgets::text_at(ui, at, head.center().y, minus);
            }
            None => {
                let words = widgets::galley(ui, if st.changes.is_some() { "no changes yet" } else { "…" }, theme::font(12.0, W::Regular), p.muted);
                widgets::text_at(ui, head.right() - 16.0 - words.size().x, head.center().y, words);
            }
        }
        if hit.clicked() {
            act = Some(Do::ToggleChanges);
        }
        if !st.changes_open {
            return;
        }
        rule(ui);
        let Some(c) = listed else {
            ui.add_space(24.0);
            egui::Frame::new().inner_margin(egui::Margin::symmetric(16, 0)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                mixed(ui, 12.0, 18.0, p.muted, Some(f32::INFINITY), &[(&format!("Nothing differs from {} yet. Edits the agent makes show up here, and pushes go only to ", view.base_branch), Face::Sans), (&view.working_branch, Face::Mono), (".", Face::Sans)]);
            });
            ui.add_space(24.0);
            return;
        };
        let totals = row(ui, 32.5);
        let mut x = totals.left() + 16.0;
        let files = c.files.len() as u64;
        let mut notes = vec![(format!("{files} changed file{}", plural(files)), p.muted), (format!("{} commit{} ahead", c.ahead, plural(c.ahead.into())), p.muted)];
        if c.uncommitted > 0 {
            notes.push((format!("{} uncommitted edit{}", c.uncommitted, plural(c.uncommitted.into())), p.warning));
        }
        for (note, ink) in notes {
            x += widgets::text_at(ui, x, totals.center().y, widgets::galley(ui, &note, theme::font(11.0, W::Regular), ink)) + 16.0;
        }
        egui::ScrollArea::vertical().id_salt("github-files").max_height(224.0).auto_shrink([false, true]).show(ui, |ui| {
            ui.spacing_mut().item_spacing = vec2(0.0, 0.0);
            for (i, f) in c.files.iter().enumerate() {
                let line = row(ui, 30.0);
                if !ui.is_rect_visible(line) {
                    continue;
                }
                if i % 2 == 0 {
                    ui.painter().rect_filled(line, 0.0, alpha(p.bg3, 20.0));
                }
                let (ink, fill) = match f.status {
                    'A' => (GREEN_400, alpha(GREEN_500, 15.0)),
                    'D' => (RED_400, alpha(RED_500, 15.0)),
                    _ => (p.accent_light, alpha(p.accent, 15.0)),
                };
                let mark = Rect::from_min_size(pos2(line.left() + 16.0, line.center().y - 8.0), vec2(16.0, 16.0));
                ui.painter().rect_filled(mark, 4.0, fill);
                let letter = widgets::galley(ui, &f.status.to_string(), theme::font(9.0, W::Bold), ink);
                widgets::text_at(ui, mark.center().x - letter.size().x / 2.0, mark.center().y, letter);
                let minus = widgets::galley(ui, &format!("−{}", f.deletions), theme::mono(12.0), RED_400);
                let plus = widgets::galley(ui, &format!("+{}", f.additions), theme::mono(12.0), GREEN_400);
                let at = line.right() - 16.0 - minus.size().x;
                let plus_at = at - 8.0 - plus.size().x;
                widgets::text_at(ui, plus_at, line.center().y, plus);
                widgets::text_at(ui, at, line.center().y, minus);
                widgets::text_at(ui, mark.right() + 8.0, line.center().y, widgets::clipped(ui, &f.path, theme::mono(12.0), p.text2, plus_at - 8.0 - mark.right() - 8.0));
            }
        });
        if c.diff.is_empty() {
            return;
        }
        rule(ui);
        let toggle = row(ui, 34.0);
        if link(ui, "github-diff", (toggle.left() + 16.0, toggle.center().y), false, if st.diff_open { "Hide full diff" } else { "View full diff" }, theme::font(12.0, W::Medium), p.accent_light, p.accent_light).clicked() {
            st.diff_open = !st.diff_open;
        }
        if st.diff_open {
            // ponytail: the diff (capped at 200 KB) is one label, copied into it every frame it is open; egui caches the layout.
            egui::Frame::new().fill(alpha(p.bg, 60.0)).corner_radius(egui::CornerRadius { nw: 0, ne: 0, sw: 11, se: 11 }).inner_margin(egui::Margin::symmetric(16, 8)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                egui::ScrollArea::both().id_salt("github-diff-text").max_height(272.0).auto_shrink([false, true]).show(ui, |ui| {
                    ui.add(egui::Label::new(egui::RichText::new(c.diff.as_str()).font(theme::mono(11.0)).color(p.text2).line_height(Some(16.5))).extend().selectable(false));
                });
            });
        }
    });
    ui.add_space(12.0);

    // The pull request: its status once it exists, otherwise a way to create it.
    section(ui, |ui| {
        if let Some(s) = pr.as_ref() {
            let line = row(ui, 62.0);
            band(ui, line, false);
            let open_width = widgets::galley(ui, "Open", theme::font(12.0, W::Semibold), p.text).size().x + 20.0;
            let refresh_width = widgets::galley(ui, "Refresh", theme::font(12.0, W::Medium), p.text).size().x + 22.0;
            let open = Rect::from_min_size(pos2(line.right() - 16.0 - open_width, line.center().y - 13.0), vec2(open_width, 26.0));
            let refresh = Rect::from_min_size(pos2(open.left() - 8.0 - refresh_width, line.center().y - 14.0), vec2(refresh_width, 28.0));
            if part(ui, refresh, |ui| outline("Refresh", (10.0, 4.0)).border(p.border, p.border_light).show(ui)).clicked() {
                act = Some(Do::RefreshPr);
            }
            if part(ui, open, |ui| accent("Open", 12.0, (10.0, 4.0)).show(ui)).clicked() {
                act = Some(Do::Link(s.pr.url.clone()));
            }
            let width = refresh.left() - 12.0 - line.left() - 16.0;
            widgets::text_at(ui, line.left() + 16.0, line.top() + 21.75, widgets::clipped(ui, &format!("#{} {}", s.pr.number, s.pr.title), theme::font(13.0, W::Semibold), p.text, width));
            let checks = &s.checks;
            let mut note = if checks.total == 0 { "No checks reported".to_string() } else { format!("Checks: {} passed · {} failed · {} pending", checks.passed, checks.failed, checks.pending) };
            if s.mergeable == Some(false) {
                note.push_str(" · not mergeable");
            }
            if s.review_comments > 0 {
                note.push_str(&format!(" · {} review comment{}", s.review_comments, plural(s.review_comments)));
            }
            widgets::text_at(ui, line.left() + 16.0, line.top() + 41.75, widgets::clipped(ui, &note, theme::font(11.0, W::Regular), p.muted, width));
        } else if !st.pr_form {
            let line = row(ui, 54.0);
            band(ui, line, false);
            let ready = if ahead > 0 { format!("{ahead} commit{} ready for review", plural(ahead.into())) } else { "Commit work to open a pull request".to_string() };
            widgets::text_at(ui, line.left() + 16.0, line.center().y, widgets::galley(ui, &ready, theme::font(12.0, W::Regular), p.muted));
            let width = widgets::galley(ui, "Create pull request", theme::font(12.0, W::Semibold), p.text).size().x + 24.0;
            let at = Rect::from_min_size(pos2(line.right() - 16.0 - width, line.center().y - 15.0), vec2(width, 30.0));
            if part(ui, at, |ui| accent("Create pull request", 12.0, (12.0, 6.0)).enabled(!st.busy && st.changes.is_some() && ahead > 0).show(ui)).clicked() {
                act = Some(Do::OpenPrForm);
            }
        } else {
            egui::Frame::new().inner_margin(egui::Margin::same(12)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                mixed(ui, 11.0, 16.5, p.muted, None, &[(&view.working_branch, Face::Mono), (" → ", Face::Sans), (&view.base_branch, Face::Mono), (". The branch is pushed first if needed.", Face::Sans)]);
                ui.add_space(8.0);
                field("Pull request title", p.bg).show(ui, "github-pr-title", &mut st.pr_title);
                ui.add_space(8.0);
                field("What changed and how it was tested", p.bg).rows(6).mono().text(12.0, 18.0).show(ui, "github-pr-body", &mut st.pr_body);
                ui.add_space(8.0);
                let foot = row(ui, 32.0);
                let tick = Rect::from_min_size(pos2(foot.left(), foot.center().y - 6.5), vec2(13.0, 13.0));
                let words = widgets::galley(ui, "Draft", theme::font(12.0, W::Regular), p.text2);
                let draft = ui.interact(Rect::from_min_max(pos2(tick.left(), foot.top()), pos2(tick.right() + 6.0 + words.size().x, foot.bottom())), ui.id().with("github-draft"), Sense::click());
                ui.painter().rect(tick, 3.0, if st.pr_draft { p.accent } else { Color32::TRANSPARENT }, Stroke::new(1.0, if st.pr_draft { p.accent } else { p.border_light }), StrokeKind::Inside);
                if st.pr_draft {
                    icons::paint(ui, icons::CHECK.stroke(3.0), tick.center(), 9.0, Color32::WHITE);
                }
                widgets::text_at(ui, tick.right() + 6.0, foot.center().y, words);
                if draft.clicked() {
                    st.pr_draft = !st.pr_draft;
                }
                let label = if st.busy { "Opening…" } else { "Create pull request" };
                let create_width = widgets::galley(ui, label, theme::font(12.0, W::Semibold), p.text).size().x + 24.0;
                let cancel_width = widgets::galley(ui, "Cancel", theme::font(12.0, W::Medium), p.text).size().x + 26.0;
                let create = Rect::from_min_size(pos2(foot.right() - create_width, foot.top()), vec2(create_width, 32.0));
                let cancel = Rect::from_min_size(pos2(create.left() - 8.0 - cancel_width, foot.top()), vec2(cancel_width, 32.0));
                if part(ui, cancel, |ui| outline("Cancel", (12.0, 6.0)).show(ui)).clicked() {
                    st.pr_form = false;
                }
                if part(ui, create, |ui| accent(label, 12.0, (12.0, 7.0)).enabled(!st.busy && !st.pr_title.trim().is_empty()).show(ui)).clicked() {
                    act = Some(Do::CreatePr);
                }
            });
        }
    });
    ui.add_space(12.0);
    mixed(ui, 12.0, 20.0, p.muted, None, &[("The agent commits on the working branch, merges the latest ", Face::Sans), (&view.base_branch, Face::Mono), (" when behind, and — only after you approve — pushes it and opens a pull request. The base branch is never pushed or force-pushed. Turning off keeps all your files.", Face::Sans)]);
    act
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_from_background_jobs_move_the_dialog_on() {
        let rt = Runtime::new().unwrap();
        let (ctx, mut settings, mut stale) = (egui::Context::default(), Settings::default(), false);
        let dir = std::env::temp_dir().join(format!("apim-gh-ui-{}", std::process::id()));
        let mut st = State { ws: Ws { id: "chat1".into(), root: dir.join("ws"), data: dir.join("data") }, loading: true, staged: true, ..Default::default() };
        let repo = |name: &str| Repo { full_name: name.into(), private: false, default_branch: "main".into() };

        // No token: the signed-out view, with no error.
        receive(&mut st, Msg::Account(None, Ok(Vec::new())), &mut settings, &mut stale, &rt, &ctx);
        assert!(!st.loading && !st.connected && st.error.is_empty());
        // A token that authenticates but cannot list: signed in, with GitHub's words shown.
        receive(&mut st, Msg::Account(Some("mona".into()), Err("GitHub returned 403: rate limited".into())), &mut settings, &mut stale, &rt, &ctx);
        assert!(st.connected && st.login == "mona" && st.error == "GitHub returned 403: rate limited");

        // Branches for a repository no longer selected are dropped; for the selected one a missing default gives way to the first.
        (st.selected, st.branch) = (Some(repo("octo/demo")), "main".into());
        receive(&mut st, Msg::Branches("octo/other".into(), Ok(vec!["x".into()])), &mut settings, &mut stale, &rt, &ctx);
        assert!(st.branches.is_empty());
        receive(&mut st, Msg::Branches("octo/demo".into(), Ok(vec!["trunk".into(), "dev".into()])), &mut settings, &mut stale, &rt, &ctx);
        assert_eq!((st.branch.as_str(), st.branches.len()), ("trunk", 2));

        // A failed clone and a failed pull request show the reason and release the buttons.
        st.busy = true;
        receive(&mut st, Msg::Connected(Err("Invalid Git branch name".into())), &mut settings, &mut stale, &rt, &ctx);
        assert!(!st.busy && st.error == "Invalid Git branch name" && st.connection.is_none() && !stale);
        (st.busy, st.pr_form) = (true, true);
        receive(&mut st, Msg::PrOpened(Err("GitHub returned 422: no commits".into())), &mut settings, &mut stale, &rt, &ctx);
        assert!(!st.busy && st.pr_form && st.error == "GitHub returned 422: no commits");
        // Results that arrive after "Turn off" are ignored.
        receive(&mut st, Msg::Changes(Some(Changes { ahead: 3, ..Default::default() })), &mut settings, &mut stale, &rt, &ctx);
        assert!(st.changes.is_none());

        // Clicks that need more first say what, in the web's words, and start nothing.
        st.error.clear();
        perform(&mut st, Do::Verify, &mut settings, &mut stale, &rt, &ctx);
        assert_eq!(st.error, "Paste a GitHub Personal Access token first.");
        (st.continuing, st.busy) = (true, false);
        perform(&mut st, Do::Connect, &mut settings, &mut stale, &rt, &ctx);
        assert!(st.error == "Pick the branch to continue." && !st.busy);
        st.suggestion = Some(("Add b".into(), "## Changes\n\n- Add b\n".into(), 1));
        perform(&mut st, Do::OpenPrForm, &mut settings, &mut stale, &rt, &ctx);
        assert!(st.pr_form && st.pr_title == "Add b" && st.pr_body.starts_with("## Changes"));
        assert_eq!(settings, Settings::default(), "nothing above saves a token");
    }
}
