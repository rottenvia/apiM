/**
 * The agent's browser is not the user's browser.
 *
 * Run:  npm run test:agentsafety
 *
 * Every check here comes from one reported incident. Asked to work on a page,
 * the agent closed the user's running Thorium browser and launched Chrome
 * with their real profile — the one holding their logged-in sessions — and it
 * could not be stopped without answering a prompt.
 *
 * Worth being precise about what went wrong, because the obvious framing is
 * the wrong one. This was not malicious code and not a security breach. The
 * script was a reasonable way to get a logged-in page. The failure is that
 * the agent's workspace overlapped the user's: a colleague who needed a
 * browser would open their own window, not take over yours.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const policy = await load("src/lib/browser-policy.ts");
const runner = await load("src/lib/runner.ts");
const diag = await load("src/lib/diagnostics.ts");

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

const WS = "/tmp/ws";

console.log("\napiM agent-safety checks\n");

console.log("1. It cannot close the user's browser");

for (const [cmd, args] of [
  ["taskkill", ["/F", "/IM", "chrome.exe"]],
  ["taskkill", ["/F", "/IM", "thorium.exe"]],
  ["pkill", ["firefox"]],
  ["killall", ["Google Chrome"]],
]) {
  const v = policy.checkBrowserPolicy(cmd, args, WS);
  check(
    `${cmd} ${args.join(" ")} is refused`,
    v.action === "refuse",
    v.action === "refuse" ? "" : `got ${v.action}`
  );
}

const killVerdict = policy.checkBrowserPolicy("taskkill", ["/IM", "chrome.exe"], WS);
check(
  "the refusal explains what to do instead",
  /user-data-dir/.test(killVerdict.reason ?? "") &&
    /headless/.test(killVerdict.reason ?? ""),
  "a bare refusal makes the model invent a workaround"
);
check(
  "it says to ask rather than borrow a session",
  /ask the user/i.test(killVerdict.reason ?? "")
);

// Killing something that is not a browser is ordinary work.
const killNode = policy.checkBrowserPolicy("pkill", ["node"], WS);
check(
  "killing a non-browser process is still allowed",
  killNode.action === "allow",
  "this guard is about the user's browser, not about processes in general"
);

console.log("\n2. It cannot drive the user's real profile");

const realProfiles = [
  "--user-data-dir=C:\\Users\\Marsel\\AppData\\Local\\Google\\Chrome\\User Data",
  "--user-data-dir=/home/marsel/.config/google-chrome",
  "--user-data-dir=/Users/marsel/Library/Application Support/Google/Chrome",
];
for (const arg of realProfiles) {
  const v = policy.checkBrowserPolicy("chrome", [arg], WS);
  check(
    `refuses ${arg.slice(16, 46)}…`,
    v.action === "refuse",
    v.action === "refuse" ? "" : `got ${v.action}`
  );
}

const ownProfile = policy.checkBrowserPolicy(
  "chrome",
  [`--user-data-dir=${WS}/${policy.AGENT_PROFILE_DIR}`, "--headless=new"],
  WS
);
check(
  "its own workspace profile is allowed",
  ownProfile.action === "allow",
  "the agent must still be able to use a browser"
);

console.log("\n3. A bare launch is made safe rather than refused");

const bare = policy.checkBrowserPolicy("chrome", ["https://example.com"], WS);
check("a plain launch is rewritten, not blocked", bare.action === "rewrite");
check(
  "it is given its own profile",
  bare.args.some((a) => a.includes(policy.AGENT_PROFILE_DIR)),
  "no --user-data-dir means the DEFAULT profile, which is the user's"
);
check(
  "it is made headless",
  bare.args.some((a) => a.startsWith("--headless")),
  "a visible window steals focus from what the user is doing"
);
check("the original URL survives", bare.args.includes("https://example.com"));
check(
  "the change is explained",
  Boolean(bare.reason && bare.reason.length > 20),
  bare.reason ?? ""
);

const headed = policy.checkBrowserPolicy(
  "chrome",
  ["--headed", `--user-data-dir=${WS}/${policy.AGENT_PROFILE_DIR}`],
  WS
);
check(
  "an explicit --headed is respected",
  !headed.args.some((a) => a.startsWith("--headless")),
  "watching it happen is a legitimate thing to ask for"
);

console.log("\n4. The rule is enforced on every path, not just one");

const viaRunner = runner.validateCommand("node", ["-e", "1"], WS);
check("ordinary commands still pass", viaRunner.ok === true);

// validateCommand is the single choke point for run_command, start_process
// and the runner, so the policy applied there covers all three.
const src = await (await import("node:fs/promises")).readFile(
  path.join(ROOT, "src/lib/runner.ts"),
  "utf8"
);
check(
  "the policy runs inside validateCommand",
  /checkBrowserPolicy\(/.test(src),
  "one choke point instead of three call sites that can drift apart"
);

const procSrc = await (await import("node:fs/promises")).readFile(
  path.join(ROOT, "src/lib/processes.ts"),
  "utf8"
);
check(
  "start_process passes the workspace directory",
  /validateCommand\(command, args, workspaceDirectory\(workspaceId\)\)/.test(procSrc),
  "a background browser is the worst case — it outlives the round"
);

const routeSrc = await (await import("node:fs/promises")).readFile(
  path.join(ROOT, "src/app/api/chat/route.ts"),
  "utf8"
);
check(
  "the model is told the rules up front",
  /BROWSER_POLICY_PROMPT/.test(routeSrc),
  "a refusal costs a whole round; telling it first costs ~60 tokens once"
);

console.log("\n5. Problems are recorded so they can be fixed");

await diag.clearDiagnostics();
await diag.record({
  kind: "tool_failed",
  subject: "run_command",
  detail: "Failed: npm install",
});
await diag.record({
  kind: "tool_failed",
  subject: "run_command",
  detail: "Failed: npm install again",
});
await diag.record({
  kind: "browser_blocked",
  subject: "taskkill",
  detail: "Refused: would close the user's browser",
});

const entries = await diag.readDiagnostics();
check("events are written", entries.length === 3);

const groups = diag.summarise(entries);
check("repeats are grouped", groups[0].count === 2, `${groups[0].subject}`);
check(
  "the most frequent comes first",
  groups[0].subject === "run_command",
  "the thing happening most is nearly always what to fix first"
);
check(
  "the newest example is kept",
  groups[0].example.includes("again"),
  "the latest wording is usually the clearest"
);

await diag.record({
  kind: "api_error",
  subject: "auth",
  detail: "Bearer sk-abcdef1234567890 was rejected",
});
const scrubbed = (await diag.readDiagnostics()).find((e) => e.kind === "api_error");
check(
  "keys are stripped before writing",
  !scrubbed.detail.includes("sk-abcdef1234567890"),
  scrubbed.detail
);

const md = diag.renderReport(await diag.readDiagnostics());
check("the report renders as Markdown", md.startsWith("# apiM diagnostics"));
check("it counts the events", /4 events recorded/.test(md), md.split("\n")[2]);
check("it groups them in a table", md.includes("| # | What |"));
check("it says nothing leaves the machine", /leaves your\s+machine/.test(md));

await diag.clearDiagnostics();
check("clearing works", (await diag.readDiagnostics()).length === 0);
check(
  "an empty report is still readable",
  diag.renderReport([]).includes("Nothing recorded"),
  "an empty state is not an error state"
);

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);
