/**
 * Slash commands typed in the composer.
 *
 * `/name args` on the first line runs a command instead of sending a
 * message. Two kinds:
 *
 *   - actions the app performs itself (compact, switch model, export…),
 *     dispatched by the page, which owns that state;
 *   - prompt shortcuts (/review, /test, /fix…) that expand into a full
 *     instruction for the agent and send it as a normal message, with the
 *     short command shown in the transcript.
 *
 * Pure data and parsing, so the menu, the dispatcher and the tests share
 * one list and cannot drift.
 */

export type SlashGroup = "Context" | "Chat" | "Agent" | "Model" | "Workspace" | "App";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Argument hint shown in the menu, e.g. "[focus]" or "<title>". */
  args?: string;
  /** True when the command does nothing without its argument. */
  argRequired?: boolean;
  description: string;
  group: SlashGroup;
  /** Works while a reply is running (everything else waits for it). */
  whileRunning?: boolean;
  /** Prompt shortcut: the message the agent receives. */
  prompt?: (arg: string) => string;
}

const focus = (arg: string, lead = " Focus on: ") =>
  arg.trim() ? `${lead}${arg.trim()}` : "";

export const SLASH_COMMANDS: SlashCommand[] = [
  // Context
  {
    name: "compact",
    args: "[what to keep]",
    description: "Summarise the conversation so far and send only the summary from now on — frees the context window",
    group: "Context",
  },
  {
    name: "context",
    description: "Show how full the context window is and what is in it",
    group: "Context",
    whileRunning: true,
  },
  {
    name: "cost",
    aliases: ["usage"],
    description: "Show tokens, cost and time spent in this chat",
    group: "Context",
    whileRunning: true,
  },

  // Chat
  { name: "new", aliases: ["clear"], description: "Start a new chat", group: "Chat", whileRunning: true },
  { name: "retry", aliases: ["regenerate"], description: "Answer the last message again", group: "Chat" },
  {
    name: "rewind",
    aliases: ["undo"],
    description: "Go back to before your last message — chat and files — and put its text back in the box",
    group: "Chat",
  },
  {
    name: "resume",
    aliases: ["continue"],
    args: "[instruction]",
    description: "Carry on the interrupted reply, keeping its work",
    group: "Chat",
  },
  { name: "stop", description: "Stop the running reply", group: "Chat", whileRunning: true },
  {
    name: "btw",
    args: "<note>",
    argRequired: true,
    description: "Tell the running task something without stopping it",
    group: "Chat",
    whileRunning: true,
  },
  { name: "copy", description: "Copy the last reply to the clipboard", group: "Chat", whileRunning: true },
  {
    name: "rename",
    args: "<title>",
    argRequired: true,
    description: "Rename this chat",
    group: "Chat",
    whileRunning: true,
  },
  {
    name: "export",
    args: "[md|json|txt|html]",
    description: "Download this chat (Markdown by default)",
    group: "Chat",
    whileRunning: true,
  },
  { name: "archive", description: "Archive this chat", group: "Chat" },
  { name: "delete", description: "Delete this chat", group: "Chat" },
  {
    name: "find",
    args: "[text]",
    description: "Find text in this chat",
    group: "Chat",
    whileRunning: true,
  },
  {
    name: "search",
    description: "Search all chats",
    group: "Chat",
    whileRunning: true,
  },

  // Agent prompt shortcuts
  {
    name: "init",
    description: "Study the workspace and write AGENTS.md — notes the agent reads at the start of every reply",
    group: "Agent",
    prompt: (arg) =>
      "Study this workspace and write AGENTS.md at its root: what the project is, how to install, build, run and test it (exact commands you verified), the layout of the directories that matter, the conventions the code follows, and anything surprising a newcomer would trip on. Keep it short and factual — it is read at the start of every future reply, so every line must earn its place. If AGENTS.md already exists, update it instead of starting over." +
      focus(arg, " Also cover: "),
  },
  {
    name: "review",
    args: "[focus]",
    description: "Review the code for bugs and risks — reports, changes nothing",
    group: "Agent",
    prompt: (arg) =>
      "Review the code in this workspace for bugs, security problems, missing edge cases and anything that would fail in real use. If it is a git repository, start with the uncommitted changes and recent commits; otherwise start with the files changed in this conversation. Read the code before judging it. Report each finding with file:line, what goes wrong and a concrete input that triggers it, ranked most severe first. Do not change any files." +
      focus(arg),
  },
  {
    name: "test",
    args: "[what]",
    description: "Run the tests, fix what fails, run them again",
    group: "Agent",
    prompt: (arg) =>
      "Find and run this project's tests" +
      (arg.trim() ? ` (${arg.trim()})` : "") +
      ". If none exist, write a small focused test suite for the main behaviour first. For every failure find the root cause and fix the code — change a test only when the test itself is wrong, and say so. Run the tests again until they pass, then report what failed and what you changed.",
  },
  {
    name: "fix",
    args: "<problem>",
    argRequired: true,
    description: "Reproduce a problem, fix the root cause, prove it is fixed",
    group: "Agent",
    prompt: (arg) =>
      `Fix this: ${arg.trim()}\n\nReproduce it first so you know what you are fixing, find the root cause rather than patching the symptom, fix it, then run it again to show it is fixed.`,
  },
  {
    name: "explain",
    args: "<file, function or idea>",
    argRequired: true,
    description: "Explain how something in the workspace works",
    group: "Agent",
    prompt: (arg) =>
      `Explain ${arg.trim()} in this workspace: what it does, how it works step by step, and how it connects to the rest of the code. Read the code first and cite file:line. Do not change any files.`,
  },
  {
    name: "plan",
    args: "<task>",
    argRequired: true,
    description: "Explore and make a plan, without starting the work",
    group: "Agent",
    prompt: (arg) =>
      `Plan this task: ${arg.trim()}\n\nRead what you need to understand it, then call make_plan with concrete steps and how each one will be checked. Do not start implementing — wait for me to say go.`,
  },
  {
    name: "commit",
    args: "[message]",
    description: "Commit the workspace changes with git",
    group: "Agent",
    prompt: (arg) =>
      "Commit the current changes in this workspace's git repository. Look at the diff first, leave out anything that should not be committed (build output, secrets, stray files), and write a clear commit message" +
      (arg.trim() ? ` based on: ${arg.trim()}` : " that says what changed and why") +
      ". Then show what was committed.",
  },

  // Model
  {
    name: "model",
    args: "[name]",
    description: "Switch the model",
    group: "Model",
    whileRunning: true,
  },
  {
    name: "effort",
    aliases: ["think"],
    args: "[auto|none|low|high|max]",
    description: "Set how hard it thinks",
    group: "Model",
    whileRunning: true,
  },
  {
    name: "web",
    args: "[off|auto|always]",
    description: "Set web search",
    group: "Model",
    whileRunning: true,
  },
  {
    name: "budget",
    args: "[dollars|off]",
    description: "Set the spending limit per reply",
    group: "Model",
    whileRunning: true,
  },

  // Workspace
  { name: "files", description: "Open the workspace files", group: "Workspace", whileRunning: true },
  { name: "panel", description: "Show or hide the side panel", group: "Workspace", whileRunning: true },

  // App
  { name: "settings", aliases: ["config"], description: "Open Settings", group: "App", whileRunning: true },
  { name: "plugins", description: "Open plugins", group: "App", whileRunning: true },
  { name: "mcp", description: "Open the MCP servers console", group: "App", whileRunning: true },
  {
    name: "theme",
    args: "[name]",
    description: "Switch the colour theme",
    group: "App",
    whileRunning: true,
  },
  { name: "sidebar", description: "Show or hide the chat list", group: "App", whileRunning: true },
  { name: "help", aliases: ["commands"], description: "List every command", group: "App", whileRunning: true },
];

