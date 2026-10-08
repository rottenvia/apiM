//! Slash commands typed in the composer: src/lib/slash-commands.ts, with the menu and submit rules
//! of src/components/ChatArea.tsx. `/name args` on the first line runs a command instead of sending
//! a message. Data and parsing only: the UI performs what a command asks for.

/// Every command, in the web's order. `COMMANDS[cmd as usize]` is its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    Compact, Context, Cost,
    New, Retry, Rewind, Resume, Stop, Btw, Copy, Rename, Export, Archive, Delete, Find, Search,
    Init, Review, Test, Fix, Explain, Plan, Commit,
    Model, Effort, Web, Budget,
    Files, Panel,
    Settings, Plugins, Mcp, Sandbox, Theme, Sidebar, Help,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Something the app does itself.
    Action,
    /// A shortcut that expands into a full instruction for the agent and is sent as a normal
    /// message, with the short command shown in the transcript.
    Prompt,
    /// Takes one of a list of values: a model, a theme, a format.
    Options,
}

#[derive(Debug)]
pub struct Command {
    pub cmd: Cmd,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    /// Argument hint shown in the menu, e.g. "[focus]" or "<title>". Empty when it takes none.
    pub args: &'static str,
    /// Does nothing without its argument.
    pub arg_required: bool,
    pub description: &'static str,
    /// Menu section: Context, Chat, Agent, Model, Workspace, App, in that order.
    pub group: &'static str,
    /// Works while a reply is running (everything else waits for it).
    pub while_running: bool,
    pub kind: Kind,
}

const BASE: Command = Command { cmd: Cmd::Help, name: "", aliases: &[], args: "", arg_required: false, description: "", group: "", while_running: false, kind: Kind::Action };

pub static COMMANDS: [Command; 36] = [
    Command { cmd: Cmd::Compact, name: "compact", args: "[what to keep]", description: "Summarise the conversation so far and send only the summary from now on — frees the context window", group: "Context", ..BASE },
    Command { cmd: Cmd::Context, name: "context", description: "Show how full the context window is and what is in it", group: "Context", while_running: true, ..BASE },
    Command { cmd: Cmd::Cost, name: "cost", aliases: &["usage"], description: "Show tokens, cost and time spent in this chat", group: "Context", while_running: true, ..BASE },
    Command { cmd: Cmd::New, name: "new", aliases: &["clear"], description: "Start a new chat", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Retry, name: "retry", aliases: &["regenerate"], description: "Answer the last message again", group: "Chat", ..BASE },
    Command { cmd: Cmd::Rewind, name: "rewind", aliases: &["undo"], description: "Go back to before your last message — chat and files — and put its text back in the box", group: "Chat", ..BASE },
    Command { cmd: Cmd::Resume, name: "resume", aliases: &["continue"], args: "[instruction]", description: "Carry on the interrupted reply, keeping its work", group: "Chat", ..BASE },
    Command { cmd: Cmd::Stop, name: "stop", description: "Stop the running reply", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Btw, name: "btw", args: "<note>", arg_required: true, description: "Tell the running task something without stopping it", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Copy, name: "copy", description: "Copy the last reply to the clipboard", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Rename, name: "rename", args: "<title>", arg_required: true, description: "Rename this chat", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Export, name: "export", args: "[md|json|txt|html]", description: "Download this chat (Markdown by default)", group: "Chat", while_running: true, kind: Kind::Options, ..BASE },
    Command { cmd: Cmd::Archive, name: "archive", description: "Archive this chat", group: "Chat", ..BASE },
    Command { cmd: Cmd::Delete, name: "delete", description: "Delete this chat", group: "Chat", ..BASE },
    Command { cmd: Cmd::Find, name: "find", args: "[text]", description: "Find text in this chat", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Search, name: "search", description: "Search all chats", group: "Chat", while_running: true, ..BASE },
    Command { cmd: Cmd::Init, name: "init", description: "Study the workspace and write AGENTS.md — notes the agent reads at the start of every reply", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Review, name: "review", args: "[focus]", description: "Review the code for bugs and risks — reports, changes nothing", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Test, name: "test", args: "[what]", description: "Run the tests, fix what fails, run them again", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Fix, name: "fix", args: "<problem>", arg_required: true, description: "Reproduce a problem, fix the root cause, prove it is fixed", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Explain, name: "explain", args: "<file, function or idea>", arg_required: true, description: "Explain how something in the workspace works", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Plan, name: "plan", args: "<task>", arg_required: true, description: "Explore and make a plan, without starting the work", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Commit, name: "commit", args: "[message]", description: "Commit the workspace changes with git", group: "Agent", kind: Kind::Prompt, ..BASE },
    Command { cmd: Cmd::Model, name: "model", args: "[name]", description: "Switch the model", group: "Model", while_running: true, kind: Kind::Options, ..BASE },
    Command { cmd: Cmd::Effort, name: "effort", aliases: &["think"], args: "[auto|none|low|high|max]", description: "Set how hard it thinks", group: "Model", while_running: true, kind: Kind::Options, ..BASE },
    Command { cmd: Cmd::Web, name: "web", args: "[off|auto|always]", description: "Set web search", group: "Model", while_running: true, kind: Kind::Options, ..BASE },
    Command { cmd: Cmd::Budget, name: "budget", args: "[dollars|off]", description: "Set the spending limit per reply", group: "Model", while_running: true, ..BASE },
    Command { cmd: Cmd::Files, name: "files", description: "Open the workspace files", group: "Workspace", while_running: true, ..BASE },
    Command { cmd: Cmd::Panel, name: "panel", description: "Show or hide the side panel", group: "Workspace", while_running: true, ..BASE },
    Command { cmd: Cmd::Settings, name: "settings", aliases: &["config"], description: "Open Settings", group: "App", while_running: true, ..BASE },
    Command { cmd: Cmd::Plugins, name: "plugins", description: "Open plugins", group: "App", while_running: true, ..BASE },
    Command { cmd: Cmd::Mcp, name: "mcp", description: "Open the MCP servers console", group: "App", while_running: true, ..BASE },
    Command { cmd: Cmd::Sandbox, name: "sandbox", description: "Set up the private Linux sandbox (run things invisibly)", group: "App", while_running: true, ..BASE },
    Command { cmd: Cmd::Theme, name: "theme", args: "[name]", description: "Switch the colour theme", group: "App", while_running: true, kind: Kind::Options, ..BASE },
    Command { cmd: Cmd::Sidebar, name: "sidebar", description: "Show or hide the chat list", group: "App", while_running: true, ..BASE },
    Command { cmd: Cmd::Help, name: "help", aliases: &["commands"], description: "List every command", group: "App", while_running: true, ..BASE },
];

