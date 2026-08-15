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

/*
 * Side-specific corners are part of the same scale, not a new tier.
 *
 * A split button (Resume | v) needs `rounded-lg rounded-r-none` on its left
 * half — that is still one radius value, just not applied to all four
 * corners. The pattern matched `rounded-r` out of `rounded-r-none` and
 * reported it as an unknown tier, which is a false positive: the rule this
 * check exists to enforce is "one size", and the size is unchanged.
 *
 * Side suffixes are therefore normalised away before comparing, so a genuine
 * new size (rounded-md, rounded-3xl) is still caught.
 */
const utils = [
  ...new Set(
    [...all.matchAll(/\brounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e))?-[a-z0-9]+\b/g)]
      .map((m) => m[0].replace(/^rounded-(?:t|b|l|r|tl|tr|bl|br|s|e)-/, "rounded-"))
  ),
];
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

// Dialogs
//
// The chat-search panel was inset from the left by the sidebar width and
// padded 32px on the right against 16px on the left, so it sat left of
// centre and moved sideways when the sidebar was toggled. Asymmetric
// padding on a centred box is the specific mistake worth catching.
const dialogs = files.filter((f) =>
  /(SearchModal|SettingsModal|PluginsModal|DeleteChatDialog)\.tsx$/.test(f.file)
);

