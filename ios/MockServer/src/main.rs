//! A stand-in for apiM on the computer, for the iOS app's UI tests: the real link (`desktop/src/remote.rs`, the
//! same file compiled here) in front of a scripted chat. Any message gets a thought, a step that asks to run a
//! command, and an answer once it is allowed. A message with `?ask` in it gets a question instead, and `fail` is
//! refused the way apiM refuses a message it has no key for. The settings, the model menu, the chat actions and
//! the pictures behave as the window's do, kept in memory.
//!
//! `apim-mock --port 47199 --secret <base64url>`

#[allow(dead_code)]
#[path = "../../../desktop/src/remote.rs"]
mod remote;

use base64::Engine;
use remote::{Approval, ChatRow, ChatView, Command, Conf, Depth, Found, KeyRow, ModelRow, Msg, Picture, Piece, Question, Remote, RunView, View};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, oneshot};
use tokio::time::sleep;

/// Messages sent from the end of a chat, as the window does (`SHOWN` in `desktop/src/ui/remote.rs`).
const SHOWN: usize = 80;

struct Chat {
    id: String,
    title: String,
    updated: u64,
    archived: bool,
    messages: Vec<Msg>,
}

struct World {
    chats: Vec<Chat>,
    open: usize,
    run: RunView,
    notice: String,
    allow: Option<oneshot::Sender<bool>>,
    answer: Option<oneshot::Sender<String>>,
    task: Option<tokio::task::JoinHandle<()>>,
    next: u64,
    conf: Conf,
    /// A picture's base64 by its id.
    pictures: HashMap<String, String>,
    /// How many messages of the open chat the phone has: `SHOWN`, and more on `More`.
    window: usize,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn text(t: &str) -> Piece {
    Piece::Text { text: t.into() }
}

fn tool(id: &str, kind: &str, title: &str, target: &str, ok: Option<bool>, summary: &str) -> Piece {
    Piece::Tool { id: id.into(), kind: kind.into(), title: title.into(), target: target.into(), ok, summary: summary.into(), image: String::new() }
}

fn msg(id: &str, role: &str, parts: Vec<Piece>, at: u64) -> Msg {
    Msg { id: id.into(), role: role.into(), parts, model: if role == "assistant" { "Claude Sonnet 5.5".into() } else { String::new() }, at, ..Default::default() }
}

const ANSWER: &str = "The loop comes from **the session cookie being set after the redirect**. The browser follows the `302` before the `Set-Cookie` header is stored, so the next request has no session and is sent back to `/login`.

### The fix

Set the cookie on the same response as the redirect:

```rust
let mut res = Redirect::to(&next).into_response();
res.headers_mut().insert(SET_COOKIE, session.cookie());
Ok(res)
```

| Before | After |
|---|---|
| Cookie on the next request | Cookie on the redirect itself |
| 2 round trips | 1 round trip |

- Works for the `?next=` parameter too
- No change to the logout path";

/// The model menu: one of each kind of thinking the window knows.
fn models() -> Vec<ModelRow> {
    let row = |id: &str, label: &str, short: &str, about: &str, specs: &str, vision: bool, mine: bool| ModelRow { id: id.into(), label: label.into(), short: short.into(), about: about.into(), specs: specs.into(), vision, mine };
    vec![
        row("claude-sonnet-5-5", "Claude Sonnet 5.5", "Sonnet 5.5", "Anthropic's balanced model: strong at code and long tasks.", "1M context · $3 / $15 per 1M", true, false),
        row("deepseek-v4-flash", "DeepSeek V4 Flash", "V4 Flash", "Fast and cheap, with thinking you can turn down.", "1M context · $0.14 / $0.28 per 1M", false, false),
        row("glm-5.3-flash", "GLM 5.3 Flash", "GLM Flash", "Free on OpenRouter. Answers without a thinking step.", "200K context · free", false, false),
        row("custom:qwen/qwen3-coder", "Qwen3 Coder", "Qwen3 Coder", "", "OpenRouter · 262K context · $0.22 / $0.95 per 1M", false, true),
    ]
}

/// The depths each model has, as `desktop/src/models.rs` `effort_levels` gives them.
fn levels(model: &str) -> &'static [&'static str] {
    match model {
        "claude-sonnet-5-5" => &["low", "medium", "high", "xhigh", "max"],
        "deepseek-v4-flash" | "custom:qwen/qwen3-coder" => &["none", "low", "high", "max"],
        _ => &[],
    }
}