/// What JS's `trim` and `\s` call whitespace: Rust's set without NEL, with the BOM.
fn space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// A command by name or alias, in any letter case.
pub fn find_command(name: &str) -> Option<&'static Command> {
    let name = name.to_lowercase();
    COMMANDS.iter().find(|c| c.name == name || c.aliases.contains(&name.as_str()))
}

#[derive(Debug)]
pub enum Parsed<'a> {
    /// The command and its trimmed argument ("" when none).
    Command(&'static Command, &'a str),
    /// A plain word after the slash that is no command, as typed.
    Unknown(&'a str),
}

/// `/name rest` as a command and its argument. None when the text is not a command at all.
///
/// A first word with another slash in it is a path ("/home/me/app.py is broken"), and so is
/// anything that is not a plain word: those send as ordinary messages. Only a plain unknown word
/// is reported as unknown. A leading space is the escape hatch for sending "/word" as a message,
/// so only the end is trimmed.
pub fn parse(input: &str) -> Option<Parsed<'_>> {
    let rest = input.trim_end_matches(space).strip_prefix('/')?;
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
    let (name, tail) = rest.split_at(end);
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) || !(tail.is_empty() || tail.starts_with(space)) {
        return None;
    }
    Some(match find_command(name) {
        Some(command) => Parsed::Command(command, tail.trim_matches(space)),
        None => Parsed::Unknown(name),
    })
}

/// Commands whose name or alias starts with the typed word, then those that only contain it.
/// An empty word lists everything, in table order.
pub fn match_commands(word: &str) -> Vec<&'static Command> {
    let word = word.to_lowercase();
    let hit = |c: &Command, test: fn(&str, &str) -> bool| test(c.name, &word) || c.aliases.iter().any(|a| test(a, &word));
    let (mut out, rest): (Vec<_>, Vec<_>) = COMMANDS.iter().partition(|c| hit(c, |name, word| name.starts_with(word)));
    out.extend(rest.into_iter().filter(|c| hit(c, |name, word| name.contains(word))));
    out
}

