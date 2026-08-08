/**
 * Guards the design scales.
 *
 * Run:  npm run test:design
 *
 * The interface read as cheap for a reason that turned out to be countable:
 * fourteen font sizes including four half-pixel values, nine corner radii,
 * and eleven transition durations. Two controls that look like siblings would
 * ease at different speeds, or sit on 11.5px next to 12px — differences too
 * small to read as deliberate and too visible to ignore.
 *
 * A scale only stays a scale if adding a value off it fails. That is what
 * this is for: it will not tell anyone whether the app looks good, only
 * whether it is still internally consistent.
 */
import path from "node:path";
import { promises as fs } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");

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

/** Every .tsx under src, with its text. */
async function sources() {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tsx")) {
        out.push({ file: path.relative(ROOT, full), text: await fs.readFile(full, "utf8") });
      }
    }
  }
  await walk(path.join(ROOT, "src"));
  return out;
}

const files = await sources();
const css = await fs.readFile(path.join(ROOT, "src/app/globals.css"), "utf8");
const all = files.map((f) => f.text).join("\n");

/** Which files contain a given pattern, for a useful failure message. */
const where = (re) =>
  files.filter((f) => re.test(f.text)).map((f) => path.basename(f.file));

console.log("\napiM design scale checks\n");

// ------------------------------------------------------------------- type

console.log("1. Type scale");

const TYPE_SCALE = [9, 11, 12, 13, 15, 30];

const sizes = [...all.matchAll(/text-\[([0-9.]+)px\]/g)].map((m) =>
  Number(m[1])
);
const uniqueSizes = [...new Set(sizes)].sort((a, b) => a - b);

check(
  "no half-pixel font sizes",
  uniqueSizes.every((n) => Number.isInteger(n)),
  uniqueSizes.filter((n) => !Number.isInteger(n)).join(", ") ||
    "11.5px beside 12px reads as misalignment, not intent"
);
check(
  "every size is on the scale",
  uniqueSizes.every((n) => TYPE_SCALE.includes(n)),
  uniqueSizes.filter((n) => !TYPE_SCALE.includes(n)).join(", ") ||
    TYPE_SCALE.join(" / ")
);
check(
  "the scale stays small",
  uniqueSizes.length <= TYPE_SCALE.length,
  `${uniqueSizes.length} in use, was 14`
);
check(
  "steps are far enough apart to be deliberate",
  uniqueSizes.every((n, i) => i === 0 || n - uniqueSizes[i - 1] >= 1),
  uniqueSizes.join(" / ")
);

// ----------------------------------------------------------------- radius

console.log("\n2. Radius scale");

const RADIUS_UTILS = ["rounded-lg", "rounded-xl", "rounded-2xl", "rounded-full", "rounded-none"];
const ALLOWED_ARBITRARY = ["rounded-[3px]"]; // search-match highlight

const utils = [...new Set([...all.matchAll(/\brounded-[a-z0-9]+\b/g)].map((m) => m[0]))];
check(
  "only the four named tiers are used",
  utils.every((u) => RADIUS_UTILS.includes(u)),
  utils.filter((u) => !RADIUS_UTILS.includes(u)).join(", ") || utils.join(", ")
);
check(
  "rounded-md is gone",
  !/\brounded-md\b/.test(all),
  "6px and 8px are indistinguishable at these sizes"
);
check(
  "rounded-3xl is gone",
  !/\brounded-3xl\b/.test(all),
  "one large tier, so every big surface matches"
);

const arbitrary = [...new Set([...all.matchAll(/rounded-\[[^\]]+\]/g)].map((m) => m[0]))];
check(
  "no invented radii",
  arbitrary.every((a) => ALLOWED_ARBITRARY.includes(a)),
  arbitrary.filter((a) => !ALLOWED_ARBITRARY.includes(a)).join(", ") ||
    "3px highlight is the only exception, and it is not a shape"
);

const cssRadii = [...new Set([...css.matchAll(/border-radius: (\d+)px/g)].map((m) => Number(m[1])))];
// 1px is the streaming caret, which is 2px wide, and 9999 is a pill. A
// shape scale applies to neither: one is thinner than the smallest radius,
// the other is asking for "fully round" rather than a size.
check(
  "the stylesheet uses the same tiers",
  cssRadii.filter((n) => n > 2 && n < 100).every((n) => [8, 12, 16].includes(n)),
  cssRadii.sort((a, b) => a - b).join(" / ")
);

// ----------------------------------------------------------------- motion

console.log("\n3. Motion");

const cssDurations = [
  ...new Set([...css.matchAll(/([0-9.]+)s (?:ease|cubic-bezier|linear)/g)].map((m) => Number(m[1]))),
].sort((a, b) => a - b);

check(
  "the stylesheet has three timings, not eleven",
  cssDurations.length <= 3,
  cssDurations.map((n) => `${n}s`).join(" / ")
);
check(
  "0.15s for a state the user caused",
  cssDurations.includes(0.15),
  "hover has to feel instant"
);
check(
  "0.3s for something arriving or leaving",
  cssDurations.includes(0.3)
);

const utilDurations = [
  ...new Set([...all.matchAll(/duration-(\d+)/g)].map((m) => Number(m[1]))),
].sort((a, b) => a - b);
check(
  "utility durations match the stylesheet",
  utilDurations.every((n) => [150, 300].includes(n)),
  utilDurations.join(" / ")
);
check(
  "duration-200 is gone",
  !/duration-200/.test(all),
  "it sat between the two tiers for no stated reason"
);

// ------------------------------------------------------------- hover feel

console.log("\n4. Hover stays responsive");

check(
  "chat rows apply hover with no transition",
  /\.conv-row:hover\s*\{[^}]*transition:\s*none/s.test(css),
  "easing hover *in* is what read as latency"
);
check(
  "list rows do the same",
  /\.list-row:hover\s*\{[^}]*transition:\s*none/s.test(css)
);
check(
  "rows still ease on the way out",
  /\.conv-row\s*\{[^}]*transition:\s*background-color/s.test(css),
  "instant-off flickers when moving fast"
);
check(
  "rows carry their own spacing rather than a parent gap",
  /\.conv-row\s*\{[^}]*margin:\s*2px 0/s.test(css),
  "a gap between rows is dead space the highlight falls through"
);

// -------------------------------------------------------------- structure

console.log("\n5. Alignment");

// The four blocks stacked down the sidebar — new chat, tabs, list, settings
// — must share one gutter, or the column reads as ragged. Popovers and
// empty states are separate surfaces and are not part of that column.
const sidebar = files.find((f) => f.file.endsWith("Sidebar.tsx"))?.text ?? "";
const columnGutters = [
  ...new Set(
    [...sidebar.matchAll(/className="flex h-\[56px\][^"]*\bpx-(\d)\b|className="(?:flex-1 )?(?:space-y-1 )?overflow-y-auto px-(\d)|className="px-(\d) pb-2 pt-0\.5"|className="border-t border-border px-(\d)/g)]
      .flatMap((m) => m.slice(1).filter(Boolean))
  ),
];
check(
  "the sidebar column shares one gutter",
  columnGutters.length === 1,
  `px-${columnGutters.join(", px-")} — was px-3 header, px-2 list`
);

check(
  "reduced motion is honoured",
  /@media \(prefers-reduced-motion: reduce\)/.test(css),
  "animation is decoration, not information"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
