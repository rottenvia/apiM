//! The `skills` tool: the model finds a skill in the catalog, adds it, and switches it on for this chat or
//! for every chat, when the user asks or a task would go better with one. A skill is a plugin
//! (`crate::plugins`): a standing instruction, and for some a longer guide read on demand.

use super::{Ctx, Output, str_arg};
use crate::agent::Event;
use crate::plugins::{self, Plugin};
use crate::store::Approval;
use serde_json::{Value, json};

pub fn schema() -> Value {
    json!({ "type": "function", "function": {
        "name": "skills",
        "description": "Skills (also called plugins) are standing instructions that change how you work or write: terse answers, least code, root cause first and more. Use this when the user asks to find, add, apply, switch off or read a skill or plugin, or when a task would plainly go better with one. search: look through the catalog (its newest list is downloaded) and what is already added. install: add a skill and switch it on for this chat only (scope chat, the default), for every chat (scope all: the user may be asked first), or add it and leave it off (scope none). off: switch one off for that scope. read: a skill's full guide. After install, follow the skill at once.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["search", "install", "off", "read"] },
                "skill": { "type": "string", "description": "install, off, read: the skill's id as search gives it (skill-terse), or its name. search: the words to look for; an empty string lists everything." },
                "scope": { "type": "string", "enum": ["chat", "all", "none"], "description": "install, off: this chat (default), every chat, or neither." }
            },
            "required": ["action", "skill"]
        }
    } })
}

/// Where a skill stands for the chat that is asking.
fn standing(ctx: &Ctx, id: &str, added: bool) -> &'static str {
    let chat = ctx.chat.lock().unwrap();
    if chat.skills_all.iter().any(|on| on == id) {
        "on for every chat"
    } else if chat.skills.iter().any(|on| on == id) {
        "on for this chat"
    } else if added {
        "added, off"
    } else {
        "in the catalog"
    }
}

/// The skill a model means by `asked`: its id, its id without the "skill-" in front, or its name.
fn find(asked: &str) -> Option<(Plugin, bool)> {
    let want = asked.trim().to_lowercase();
    every().into_iter().find(|(p, _)| !want.is_empty() && (p.id == want || p.id.strip_prefix("skill-") == Some(want.as_str()) || p.name.to_lowercase() == want))
}

const NOT_FOUND: &str = "Pass the skill's id in `skill`, for example skill-terse; action search lists them.";

/// Every skill there is: (the skill, whether it is already among the user's plugins or built in).
/// Read from disk, not from the reply's settings: an install earlier in this reply is already there.
fn every() -> Vec<(Plugin, bool)> {
    let added: Vec<Plugin> = plugins::all(&plugins::custom()).into_iter().filter(|p| !p.legacy).collect();
    let more: Vec<Plugin> = plugins::catalog().into_iter().filter(|c| !added.iter().any(|p| p.id == c.id)).collect();
    added.into_iter().map(|p| (p, true)).chain(more.into_iter().map(|p| (p, false))).collect()
}

fn search(ctx: &Ctx, query: &str) -> Output {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
    let found: Vec<String> = every()
        .into_iter()
        .filter(|(p, _)| {
            let text = format!("{} {} {} {} {}", p.id, p.name, p.category, p.description, p.prompt).to_lowercase();
            words.iter().all(|word| text.contains(word))
        })
        .map(|(p, added)| format!("{} — {} [{}] ({}): {}", p.id, p.name, p.category, standing(ctx, &p.id, added), if p.description.is_empty() { p.prompt.chars().take(140).collect() } else { p.description.clone() }))
        .collect();
    if found.is_empty() {
        return Output::ok(format!("No skill matches \"{query}\". Search with fewer words, or with none to list them all."), "No match");
    }
    Output::ok(
        format!("{} skill{}:\n{}\n\nInstall one with action install and `skill` set to its id (the first word of its line); scope chat (this chat only), all (every chat) or none (add it, leave it off).", found.len(), if found.len() == 1 { "" } else { "s" }, found.join("\n")),
        format!("{} found", found.len()),
    )
}