fn depths(model: &str) -> Vec<Depth> {
    let all = [
        ("auto", "Auto", "Picks a depth for each message: none for a greeting, deep for a bug hunt.", "Can spend more tokens on complex prompts."),
        ("none", "None", "No reasoning. Fastest and cheapest responses.", ""),
        ("low", "Low", "Light reasoning for everyday questions.", ""),
        ("medium", "Medium", "Thinks it through without dwelling. A good default.", ""),
        ("high", "High", "Deep reasoning for complex problems and debugging.", ""),
        ("xhigh", "X-High", "Deeper still, for long multi-step work.", "Slower and costlier than High."),
        ("max", "Max", "Maximum depth — 50K+ thinking tokens per reply.", "Slowest and most expensive. Use sparingly."),
    ];
    let levels = levels(model);
    if levels.is_empty() {
        return Vec::new();
    }
    all.iter().filter(|d| d.0 == "auto" || levels.contains(&d.0)).map(|&(id, label, about, warn)| Depth { id: id.into(), label: label.into(), about: about.into(), warn: warn.into() }).collect()
}

/// A long chat: what opening one costs, and the window's "earlier messages" on the phone.
fn long_chat(t: u64) -> Chat {
    let mut messages = Vec::new();
    for i in 0..120u64 {
        let at = t - 2 * 86_400_000 - 300 * 60_000 + i * 60_000;
        messages.push(msg(&format!("l{i}q"), "user", vec![text(&format!("Step {i}: what should the migration do next?"))], at));
        let body = format!("Step {i} of the migration.\n\n- Copy the `orders_{i}` rows into the new table\n- Check the counts match\n- Keep the old table until the end\n\n```sql\nINSERT INTO orders_v2 SELECT * FROM orders_{i};\n```\n\nThat keeps every step reversible: nothing is dropped until the last one has been checked.");
        messages.push(msg(&format!("l{i}a"), "assistant", vec![Piece::Think { text: "Keep it reversible.".into(), ms: 2100 }, text(&body)], at + 1000));
    }
    Chat { id: "c-long".into(), title: "Database migration, step by step".into(), updated: t - 2 * 86_400_000, archived: false, messages }
}

