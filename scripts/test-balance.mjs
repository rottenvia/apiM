/**
 * Knowing the balance before it runs out, not after.
 *
 * Run:  npm run test:balance
 *
 * The app estimated cost from token counts once a reply had finished, which
 * cannot answer the only question that matters — will the next task finish.
 * DeepSeek admits a request against the balance and deducts after it runs, so
 * a forty-round agent task can start with four cents and end tens of cents
 * overdrawn. That is how an account reaches a negative figure with nothing
 * having gone wrong.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const B = await load("src/components/BalanceWarning.tsx");
const api = read("src/app/api/balance/route.ts");
const page = read("src/app/page.tsx");
const chat = read("src/components/ChatArea.tsx");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

console.log("\napiM balance checks\n");

console.log("1. It reads the real figure, not an estimate");
check(
  "it calls DeepSeek's balance endpoint",
  /\/user\/balance/.test(api),
  "token estimates cannot say whether the next task will finish"
);
check("it uses the account's own availability flag", /is_available/.test(api));
check(
  "USD is preferred when several currencies are returned",
  /i\.currency === "USD"/.test(api),
  "balance_infos is an array; the first entry may be CNY"
);
check(
  "a failed check keeps the last known figure",
  /if \(!data\.error && typeof data\.total === "number"\)/.test(page),
  "replacing a real number with a guess is worse than saying nothing"
);

console.log("\n2. The thresholds match how this app spends");
check(
  "low is about one agent task, not almost zero",
  B.LOW_BALANCE_USD >= 0.4,
  `$${B.LOW_BALANCE_USD} — a max-thinking run costs tens of cents`
);
check("critical sits below it", B.CRITICAL_BALANCE_USD < B.LOW_BALANCE_USD);
check("a healthy balance says nothing at all", B.levelFor(5, true) === "ok");
check("just under the line warns", B.levelFor(0.49, true) === "low");
check("nearly gone escalates", B.levelFor(0.14, true) === "critical");
check(
  "a negative balance is handled, not treated as impossible",
  B.levelFor(-0.53, true) === "empty",
  "post-paid billing means overdrawn is a normal state"
);
check(
  "the account's own 'unavailable' overrides a positive number",
  B.levelFor(2, false) === "empty"
);

console.log("\n3. It does not become noise");
check(
  "nothing renders while the balance is fine",
  /if \(level === "ok"\) return null/.test(read("src/components/BalanceWarning.tsx"))
);
check(
  "it is only re-read when a reply finishes",
  /void refreshBalanceRef\.current\?\.\(\)/.test(page) &&
    !/setInterval/.test(page),
  "polling would spend requests to learn nothing between messages"
);
check(
  "dismissing hides it until the balance actually worsens",
  /balance\.total < balanceDismissedAt - 0\.001/.test(page),
  "hiding at $0.40 must not also hide it at $0.05"
);

console.log("\n4. It says what to do");
check("it links to the top-up page", /platform\.deepseek\.com\/top_up/.test(read("src/components/BalanceWarning.tsx")));
check(
  "it explains that an interrupted task is recoverable",
  /Continue picks it up/.test(read("src/components/BalanceWarning.tsx")),
  "the work is saved; panic is not warranted"
);
check(
  "it explains why a balance can go negative",
  /bills after each request/.test(read("src/components/BalanceWarning.tsx"))
);
check(
  "money is shown above everything else in the composer area",
  chat.indexOf("{balanceWarning}") < chat.indexOf("{btwEntry && ("),
  "if a task cannot finish, that outranks the rest of the screen"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
