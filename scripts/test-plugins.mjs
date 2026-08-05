/**
 * Checks that enabled plugins land where they can actually be obeyed.
 *
 * Run:  npm run test:plugins
 *
 * Plugins were reaching the model the whole time — the wiring was never
 * broken. They sat second of four sections, with roughly five thousand
 * characters of workspace rules and file listings after them, and lost every
 * conflict on length and position. These assert the ordering, since that is
 * the part that decides whether a plugin does anything.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const P = await import(pathToFileURL(path.join(ROOT, "src/lib/plugins.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const withEnabled = (...ids) =>
  P.AVAILABLE_PLUGINS.map((p) => ({ ...p, enabled: ids.includes(p.id) }));

console.log("\napiM plugin directive checks\n");

// --------------------------------------------------------------- the block

console.log("1. The directive block");

check(
  "nothing enabled produces nothing at all",
  P.buildPluginDirectives(withEnabled()) === "",
  "the prompt must be byte-identical for anyone not using plugins"
);

const one = P.buildPluginDirectives(withEnabled("caveman"));
check("one enabled plugin produces a block", one.length > 0);
check(
  "the block states that it is the highest priority",
  /HIGHEST PRIORITY/.test(one)
);
check(
  "it says the orders outrank what came before",
  /outrank everything above/i.test(one),
  "a conflict needs a stated winner, not a length contest"
);
check(
  "it applies for the whole conversation, not one reply",
  /every reply for the whole conversation/i.test(one)
);
check(
  "the model is told to apply them silently",
  /Do not announce them/i.test(one),
  "or every reply opens by narrating its own settings"
);
check(
  "the user's newest message can still override",
  /newest message/i.test(one)
);
check(
  "conflicting orders have a deterministic resolution",
  /follow the one listed\s+first/i.test(one)
);
check(
  "the model is told to check its reply against the list",
  /Before you send a reply/i.test(one)
);

// ------------------------------------------------------------- the content

console.log("\n2. What the block contains");

check(
  "the enabled plugin's name appears",
  one.includes("Caveman Mode")
);
check(
  "its instruction text appears",
  one.includes("Answer in as few words")
);
check(
  "the bracket tag is stripped — the list already attributes it",
  !one.includes("[CAVEMAN MODE]")
);

const disabled = P.buildPluginDirectives(withEnabled("caveman"));
check(
  "a plugin that is off does not appear",
  !disabled.includes("Security First"),
  "only Caveman was enabled"
);

const two = P.buildPluginDirectives(withEnabled("caveman", "security"));
check("several enabled plugins all appear", 
  two.includes("Caveman Mode") && two.includes("Security First"));
check(
  "they are listed in a stable order",
  two.indexOf("Caveman Mode") < two.indexOf("Security First"),
  "so 'follow the one listed first' means something"
);

// Every shipped plugin must survive the tag-stripping intact.
let allRendered = true;
for (const plugin of P.AVAILABLE_PLUGINS) {
  const block = P.buildPluginDirectives(withEnabled(plugin.id));
  if (!block.includes(plugin.name) || block.length < 200) allRendered = false;
}
check(
  "every shipped plugin renders into the block",
  allRendered,
  `${P.AVAILABLE_PLUGINS.length} plugins`
);

// ------------------------------------------------------------- positioning

console.log("\n3. Position in the assembled prompt");

// Mirrors how the chat route concatenates the sections.
const searchSummary = "";
const clarify = "";
const workspace =
  "\n\nYou have a workspace on the user's machine and tools to work in it. " +
  "Prefer creating real files over printing code in chat. ".repeat(30);

const assembled =
  P.BASE_PROMPT + searchSummary + clarify + workspace + two;

check(
  "the persona still comes first",
  assembled.indexOf(P.BASE_PROMPT) === 0
);
check(
  "the directives come after the workspace rules",
  assembled.indexOf("HIGHEST PRIORITY") >
    assembled.indexOf("You have a workspace"),
  "whatever sits after several thousand characters is what carries weight"
);
check(
  "the directives are the last thing in the prompt",
  assembled.trimEnd().endsWith("Before you send a reply, check it against the list above."),
  "last position in a system prompt is the strongest"
);

const tailShare =
  (assembled.length - assembled.indexOf("HIGHEST PRIORITY")) / assembled.length;
check(
  "the block is a meaningful share of the prompt, not a footnote",
  tailShare > 0.15,
  `${(tailShare * 100).toFixed(0)}% of the prompt — was about 2%`
);

// ------------------------------------------------- the old blended builder

console.log("\n4. The old builder still works for other callers");

const blended = P.buildSystemPrompt(withEnabled("caveman"));
check(
  "buildSystemPrompt still returns the base with plugins appended",
  blended.startsWith(P.BASE_PROMPT) && blended.includes("Answer in as few words")
);
check(
  "with nothing enabled it returns the base unchanged",
  P.buildSystemPrompt(withEnabled()) === P.BASE_PROMPT
);

// ---------------------------------------------------------------- wording

console.log("\n5. Plugin wording");

const direct = P.AVAILABLE_PLUGINS.find((p) => p.id === "god-mode");
check(
  "the id is unchanged, so saved settings keep working",
  Boolean(direct),
  "renaming the id would silently disable it for existing users"
);
check(
  "it no longer claims the model is unrestricted",
  !/unrestricted/i.test(direct.prompt),
  "that phrasing is the signature of a jailbreak and makes refusals more likely"
);
check(
  "it no longer says never refuse",
  !/never refuse/i.test(direct.prompt)
);
check(
  "it establishes audience and context instead",
  /experienced adult developer/i.test(direct.prompt),
  "which is what actually reduces false refusals"
);

// Vague instructions lose to specific ones, so none should be trivially short.
const tooVague = P.AVAILABLE_PLUGINS.filter((p) => p.prompt.length < 150);
check(
  "no plugin is so short it loses on specificity alone",
  tooVague.length === 0,
  tooVague.map((p) => p.name).join(", ") || "all are concrete"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