const BY_NAME = new Map<string, SlashCommand>();
for (const c of SLASH_COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) BY_NAME.set(a, c);
}

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export type ParsedSlash =
  | { kind: "command"; command: SlashCommand; arg: string }
  | { kind: "unknown"; name: string };

/**
 * `/name rest` → the command and its argument; null when the text is not a
 * command at all.
 *
 * A first word with another slash in it is a path ("/home/me/app.py is
 * broken"), and so is anything that is not a plain word — those send as
 * ordinary messages. Only a plain unknown word is reported as unknown.
 * A leading space sends any of it as a message.
 */
export function parseSlash(input: string): ParsedSlash | null {
  // No trimming: a leading space is the escape hatch for sending "/word"
  // as an ordinary message.
  const m = /^\/([A-Za-z][\w-]*)(?=\s|$)([\s\S]*)$/.exec(input.trimEnd());
  if (!m) return null;
  const command = findCommand(m[1]);
  if (!command) return { kind: "unknown", name: m[1] };
  return { kind: "command", command, arg: m[2].trim() };
}

/** Commands whose name or alias starts with (then contains) the typed word. */
export function matchCommands(word: string): SlashCommand[] {
  const w = word.toLowerCase();
  if (!w) return SLASH_COMMANDS;
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const c of SLASH_COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])];
    if (names.some((n) => n.startsWith(w))) starts.push(c);
    else if (names.some((n) => n.includes(w))) contains.push(c);
  }
  return [...starts, ...contains];
}

/** A value offered for a command's argument (models, themes, formats…). */
export interface SlashOption {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
}

/** Filter argument options by what has been typed, prefix matches first. */
export function matchOptions(options: SlashOption[], typed: string): SlashOption[] {
  const t = typed.trim().toLowerCase();
  if (!t) return options;
  const starts = options.filter(
    (o) => o.value.toLowerCase().startsWith(t) || o.label.toLowerCase().startsWith(t)
  );
  const rest = options.filter(
    (o) =>
      !starts.includes(o) &&
      (o.value.toLowerCase().includes(t) || o.label.toLowerCase().includes(t))
  );
  return [...starts, ...rest];
}

/** Parse "/budget" amounts: "2", "$2.50", "off". NaN when unreadable. */
export function parseBudget(arg: string): number | null {
  const t = arg.trim().toLowerCase();
  // "0" is refused, not read as "no limit" (found by review: /budget 0
  // removed the cap while "0.00" was an error). Removing it is explicit.
  if (t === "off" || t === "none") return null;
  const n = Number(t.replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 ? n : NaN;
}
