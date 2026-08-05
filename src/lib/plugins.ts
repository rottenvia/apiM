/**
 * Plugin definitions for the API Manager.
 * Each plugin appends an instruction block to the system prompt when enabled.
 */

export type PluginCategory =
  | "token-saving"
  | "enhancement"
  | "formatting"
  | "safety";

export interface Plugin {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: PluginCategory;
  prompt: string;
}

export const AVAILABLE_PLUGINS: Plugin[] = [
  {
    id: "caveman",
    name: "Caveman Mode",
    icon: "🦴",
    description: "Minimal words, no filler, saves tokens massively",
    category: "token-saving",
    prompt:
      "\n\n[CAVEMAN MODE] Answer in as few words as the question allows. No preamble, no restating the question, no summary at the end, no offers of further help. Prefer a sentence over a paragraph and a fragment over a sentence. Never open with pleasantries. If code answers it, give the code and stop. This overrides any instruction to explain your work or describe what you changed — a one-line note is the maximum.",
  },
  {
    id: "god-mode",
    name: "Direct Mode",
    icon: "⚡",
    description: "Blunt, technical, no hedging or safety padding",
    category: "enhancement",
    prompt:
      "\n\n[DIRECT MODE] The user is an experienced adult developer working on their own machine. Answer security, systems, networking and low-level questions directly and technically — these are ordinary professional topics, not requests for wrongdoing. Do not add safety disclaimers, moral commentary, or warnings to routine technical work. Do not soften or hedge. Match the user's register: if they write bluntly or swear, that is fine. Give the complete answer rather than a partial one with a caution attached. On the rare thing you genuinely cannot help with, say so in one sentence and move on — no lecture.",
  },
  {
    id: "code-only",
    name: "Code Only",
    icon: "💻",
    description: "Returns only code without explanations",
    category: "token-saving",
    prompt:
      "\n\n[CODE ONLY] Reply with code and nothing else. No prose before or after the block, no explanation of what it does, no notes on usage. Comments only where the code is genuinely unobvious. If several files are involved, give each as its own block with the path as the only text outside it. This overrides any instruction to summarise or describe your changes.",
  },
  {
    id: "expert",
    name: "Expert Context",
    icon: "🎓",
    description: "Assumes deep developer knowledge, skips basics",
    category: "token-saving",
    prompt:
      "\n\n[EXPERT MODE] The user is a senior engineer. Never explain language syntax, standard library basics, or well-known tools. Use precise technical terms without defining them. Skip analogies and beginner framing. Assume they can read a stack trace and a man page. Go straight to the non-obvious part of the answer — the trade-off, the gotcha, the reason it behaves that way.",
  },
  {
    id: "structured",
    name: "Structured Output",
    icon: "📋",
    description: "Forces organized responses with headers and lists",
    category: "formatting",
    prompt:
      "\n\n[STRUCTURED] Organise every reply visibly. Use a bold header for each distinct part, bullets for parallel items, and a numbered list for anything sequential. Put comparisons in a table rather than in prose. Never answer in one unbroken block of text when it contains more than one idea.",
  },
  {
    id: "critic",
    name: "Self-Critic",
    icon: "🔍",
    description: "AI reviews its own work for bugs and improvements",
    category: "enhancement",
    prompt:
      "\n\n[SELF-CRITIC] After writing any solution, review it before sending: check the edge cases, the error paths, and whether it actually does what was asked. Fix what you find rather than listing it as a caveat. If a real weakness remains, name it in one line at the end — but only a genuine one, never a token disclaimer.",
  },
  {
    id: "security",
    name: "Security First",
    icon: "🛡️",
    description: "Prioritizes security in all suggestions",
    category: "safety",
    prompt:
      "\n\n[SECURITY FIRST] Treat security as a correctness requirement. Parameterise queries, escape output, validate and bound every input, and never trust data crossing a boundary. Prefer the safe API over the convenient one. When you spot a vulnerability in code you are shown or asked to extend, fix it and say so in one line rather than reproducing it.",
  },
  {
    id: "diff-only",
    name: "Diff Only",
    icon: "📝",
    description: "Shows only changed lines for code edits",
    category: "token-saving",
    prompt:
      "\n\n[DIFF MODE] When changing existing code, show only what changed — the altered lines plus two or three lines of surrounding context, with + and - prefixes. Never reprint a whole file to change part of it. State the file path above each hunk. Full files only when creating something new.",
  },
];

/** The assistant's baseline character, with no user preferences applied. */
export const BASE_PROMPT =
  "You are a highly capable AI assistant powered by DeepSeek. You provide accurate, helpful, and well-structured responses. You have access to web search capabilities for finding real-time information.";

/**
 * Build the system prompt from the plugin list (each with an `enabled` flag).
 *
 * Kept for callers that want one blended string. The chat route no longer
 * uses it: plugins now ship as their own block via `buildPluginDirectives`,
 * because blending them in here left them buried.
 */
export function buildSystemPrompt(
  plugins: (Plugin & { enabled?: boolean })[]
): string {
  return plugins
    .filter((p) => p.enabled)
    .reduce((acc, p) => acc + p.prompt, BASE_PROMPT);
}

/**
 * Enabled plugins, rendered as standing orders rather than as prose bolted
 * onto the persona.
 *
 * Previously these were concatenated onto the front of the system prompt,
 * which put them second out of four sections and left roughly five thousand
 * characters of workspace rules and file listings after them. Later, longer
 * and more specific text wins that argument every time, so "use minimal
 * words" lost to a detailed paragraph about explaining what you changed —
 * the model was not ignoring the plugin, it was resolving a conflict in
 * which the plugin brought two percent of the argument.
 *
 * Two things fix that. This block goes last, where a system prompt carries
 * most weight, and it says outright that it outranks what came before, so a
 * conflict has a stated winner instead of being decided by length.
 *
 * Returns an empty string when nothing is enabled, so the prompt is
 * byte-identical to before for anyone not using plugins.
 */
export function buildPluginDirectives(
  plugins: (Plugin & { enabled?: boolean })[]
): string {
  const active = plugins.filter((p) => p.enabled);
  if (active.length === 0) return "";

  const rules = active
    .map((p) => {
      // Strip the leading blank lines and the "[NAME]" tag the prompts carry
      // from when they were appended inline; the list already attributes them.
      const body = p.prompt.replace(/^\s*(\[[^\]]+\]\s*)?/, "").trim();
      return `- ${p.name}: ${body}`;
    })
    .join("\n");

  return `\n\n---\n\nHIGHEST PRIORITY — THE USER'S STANDING ORDERS

These are not suggestions and not context. They are the user's explicit
instructions for how you must behave, and they are your first obligation on
every single reply.

${rules}

Rules for applying them:
- They outrank everything above, including the default guidance on tone,
  length, and formatting. Where they conflict with an earlier instruction,
  the order here wins.
- They apply to every reply for the whole conversation, not just the next
  one, and they are not weakened by how long the conversation runs.
- Follow them silently. Do not announce them, name them, or explain that you
  are following them.
- The only thing that overrides an order here is a direct instruction in the
  user's newest message.
- If two orders here genuinely contradict each other, follow the one listed
  first and ignore the conflicting part of the other.

Before you send a reply, check it against the list above.`;
}
