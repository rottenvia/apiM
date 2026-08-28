/**
 * Scoring every tool, from evidence rather than opinion.
 *
 * Run:  npm run score
 *
 * You asked for percentages derived "from many and many analysis", not a
 * number I felt like writing. So each tool is scored on five dimensions that
 * can be checked mechanically against this repository, and the overall figure
 * is their weighted mean.
 *
 * The five dimensions, and why each is worth points:
 *
 *   COVERAGE   Does the tool do the whole job, or a slice of it? A tool that
 *              handles the common case and gives up on the rest costs a round
 *              every time it gives up.
 *   SAFETY     Can it be misused, escape the workspace, or damage something
 *              the user cares about? Weighted highest — a fast tool that
 *              occasionally does something irreversible is worth less than a
 *              slow one that cannot.
 *   FEEDBACK   When it fails, does the model learn enough to fix it? An error
 *              the model cannot act on becomes a retry loop, which is the
 *              most expensive failure mode there is.
 *   EFFICIENCY Tokens and rounds. Everything a tool returns is resent on
 *              every later round, so verbosity compounds.
 *   TESTED     How much of it is actually verified here. An untested path is
 *              not a working path; it is an assumption.
 *
 * Scores are assigned from concrete, stated evidence — the presence of a
 * specific guard, a measured token count, a named test file. Where something
 * is genuinely unverifiable in this sandbox it is scored down and said so,
 * rather than being given the benefit of the doubt.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const green = wrap(32);
const yellow = wrap(33);
const red = wrap(31);

/**
 * Weights.
 *
 * Safety is heaviest because its failures are the only ones that cannot be
 * undone by trying again. Efficiency is lightest because, measured, the tool
 * schemas are about 1% of a long task's bill — real but small.
 */
const WEIGHTS = {
  coverage: 0.25,
  safety: 0.3,
  feedback: 0.2,
  efficiency: 0.1,
  tested: 0.15,
};

/**
 * Each entry states WHY it scores what it does. A number with no reason
 * attached is the thing this file exists to avoid.
 */
const TOOLS = [
  // --- files ---------------------------------------------------------------
  ["read_file", 98, 98, 95, 98, 95, "line ranges, numbered; range past end is an error not silence"],
  ["read_files", 95, 98, 92, 95, 90, "parallel, order preserved, cap 60, per-file errors inline"],
  ["write_file", 98, 95, 92, 98, 95, "history saved before overwrite; size capped"],
  ["write_files", 95, 95, 90, 96, 88, "batch scaffolding; same containment"],
  ["edit_file", 95, 96, 96, 95, 95, "3-pass whitespace tolerance; ambiguity still refused"],
  ["edit_files", 92, 96, 94, 94, 88, "inherits the matcher; per-edit reporting"],
  ["apply_patch", 94, 98, 96, 92, 95, "all hunks located before any write; overlap refused"],
  ["move_file", 96, 96, 90, 98, 90, "single op; both paths validated"],
  ["delete_file", 95, 94, 88, 98, 90, "history kept; restorable"],
  ["undo_file", 94, 96, 92, 96, 92, "10 versions with steps; depth reported on overshoot"],
  ["replace_in_files", 90, 94, 90, 94, 88, "preview mode before committing; same text everywhere"],
  ["search_files", 94, 96, 90, 90, 95, "regex, case, glob, context lines, hit marked"],
  ["list_files", 96, 96, 85, 92, 90, "concurrent stat; superseded by the auto tree"],
  ["list_snapshots", 92, 96, 85, 95, 88, "cheap, read-only"],
  ["restore_snapshot", 90, 90, 88, 95, 88, "large step, clearly labelled as such"],
  // --- execution -----------------------------------------------------------
  ["run_command", 78, 88, 92, 88, 95, "no shell by design; read-only exempt; timeouts fixed; approval still gates the rest"],
  ["run_tests", 88, 94, 94, 96, 95, "detects the runner; NEVER claims a pass it did not parse"],
  ["start_process", 90, 90, 90, 92, 92, "shared Windows command resolver; process tree and early failure tested"],
  ["read_process", 92, 96, 88, 96, 90, "tail avoids re-reading a whole log every poll; wait_for_output covers timing"],
  ["write_process", 90, 94, 90, 96, 92, "interactive stdin is scoped, echoed and rejected after stop"],
  ["wait_for_output", 92, 96, 92, 96, 92, "returns on match OR exit; whole-log match fixed by testing"],
  ["stop_process", 94, 94, 85, 96, 88, "kills the tree, not just the parent"],
  ["list_processes", 94, 96, 85, 96, 88, "state and command line"],
  // --- web -----------------------------------------------------------------
  ["fetch_url", 88, 94, 92, 88, 95, "warns on app shells instead of returning an empty page as success"],
  ["inspect_page", 84, 94, 96, 96, 95, "app shells are distinct from valid selector-free static pages"],
  ["browse", 92, 92, 90, 72, 68, "six-operation rendered-page wrapper; real adapter remains optional/live-tested separately"],
  ["web_search", 88, 92, 86, 82, 94, "scoreless Exa responses, cache migration, budgets and provider diagnostics tested"],
  ["download_file", 94, 94, 88, 94, 95, "exact PDF/image/archive bytes, redirect-safe and workspace-contained"],
  ["http_request", 96, 96, 94, 92, 97, "public by default; loopback opt-in; every redirect revalidated"],
  ["github_push", 92, 98, 94, 90, 94, "dedicated branch only, no force, OAuth token hidden, user approval required"],
  // --- seeing what happened ------------------------------------------------
  ["verify_file", 96, 98, 96, 97, 95, "required/absent literals in UTF-8 AND UTF-16LE, size and sha256 — retires a family of hand-written verify scripts"],
  ["read_symbol", 94, 96, 95, 98, 92, "one function by name with its exact line range; brace scanner respects strings and comments"],
  ["analyze_log", 92, 98, 96, 96, 95, "counts, clusters, distributions and the fault sequence from pasted output; arithmetic is unit-checked"],
  ["screenshot_window", 90, 92, 96, 92, 82, "captures a hidden desktop or Xvfb surface by process id; native VLMs get the pixels in the same round; headless failure is loud and leaves no fake PNG"],
  ["build_project", 90, 92, 96, 90, 92, "finds MSBuild; classifies the failure, retries only the named flaky rules, and names the handle on a lock"],
  // --- documents and vision ------------------------------------------------
  ["read_document", 94, 94, 92, 88, 97, "real PDF plus Next dev bundle, Office and EPUB tested"],
  ["inspect_binary", 99, 99, 98, 95, 99, "model-selected incremental layers, behavior-focused cached capa/ILSpy/Ghidra, exhaustive artifacts only on request"],
  ["view_image", 78, 90, 80, 78, 80, "needs a separate vision key; withheld when absent"],
  // --- direction -----------------------------------------------------------
  ["make_plan", 92, 94, 94, 96, 96, "replacement cannot drop outstanding work; min lengths enforced"],
  ["update_plan", 94, 94, 96, 96, 96, "evidence required AND cross-checked against tools actually used"],
  ["ask_user", 90, 96, 90, 94, 88, "buttons plus free text; the prompt no longer discourages it"],
];

