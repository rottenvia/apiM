//! apiM desktop: the native version. One small program, no browser engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod binary;
mod browser;
mod compact;
mod context;
mod diagnostics;
mod diff;
mod export;
mod filetree;
mod find;
mod git_agent;
mod github;
mod lessons;
mod local;
mod media;
mod mcp;
mod models;
mod plugins;
mod prompt;
mod provider;
mod refusal;
mod run;
mod sandbox;
mod search;
mod machine;
mod skillhub;
mod search_usage;
mod slash;
mod snapshots;
mod store;
mod summary;
mod tools;
mod ui;

use std::sync::Arc;

fn runtime() -> tokio::runtime::Runtime {
    // First thing, so a crash anywhere after this is in the problem report.
    diagnostics::watch_for_crashes();
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("async runtime")
}

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--pdf-pages") {
        // A PDF on stdin, its pages as JSON on stdout: the app parses PDFs in a child of itself so a crash stays out of it.
        let mut pdf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut pdf);
        println!("{}", serde_json::to_string(&media::documents::pdf_pages_here(&pdf)).unwrap_or_default());
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--ask") {
        headless(&args[1..]);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--tools") {
        tool_calls(&args[1..]);
        return Ok(());
    }
    ui::run(runtime())
}

/// `apim --tools FILE [--auto] [--dir FOLDER]`: runs the tool calls listed in FILE, a JSON list of
/// {"name", "args"}, one after another as the agent would make them, and prints what each handed back.
/// No model is involved: this is how a tool is checked for what it does rather than for how a model uses it.
/// Nobody answers an approval card here, so without --auto whatever would ask is declined.
fn tool_calls(args: &[String]) {
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn AttachConsole(process: u32) -> i32;
        }
        unsafe { AttachConsole(u32::MAX) };
    }
    let mut settings = store::Settings::load();
    let mut dir = std::env::temp_dir().join("apim-ask");
    let mut file = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--auto" => settings.approval = store::Approval::Auto,
            "--dir" => dir = it.next().map(Into::into).unwrap_or(dir),
            _ => file = Some(a.clone()),
        }
    }
    let calls: Vec<serde_json::Value> = file.and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if calls.is_empty() {
        println!("Give a file holding a JSON list of {{\"name\": ..., \"args\": {{...}}}}.");
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let (tx, rx) = std::sync::mpsc::channel();
    let ctx = tools::Ctx {
        root: dir.clone(),
        state_dir: dir.join(".apim-state"),
        settings,
        client: provider::client(),
        read_chars: 20_000,
        limits: context::tool_limits::tool_limits_for(false),
        memory: Default::default(),
        emit: agent::Emitter::new(tx, || {}),
        chat: Default::default(),
        procs: Default::default(),
        planner: None,
    };
    // Whatever asks is declined, and whatever else a tool reports while it runs is dropped.
    std::thread::spawn(move || {
        for event in rx {
            match event {
                agent::Event::Approval { reply, .. } => drop(reply.send(false)),
                agent::Event::Question { reply, .. } => drop(reply.send(String::new())),
                _ => {}
            }
        }
    });
    let rt = runtime();
    let limit = std::env::var("APIM_TOOL_CHARS").ok().and_then(|n| n.parse().ok()).unwrap_or(900);
    for call in &calls {
        let (name, args) = (call["name"].as_str().unwrap_or(""), &call["args"]);
        let started = std::time::Instant::now();
        let out = rt.block_on(tools::run(name, args, &ctx));
        let text: String = out.text.chars().take(limit).collect();
        println!("\n## {name} {}\n{} [{}] {:.1}s{}\n{text}{}", args.to_string().chars().take(160).collect::<String>(), if out.ok { "ok" } else { "FAILED" }, out.summary, started.elapsed().as_secs_f32(), out.changed.map(|p| format!(" changed {p}")).unwrap_or_default(), if out.text.chars().count() > limit { "\n…" } else { "" });
    }
}

