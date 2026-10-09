//! The `skills` tool: the model finds a skill, adds it, and switches it on for this chat or for every chat,
//! when the user asks or a task would go better with one. A skill is a plugin (`crate::plugins`): a standing
//! instruction, and for some a longer guide read on demand. It comes from apiM's catalog, or from GitHub
//! (`crate::skillhub`): Claude's own skills, the plugins written for it, any repository that holds a SKILL.md.

use super::{Ctx, Output, str_arg};
use crate::agent::Event;
use crate::plugins::{self, Plugin};
use crate::skillhub::{self, Weight};
use crate::store::Approval;
use serde_json::{Value, json};

pub fn schema() -> Value {
    json!({ "type": "function", "function": {
        "name": "skills",
        "description": "Skills (also called plugins) are standing instructions that change how you work or write: terse answers, least code, a way to make PDFs, and more. They come from apiM's catalog, which also names the official skills on GitHub (Caveman, Ponytail, Graphify, Anthropic's own), or straight from any GitHub repository that holds a SKILL.md. Use this when the user asks to find, add, apply, check, switch off or read a skill or plugin, or when a task would plainly go better with one. search: look through the catalog and what is already added; give owner/repo to list a repository's skills. install: download if needed, add, and switch on for this chat only (scope chat, the default), for every chat (scope all), or leave off (scope none); the user may be asked first. check: where a skill comes from and whether its text is safe, without adding it. off: switch one off for that scope. read: a skill's full instructions, or one of the files it carries. After install, follow the skill at once.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["search", "install", "check", "off", "read"] },
                "skill": { "type": "string", "description": "install, check, off, read: the skill's name or id as search gives it (caveman, skill-terse), or a GitHub address (owner/repo, owner/repo/skill-name, a github.com link). search: the words to look for, or owner/repo; an empty string lists everything." },
                "scope": { "type": "string", "enum": ["chat", "all", "none"], "description": "install, off: this chat (default), every chat, or neither." },
                "file": { "type": "string", "description": "read only: one of the files the skill carries, as read lists them." }
            },
            "required": ["action", "skill"]
        }
    } })
}

/// Where a skill stands for the chat that is asking.
fn standing(ctx: &Ctx, skill: &Plugin, added: bool) -> &'static str {
    let chat = ctx.chat.lock().unwrap();
    if chat.skills_all.iter().any(|on| *on == skill.id) {
        "on for every chat"
    } else if chat.skills.iter().any(|on| *on == skill.id) {
        "on for this chat"
    } else if added {
        "added, off"
    } else if skill.origin.is_some() {
        "official, on GitHub: install downloads it"
    } else {
        "in the catalog"
    }
}

/// What a skill from GitHub is asked for by: the folder its file sits in ("docx", "caveman-commit").
fn short_name(skill: &Plugin) -> String {
    skill.origin.as_ref().and_then(|origin| origin.file.rsplit('/').nth(1).map(str::to_lowercase)).unwrap_or_default()
}

/// The skill a model means by `asked`: its id, its id without the "skill-" in front, or its name. A skill from
/// GitHub is looked for first, so that "caveman" is the official one and not the built-in rule of that name.
fn find(asked: &str) -> Option<(Plugin, bool)> {
    let want = asked.trim().to_lowercase();
    if want.is_empty() {
        return None;
    }
    let all = every();
    let official = |p: &Plugin| p.origin.is_some() && (p.id == want || p.name.to_lowercase() == want || short_name(p) == want);
    let any = |p: &Plugin| p.id == want || p.id.strip_prefix("skill-") == Some(want.as_str()) || p.name.to_lowercase() == want;
    all.iter().find(|(p, _)| official(p)).or_else(|| all.iter().find(|(p, _)| any(p))).cloned()
}

const NOT_FOUND: &str = "Pass the skill's name or id in `skill` (caveman, skill-terse), or a GitHub address (owner/repo); action search lists what there is.";

/// Every skill there is: (the skill, whether it is already among the user's plugins or built in).
/// Read from disk, not from the reply's settings: an install earlier in this reply is already there.
fn every() -> Vec<(Plugin, bool)> {
    let added: Vec<Plugin> = plugins::all(&plugins::custom()).into_iter().filter(|p| !p.legacy).collect();
    let more: Vec<Plugin> = plugins::catalog().into_iter().filter(|c| !added.iter().any(|p| p.id == c.id)).collect();
    added.into_iter().map(|p| (p, true)).chain(more.into_iter().map(|p| (p, false))).collect()
}