/// One value a command's argument can take: `(value, label, description)`.
pub type Opt<'a> = (&'a str, &'a str, &'a str);

// The lists the web builds in src/app/page.tsx. Models and themes come from the caller.
pub const EFFORT: [Opt<'static>; 5] = [("auto", "Auto", ""), ("none", "None", ""), ("low", "Low", ""), ("high", "High", ""), ("max", "Max", "")];
pub const WEB: [Opt<'static>; 3] = [("auto", "On", "Searches when it needs to"), ("always", "Every message", "Leans towards looking things up"), ("off", "Off", "No web search")];
pub const EXPORT: [Opt<'static>; 4] = [("md", "Markdown", ".md"), ("json", "JSON", ".json"), ("txt", "Plain text", ".txt"), ("html", "Web page", ".html")];

/// What the option commands choose between, and the value in force now (marked "current" in the menu).
/// On the web a model is `(id, label, specs)`, with " · no key" added to the specs when its
/// provider's key is missing, and the theme list ends with `("custom", "Custom", "")`.
#[derive(Clone, Copy, Default)]
pub struct Choices<'a> {
    pub models: &'a [Opt<'a>],
    pub themes: &'a [Opt<'a>],
    pub model: &'a str,
    pub effort: &'a str,
    pub web: &'a str,
    pub theme: &'a str,
}

/// The values a command offers and which one is current. Empty for a command that offers none.
fn options<'a>(cmd: Cmd, choices: &Choices<'a>) -> (&'a [Opt<'a>], &'a str) {
    match cmd {
        Cmd::Model => (choices.models, choices.model),
        Cmd::Effort => (&EFFORT, choices.effort),
        Cmd::Web => (&WEB, choices.web),
        Cmd::Theme => (choices.themes, choices.theme),
        Cmd::Export => (&EXPORT, ""),
        _ => (&[], ""),
    }
}

/// Options filtered by what has been typed, prefix matches first. Value and label both count.
pub fn match_options<'a>(options: &[Opt<'a>], typed: &str) -> Vec<Opt<'a>> {
    let typed = typed.trim_matches(space).to_lowercase();
    let hit = |o: &Opt, test: fn(&str, &str) -> bool| test(&o.0.to_lowercase(), &typed) || test(&o.1.to_lowercase(), &typed);
    let (mut out, rest): (Vec<Opt>, Vec<Opt>) = options.iter().copied().partition(|o| hit(o, |text, typed| text.starts_with(typed)));
    out.extend(rest.into_iter().filter(|o| hit(o, |text, typed| text.contains(typed))));
    out
}

/// The option an argument names: an exact value or label first, else the best partial match.
fn pick<'a>(options: &[Opt<'a>], arg: &str) -> Option<Opt<'a>> {
    let typed = arg.to_lowercase();
    options.iter().find(|o| o.0.to_lowercase() == typed || o.1.to_lowercase() == typed).copied().or_else(|| match_options(options, arg).first().copied())
}

/// One row of the menu above the composer: a command, or a value for a command's argument.
#[derive(Clone, Debug, PartialEq)]
pub struct MenuItem {
    /// "/name", or the option's label.
    pub label: String,
    /// A command's argument hint; for an option, its raw value when the label differs from it. Empty for none.
    pub hint: String,
    pub description: String,
    /// Section name to print above this row (the web shows it in capitals): set on the first row
    /// of each group while a bare "/" lists everything.
    pub header: &'static str,
    /// Composer text after picking this row: "/name", plus a space when the command takes an argument.
    pub insert: String,
    /// A click runs it straight away (`submit(&insert, …)`) and so does Enter, see `enter_runs`.
    /// Unset for commands that need an argument or have choices to show: those only complete.
    pub run: bool,
    /// The option in force now, tagged "current" at the end of its row.
    pub current: bool,
}

