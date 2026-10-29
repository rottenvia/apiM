//! A stand-in for apiM on the computer, for the iOS app's UI tests: the real link (`desktop/src/remote.rs`, the
//! same file compiled here) in front of a scripted chat. Any message gets a thought, a step that asks to run a
//! command, and an answer once it is allowed. A message with `?ask` in it gets a question instead, and `fail` is
//! refused the way apiM refuses a message it has no key for.
//!
//! `apim-mock --port 47199 --secret <base64url>`

#[allow(dead_code)]
#[path = "../../../desktop/src/remote.rs"]
mod remote;

use remote::{Approval, ChatRow, ChatView, Command, Msg, Piece, Question, Remote, RunView, View};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, oneshot};
use tokio::time::sleep;

struct Chat {
    id: String,
    title: String,
    updated: u64,
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
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn text(t: &str) -> Piece {
    Piece::Text { text: t.into() }
}

fn tool(id: &str, kind: &str, title: &str, target: &str, ok: Option<bool>, summary: &str) -> Piece {
    Piece::Tool { id: id.into(), kind: kind.into(), title: title.into(), target: target.into(), ok, summary: summary.into() }
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

impl World {
    fn new() -> World {
        let t = now();
        let (min, hour, day) = (60_000, 3_600_000, 86_400_000);
        let simple = |id: &str, title: &str, updated: u64, q: &str, a: &str| Chat {
            id: id.into(),
            title: title.into(),
            updated,
            messages: vec![msg(&format!("{id}-q"), "user", vec![text(q)], updated - 1000), msg(&format!("{id}-a"), "assistant", vec![text(a)], updated)],
        };
        let login = Chat {
            id: "c-login".into(),
            title: "Fix the login redirect loop".into(),
            updated: t - 5 * min,
            messages: vec![
                msg("m1", "user", vec![text("The login page keeps redirecting back to itself after I sign in. Can you find out why?")], t - 6 * min),
                msg(
                    "m2",
                    "assistant",
                    vec![
                        Piece::Think { text: "Looking at the redirect flow first. If the session cookie lands after the 302, the next request arrives with no session.".into(), ms: 4200 },
                        tool("t1", "read", "Read", "src/auth/session.rs", Some(true), "214 lines"),
                        tool("t2", "search", "Searched", "redirect_to", Some(true), "3 matches in 2 files"),
                        text(ANSWER),
                    ],
                    t - 5 * min,
                ),
            ],
        };
        World {
            chats: vec![
                login,
                simple("c-trip", "Plan a weekend in Lisbon", t - 3 * hour, "Two days in Lisbon, what should I not miss?", "Start in **Alfama** early, before the trams fill up, and keep the evening for Bairro Alto."),
                simple("c-sql", "Why is this SQL query slow?", t - day, "Why is this query slow?", "It scans `orders` because the filter wraps `created_at` in a function. Index the column and compare it directly."),
                simple("c-css", "Center a div, properly", t - 3 * day, "How do I center a div?", "`display: grid; place-items: center;` on the parent."),
                simple("c-rust", "Rust lifetimes, explained simply", t - 12 * day, "Explain lifetimes simply.", "A lifetime is how long a borrow is allowed to stay valid."),
                simple("c-old", "Budget spreadsheet formulas", t - 45 * day, "Sum a column only where B says rent.", "`=SUMIF(B:B, \"rent\", C:C)`"),
            ],
            open: 0,
            run: RunView::default(),
            notice: String::new(),
            allow: None,
            answer: None,
            task: None,
            next: 100,
        }
    }

    fn id(&mut self, what: &str) -> String {
        self.next += 1;
        format!("{what}{}", self.next)
    }

    fn view(&self) -> View {
        let chat = &self.chats[self.open];
        View {
            pc: "MOCK-PC".into(),
            model: "Claude Sonnet 5.5".into(),
            chats: self.chats.iter().filter(|c| !c.messages.is_empty()).map(|c| ChatRow { id: c.id.clone(), title: c.title.clone(), updated: c.updated, running: self.run.running && c.id == chat.id }).collect(),
            chat: ChatView { id: chat.id.clone(), title: chat.title.clone(), earlier: 0, messages: chat.messages.clone() },
            run: self.run.clone(),
            notice: self.notice.clone(),
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
}

fn act(world: &Arc<Mutex<World>>, command: Command) {
    let mut w = world.lock().unwrap();
    match command {
        Command::Open { id } => {
            if let Some(at) = w.chats.iter().position(|c| c.id == id) {
                w.open = at;
            }
        }
        Command::New => {
            if !w.chats[w.open].messages.is_empty() {
                let id = w.id("c-new");
                w.chats.push(Chat { id, title: String::new(), updated: now(), messages: Vec::new() });
                w.open = w.chats.len() - 1;
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
            let (question, answer) = (w.id("q"), w.id("a"));
            let mut asked = msg(&question, "user", vec![text(&said)], now());
            asked.files = photos.iter().map(|p| format!("{}.jpg", p.name)).collect();
            let chat = &mut w.chats[open];
            if chat.title.is_empty() {
                chat.title = said.chars().take(40).collect();
            }
            chat.updated = now();
            chat.messages.push(asked);
            chat.messages.push(msg(&answer, "assistant", Vec::new(), now()));
            w.run = RunView { running: true, status: "Thinking".into(), ..Default::default() };
            w.task = Some(tokio::spawn(script(world.clone(), said)));
        }
        Command::Ping => {}
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
            println!("phone: {command:?}");
            act(&world, command);
        }
        let view = world.lock().unwrap().view();
        link.publish(view);
    }
}