/// Tells the window, which keeps the lists (the chat's own and the one for every chat) and saves them.
fn tell(ctx: &Ctx, id: &str, all: bool, on: bool) {
    {
        let mut chat = ctx.chat.lock().unwrap();
        let list = if all { &mut chat.skills_all } else { &mut chat.skills };
        list.retain(|have| have != id);
        if on {
            list.push(id.to_string());
        }
    }
    ctx.emit.send(Event::Skill { id: id.to_string(), all, on });
}

async fn install(ctx: &Ctx, asked: &str, scope: &str) -> Output {
    let mut found = find(asked);
    if found.is_none() && plugins::refresh_catalog(&ctx.client).await {
        // Not in the list that came with the app: perhaps in the newest one.
        found = find(asked);
    }
    let Some((skill, added)) = found else {
        return Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}"));
    };
    let id = skill.id.as_str();
    if scope == "all" && ctx.settings.approval != Approval::Auto {
        let ask = format!("Switch on the skill \"{}\" for every chat", skill.name);
        if !ctx.emit.approve_keyed(&ask, "It changes how the assistant answers in all chats, until it is switched off in Plugins.", &format!("skill-all:{id}")).await {
            return Output::fail("The user declined to switch it on for every chat. Offer it for this chat only (scope chat), or leave it.");
        }
    }
    if !added {
        if let Err(why) = plugins::install(&skill) {
            return Output::fail(format!("Could not add \"{}\": {why}", skill.name));
        }
    }
    let place = match scope {
        "all" => "on for every chat",
        "none" => "added, and left off",
        _ => "on for this chat",
    };
    match scope {
        "all" => tell(ctx, id, true, true),
        // Nothing to switch, but the window has to learn that the user's plugins changed.
        "none" => ctx.emit.send(Event::Skill { id: String::new(), all: false, on: false }),
        _ => tell(ctx, id, false, true),
    }
    if scope == "none" {
        return Output::ok(format!("{} is {place}. The user can switch it on in Plugins, or ask you to.", skill.name), format!("{} · added", skill.name));
    }
    let guide = if skill.guide.is_empty() { String::new() } else { format!("\n\n{}", skill.guide) };
    Output::ok(format!("{} is {place}. Follow it from now on, starting with your next words:\n{}{guide}", skill.name, skill.prompt.trim()), format!("{} · {}", skill.name, if scope == "all" { "every chat" } else { "this chat" }))
}

fn off(ctx: &Ctx, asked: &str, scope: &str) -> Output {
    let Some((skill, _)) = find(asked) else {
        return Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}"));
    };
    let id = skill.id.as_str();
    let (for_all, for_chat) = {
        let chat = ctx.chat.lock().unwrap();
        (chat.skills_all.iter().any(|on| on == id), chat.skills.iter().any(|on| on == id))
    };
    let all = scope == "all";
    if all && !for_all || !all && !for_chat {
        let other = if all && for_chat {
            " It is on for this chat: scope chat switches that off."
        } else if !all && for_all {
            " It is on for every chat: scope all switches that off."
        } else {
            ""
        };
        return Output::ok(format!("{} was not on for {}.{other}", skill.name, if all { "every chat" } else { "this chat" }), "Not on");
    }
    tell(ctx, id, all, false);
    Output::ok(format!("{} is off for {}. Stop following it.", skill.name, if all { "every chat" } else { "this chat" }), format!("{} · off", skill.name))
}

fn read(asked: &str) -> Output {
    match find(asked) {
        None => Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}")),
        Some((skill, _)) => Output::ok(format!("{}\n\n{}{}", skill.name, skill.prompt.trim(), if skill.guide.is_empty() { String::new() } else { format!("\n\n{}", skill.guide) }), skill.name),
    }
}

pub async fn run(ctx: &Ctx, args: &Value) -> Output {
    // One argument names the skill or holds the search words; the names a model might give it instead are taken too.
    let said = ["skill", "id", "name", "query"].iter().map(|key| str_arg(args, key).trim()).find(|text| !text.is_empty()).unwrap_or("");
    let (id, scope) = (said, str_arg(args, "scope"));
    match str_arg(args, "action") {
        "search" => {
            // The catalog on the project's page may have grown since this app was built.
            plugins::refresh_catalog(&ctx.client).await;
            search(ctx, said)
        }
        "install" => install(ctx, id, scope).await,
        "off" => off(ctx, id, scope),
        "read" => read(id),
        other => Output::fail(format!("Unknown action \"{other}\". Use search, install, off or read.")),
    }
}
