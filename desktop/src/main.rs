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
    ui::run(runtime())
}

/// `apim --ask [--auto] [--dir FOLDER] question`: one reply in the terminal, no window.
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
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--auto" => settings.approval = store::Approval::Auto,
            "--dir" => dir = it.next().map(Into::into).unwrap_or(dir),
            "--model" => settings.model = it.next().cloned().unwrap_or_default(),
            "--effort" => settings.effort = it.next().cloned().unwrap_or_default(),
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
    let rt = runtime();
    rt.spawn(agent::run(request, agent::Emitter::new(tx, || {}), Arc::new(tools::exec::Procs::default())));
    for event in rx {
        use agent::Event::*;
        match event {
            Content(t) => print!("{t}"),
            ToolStart(t) => println!("\n> {} {}", t.name, t.args.chars().take(200).collect::<String>()),
            ToolDone { ok, summary, .. } => println!("  {} {summary}", if ok { "ok" } else { "FAILED" }),
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
            Status(_) | Reasoning(_) | ToolDraft { .. } | NoteRead { .. } | State(_) | Context(_) | Checkpoint(_) | ToolProgress { .. } | Skill { .. } | Groups(_) => {}
        }
    }
}