/// The menu for the composer text, and its title ("Choose" over a command's options, else none).
/// Empty unless the text is one line starting with "/". The menu is open while this is not empty
/// and Esc was not pressed on this exact text; any edit reopens it and moves the highlight to the top.
pub fn menu(input: &str, choices: &Choices) -> (&'static str, Vec<MenuItem>) {
    let Some(rest) = input.strip_prefix('/').filter(|_| !input.contains('\n')) else { return ("", Vec::new()) };
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len());
    let (word, tail) = rest.split_at(end);
    if tail.is_empty() {
        let mut group = "";
        let row = |c: &'static Command| {
            // Headers only while browsing: a filtered list is ranked, not grouped.
            let header = if word.is_empty() && c.group != group { c.group } else { "" };
            group = c.group;
            let run = !c.arg_required && (c.cmd == Cmd::Export || options(c.cmd, choices).0.is_empty());
            let insert = format!("/{}{}", c.name, if c.args.is_empty() { "" } else { " " });
            MenuItem { label: format!("/{}", c.name), hint: c.args.into(), description: c.description.into(), header, insert, run, current: false }
        };
        return ("", match_commands(word).into_iter().map(row).collect());
    }
    // "/name " and on: the values that command can take, narrowed by what follows.
    let Some(c) = find_command(word).filter(|_| tail.starts_with(space)) else { return ("", Vec::new()) };
    let (offered, current) = options(c.cmd, choices);
    let row = |(value, label, description): Opt| MenuItem {
        label: label.into(),
        hint: if label.to_lowercase() == value.to_lowercase() { String::new() } else { value.into() },
        description: description.into(),
        header: "",
        insert: format!("/{} {value}", c.name),
        run: true,
        current: value == current,
    };
    ("Choose", match_options(offered, tail).into_iter().map(row).collect())
}

/// Whether Enter on the highlighted row runs it rather than only putting `insert` in the composer.
/// A bare "/" only browses: Enter must not fire the first command (compacting costs a model call)
/// just because it is listed first. Tab only ever completes. Up and Down wrap around.
/// The menu's footer: "↑↓ choose", "Tab complete", "Enter run", "Esc close".
pub fn enter_runs(item: &MenuItem, input: &str) -> bool {
    item.run && input != "/"
}

/// What the agent receives for a prompt shortcut. None for every other command.
pub fn expand(cmd: Cmd, arg: &str) -> Option<String> {
    let arg = arg.trim_matches(space);
    let with = |lead: &str, tail: &str| if arg.is_empty() { String::new() } else { format!("{lead}{arg}{tail}") };
    Some(match cmd {
        Cmd::Init => format!(
            "Study this workspace and write AGENTS.md at its root: what the project is, how to install, build, run and test it (exact commands you verified), the layout of the directories that matter, the conventions the code follows, and anything surprising a newcomer would trip on. Keep it short and factual — it is read at the start of every future reply, so every line must earn its place. If AGENTS.md already exists, update it instead of starting over.{}",
            with(" Also cover: ", "")
        ),
        Cmd::Review => format!(
            "Review the code in this workspace for bugs, security problems, missing edge cases and anything that would fail in real use. If it is a git repository, start with the uncommitted changes and recent commits; otherwise start with the files changed in this conversation. Read the code before judging it. Report each finding with file:line, what goes wrong and a concrete input that triggers it, ranked most severe first. Do not change any files.{}",
            with(" Focus on: ", "")
        ),
        Cmd::Test => format!(
            "Find and run this project's tests{}. If none exist, write a small focused test suite for the main behaviour first. For every failure find the root cause and fix the code — change a test only when the test itself is wrong, and say so. Run the tests again until they pass, then report what failed and what you changed.",
            with(" (", ")")
        ),
        Cmd::Fix => format!("Fix this: {arg}\n\nReproduce it first so you know what you are fixing, find the root cause rather than patching the symptom, fix it, then run it again to show it is fixed."),
        Cmd::Explain => format!("Explain {arg} in this workspace: what it does, how it works step by step, and how it connects to the rest of the code. Read the code first and cite file:line. Do not change any files."),
        Cmd::Plan => format!("Plan this task: {arg}\n\nRead what you need to understand it, then call make_plan with concrete steps and how each one will be checked. Do not start implementing — wait for me to say go."),
        Cmd::Commit => format!(
            "Commit the current changes in this workspace's git repository. Look at the diff first, leave out anything that should not be committed (build output, secrets, stray files), and write a clear commit message{}. Then show what was committed.",
            if arg.is_empty() { " that says what changed and why".to_string() } else { format!(" based on: {arg}") }
        ),
        _ => return None,
    })
}

