/**
 * The agent gets its own browser. It never touches yours.
 *
 * ## What happened
 *
 * Asked to work on a page, the agent wrote a Playwright script that closed
 * the user's running Thorium browser and launched Chrome with their real
 * profile — the one with their sessions in it — because that is the obvious
 * way to get a logged-in page. It could not be stopped without pressing
 * Enter on a prompt. The user's own work was interrupted by a tool that was
 * supposed to be working alongside them.
 *
 * This is not the classic "malicious code" security problem, and framing it
 * that way misses the point. The script was reasonable, the model was doing
 * what it was asked, nothing was destroyed. The failure is that **an agent's
 * workspace must not overlap with the user's workspace.** A colleague who
 * needed a browser would open their own window, not take over yours.
 *
 * ## What this enforces
 *
 * Three rules, checked before any command runs:
 *
 *   1. **Never kill a browser.** Not the user's, not any. A `taskkill` for
 *      chrome.exe is the single most disruptive thing an automation script
 *      does, and there is no task where it is required.
 *
 *   2. **Never attach to a real profile.** `user-data-dir` pointed at the
 *      default Chrome/Edge/Firefox profile means the agent is driving the
 *      browser the user is logged into. Automation gets its own profile
 *      directory inside the workspace.
 *
 *   3. **Never open a visible window on the user's desktop.** Headless by
 *      default, so a launched browser cannot steal focus mid-sentence.
 *
 * Each rule rewrites the command where a safe equivalent exists, and refuses
 * with an explanation where it does not. Refusing silently would just make
 * the model try something worse — it needs to be told what to do instead.
 */

import path from "node:path";

/** Where an agent-launched browser keeps its profile, inside the workspace. */
export const AGENT_PROFILE_DIR = ".agent-browser";

/**
 * Programs that ARE a browser, or that drive one.
 *
 * Matched loosely because the model may write `chrome`, `google-chrome`,
 * `chrome.exe` or a full path.
 */
const BROWSER_NAMES = [
  "chrome",
  "chromium",
  "msedge",
  "edge",
  "firefox",
  "brave",
  "opera",
  "thorium",
  "safari",
  "iexplore",
];

/** Commands whose entire purpose is to terminate other programs. */
const KILLERS = new Set([
  "taskkill",
  "kill",
  "killall",
  "pkill",
  "wmic",
  "stop-process",
]);

export interface PolicyVerdict {
  /** "allow" unchanged, "rewrite" with fixed args, or "refuse". */
  action: "allow" | "rewrite" | "refuse";
  args: string[];
  /** Shown to the model, and to the user in the approval prompt. */
  reason?: string;
}

function looksLikeBrowser(text: string): boolean {
  const lower = text.toLowerCase();
  return BROWSER_NAMES.some((b) => {
    if (
      lower === b ||
      lower.endsWith(`/${b}`) ||
      lower.endsWith(`\\${b}`) ||
      lower.includes(`${b}.exe`) ||
      lower.includes(`${b}-stable`)
    ) {
      return true;
    }
    /*
     * The name as a whole word anywhere in the argument.
     *
     * Caught by the test: `killall "Google Chrome"` passed every check above,
     * because the macOS process name is two words and matches none of the
     * path or extension shapes. A word-boundary match covers that, and
     * "Brave Browser", "Microsoft Edge" and similar, without matching
     * unrelated words that merely contain the name as a substring.
     */
    return new RegExp(`(^|[^a-z0-9])${b}([^a-z0-9]|$)`).test(lower);
  });
}

/**
 * Does this argument point at a real, human-owned browser profile?
 *
 * The agent's own profile lives inside the workspace, so anything that
 * resolves outside it — `%LOCALAPPDATA%`, `~/Library`, `~/.config` — is the
 * user's.
 */
function isUserProfilePath(value: string): boolean {
  const v = value.toLowerCase().replace(/\\/g, "/");
  if (v.includes(AGENT_PROFILE_DIR)) return false;
  return (
    v.includes("appdata") ||
    v.includes("local/google") ||
    v.includes("library/application support") ||
    v.includes(".config/google-chrome") ||
    v.includes(".config/chromium") ||
    v.includes(".mozilla") ||
    v.includes("user data") ||
    v.includes("/users/") ||
    v.includes("c:/users") ||
    v.includes("default profile") ||
    /(^|\/)profile( ?\d+)?$/.test(v)
  );
}

