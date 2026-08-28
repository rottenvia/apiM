/**
 * Seeing what happened: build diagnosis, log analysis, window capture.
 *
 * Run:  npm run test:observability
 *
 * Three complaints from the retro share one shape — the agent had to guess at
 * something the machine already knew:
 *
 *   1. "first build fails, retry succeeds" and "LNK1104 with no owning
 *      process". A retry armed as a superstition is an undocumented rule, so
 *      the rules are written down in build-diagnostics.ts and checked here:
 *      the flaky classes retry, a real compile error never does, and a lock
 *      names the file plus whoever holds it.
 *   2. "give it pasted console lines and get phase ratios, gain distribution,
 *      crash sequence back". That is logs.ts, and the numbers it prints have
 *      to be arithmetically right, not plausible.
 *   3. "launch this exe, screenshot its window, show me". This sandbox has no
 *      desktop, so what is testable is the part that matters most: it must
 *      fail loudly and never hand back a blank PNG as if it were a window.
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const build = await load("src/lib/build-diagnostics.ts");
const logs = await load("src/lib/logs.ts");
const shots = await load("src/lib/screenshot.ts");

console.log("\napiM observability checks\n");

// ------------------------------------------------------- 1. build diagnosis
console.log("1. A failed build is classified, and only the flaky kinds retry");

const CASES = [
  [
    "MSB4166: Child node \"2\" exited prematurely. Shutting down.",
    "flaky_race",
    true,
  ],
  [
    "fatal error C1041: cannot open program database 'x64\\Release\\vc143.pdb'; " +
      "if multiple CL.EXE write to the same .PDB file, please use /FS",
    "flaky_race",
    true,
  ],
  [
    "LINK : fatal error LNK1318: Unexpected PDB error; OK (0)",
    "flaky_race",
    true,
  ],
  [
    "MSB3021: Unable to copy file \"obj\\app.exe\" to \"bin\\app.exe\". " +
      "The process cannot access the file because it is being used by another process.",
    "locked_file",
    false,
  ],
  [
    "LINK : fatal error LNK1104: cannot open file 'cleanroom_bhop.exe'",
    "locked_file",
    false,
  ],
  [
    "main.cpp(412): error C2065: 'g_hWnd': undeclared identifier",
    "compile_error",
    false,
  ],
  [
    "'msbuild' is not recognized as an internal or external command",
    "missing_toolchain",
    false,
  ],
  [
    "fatal error C1083: There is not enough space on the disk.",
    "out_of_space",
    false,
  ],
];

for (const [output, kind, retryable] of CASES) {
  const dx = build.diagnoseBuildFailure(output);
  check(
    `${kind.padEnd(17)} ${JSON.stringify(output.slice(0, 46))}`,
    dx.kind === kind,
    dx.kind === kind ? dx.rule : `got ${dx.kind}`
  );
  check(
    `  …retryable=${retryable}`,
    dx.retryable === retryable,
    retryable
      ? "a known race; the second attempt is the fix"
      : "retrying this would burn a round and teach the model that failures are noise"
  );
}

check(
  "a compile error is NEVER retried, even next to a flaky-looking line",
  build.diagnoseBuildFailure(
    "MSB4166: Child node \"2\" exited prematurely.\n" +
      "main.cpp(9): error C2143: syntax error: missing ';' before '}'"
  ).retryable === false,
  "a real error present anywhere outranks the race heuristic"
);

const locked = build.diagnoseBuildFailure(
  "LINK : fatal error LNK1104: cannot open file 'cleanroom_bhop.exe'"
);
check(
  "the locked file is named, not just the error code",
  locked.lockedFile === "cleanroom_bhop.exe",
  String(locked.lockedFile)
);
check(
  "and the advice includes the rename gambit that actually works",
  /rename/i.test(locked.advice),
  "delete is denied on a running image; rename is not"
);

const noise = build.diagnoseBuildFailure("Build succeeded.\n0 Error(s)");
check(
  "output with no recognised failure is 'unknown', not a false positive",
  noise.kind === "unknown" && noise.retryable === false,
  noise.rule
);

// ---------------------------------------------------------- 2. lock reports
console.log("\n2. A lock report says who holds the file, or admits it cannot tell");

const report = build.formatLockReport("ws-observability-test", "cleanroom_bhop.exe");
check("the report names the file", /cleanroom_bhop\.exe/.test(report));
check(
  "with no holder found it says 'no holder identified', never 'nothing holds it'",
  /No holder identified/i.test(report) || /Holders:/.test(report),
  "the difference between 'I could not tell' and 'it is free' is the whole point"
);
check(
  "it lists what it probed, so the answer can be judged",
  /probed:/i.test(report) || /Holders:/.test(report)
);
check(
  "and it still gives the fix when nothing was identified",
  /rename/i.test(report),
  "an answer of 'unknown' with no next step is a wasted round"
);

const holders = build.findFileHolders("ws-observability-test", "no-such-file.exe");
check(
  "findFileHolders reports which probes were unavailable",
  Array.isArray(holders.probed) && Array.isArray(holders.unavailable),
  `probed: ${holders.probed.join(", ") || "none"}`
);
check(
  "workspace processes are probed first",
  holders.probed[0] === "workspace processes",
  "the thing holding the exe is usually the exe the agent launched"
);

// ------------------------------------------------------------ 3. log parser
console.log("\n3. The log parser returns arithmetic, not impressions");

const LINES = [];
for (let i = 0; i < 46; i++) {
  LINES.push(`[00:${String(i).padStart(2, "0")}] phase=hop gain=${(i % 10) / 10 + 0.5} dt=${10 + (i % 5)}`);
}
for (let i = 0; i < 9; i++) {
  LINES.push(`[01:${String(i).padStart(2, "0")}] WARN backstop engaged, gain=0.2 dt=99`);
}
LINES.push("[02:00] ERROR Unhandled exception thrown at 0x00401337");
LINES.push("[02:01] FATAL process crashed, exit code -1073741819");
const LOG = LINES.join("\n");

const a = logs.analyzeLog(LOG, { count: ["phase", "backstop"] });

check("every non-empty line is counted", a.counted === 57, `${a.counted} of ${a.lines}`);
check(
  "the requested tokens are counted and turned into a ratio",
  a.requested.find((x) => x.label === "phase")?.count === 46 &&
    a.requested.find((x) => x.label === "backstop")?.count === 9,
  "46 phase, 9 backstop — the exact figures the retro wanted back"
);
check(
  "percentages are shares of the counted lines, and they add up",
  Math.abs(
    a.requested.reduce((sum, x) => sum + x.percent, 0) - 100
  ) < 0.5,
  a.requested.map((x) => `${x.label} ${x.percent}%`).join(" · ")
);

const gain = a.numerics.find((n) => n.key === "gain");
check("numeric key=value fields are discovered without being named", !!gain, gain?.key);
check(
  "the distribution is right, not decorative",
  gain && gain.n === 55 && gain.min === 0.2 && Math.abs(gain.max - 1.4) < 1e-9,
  gain ? `n=${gain.n} min=${gain.min} max=${gain.max} median=${gain.median}` : ""
);
check(
  "median sits between min and max, and p95 above the median",
  gain && gain.median >= gain.min && gain.median <= gain.max && gain.p95 >= gain.median,
  gain ? `median=${gain.median} p95=${gain.p95}` : ""
);

check(
  "levels are counted separately from the requested tokens",
  a.levels.find((l) => l.label === "WARN")?.count === 9 &&
    a.levels.find((l) => l.label === "ERROR")?.count === 1 &&
    a.levels.find((l) => l.label === "FATAL")?.count === 1,
  a.levels.map((l) => `${l.label} ${l.count}`).join(" · ")
);

check(
  "repeated lines collapse into clusters with a frequency",
  a.clusters.length > 0 && a.clusters[0].count >= 9,
  a.clusters[0] ? `${a.clusters[0].count}x ${a.clusters[0].pattern.slice(0, 40)}` : ""
);
check(
  "a cluster carries a real sample line, not just the skeleton",
  a.clusters[0] && LOG.includes(a.clusters[0].sample),
  "the skeleton is for grouping; the sample is what a human reads"
);

check(
  "the crash sequence comes back in order",
  a.faults.length >= 2 &&
    a.faults[0].line < a.faults[1].line &&
    /exception/i.test(a.faults[0].kind + a.faults[0].text),
  a.faults.map((f) => `${f.line}:${f.kind}`).join(" → ")
);
check(
  "a nonzero exit code is a fault; exit code 0 is not",
  logs.analyzeLog("done, exit code 0").faults.length === 0 &&
    logs.analyzeLog("done, exit code 3").faults.length === 1,
  "otherwise every clean run looks like a crash"
);
check(
  "context around the first fault is included, so the sequence reads",
  a.faultContext.length > 0 && a.faultContext.some((l) => /backstop|phase/.test(l)),
  `${a.faultContext.length} line(s) of context`
);

check(
  "skeleton() collapses the variable parts that break grouping",
  logs.skeleton("[00:01] hit 0x004013 at C:\\src\\main.cpp took 12.5ms") ===
    logs.skeleton("[09:44] hit 0xdeadbe at C:\\other\\x.cpp took 0.5ms"),
  "hex, time, path and number all normalise"
);
check(
  "…but two genuinely different lines do not collapse together",
  logs.skeleton("phase=hop gain=1") !== logs.skeleton("phase=air gain=1")
);

const empty = logs.analyzeLog("");
check(
  "an empty log is zeroes, not a crash",
  empty.counted === 0 && empty.faults.length === 0 && empty.numerics.length === 0
);

const text = logs.formatLogAnalysis(a);
check(
  "the formatted report leads with the counts a human would ask for",
  /Levels:/.test(text) && /Counted:/.test(text) && /Ratio phase:backstop/.test(text),
  text.split("\n").find((l) => /Ratio/.test(l))
);
check(
  "…and the numeric distribution is printed with its quantiles",
  /gain: n=55/.test(text) && /median=/.test(text) && /p95=/.test(text)
);

const huge = logs.analyzeLog(
  Array.from({ length: 40 }, (_, i) => `phase=${i} gain=${i}`).join("\n"),
  { count: ["phase"], maxClusters: 3, maxNumerics: 1 }
);
check(
  "the caps are honoured, so a 10k-line log cannot flood the context",
  huge.clusters.length <= 3 && huge.numerics.length <= 1,
  `${huge.clusters.length} cluster(s), ${huge.numerics.length} numeric(s)`
);

// ------------------------------------------------------- 4. window capture
console.log("\n4. Window capture fails honestly on a machine with no desktop");

const tmp = await mkdtemp(path.join(os.tmpdir(), "apim-shot-"));

let res = await shots.captureWindow({ outPath: path.join(tmp, "a.png") });
check(
  "with no title, pid or full_screen it says what to pass",
  !res.ok && /title|pid|full_screen/i.test(res.error),
  res.error
);

res = await shots.captureWindow({
  title: "definitely-not-a-real-window-" + Date.now(),
  outPath: path.join(tmp, "b.png"),
  timeoutMs: 8000,
});
check("a window that is not there is a failure", !res.ok, res.error);
check(
  "the error explains WHY — no display, no backend, or no such window",
  /display|backend|window|X server|screenshot/i.test(res.error || ""),
  res.error
);
check(
  "nothing is left on disk to be mistaken for a screenshot",
  await readFile(path.join(tmp, "b.png")).then(
    () => false,
    () => true
  ),
  "a zero-byte PNG that view_image describes as 'a dark window' is the worst outcome"
);

check(
  "pngSize reads the real dimensions out of a PNG header",
  (() => {
    const png = Buffer.alloc(24);
    png.write("\x89PNG\r\n\x1a\n", 0, "binary");
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(720, 20);
    const size = shots.pngSize(png);
    return size?.width === 1280 && size?.height === 720;
  })(),
  "the report quotes a size, so it must come from the file"
);
check(
  "…and returns null for something that is not a PNG",
  shots.pngSize(Buffer.from("not a png at all")) === null
);

const script = shots.windowsCaptureScript();
check(
  "the Windows path uses PrintWindow, so a covered window still captures",
  /PrintWindow/.test(script),
  "the agent's own background app is usually behind the editor"
);
check(
  "…and falls back to a screen copy for surfaces that refuse it",
  /CopyFromScreen/.test(script)
);
check(
  "the script accepts a pid as well as a title",
  /ProcId/.test(script),
  "a borderless GUI may have no title to match"
);

await rm(tmp, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
if (fail) process.exit(1);