/// `apim --ask [--auto] [--dir FOLDER] [--note TEXT] [--think] question`: one reply in the terminal, no window.
/// `--note` is handed to the reply after its first step, as a "btw" typed while it works; `--think` prints its thinking.
/// The smoke test for the whole agent path, and handy in scripts.
fn headless(args: &[String]) {
    // A release build has no console of its own (so no black window flashes when the
    // app starts); terminal mode borrows the one it was started from.
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn AttachConsole(process: u32) -> i32;
        }
        // u32::MAX is ATTACH_PARENT_PROCESS. Fails harmlessly when output is already piped or a console exists.
        unsafe { AttachConsole(u32::MAX) };
    }
    let mut settings = store::Settings::load();
    let mut dir = std::env::temp_dir().join("apim-ask");
    let mut words = Vec::new();
    let (mut note, mut think) = (None, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--auto" => settings.approval = store::Approval::Auto,
            "--dir" => dir = it.next().map(Into::into).unwrap_or(dir),
            "--model" => settings.model = it.next().cloned().unwrap_or_default(),
            "--effort" => settings.effort = it.next().cloned().unwrap_or_default(),
            "--note" => note = it.next().cloned(),
            "--think" => think = true,
            _ => words.push(a.clone()),
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let request = agent::Request {
        settings,
        history: Vec::new(),
        text: words.join(" "),
        images: Vec::new(),
        summary: None,
        workspace: dir.clone(),
        state_dir: dir.join(".apim-state"),
        chat: Default::default(),
        conv_id: store::new_id(),
        ..Default::default()
    };
    let notes = request.notes.clone();
    let rt = runtime();
    rt.spawn(agent::run(request, agent::Emitter::new(tx, || {}), Arc::new(tools::exec::Procs::default())));
    // Every line of a thought is marked, its first too: unmarked, it read as the reply's own words.
    let mut thinking = false;
    for event in rx {
        use agent::Event::*;
        if !matches!(event, Reasoning(_)) {
            thinking = false;
        }
        match event {
            Content(t) => print!("{t}"),
            Reasoning(t) if think => {
                print!("{}{}", if thinking { "" } else { "\n  ~ " }, t.replace('\n', "\n  ~ "));
                thinking = true;
            }
            ToolStart(t) => println!("\n> {} {}", t.name, t.args.chars().take(200).collect::<String>()),
            ToolDone { ok, summary, .. } => {
                println!("  {} {summary}", if ok { "ok" } else { "FAILED" });
                if let Some(note) = note.take() {
                    println!("\n[note passed: {note}]");
                    notes.lock().unwrap().push(note);
                }
            }
            WebSearch(_) => {}
            // Nobody is here to click: decline, and the model is told so.
            Approval { command, reply, .. } => {
                println!("\n  (declined, pass --auto to allow: {command})");
                let _ = reply.send(false);
            }
            Question { question, reply, .. } => {
                println!("\n  (question skipped: {question})");
                let _ = reply.send(String::new());
            }
            Notice(n) => println!("\n[{n}]"),
            Retry { reason, wait, .. } => println!("\n[{reason} Retrying in {}s]", wait.as_secs()),
            Usage(u) => eprintln!("\n[tokens in {} out {} cached {}]", u.prompt, u.completion, u.cache_hit),
            Done { finish, incomplete, stop_reason } => {
                println!("\n[done: {finish:?}{}{}]", if incomplete { ", incomplete" } else { "" }, stop_reason.map(|r| format!(", {r}")).unwrap_or_default());
                break;
            }
            Error(e) => {
                println!("\n[error: {e}]");
                break;
            }
            Status(_) | Reasoning(_) | ToolDraft { .. } | State(_) | Context(_) | Checkpoint(_) | ToolProgress { .. } | Skill { .. } | Groups(_) | ModelAdded(_) => {}
        }
    }
}