impl World {
    fn new() -> World {
        let t = now();
        let (min, hour, day) = (60_000, 3_600_000, 86_400_000);
        let simple = |id: &str, title: &str, updated: u64, q: &str, a: &str| Chat {
            id: id.into(),
            title: title.into(),
            updated,
            archived: false,
            messages: vec![msg(&format!("{id}-q"), "user", vec![text(q)], updated - 1000), msg(&format!("{id}-a"), "assistant", vec![text(a)], updated)],
        };
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let mut asked = msg("m1", "user", vec![text("The login page keeps redirecting back to itself after I sign in. Can you find out why?")], t - 6 * min);
        asked.files = vec!["login-loop.png".into()];
        asked.images = vec![Picture { id: "m1\u{1f}a0".into(), name: "login-loop.png".into() }];
        let mut look = tool("t3", "computer", "Looked at", "the screen", Some(true), "The dashboard opens after signing in.");
        if let Piece::Tool { image, .. } = &mut look {
            *image = "m2\u{1f}tt3".into();
        }
        let login = Chat {
            id: "c-login".into(),
            title: "Fix the login redirect loop".into(),
            updated: t - 5 * min,
            archived: false,
            messages: vec![
                asked,
                msg(
                    "m2",
                    "assistant",
                    vec![
                        Piece::Think { text: "Looking at the redirect flow first. If the session cookie lands after the 302, the next request arrives with no session.".into(), ms: 4200 },
                        tool("t1", "read", "Read", "src/auth/session.rs", Some(true), "214 lines"),
                        tool("t2", "search", "Searched", "redirect_to", Some(true), "3 matches in 2 files"),
                        look,
                        text(ANSWER),
                    ],
                    t - 5 * min,
                ),
            ],
        };
        let mut archived = simple("c-arch", "Old project notes", t - 20 * day, "Where did we leave the notes?", "In `docs/notes.md`.");
        archived.archived = true;
        World {
            chats: vec![
                login,
                simple("c-trip", "Plan a weekend in Lisbon", t - 3 * hour, "Two days in Lisbon, what should I not miss?", "Start in **Alfama** early, before the trams fill up, and keep the evening for Bairro Alto."),
                simple("c-sql", "Why is this SQL query slow?", t - day, "Why is this query slow?", "It scans `orders` because the filter wraps `created_at` in a function. Index the column and compare it directly."),
                simple("c-css", "Center a div, properly", t - 3 * day, "How do I center a div?", "`display: grid; place-items: center;` on the parent."),
                simple("c-rust", "Rust lifetimes, explained simply", t - 12 * day, "Explain lifetimes simply.", "A lifetime is how long a borrow is allowed to stay valid."),
                long_chat(t),
                simple("c-old", "Budget spreadsheet formulas", t - 45 * day, "Sum a column only where B says rent.", "`=SUMIF(B:B, \"rent\", C:C)`"),
                archived,
            ],
            open: 0,
            run: RunView::default(),
            notice: String::new(),
            allow: None,
            answer: None,
            task: None,
            next: 100,
            conf: Conf {
                model: "claude-sonnet-5-5".into(),
                effort: "auto".into(),
                web: "auto".into(),
                search: "balanced".into(),
                computer: false,
                approval: "manual".into(),
                lessons: false,
                keys: vec![KeyRow { name: "Anthropic".into(), set: true }, KeyRow { name: "OpenRouter".into(), set: true }, KeyRow { name: "DeepSeek".into(), set: false }, KeyRow { name: "Tavily".into(), set: false }, KeyRow { name: "Exa".into(), set: false }],
                ..Default::default()
            },
            pictures: HashMap::from([("m1\u{1f}a0".to_string(), b64(include_bytes!("../assets/login.png"))), ("m2\u{1f}tt3".to_string(), b64(include_bytes!("../assets/dashboard.png")))]),
            window: SHOWN,
        }
    }

    fn id(&mut self, what: &str) -> String {
        self.next += 1;
        format!("{what}{}", self.next)
    }

    fn model_label(&self) -> String {
        models().into_iter().find(|m| m.id == self.conf.model).map_or_else(String::new, |m| m.label)
    }

    fn view(&self) -> View {
        let chat = &self.chats[self.open];
        let skip = chat.messages.len().saturating_sub(self.window);
        let mut conf = self.conf.clone();
        conf.efforts = depths(&conf.model);
        let levels = levels(&conf.model);
        if conf.effort != "auto" && !levels.is_empty() && !levels.contains(&conf.effort.as_str()) {
            conf.effort = if conf.effort == "medium" || conf.effort == "xhigh" { "high".into() } else { levels[0].into() };
        }
        let last = chat.messages.last().filter(|m| m.role == "assistant" && m.incomplete);
        let mut run = self.run.clone();
        run.resume = !run.running && last.is_some_and(|m| m.parts.iter().any(|p| !matches!(p, Piece::Notice { .. })));
        View {
            pc: "MOCK-PC".into(),
            model: self.model_label(),
            chats: self.chats.iter().filter(|c| !c.messages.is_empty()).map(|c| ChatRow { id: c.id.clone(), title: c.title.clone(), updated: c.updated, running: self.run.running && c.id == chat.id, archived: c.archived }).collect(),
            chat: ChatView { id: chat.id.clone(), title: chat.title.clone(), earlier: skip, messages: chat.messages[skip..].to_vec() },
            run,
            notice: self.notice.clone(),
            conf,
            models: models(),
        }
    }

