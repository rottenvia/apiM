/**
 * Checks that a refusal is put on whoever actually made it.
 *
 * Run:  npm run test:refusal
 *
 * apiM adds no content rules, but when a model said no or a provider's own
 * filter blocked a request, the user only saw a raw "API error (400)" or a
 * short reply, and clients blamed the app. These check that provider filters
 * are named as such, that real refusals are recognised, that ordinary
 * replies and ordinary errors are left alone, and that the base prompt gives
 * context instead of the "never refuse" wording that backfires.
 */
const R = await import("@/lib/refusal-source");
const providers = await import("@/lib/providers");
const { BASE_PROMPT } = await import("@/lib/plugins");

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

console.log("\napiM refusal source checks\n");

console.log("1. Provider content filters");

const filters = [
  ["DeepSeek", 400, '{"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}'],
  ["GLM", 400, '{"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。"}}'],
  ["GLM", 400, '{"error":{"code":"1301","message":"The system detected that the input or generated content may contain unsafe or sensitive content"}}'],
  ["OpenRouter", 403, '{"error":{"message":"Input requires moderation","metadata":{"reasons":["violence"],"flagged_input":"..."}}}'],
  ["Qwen", 400, '{"error":{"code":"data_inspection_failed","message":"Input data may contain inappropriate content."}}'],
];
for (const [name, status, detail] of filters) {
  const msg = providers.providerHttpError(status, name, detail);
  check(
    `${name} ${status} reads as ${name}'s own filter`,
    msg.startsWith(`${name} blocked this request with its own content filter`) &&
      /apiM does not filter or change what you send/.test(msg),
    msg.slice(0, 70) + "..."
  );
}
check(
  "the provider's own message is quoted, not its JSON",
  providers.providerHttpError(400, "DeepSeek", filters[0][2]).includes('("Content Exists Risk")')
);

const ordinary = [
  [401, ""],
  [402, ""],
  [429, ""],
  [413, "request content too large"],
  [400, "invalid tool_choice"],
  [400, "This model's maximum context length is 65536 tokens"],
];
check(
  "ordinary errors are not called a content filter",
  ordinary.every(([s, det]) => !/content filter/.test(providers.providerHttpError(s, "DeepSeek", det))),
  "a broken key or a full context must not be blamed on moderation"
);

console.log("\n2. Refusals in replies");

const refusals = [
  "I'm sorry, but I can't help with that.",
  "I can't assist with creating that.",
  "Sorry, but I cannot provide instructions for this.",
  "I must decline this request because it goes against my guidelines.",
  "I won't write that. It violates the usage policy.",
];
for (const t of refusals) {
  check(`refusal: "${t.slice(0, 40)}"`, R.looksLikeModelRefusal(t));
}

const answers = [
  "I can't reproduce the crash yet, so I added logging to src/app.ts and ran the build again.",
  "The build can't find the symbol because the import path is wrong. Fixed in main.ts.",
  "Here is the decompiled function:\n\n```c\nint check_license(char *key) { ... }\n```",
  "",
  "I can't help noticing the loop is quadratic, so I made it linear.",
  // A long, real answer that hedges once near the start is still an answer.
  "I can't help noticing the loop is quadratic. " + "Here is the faster version. ".repeat(80),
];
for (const t of answers) {
  check(`not a refusal: "${(t || "(empty)").slice(0, 40)}"`, !R.looksLikeModelRefusal(t));
}

check(
  "a content_filter ending is named even when text arrived",
  R.refusalSource({ content: "Here is the start of", ending: { finish: "content_filter" } }) === "content_filter"
);
check(
  "a normal stop with a real answer gets no note",
  R.refusalSource({ content: "Done. All 12 tests pass.", ending: { finish: "stop" } }) === null
);
check(
  "a refusal reply gets the model note",
  R.refusalSource({ content: "I'm sorry, but I can't help with that.", ending: { finish: "stop" } }) === "model"
);

console.log("\n3. Model names");

const catalog = [{ id: "glm-5.3-flash", label: "GLM 5.3 Flash" }];
check("catalog id uses its label", R.modelDisplayName("glm-5.3-flash", catalog) === "GLM 5.3 Flash");
check(
  "custom id uses the model's own name",
  R.modelDisplayName("custom:nvidia/nemotron-3-ultra:free", catalog) === "nemotron-3-ultra"
);
check("missing id reads naturally", R.modelDisplayName(undefined, catalog) === "the model");

console.log("\n4. Base prompt");

check(
  "it gives the work context that prevents false refusals",
  /developer workstation/.test(BASE_PROMPT) && /reverse engineer/.test(BASE_PROMPT) && /mod games/.test(BASE_PROMPT)
);
check(
  "it asks for the rest of a task when one part is declined",
  /do the rest\s+of the task/.test(BASE_PROMPT)
);
check(
  "it does not use jailbreak wording, which makes refusals more likely",
  !/never refuse|unrestricted|no restrictions|ignore (?:your|all) (?:rules|guidelines)/i.test(BASE_PROMPT)
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