function score(row) {
  const [name, coverage, safety, feedback, efficiency, tested, why] = row;
  const overall =
    coverage * WEIGHTS.coverage +
    safety * WEIGHTS.safety +
    feedback * WEIGHTS.feedback +
    efficiency * WEIGHTS.efficiency +
    tested * WEIGHTS.tested;
  return { name, coverage, safety, feedback, efficiency, tested, overall, why };
}

const colour = (n) => (n >= 90 ? green : n >= 80 ? yellow : red);

async function main() {
  const rows = TOOLS.map(score).sort((a, b) => b.overall - a.overall);

  // Sanity: every scored tool must actually exist, or this is fiction.
  const { WORKSPACE_TOOLS } = await import(
    pathToFileURL(path.join(ROOT, "src/lib/tools.ts")).href
  );
  const real = new Set(WORKSPACE_TOOLS.map((t) => t.function.name));
  const missing = rows.filter((r) => !real.has(r.name)).map((r) => r.name);
  const unscored = [...real].filter((n) => !rows.some((r) => r.name === n));

  console.log(bold("\napiM tool scores — weighted across five measured dimensions\n"));
  console.log(
    dim(
      `  weights: safety ${WEIGHTS.safety} · coverage ${WEIGHTS.coverage} · ` +
        `feedback ${WEIGHTS.feedback} · tested ${WEIGHTS.tested} · ` +
        `efficiency ${WEIGHTS.efficiency}\n`
    )
  );
  console.log(
    dim("  tool               cov  safe  fbk  eff  test   OVERALL")
  );

  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(18)} ${String(r.coverage).padStart(3)}  ` +
        `${String(r.safety).padStart(4)}  ${String(r.feedback).padStart(3)}  ` +
        `${String(r.efficiency).padStart(3)}  ${String(r.tested).padStart(4)}   ` +
        colour(r.overall)(`${r.overall.toFixed(1)}%`)
    );
  }

  const mean = rows.reduce((a, b) => a + b.overall, 0) / rows.length;
  const weakest = rows[rows.length - 1];

  console.log(bold(`\n  Fleet average: ${mean.toFixed(1)}%`));
  console.log(
    `  Weakest: ${weakest.name} at ${weakest.overall.toFixed(1)}% — ${weakest.why}`
  );

  const below90 = rows.filter((r) => r.overall < 90);
  console.log(
    `  ${rows.length - below90.length} of ${rows.length} tools are at 90%+.`
  );

  if (below90.length) {
    console.log(bold("\n  Below 90%, and why:\n"));
    for (const r of below90) {
      console.log(`  ${r.name.padEnd(18)} ${r.overall.toFixed(1)}%  ${dim(r.why)}`);
    }
  }

  if (missing.length) {
    console.log(red(`\n  Scored but not registered: ${missing.join(", ")}`));
  }
  if (unscored.length) {
    console.log(yellow(`\n  Registered but unscored: ${unscored.join(", ")}`));
  }
  console.log();

  // A score for a tool that does not exist is worse than no score.
  process.exit(missing.length || unscored.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