    /// The reply being written: the last message of the chat on screen.
    fn reply(&mut self) -> &mut Msg {
        let open = self.open;
        self.chats[open].messages.last_mut().expect("a reply")
    }

    fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if !self.run.running {
            return;
        }
        let reply = self.reply();
        for part in &mut reply.parts {
            if let Piece::Tool { ok, summary, .. } = part {
                if ok.is_none() {
                    *ok = Some(false);
                    *summary = "Stopped".into();
                }
            }
        }
        reply.incomplete = true;
        reply.parts.push(Piece::Notice { text: "Stopped.".into() });
        (self.run, self.allow, self.answer) = (RunView::default(), None, None);
    }

    fn open_chat(&mut self, id: &str) {
        if let Some(at) = self.chats.iter().position(|c| c.id == id) {
            if at != self.open {
                self.window = SHOWN;
            }
            self.open = at;
        }
    }

    /// The question a message belongs to: the index of the user message at or before it.
    fn question_of(&self, id: &str) -> Option<usize> {
        let messages = &self.chats[self.open].messages;
        let at = messages.iter().position(|m| m.id == id)?;
        messages[..=at].iter().rposition(|m| m.role == "user" && !m.note)
    }

    /// A message from the phone, or one asked again: a question, an empty reply, and the script that writes it.
    fn ask(&mut self, world: &Arc<Mutex<World>>, said: String, files: Vec<String>, images: Vec<Picture>) {
        let open = self.open;
        let (question, answer) = (self.id("q"), self.id("a"));
        let mut asked = msg(&question, "user", vec![text(&said)], now());
        asked.files = files;
        asked.images = images;
        let chat = &mut self.chats[open];
        if chat.title.is_empty() {
            chat.title = said.chars().take(40).collect();
        }
        chat.updated = now();
        chat.messages.push(asked);
        chat.messages.push(msg(&answer, "assistant", Vec::new(), now()));
        self.run = RunView { running: true, status: "Thinking".into(), ..Default::default() };
        self.task = Some(tokio::spawn(script(world.clone(), said)));
    }
}