check(
  "every dialog centres in the window",
  dialogs.every((f) => /fixed inset-0[^"]*justify-center/.test(f.text)),
  dialogs
    .filter((f) => !/fixed inset-0[^"]*justify-center/.test(f.text))
    .map((f) => path.basename(f.file))
    .join(", ") || `${dialogs.length} dialogs`
);

check(
  "no dialog pads one side more than the other",
  dialogs.every(
    (f) => !/fixed inset-[0y][^"]*\b(pr|pl)-\d/.test(f.text)
  ),
  dialogs
    .filter((f) => /fixed inset-[0y][^"]*\b(pr|pl)-\d/.test(f.text))
    .map((f) => path.basename(f.file))
    .join(", ") || "a centred box with uneven padding is not centred"
);

check(
  "no dialog is offset by the sidebar",
  dialogs.every((f) => !/style=\{\{ left:/.test(f.text)),
  "otherwise it shifts sideways when the sidebar toggles"
);

const dialogWidths = [
  ...new Set(
    dialogs
      .flatMap((f) => [...f.text.matchAll(/max-w-(\w+)/g)].map((m) => m[1]))
      .filter((w) => /^\d?xl$|^(sm|md|lg)$/.test(w))
  ),
];
check(
  "the main dialogs share one width",
  dialogWidths.length <= 1,
  dialogWidths.map((w) => `max-w-${w}`).join(", ") ||
    "search was max-w-4xl while settings and plugins were max-w-2xl"
);

// A tabbed dialog sized with max-h is one height for a short tab and
// another for a tall one. Because it is centred, the top edge moves with
// it — so the rail you are aiming at slides away between looking and
// clicking. Fixed height, content scrolls inside.
const tabbed = files.filter((f) =>
  /(SettingsModal|PluginsModal)\.tsx$/.test(f.file)
);

check(
  "tabbed dialogs have a fixed height",
  tabbed.every((f) => /className="relative flex h-\[min\(/.test(f.text)),
  tabbed
    .filter((f) => !/className="relative flex h-\[min\(/.test(f.text))
    .map((f) => path.basename(f.file))
    .join(", ") || "so switching tabs cannot resize the window"
);

check(
  "they no longer size themselves with max-h",
  tabbed.every((f) => !/className="relative flex max-h-\[/.test(f.text)),
  "max-h is a maximum, not a height"
);

check(
  "their scroll areas can actually shrink",
  tabbed.every((f) =>
    [...f.text.matchAll(/className="([^"]*\bflex-1[^"]*overflow-y-auto[^"]*)"/g)].every(
      (m) => m[1].includes("min-h-0")
    )
  ),
  "a flex child without min-h-0 overflows instead of scrolling"
);

check(
  "switching tabs does not animate the content",
  !/key=\{tab\}[\s\S]{0,120}animate-fade-in/.test(
    files.find((f) => f.file.endsWith("SettingsModal.tsx"))?.text ?? ""
  ),
  "sliding the body 8px per switch makes a stable frame feel unstable"
);

// The workspace
//
// The panel showed a progress bar against 128MB and 10,000 files, which are
// a hosted service's numbers. Everything lives on the user's own disk, so a
// bar creeping toward a limit that does not exist is worse than none.
const wsPanel =
  files.find((f) => f.file.endsWith("WorkspaceSidePanel.tsx"))?.text ?? "";

check(
  "the workspace panel shows no invented capacity",
  !/CAPACITY_BYTES|CAPACITY_FILES/.test(wsPanel),
  "there is no quota to fill"
);
check(
  "and no progress bar against one",
  !/usedPercent/.test(wsPanel)
);
check(
  "its header matches the other two columns at 56px",
  /h-\[56px\]/.test(wsPanel),
  "sidebar, chat and workspace share one header height"
);

const chatArea = files.find((f) => f.file.endsWith("ChatArea.tsx"))?.text ?? "";
check(
  "the workspace has no on/off toggle",
  !/WorkspaceToggle/.test(chatArea),
  "it is always on, so the control had one position"
);

// Tool activity and the split view
const toolActivity =
  files.find((f) => f.file.endsWith("ToolActivity.tsx"))?.text ?? "";
const timeline =
  files.find((f) => f.file.endsWith("MessageTimeline.tsx"))?.text ?? "";

check(
  "an expanded step collapses when the next one starts",
  /runningCount > lastRunning\.current/.test(toolActivity),
  "otherwise stale panels accumulate until the reply is unreadable"
);
check(
  "commands can be inspected, not just writes",
  /parsed\.command === "string"/.test(toolActivity),
  "the one thing most worth seeing was the only thing hidden"
);
check(
  "the split has a real divider column",
  /w-px self-stretch bg-border/.test(timeline),
  "a border on the prose stops at the shorter side"
);
check(
  "the divider is hidden where the layout stacks",
  /hidden w-px[^"]*md:block/.test(timeline),
  "a vertical rule across stacked content is just a line through it"
);
check(
  "the first tool row has no ornamental page-break line",
  !/h-px w-full[^"]*bg-border/.test(timeline) &&
    /i > 0 \? "mt-4 border-t/.test(timeline),
  "the reported screenshot showed that line as the only thing where thinking belonged"
);

// Attachment progress
const chips = files.find((f) => f.file.endsWith("AttachmentChips.tsx"))?.text ?? "";
const chatArea2 = files.find((f) => f.file.endsWith("ChatArea.tsx"))?.text ?? "";

check(
  "a chip appears before the file has been read",
  /id: `pending-/.test(chatArea2),
  "otherwise dropping a large zip looks like nothing happened"
);
check(
  "the chip says which stage it is at",
  /STAGE_LABELS\[file\.stage\]/.test(chips),
  "'loading' for both unpacking and extracting tells the user nothing"
);
check(
  "there is a spinner, not just text",
  /animate-spin/.test(chips)
);

// A placeholder that is never replaced spins forever, which is worse than
// having shown nothing at all.
check(
  "the file-count cap is not read out of a state updater",
  !/let room = 0;[\s\S]{0,200}setAttachments\(\(prev\) => \{[\s\S]{0,120}room =/.test(
    chatArea2
  ),
  "React defers the updater, so the value read afterwards is still the initial one"
);
check(
  "a reader that throws cannot strand its placeholder",
  /catch \(e\)[\s\S]{0,300}Couldn't read/.test(chatArea2),
  "the chip is removed on failure rather than left spinning"
);

// The thinking panel
//
// A filled amber box with an amber label made the model's private notes the
// loudest thing on screen, above the reply they belong to.
const bubble = files.find((f) => f.file.endsWith("MessageBubble.tsx"))?.text ?? "";
// Anchored on the panel's opening element rather than an exact className
// string: the wrapper and the shell were split into two elements so the panel
// can animate its own height, and a slice keyed to the old combined class
// silently matched nothing.
const panel = bubble.slice(
  bubble.indexOf('className="thinking-panel"'),
  bubble.indexOf("{/* Reply was cut short")
);

check(
  "the panel's colour is transitioned, not switched",
  /\.thinking-shell\s*\{[^}]*transition:[^}]*border-color[^}]*background-color/s.test(
    css
  ),
  "an instant colour change reads as a repaint, which is what looked like a glitch"
);
check(
  "the label's colour is transitioned too",
  /\.thinking-toggle\s*\{[^}]*transition:\s*color/s.test(css),
  "text jumping from grey to amber in one frame is the same jump"
);
check(
  // Was "the resting state is transparent". A fully transparent resting state
  // is what left a finished panel with no edge at all, so its text sat loose
  // on the page — reported directly by the user. The panel is a container
  // whether or not it is active; what matters is that the amber ARRIVES
  // rather than snapping in, which the transition check above covers.
  "the resting state is visible but quiet",
  /\.thinking-shell\s*\{[^}]*border:\s*1px solid var\(--color-border\)/s.test(css) &&
    /\.thinking-shell\[data-thinking='true'\]\s*\{[^}]*#cfa25a/s.test(css),
  "a finished panel still needs an outline, or its text looks out of place"
);
check(
  "the outer panel is visible before animation does anything",
  /\.thinking-panel\s*\{[^}]*grid-template-rows:\s*1fr;[^}]*opacity:\s*1;/s.test(css),
  "0fr as the base state turns the whole box into a one-pixel border when animation is unavailable"
);
check(
  "reduced motion disables decoration without hiding information",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,180}\.thinking-panel\s*\{[^}]*animation:\s*none/s.test(
    css.slice(css.indexOf("/* Expanding to reveal the text."))
  ) &&
    !/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,180}\.thinking-panel\s*\{[^}]*grid-template-rows:\s*0fr/s.test(
      css
    ),
  "Windows reduced-motion reproduced Screenshot_166 exactly: animation off, base row still 0fr"
);
check(
  "everything that changes shares one duration",
  (css.match(/\.thinking-(shell|toggle|body-text)[^{]*\{[^}]*0\.3s/gs) ?? []).length >= 3,
  "staggered easings read as several things happening, not one"
);
check(
  "thinking progress stays inside the box header",
  panel.includes("<Dots size={3}") && !panel.includes("thinking-line"),
  "a full-width line was mistaken for the missing thinking panel"
);
check(
  "there is no orphaned thinking-line animation",
  !/@keyframes thinking-sweep/.test(css) && !/\.thinking-line/.test(css)
);
check(
  "there is no divider above the first tool action",
  !/h-px w-full/.test(timeline),
  "effort metadata followed by a line and fetch_url reproduced the screenshot exactly"
);

// The workspace shows a tree, not a list of paths
check(
  "file rows show a name, not a full path",
  !/\{file\.path\}/.test(wsPanel),
  "printing the path on every row made an unpacked archive a column of identical truncated strings"
);
check(
  "folders can be opened and closed",
  /aria-expanded=\{open\}/.test(wsPanel)
);
check(
  "nesting is indented rather than nested in containers",
  /paddingLeft: `\$\{depth \* 12/.test(wsPanel),
  "so every row keeps the same full-width hover area"
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