/**
 * Check one command before it runs.
 *
 * `workspaceDir` is where the agent's own browser profile belongs.
 */
export function checkBrowserPolicy(
  command: string,
  args: string[],
  workspaceDir: string
): PolicyVerdict {
  const cmd = command.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const joined = args.join(" ").toLowerCase();

  // --- Rule 1: never terminate a browser -----------------------------------
  if (KILLERS.has(cmd)) {
    if (args.some((a) => looksLikeBrowser(a)) || looksLikeBrowser(joined)) {
      return {
        action: "refuse",
        args,
        reason:
          "Refused: this would close a browser that is running on the user's " +
          "desktop, which may be in the middle of their own work. You do not " +
          "need to close their browser — launch your own with " +
          "`--headless` and `--user-data-dir=" +
          AGENT_PROFILE_DIR +
          "`, which is a separate profile inside the workspace. If the page " +
          "needs a logged-in session, say so and ask the user rather than " +
          "taking over the browser they are using.",
      };
    }
  }

  // --- Rules 2 and 3: launching a browser ----------------------------------
  const launching =
    looksLikeBrowser(cmd) ||
    // Playwright/Puppeteer CLI paths, e.g. `npx playwright open`.
    (joined.includes("playwright") && joined.includes("open"));

  if (!launching) return { action: "allow", args };

  const next = [...args];
  const notes: string[] = [];

  // A real profile is never acceptable.
  const profileIndex = next.findIndex(
    (a) => a.startsWith("--user-data-dir") || a.startsWith("--profile-directory")
  );
  const agentProfile = path.join(workspaceDir, AGENT_PROFILE_DIR);

  if (profileIndex !== -1) {
    const value = next[profileIndex].includes("=")
      ? next[profileIndex].split("=").slice(1).join("=")
      : (next[profileIndex + 1] ?? "");
    if (isUserProfilePath(value)) {
      return {
        action: "refuse",
        args,
        reason:
          "Refused: that is the user's own browser profile, with their " +
          "logged-in sessions in it. Driving it would interfere with the " +
          "browser they are using. Use `--user-data-dir=" +
          agentProfile +
          "` instead — a separate profile that belongs to this workspace. " +
          "If the task genuinely needs the user to be signed in, stop and " +
          "ask them; do not take their session.",
      };
    }
  } else {
    // No profile given means the default one, which IS the user's.
    next.push(`--user-data-dir=${agentProfile}`);
    notes.push("using the workspace's own browser profile");
  }

  // Headless unless the user explicitly wanted to watch.
  const hasHeadless = next.some(
    (a) => a === "--headless" || a.startsWith("--headless=")
  );
  const wantsVisible = next.some((a) => a === "--headed" || a === "--no-headless");
  if (!hasHeadless && !wantsVisible) {
    next.push("--headless=new");
    notes.push("headless, so it cannot take focus from what the user is doing");
  }

  if (notes.length === 0) return { action: "allow", args };

  return {
    action: "rewrite",
    args: next,
    reason: `Adjusted so the agent's browser stays separate from the user's: ${notes.join(
      "; "
    )}.`,
  };
}

/**
 * The same rules, stated for the model up front.
 *
 * Cheaper than letting it discover them by being refused: a refusal costs a
 * whole round, and a model that has been refused often starts inventing
 * workarounds.
 */
export const BROWSER_POLICY_PROMPT = `
Browser use:
- You have your own browser profile at ${AGENT_PROFILE_DIR}/ inside the workspace. Use it.
- Never close, kill or restart the user's browser. They may be working in it.
- Never launch a browser with the user's real profile (their Chrome/Edge/Firefox user data). It holds their live sessions.
- Run headless unless the user asked to watch it happen.
- If a page needs a logged-in account, stop and ask the user instead of trying to borrow their session.`;