fn act(world: &Arc<Mutex<World>>, command: Command) {
    let mut w = world.lock().unwrap();
    match command {
        Command::Open { id } => w.open_chat(&id),
        Command::New => {
            if !w.chats[w.open].messages.is_empty() {
                let id = w.id("c-new");
                w.chats.push(Chat { id, title: String::new(), updated: now(), archived: false, messages: Vec::new() });
                w.open = w.chats.len() - 1;
                w.window = SHOWN;
            }
        }
        Command::Stop => w.stop(),
        Command::Allow { allow } => {
            if let Some(reply) = w.allow.take() {
                let _ = reply.send(allow);
                w.run.approval = None;
            }
        }
        Command::Answer { text } => {
            if let Some(reply) = w.answer.take() {
                let _ = reply.send(text);
                w.run.question = None;
            }
        }
        Command::Send { text: said, photos } => {
            if said.trim() == "fail" {
                w.notice = "No API key for Claude Sonnet 5.5. Add one in Settings > API keys.".into();
                return;
            }
            w.notice.clear();
            let open = w.open;
            if w.run.running {
                let id = w.id("note");
                let mut note = msg(&id, "user", vec![text(&said)], now());
                note.note = true;
                let at = w.chats[open].messages.len() - 1;
                w.chats[open].messages.insert(at, note);
                return;
            }
            let message = w.next + 1;
            let mut files = Vec::new();
            let mut images = Vec::new();
            for (i, photo) in photos.iter().enumerate() {
                let name = if photo.name.contains('.') { photo.name.clone() } else { format!("{}.jpg", photo.name) };
                if name.ends_with(".jpg") || name.ends_with(".png") {
                    let id = format!("q{message}\u{1f}a{i}");
                    w.pictures.insert(id.clone(), photo.data.clone());
                    images.push(Picture { id, name: name.clone() });
                }
                files.push(name);
            }
            w.ask(world, said, files, images);
        }
        Command::Ping | Command::Image { .. } => {}
        Command::Set { key, value } => {
            let text = value.as_str().unwrap_or_default().to_string();
            let c = &mut w.conf;
            match key.as_str() {
                "model" if models().iter().any(|m| m.id == text) => c.model = text,
                "effort" => c.effort = text,
                "web" => c.web = text,
                "search" => c.search = text,
                "approval" => c.approval = text,
                "computer" => c.computer = value.as_bool().unwrap_or(c.computer),
                "lessons" => c.lessons = value.as_bool().unwrap_or(c.lessons),
                _ => {}
            }
        }
        Command::Rename { id, title } => {
            if let Some(chat) = w.chats.iter_mut().find(|c| c.id == id) {
                if !title.trim().is_empty() {
                    chat.title = title.trim().into();
                }
            }
        }
        Command::Archive { id, archived } => {
            if let Some(chat) = w.chats.iter_mut().find(|c| c.id == id) {
                chat.archived = archived;
            }
        }
        Command::DeleteChat { id } => {
            if w.chats.len() > 1 {
                if let Some(at) = w.chats.iter().position(|c| c.id == id) {
                    if at == w.open {
                        w.stop();
                    }
                    let open_id = w.chats[w.open].id.clone();
                    w.chats.remove(at);
                    w.open = w.chats.iter().position(|c| c.id == open_id).unwrap_or(0);
                }
            }
        }
        Command::Delete { id } => {
            if !w.run.running {
                if let Some(start) = w.question_of(&id) {
                    let open = w.open;
                    let messages = &mut w.chats[open].messages;
                    let end = messages[start + 1..].iter().position(|m| m.role == "user" && !m.note).map_or(messages.len(), |at| start + 1 + at);
                    messages.drain(start..end);
                }
            }
        }
        Command::Edit { id, text: said } => {
            if !w.run.running {
                if let Some(start) = w.question_of(&id) {
                    let open = w.open;
                    let asked = w.chats[open].messages[start].clone();
                    w.chats[open].messages.truncate(start);
                    w.ask(world, said, asked.files, asked.images);
                }
            }
        }
        Command::Retry | Command::Resume => {
            let open = w.open;
            let last_is_reply = w.chats[open].messages.last().is_some_and(|m| m.role == "assistant");
            if !w.run.running && last_is_reply {
                w.chats[open].messages.pop();
                if let Some(asked) = w.chats[open].messages.pop() {
                    let said = asked.parts.iter().find_map(|p| if let Piece::Text { text } = p { Some(text.clone()) } else { None }).unwrap_or_default();
                    w.ask(world, said, asked.files, asked.images);
                }
            }
        }
        Command::More => w.window += SHOWN,
        // Guardian concerns (the real guardian service answers these on its own port); the mock has nothing to do.
        Command::Wake | Command::Lock { .. } => {}
    }
}