/// What the agent is sent for a message the transcript shows as typed: a prompt shortcut
/// ("/review auth") becomes its full instruction, anything else goes as it is.
pub fn wire(shown: &str) -> std::borrow::Cow<'_, str> {
    match parse(shown) {
        Some(Parsed::Command(c, arg)) => expand(c.cmd, arg).map_or(shown.into(), Into::into),
        _ => shown.into(),
    }
}

/// What a submitted line turns out to be.
#[derive(Clone, Debug, PartialEq)]
pub enum Submit {
    /// Not a command: send the text as an ordinary message.
    Message,
    /// Nothing runs. Show `notice` in the error colour; `input`, when set, replaces the composer text.
    Refused { notice: String, input: Option<String> },
    /// Put `input` in the composer and show the menu again: a bare /model lists its choices
    /// instead of doing nothing, and /help lists every command.
    Reopen { input: String },
    /// A prompt shortcut: send `prompt` to the agent and show `shown` as the message in the transcript.
    Prompt { cmd: Cmd, prompt: String, shown: String },
    /// An option command with its choice resolved: apply `value`, then show `notice` (for Export,
    /// the web's line once the file is on its way).
    Pick { cmd: Cmd, value: String, notice: String },
    /// Every other command, for the UI to perform. `arg` is trimmed, "" when none was given.
    Run { cmd: Cmd, arg: String },
}

fn refused(notice: String) -> Submit {
    Submit::Refused { notice, input: None }
}

/// Decides what a submitted line does, with every check the web makes before a command runs.
/// `running`: a reply is streaming in this chat. `compacting`: this chat is being compacted.
pub fn submit(text: &str, running: bool, compacting: bool, choices: &Choices) -> Submit {
    let (c, arg) = match parse(text) {
        None => return Submit::Message,
        Some(Parsed::Unknown(name)) => return refused(format!("Unknown command /{name}. Type / to see them all — or start with a space to send it as a message.")),
        Some(Parsed::Command(c, arg)) => (c, arg),
    };
    let (name, offered) = (c.name, options(c.cmd, choices).0);
    if c.arg_required && arg.is_empty() {
        return Submit::Refused { notice: format!("/{name} needs {}.", c.args), input: Some(format!("/{name} ")) };
    }
    // "/clear the npm cache and rebuild" is a message, not /clear with its words thrown away.
    if c.args.is_empty() && !arg.is_empty() {
        return refused(format!("/{name} takes nothing after it. To send this as a message, start it with a space."));
    }
    if compacting && (c.kind == Kind::Prompt || matches!(c.cmd, Cmd::Retry | Cmd::Resume | Cmd::Rewind)) {
        return refused("Compacting this chat — one moment.".into());
    }
    if running && !c.while_running {
        return refused("A reply is running — wait for it, or /stop it first.".into());
    }
    if arg.is_empty() && !offered.is_empty() && c.cmd != Cmd::Export {
        return Submit::Reopen { input: format!("/{name} ") };
    }
    if let Some(prompt) = expand(c.cmd, arg) {
        return Submit::Prompt { cmd: c.cmd, prompt, shown: text.trim_matches(space).to_string() };
    }
    if c.cmd == Cmd::Help {
        return Submit::Reopen { input: "/".into() };
    }
    if c.kind != Kind::Options {
        return Submit::Run { cmd: c.cmd, arg: arg.to_string() };
    }
    // A bare /export is Markdown.
    let picked = if arg.is_empty() && c.cmd == Cmd::Export { Some(EXPORT[0]) } else { pick(offered, arg) };
    let Some((value, label, _)) = picked else {
        return refused(match c.cmd {
            Cmd::Theme => format!("No theme called \"{arg}\"."),
            Cmd::Export => "Export as md, json, txt, html.".into(),
            _ => format!("Nothing matches \"{arg}\". Type /{name} to see the choices."),
        });
    };
    let notice = match c.cmd {
        Cmd::Model => format!("Model: {label}"),
        Cmd::Effort => format!("Thinking: {label}"),
        Cmd::Web => format!("Web search: {label}"),
        Cmd::Theme => format!("Theme: {label}"),
        _ => format!("Downloading this chat as {label}."),
    };
    Submit::Pick { cmd: c.cmd, value: value.to_string(), notice }
}