async fn search(ctx: &Ctx, query: &str) -> Output {
    // An address: what that repository holds.
    if let Some(source) = skillhub::parse_source(query) {
        return match skillhub::names(&ctx.client, &source.repo).await {
            Ok((repo, names)) if names.is_empty() => Output::ok(format!("github.com/{repo} holds no skill: no SKILL.md file. A plugin that only brings commands, hooks or an MCP server has nothing apiM can use."), "None on GitHub"),
            Ok((repo, names)) => Output::ok(
                format!("github.com/{repo} holds {} skill{}: {}.\n\nInstall one with action install and `skill` set to {repo}/<name>; action check tells where it comes from and whether its text is safe.", names.len(), if names.len() == 1 { "" } else { "s" }, names.join(", ")),
                format!("{} on GitHub", names.len()),
            ),
            Err(why) => Output::fail(why),
        };
    }
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
    let found: Vec<String> = every()
        .into_iter()
        .filter(|(p, _)| {
            let text = format!("{} {} {} {} {} {}", p.id, p.name, short_name(p), p.category, p.description, p.prompt.chars().take(400).collect::<String>()).to_lowercase();
            words.iter().all(|word| text.contains(word))
        })
        .map(|(p, added)| format!("{} — {} [{}] ({}): {}", p.id, p.name, p.category, standing(ctx, &p, added), if p.description.is_empty() { p.prompt.chars().take(140).collect() } else { p.description.clone() }))
        .collect();
    if found.is_empty() {
        return Output::ok(format!("No skill matches \"{query}\". Search with fewer words, or with none to list them all. A skill that is on GitHub can be installed by its address (owner/repo)."), "No match");
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

fn today() -> String {
    crate::store::iso(crate::store::now_ms()).chars().take(10).collect()
}

/// Downloads a skill from GitHub and weighs it: (what came, the check as text, the worst it found).
async fn download(ctx: &Ctx, repo: &str, path: &str, refs: &str) -> Result<(skillhub::Found, String, Weight), String> {
    let found = skillhub::fetch(&ctx.client, repo, path, refs).await?;
    let check = skillhub::check(&found, plugins::listed(&found.repo.name, &found.skill.file).is_some(), &today());
    let told = check.told(&found);
    Ok((found, told, check.worst))
}

/// Where a request for a skill leads: one already here, or one on GitHub (repository, path inside it, folder to carry).
enum Wanted {
    Here(Plugin, bool),
    GitHub(String, String, String),
}

fn wanted(asked: &str) -> Option<Wanted> {
    match find(asked) {
        // In the catalog as a pointer, not downloaded yet.
        Some((skill, false)) if skill.origin.is_some() => skill.origin.map(|origin| Wanted::GitHub(origin.repo, origin.file, origin.refs)),
        Some((skill, added)) => Some(Wanted::Here(skill, added)),
        None => skillhub::parse_source(asked).map(|source| Wanted::GitHub(source.repo, source.path, String::new())),
    }
}

async fn install(ctx: &Ctx, asked: &str, scope: &str) -> Output {
    let mut target = wanted(asked);
    if target.is_none() && plugins::refresh_catalog(&ctx.client).await {
        // Not in the list that came with the app: perhaps in the newest one.
        target = wanted(asked);
    }
    let auto = ctx.settings.approval == Approval::Auto;
    let mut more = String::new();
    let skill = match target {
        None => return Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}")),
        Some(Wanted::Here(skill, added)) => {
            if !added {
                if let Err(why) = plugins::install(&skill) {
                    return Output::fail(format!("Could not add \"{}\": {why}", skill.name));
                }
            }
            skill
        }
        Some(Wanted::GitHub(repo, path, refs)) => {
            let (found, told, worst) = match download(ctx, &repo, &path, &refs).await {
                Ok(got) => got,
                Err(why) => return Output::fail(why),
            };
            // Text from the internet is about to join the instructions: the user sees where it is from and what the
            // check found. A skill the check calls bad is never added unseen, whatever the approval mode.
            if !auto || worst == Weight::Bad {
                let reason = if worst == Weight::Note { "Its instructions will be followed in the chats you put it on." } else { "The trust check found something. Its instructions will be followed in the chats you put it on." };
                if !ctx.emit.approve_keyed(&told, reason, &format!("skill-add:{}/{}", found.repo.name, found.skill.file)).await {
                    return Output::fail(format!("The user declined to add \"{}\". Do not retry. The check said:\n{told}", found.skill.name));
                }
            }
            if !found.others.is_empty() {
                let shown: Vec<&str> = found.others.iter().take(30).map(String::as_str).collect();
                more = format!("\n\nThe repository holds {} more skill{}: {}. Install one with `skill` set to {}/<name>.", found.others.len(), if found.others.len() == 1 { "" } else { "s" }, shown.join(", "), found.repo.name);
            }
            more = format!("\n\n{told}\n({}){more}", skillhub::LIMITS);
            match plugins::install_package(&found, &refs) {
                Ok(skill) => skill,
                Err(why) => return Output::fail(format!("Could not add \"{}\": {why}", found.skill.name)),
            }
        }
    };
    let id = skill.id.as_str();
    // One already approved on its way in from GitHub is not asked about twice.
    if scope == "all" && !auto && more.is_empty() {
        let ask = format!("Switch on the skill \"{}\" for every chat", skill.name);
        if !ctx.emit.approve_keyed(&ask, "It changes how the assistant answers in all chats, until it is switched off in Plugins.", &format!("skill-all:{id}")).await {
            return Output::fail("The user declined to switch it on for every chat. Offer it for this chat only (scope chat), or leave it.");
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
        return Output::ok(format!("{} is {place}. The user can switch it on in Plugins, or ask you to.{more}", skill.name), format!("{} · added", skill.name));
    }
    let rules = if skill.guide.is_empty() {
        skill.prompt.trim().to_string()
    } else if skill.origin.is_some() {
        // Long instructions are not pasted into a result that is carried along for the rest of the reply.
        format!("{}\nIts instructions run to {} characters: read them (action read, skill {id}) before the first task they apply to.", skill.prompt.trim(), skill.guide.chars().count())
    } else {
        format!("{}\n\n{}", skill.prompt.trim(), skill.guide)
    };
    Output::ok(format!("{} is {place}. Follow it from now on, starting with your next words:\n{rules}{more}", skill.name), format!("{} · {}", skill.name, if scope == "all" { "every chat" } else { "this chat" }))
}

async fn check(ctx: &Ctx, asked: &str) -> Output {
    let (repo, path, refs) = match wanted(asked) {
        None => return Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}")),
        Some(Wanted::GitHub(repo, path, refs)) => (repo, path, refs),
        // One already added from GitHub is checked as it stands there today.
        Some(Wanted::Here(skill, _)) => match skill.origin {
            Some(origin) => (origin.repo, origin.file, origin.refs),
            None => return Output::ok(format!("{} is one of apiM's own: it ships with the app or comes from its catalog, and is nothing but the instruction you can read with action read.", skill.name), format!("{} · apiM's own", skill.name)),
        },
    };
    match download(ctx, &repo, &path, &refs).await {
        Ok((found, told, worst)) => Output::ok(format!("{told}\n\n{} Nothing was added. Tell the user what was found, in a few plain lines.", skillhub::LIMITS), format!("{} · {}", found.skill.name, if worst == Weight::Note { "nothing suspicious" } else { "needs a look" })),
        Err(why) => Output::fail(why),
    }
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

fn read(asked: &str, file: &str) -> Output {
    let Some((skill, added)) = find(asked) else {
        return Output::fail(format!("There is no skill \"{asked}\". {NOT_FOUND}"));
    };
    let carries = skill.origin.as_ref().map(|origin| origin.files.clone()).unwrap_or_default();
    if !file.trim().is_empty() {
        return match plugins::carried(&skill, file) {
            Some(text) => Output::ok(text, format!("{} · {}", skill.name, file.trim())),
            None if carries.is_empty() => Output::fail(format!("{} carries no files.", skill.name)),
            None => Output::fail(format!("{} carries no file \"{}\". It has: {}.", skill.name, file.trim(), carries.join(", "))),
        };
    }
    if skill.origin.is_some() && !added {
        return Output::ok(format!("{}: {}\n\nIt is on GitHub and not downloaded yet: action install adds it, action check tells whether it is safe.", skill.name, skill.description), skill.name);
    }
    let listing = if carries.is_empty() { String::new() } else { format!("\n\n[It carries these files; read one with action read and `file`: {}]", carries.join(", ")) };
    Output::ok(format!("{}\n\n{}{}{listing}", skill.name, skill.prompt.trim(), if skill.guide.is_empty() { String::new() } else { format!("\n\n{}", skill.guide) }), skill.name)
}

pub async fn run(ctx: &Ctx, args: &Value) -> Output {
    // One argument names the skill or holds the search words; the names a model might give it instead are taken too.
    let said = ["skill", "id", "name", "query", "repo", "url"].iter().map(|key| str_arg(args, key).trim()).find(|text| !text.is_empty()).unwrap_or("");
    let (id, scope) = (said, str_arg(args, "scope"));
    match str_arg(args, "action") {
        "search" => {
            // The catalog on the project's page may have grown since this app was built.
            plugins::refresh_catalog(&ctx.client).await;
            search(ctx, said).await
        }
        "install" | "add" | "apply" => install(ctx, id, scope).await,
        "check" | "trust" | "verify" => check(ctx, id).await,
        "off" => off(ctx, id, scope),
        "read" => read(id, str_arg(args, "file")),
        other => Output::fail(format!("Unknown action \"{other}\". Use search, install, check, off or read.")),
    }
}