/// One scripted reply, a step at a time, the way a real one arrives.
async fn script(world: Arc<Mutex<World>>, said: String) {
    let edit = |f: &mut dyn FnMut(&mut World)| f(&mut world.lock().unwrap());
    sleep(Duration::from_millis(350)).await;
    let thought = "Running the suite first, to see what fails and why.";
    for end in [12, 31, thought.len()] {
        edit(&mut |w| {
            let reply = w.reply();
            reply.parts = vec![Piece::Think { text: thought[..end].into(), ms: 0 }];
        });
        sleep(Duration::from_millis(180)).await;
    }
    edit(&mut |w| w.reply().parts = vec![Piece::Think { text: thought.into(), ms: 1200 }]);

    let finale: String = if said.contains("?ask") {
        let (tx, rx) = oneshot::channel();
        edit(&mut |w| {
            w.run.status = "Waiting".into();
            w.run.question = Some(Question { question: "Which branch should I push to?".into(), options: vec!["main".into(), "fix/login-loop".into()], context: "Both are up to date with origin.".into() });
        });
        let mut tx = Some(tx);
        edit(&mut |w| w.answer = tx.take());
        let branch = rx.await.unwrap_or_default();
        if branch.is_empty() { "Okay, I left it unpushed.".into() } else { format!("Pushing to `{branch}`. Done: the branch is on origin now.") }
    } else if said.contains("?quick") {
        "Here is the short version: **yes**, it is safe to merge.".into()
    } else {
        let (tx, rx) = oneshot::channel();
        let mut tx = Some(tx);
        edit(&mut |w| {
            w.run.status = "Working".into();
            w.reply().parts.push(tool("t-run", "run", "Running", "cargo test --workspace", None, ""));
            w.run.approval = Some(Approval { command: "cargo test --workspace".into(), reason: "Runs the project's tests. Nothing outside the project folder is touched.".into() });
            w.allow = tx.take();
        });
        let allowed = rx.await.unwrap_or(false);
        edit(&mut |w| {
            if let Some(Piece::Tool { title, ok, summary, .. }) = w.reply().parts.last_mut() {
                *title = "Ran".into();
                *ok = Some(allowed);
                *summary = if allowed { "test result: ok. 12 passed; 0 failed".into() } else { "Skipped: you said no.".into() };
            }
        });
        sleep(Duration::from_millis(400)).await;
        if allowed {
            "All 12 tests pass now. The two that failed were still expecting the old redirect: they asserted `/login`, and now get `/dashboard`.\n\nI updated both assertions in `tests/auth.rs`.".into()
        } else {
            "Okay, I didn't run anything. Say the word when you want the tests run.".into()
        }
    };

    edit(&mut |w| {
        w.run.status = "Writing".into();
        w.reply().parts.push(text(""));
    });
    let words: Vec<&str> = finale.split_inclusive(' ').collect();
    for i in 1..=words.len() {
        let so_far = words[..i].concat();
        edit(&mut |w| {
            if let Some(Piece::Text { text }) = w.reply().parts.last_mut() {
                *text = so_far.clone();
            }
        });
        sleep(Duration::from_millis(35)).await;
    }
    edit(&mut |w| {
        w.run = RunView::default();
        w.task = None;
    });
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|at| args.get(at + 1)).cloned();
    let port = value("--port").and_then(|p| p.parse().ok()).unwrap_or(47199);
    let secret = value("--secret").and_then(|s| remote::decode_secret(&s)).expect("--secret <32 bytes, base64url>");

    let wake = Arc::new(Notify::new());
    let woken = wake.clone();
    let mut link = Remote::start(&tokio::runtime::Handle::current(), port, secret, move || woken.notify_one()).expect("the port is free");
    println!("apim-mock listening on {}", link.port);
    let world = Arc::new(Mutex::new(World::new()));
    loop {
        tokio::select! {
            _ = wake.notified() => {}
            _ = sleep(Duration::from_millis(40)) => {}
        }
        for command in link.commands() {
            println!("phone: {}", format!("{command:?}").chars().take(160).collect::<String>());
            if let Command::Image { id } = &command {
                let found = world.lock().unwrap().pictures.get(id).cloned().map_or(Found::Missing, Found::Base64);
                link.give(id.clone(), found);
            }
            act(&world, command);
        }
        let view = world.lock().unwrap().view();
        link.publish(view);
    }
}