/// "2", "$2.50" or "off" as a spending limit per reply. `Some(None)` removes the limit; `None` is unreadable.
/// "0" is refused rather than read as "no limit": removing the cap has to be explicit.
pub fn parse_budget(arg: &str) -> Option<Option<f64>> {
    let typed = arg.trim_matches(space).to_lowercase();
    if typed == "off" || typed == "none" {
        return Some(None);
    }
    // ponytail: Rust's float syntax, not JS Number(): "0x10" is refused here and 16 on the web. Nobody types a budget in hex.
    typed.strip_prefix('$').unwrap_or(&typed).trim_matches(space).parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0).map(Some)
}

/// `/budget [dollars|off]`: the limit afterwards, whether it worked (false = error colour) and the line to show.
pub fn budget(arg: &str, current: Option<f64>) -> (Option<f64>, bool, String) {
    if arg.trim_matches(space).is_empty() {
        let line = match current {
            None => "No spending limit. Set one with /budget 2 (dollars per reply).".into(),
            Some(limit) => format!("Limit: ${limit} per reply. /budget off removes it."),
        };
        return (current, true, line);
    }
    match parse_budget(arg) {
        None => (current, false, "Give an amount in dollars, like \"/budget 2\", or \"/budget off\".".into()),
        Some(None) => (None, true, "Spending limit removed.".into()),
        Some(Some(limit)) => (Some(limit), true, format!("Each reply now stops at ${limit}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODELS: [Opt; 2] = [("glm-5.3-flash", "GLM 5.3 Flash", "1M context"), ("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "1M context · no key")];
    const THEMES: [Opt; 2] = [("apim", "apiM", ""), ("custom", "Custom", "")];
    const CHOICES: Choices = Choices { models: &MODELS, themes: &THEMES, model: "glm-5.3-flash", effort: "auto", web: "auto", theme: "apim" };

    fn run(text: &str) -> Submit {
        submit(text, false, false, &CHOICES)
    }

    fn notice(outcome: Submit) -> String {
        match outcome {
            Submit::Refused { notice, .. } | Submit::Pick { notice, .. } => notice,
            other => panic!("no notice in {other:?}"),
        }
    }

    #[test]
    fn every_name_and_alias_resolves() {
        let mut names: Vec<&str> = Vec::new();
        for (i, c) in COMMANDS.iter().enumerate() {
            assert_eq!(c.cmd as usize, i, "{} is out of order", c.name);
            for name in std::iter::once(&c.name).chain(c.aliases) {
                assert_eq!(find_command(&name.to_uppercase()).map(|found| found.cmd), Some(c.cmd), "{name}");
                assert!(!names.contains(name), "{name} is used twice");
                names.push(*name);
            }
            assert!(!c.description.is_empty() && c.arg_required == c.args.starts_with('<'), "{}", c.name);
            assert_eq!(c.kind == Kind::Prompt, expand(c.cmd, "x").is_some(), "{}", c.name);
            assert_eq!(c.kind == Kind::Options, !options(c.cmd, &CHOICES).0.is_empty(), "{}", c.name);
        }
        assert_eq!(names.len(), 44);
        let mut groups: Vec<&str> = COMMANDS.iter().map(|c| c.group).collect();
        groups.dedup();
        assert_eq!(groups, ["Context", "Chat", "Agent", "Model", "Workspace", "App"]);
        assert_eq!(find_command("clear").unwrap().name, "new");
    }

    #[test]
    fn parses_a_submitted_line() {
        let command = |text: &'static str| match parse(text) {
            Some(Parsed::Command(c, arg)) => Some((c.name, arg)),
            _ => None,
        };
        assert_eq!(command("/compact keep the API design"), Some(("compact", "keep the API design")));
        assert_eq!(command("/MODEL glm"), Some(("model", "glm")));
        assert_eq!(command("/stop\n"), Some(("stop", "")));
        assert_eq!(command("/fix the login\nit 500s on submit"), Some(("fix", "the login\nit 500s on submit")));
        assert!(matches!(parse("/frobnicate now"), Some(Parsed::Unknown("frobnicate"))));
        // A path, a leading space and ordinary text are all messages.
        for message in ["/home/me/app.py is broken", " /compact", "hello /compact", "/", "/2fa", "/stop!"] {
            assert!(parse(message).is_none(), "{message}");
            assert_eq!(run(message), Submit::Message);
        }
    }

    #[test]
    fn refuses_before_running() {
        assert_eq!(notice(run("/Frob")), "Unknown command /Frob. Type / to see them all — or start with a space to send it as a message.");
        assert_eq!(run("/fix"), Submit::Refused { notice: "/fix needs <problem>.".into(), input: Some("/fix ".into()) });
        assert_eq!(notice(run("/clear the npm cache and rebuild")), "/new takes nothing after it. To send this as a message, start it with a space.");
        assert_eq!(notice(submit("/retry", true, false, &CHOICES)), "A reply is running — wait for it, or /stop it first.");
        for line in ["/review", "/retry", "/continue", "/undo"] {
            assert_eq!(notice(submit(line, false, true, &CHOICES)), "Compacting this chat — one moment.", "{line}");
        }
        // Commands marked for it still work while a reply runs or the chat compacts.
        assert_eq!(submit("/btw use tabs", true, true, &CHOICES), Submit::Run { cmd: Cmd::Btw, arg: "use tabs".into() });
        assert_eq!(run("/find  needle "), Submit::Run { cmd: Cmd::Find, arg: "needle".into() });
    }

    #[test]
    fn prompt_shortcuts_expand() {
        let fix = "Fix this: login 500s\n\nReproduce it first so you know what you are fixing, find the root cause rather than patching the symptom, fix it, then run it again to show it is fixed.";
        assert_eq!(run("/fix  login 500s \n"), Submit::Prompt { cmd: Cmd::Fix, prompt: fix.into(), shown: "/fix  login 500s".into() });
        let text = |cmd, arg| expand(cmd, arg).unwrap();
        assert!(text(Cmd::Init, "").ends_with("update it instead of starting over.") && text(Cmd::Init, "the API").ends_with("starting over. Also cover: the API"));
        assert!(text(Cmd::Review, "").ends_with("Do not change any files.") && text(Cmd::Review, " auth ").ends_with("Do not change any files. Focus on: auth"));
        assert!(text(Cmd::Test, "").starts_with("Find and run this project's tests. If none exist") && text(Cmd::Test, "unit").starts_with("Find and run this project's tests (unit). If"));
        assert!(text(Cmd::Explain, "the cache").starts_with("Explain the cache in this workspace: what it does"));
        assert!(text(Cmd::Plan, "add auth").starts_with("Plan this task: add auth\n\nRead what you need") && text(Cmd::Plan, "x").ends_with("Do not start implementing — wait for me to say go."));
        assert!(text(Cmd::Commit, "").contains("a clear commit message that says what changed and why. Then show what was committed."));
        assert!(text(Cmd::Commit, "fix login").ends_with("a clear commit message based on: fix login. Then show what was committed."));
        assert_eq!(expand(Cmd::Stop, "x"), None);
        // The transcript keeps the short form; the agent gets the instruction. A leading space sends it as typed.
        assert_eq!(wire("/fix login 500s"), fix);
        assert_eq!((wire(" /fix login").as_ref(), wire("/stop").as_ref(), wire("fix /it").as_ref()), (" /fix login", "/stop", "fix /it"));
    }

    #[test]
    fn option_commands_resolve_their_choice() {
        assert_eq!(run("/model"), Submit::Reopen { input: "/model ".into() });
        assert_eq!(run("/help"), Submit::Reopen { input: "/".into() });
        assert_eq!(run("/model deep"), Submit::Pick { cmd: Cmd::Model, value: "deepseek-v4.1-flash".into(), notice: "Model: DeepSeek V4.1 Flash".into() });
        assert_eq!(run("/think HIGH"), Submit::Pick { cmd: Cmd::Effort, value: "high".into(), notice: "Thinking: High".into() });
        // An exact label beats a prefix of another value: "on" is the label of `auto`.
        assert_eq!(run("/web on"), Submit::Pick { cmd: Cmd::Web, value: "auto".into(), notice: "Web search: On".into() });
        assert_eq!(notice(run("/web every")), "Web search: Every message");
        assert_eq!(notice(run("/theme custom")), "Theme: Custom");
        assert_eq!(notice(run("/theme nope")), "No theme called \"nope\".");
        assert_eq!(notice(run("/model zzz")), "Nothing matches \"zzz\". Type /model to see the choices.");
        assert_eq!(run("/export"), Submit::Pick { cmd: Cmd::Export, value: "md".into(), notice: "Downloading this chat as Markdown.".into() });
        assert_eq!(notice(run("/export web")), "Downloading this chat as Web page.");
        assert_eq!(notice(run("/export pdf")), "Export as md, json, txt, html.");
    }

    #[test]
    fn menu_rows() {
        let (title, all) = menu("/", &CHOICES);
        assert_eq!((title, all.len()), ("", COMMANDS.len()));
        let headers: Vec<(&str, &str)> = all.iter().filter(|row| !row.header.is_empty()).map(|row| (row.header, row.label.as_str())).collect();
        assert_eq!(headers, [("Context", "/compact"), ("Chat", "/new"), ("Agent", "/init"), ("Model", "/model"), ("Workspace", "/files"), ("App", "/settings")]);
        assert_eq!((all[0].insert.as_str(), all[0].hint.as_str(), all[0].run, enter_runs(&all[0], "/"), enter_runs(&all[0], "/c")), ("/compact ", "[what to keep]", true, false, true));

        // Prefix matches first, then names that only contain the word; aliases match but the name shows.
        let labels = |input| menu(input, &CHOICES).1.into_iter().map(|row| row.label).collect::<Vec<_>>();
        assert_eq!(labels("/co"), ["/compact", "/context", "/cost", "/resume", "/copy", "/commit", "/settings", "/help"]);
        assert_eq!(labels("/usa"), ["/cost"]);
        assert!(menu("/co", &CHOICES).1.iter().all(|row| row.header.is_empty()));
        // Needing an argument or having choices to show means Enter only completes; /export runs as Markdown.
        let row = |input| menu(input, &CHOICES).1.remove(0);
        assert_eq!((row("/fix").run, row("/fix").insert.as_str()), (false, "/fix "));
        assert_eq!((row("/model").run, row("/export").run, row("/stop").run, row("/stop").insert.as_str()), (false, true, true, "/stop"));

        let (title, models) = menu("/model ", &CHOICES);
        assert_eq!((title, models.len()), ("Choose", 2));
        let glm = MenuItem { label: "GLM 5.3 Flash".into(), hint: "glm-5.3-flash".into(), description: "1M context".into(), header: "", insert: "/model glm-5.3-flash".into(), run: true, current: true };
        assert_eq!(models[0], glm);
        assert_eq!(labels("/MODEL  deep"), ["DeepSeek V4.1 Flash"]);
        // A label that only repeats the value shows no hint, and the insert uses the command's real name.
        let high = row("/think h");
        assert_eq!((high.label.as_str(), high.hint.as_str(), high.insert.as_str(), high.run, high.current), ("High", "", "/effort high", true, false));
        for closed in ["hello", " /model", "/model\n", "/fix it", "/nope x", "/ model", "/model:x"] {
            assert!(menu(closed, &CHOICES).1.is_empty(), "{closed}");
        }
    }

    #[test]
    fn budget_amounts() {
        assert_eq!((parse_budget("$2.50"), parse_budget(" 3 "), parse_budget("OFF"), parse_budget("none")), (Some(Some(2.5)), Some(Some(3.0)), Some(None), Some(None)));
        for unreadable in ["lots", "0", "0.00", "-2", "", "$", "infinity", "nan", "2 dollars"] {
            assert_eq!(parse_budget(unreadable), None, "{unreadable}");
        }
        assert_eq!(budget("", None), (None, true, "No spending limit. Set one with /budget 2 (dollars per reply).".into()));
        assert_eq!(budget("", Some(2.5)), (Some(2.5), true, "Limit: $2.5 per reply. /budget off removes it.".into()));
        assert_eq!(budget("$2", None), (Some(2.0), true, "Each reply now stops at $2.".into()));
        assert_eq!(budget("off", Some(2.0)), (None, true, "Spending limit removed.".into()));
        assert_eq!(budget("lots", Some(2.0)), (Some(2.0), false, "Give an amount in dollars, like \"/budget 2\", or \"/budget off\".".into()));
        assert_eq!(run("/budget $2"), Submit::Run { cmd: Cmd::Budget, arg: "$2".into() });
    }
}
