/**
 * A second LLM provider — OpenCode Zen serving Ox Alpha.
 *
 * Run:  npm run test:providers
 *
 * DeepSeek used to be the only Chat Completions host. Ox Alpha is a stealth
 * model on OpenCode Zen (`x-preview-f-free` at opencode.ai/zen/v1). The
 * agent loop stays identical; only the URL, key and on-the-wire model id
 * change. Plugin directive priority is left alone.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

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

const models = await load("src/lib/models.ts");
const providers = await load("src/lib/providers.ts");
const pricing = await load("src/lib/pricing.ts");
const budget = await load("src/lib/budget.ts");

const route = read("src/app/api/chat/route.ts");
const page = read("src/app/page.tsx");
const settings = read("src/components/SettingsModal.tsx");
const selector = read("src/components/ModelSelector.tsx");
const plugins = read("src/lib/plugins.ts");
const effort = read("src/components/ThinkingEffortSelector.tsx");

console.log("\napiM provider checks\n");

console.log("1. The catalog");

check("DeepSeek V4 Pro is still listed", models.MODELS.some((m) => m.id === "deepseek-v4-pro"));
check("DeepSeek V4 Flash is still listed", models.MODELS.some((m) => m.id === "deepseek-v4-flash"));
const ox = models.MODELS.find((m) => m.id === "ox-alpha");
check("Ox Alpha is listed", Boolean(ox));
check(
  "Ox Alpha is served by OpenCode",
  ox?.provider === "opencode",
  ox?.provider
);
check(
  "the wire id is the official Zen model",
  ox?.apiModel === "x-preview-f-free",
  "opencode.ai/docs/zen lists Ox Alpha Free as x-preview-f-free"
);
check(
  "unknown ids fall back to the default DeepSeek model",
  models.getModel("nope").id === models.DEFAULT_MODEL_ID
);

console.log("\n2. Resolution");

const ds = providers.resolveChatTarget("deepseek-v4-pro", {
  deepseekApiKey: "sk-ds",
});
check("DeepSeek resolves with a DeepSeek key", ds.ok && ds.target.apiModel === "deepseek-v4-pro");
check(
  "DeepSeek hits the DeepSeek host",
  ds.ok && ds.target.baseUrl.includes("api.deepseek.com")
);

const noDs = providers.resolveChatTarget("deepseek-v4-pro", { opencodeApiKey: "sk-zen" });
check("DeepSeek refuses without its own key", !noDs.ok);

const oxOk = providers.resolveChatTarget("ox-alpha", { opencodeApiKey: "sk-zen-1" });
check("Ox Alpha resolves with an OpenCode key", oxOk.ok);
check(
  "and sends x-preview-f-free on the wire",
  oxOk.ok && oxOk.target.apiModel === "x-preview-f-free"
);
check(
  "and hits OpenCode Zen",
  oxOk.ok && oxOk.target.baseUrl.includes("opencode.ai/zen/v1"),
  oxOk.ok ? oxOk.target.baseUrl : ""
);

const noOx = providers.resolveChatTarget("ox-alpha", { deepseekApiKey: "sk-ds" });
check("Ox Alpha refuses a DeepSeek-only setup", !noOx.ok);

const helperDs = providers.resolveHelperTarget({
  deepseekApiKey: "sk-ds",
  opencodeApiKey: "sk-zen",
});
check(
  "the helper prefers Flash when a DeepSeek key exists",
  helperDs?.model.id === "deepseek-v4-flash",
  "existing DeepSeek setups keep the same cheap planning path"
);

const helperOx = providers.resolveHelperTarget({ opencodeApiKey: "sk-zen" });
check(
  "the helper falls back to Ox Alpha without DeepSeek",
  helperOx?.model.id === "ox-alpha"
);

check("no keys means no helper", providers.resolveHelperTarget({}) === null);

console.log("\n3. Thinking fields");

const dsBody = {};
providers.applyThinking(dsBody, "deepseek", true, "high");
check("DeepSeek thinking-on sends the thinking object", dsBody.thinking?.type === "enabled");
check("and reasoning_effort", dsBody.reasoning_effort === "high");

const dsOff = {};
providers.applyThinking(dsOff, "deepseek", false, "none");
check("DeepSeek thinking-off still sends the disable", dsOff.thinking?.type === "disabled");
check("and no effort", dsOff.reasoning_effort === undefined);

const ocBody = {};
providers.applyThinking(ocBody, "openai", true, "max");
check(
  "OpenCode thinking-on does NOT send DeepSeek's thinking object",
  ocBody.thinking === undefined,
  "that field 400s on OpenAI-compatible hosts"
);
check("OpenCode thinking-on sends reasoning_effort", ocBody.reasoning_effort === "max");

const ocOff = {};
providers.applyThinking(ocOff, "openai", false, "none");
check("OpenCode thinking-off sends neither field", ocOff.thinking === undefined && ocOff.reasoning_effort === undefined);

console.log("\n4. Pricing");

check("Ox Alpha is in the rate table", Boolean(pricing.MODEL_RATES["ox-alpha"]));
check(
  "the preview is free",
  pricing.estimateCost(
    { prompt_tokens: 10_000, completion_tokens: 2_000, prompt_cache_miss_tokens: 10_000 },
    "ox-alpha"
  ) === 0
);
check(
  "a free model does not divide-by-zero the budget cap",
  budget.maxTokensFor(budget.createBudget(0.1), "ox-alpha", 65_536) === 65_536
);
check(
  "DeepSeek Pro rates are unchanged",
  pricing.MODEL_RATES["deepseek-v4-pro"].input === 0.435
);

console.log("\n5. The chat route actually uses the resolver");

check("the route accepts an OpenCode key", /opencodeApiKey/.test(route));
check("it no longer requires a DeepSeek key for every request", !/Message and DeepSeek API key are required/.test(route));
check("it resolves the target before opening the stream", /resolveChatTarget\(model, creds\)/.test(route));
check(
  "the fetch uses the resolved host",
  /target\.baseUrl/.test(route) && /completionHeaders\(target\)/.test(route)
);
check("the wire model is the resolved one", /model: target\.apiModel/.test(route));
check("thinking is applied per provider", /applyThinking\(/.test(route));
check(
  "plugin directives are still appended last every round",
  /while \(true\) \{\s*round \+= 1;\s*appendPluginDirectives\(\)/.test(route),
  "this is the priority system — do not move it"
);
check(
  "the directive marker is unchanged",
  /ACTIVE USER CONFIGURATION — RESPONSE BEHAVIOR/.test(plugins)
);

console.log("\n6. The UI offers both providers");

check("Settings has an OpenCode key field", /OpenCode API Key/.test(settings));
check("Settings offers Ox Alpha as a model", /onModelChange\("ox-alpha"\)/.test(settings));
check("the composer selector lists the catalog", /from "@\/lib\/models"/.test(selector));
check("the page persists the OpenCode key", /opencodeKey/.test(page));
check("the page sends the OpenCode key with the chat request", /opencodeApiKey: opencodeKey/.test(page));
check(
  "Low effort is only remapped on V4 Pro",
  /const isPro = model === "deepseek-v4-pro"/.test(effort),
  "Ox Alpha must not inherit Pro's silent low→high mapping"
);

console.log("\n7. Local Qwen 3.8 27B");

const qwen = models.MODELS.find((m) => m.id === "qwen-3.8-27b");
check("Qwen 3.8 27B is listed", Boolean(qwen));
check("it is a local model", qwen?.provider === "local", qwen?.provider);
check(
  "the default wire id is the in-app sidecar name",
  qwen?.apiModel === "qwen-3.8-27b",
  qwen?.apiModel
);
check(
  "local needs no cloud key",
  models.hasKeyForModel("qwen-3.8-27b", {})
);

const localOk = providers.resolveChatTarget("qwen-3.8-27b", {});
check("Qwen resolves without any API key", localOk.ok);
check(
  "and defaults to the in-app sidecar",
  localOk.ok && localOk.target.baseUrl === "http://127.0.0.1:18765/v1",
  localOk.ok ? localOk.target.baseUrl : ""
);

const vllm = providers.resolveChatTarget("qwen-3.8-27b", {
  localBaseUrl: "http://127.0.0.1:8000",
  localApiModel: "Qwen/Qwen3.8-27B",
});
check(
  "a pasted host without /v1 is normalised",
  vllm.ok && vllm.target.baseUrl === "http://127.0.0.1:8000/v1"
);
check(
  "the wire id can be the Hugging Face name",
  vllm.ok && vllm.target.apiModel === "Qwen/Qwen3.8-27B"
);

const qOn = {};
providers.applyThinking(qOn, "qwen", true, "max");
check(
  "Qwen thinking-on sends enable_thinking",
  qOn.chat_template_kwargs?.enable_thinking === true &&
    qOn.chat_template_kwargs?.preserve_thinking === true
);
check(
  "Max maps to Qwen's xhigh",
  qOn.reasoning_effort === "xhigh" &&
    providers.qwenReasoningEffort("max") === "xhigh"
);
check(
  "High maps to Qwen's medium",
  providers.qwenReasoningEffort("high") === "medium"
);

const qOff = {};
providers.applyThinking(qOff, "qwen", false, "none");
check(
  "Qwen thinking-off disables thinking and sends no effort",
  qOff.chat_template_kwargs?.enable_thinking === false &&
    qOff.reasoning_effort === undefined
);
check(
  "Qwen never gets DeepSeek's thinking object",
  qOn.thinking === undefined && qOff.thinking === undefined,
  "that field is DeepSeek-only"
);
check("local Qwen is free in the rate table", pricing.MODEL_RATES["qwen-3.8-27b"]?.input === 0);
check("Settings offers the local host", /Local model/.test(settings));
check("Settings offers Qwen 3.8 27B as a model", /Qwen 3.8 27B/.test(settings));
check("the page persists the local host", /localBaseUrl/.test(page));
check("the page sends the local host with the chat request", /localBaseUrl/.test(page) && /localApiModel/.test(page));

console.log("\n8. In-app download, sidecar on this PC");

const shared = await load("src/lib/local-engine-shared.ts");
const localRoute = read("src/app/api/local/route.ts");
const localUi = read("src/components/LocalModelRuntime.tsx");
const engineSrc = read("src/lib/local-engine.ts");
const sharedSrc = read("src/lib/local-engine-shared.ts");

check(
  "Settings has a Download Qwen control",
  /LocalModelRuntime/.test(settings) && /Download Qwen 3.8 27B/.test(localUi)
);
check(
  "Settings does not require Ollama",
  !/via Ollama/.test(settings) && !/ollama serve/.test(settings)
);
check(
  "the UI never imports Node spawn",
  !/node:child_process/.test(localUi) && !/node:child_process/.test(sharedSrc)
);
const args = shared.sidecarArgs("/tmp/qwen.gguf");
check(
  "the sidecar binds loopback only",
  args.includes("--host") && args[args.indexOf("--host") + 1] === "127.0.0.1"
);
check(
  "the sidecar is llama-server, not Ollama",
  args.includes("-m") && engineSrc.includes("llama-server") && !/ollama serve/.test(engineSrc)
);
check(
  "Qwen 3.8 27B is native vision with video",
  qwen?.vision === "native" && qwen?.video === true
);
check(
  "the official GGUF URL is allow-listed",
  shared.isAllowedDownloadUrl(shared.GGUF_URL)
);
check(
  "the official mmproj URL is allow-listed",
  shared.isAllowedDownloadUrl(shared.MMPROJ_URL)
);
check(
  "a random HTTPS host is refused",
  !shared.isAllowedDownloadUrl("https://example.com/evil.gguf")
);
check(
  "cloud metadata is refused",
  !shared.isAllowedDownloadUrl("http://169.254.169.254/latest")
);
check(
  "a LAN address is refused",
  !shared.isAllowedDownloadUrl("http://192.168.1.10/qwen.gguf")
);
const mac = shared.pickLlamaAsset(
  [
    "llama-b10566-bin-macos-arm64.tar.gz",
    "llama-b10566-bin-ubuntu-x64.tar.gz",
    "llama-b10566-bin-win-cpu-x64.zip",
  ],
  { platform: "darwin", arch: "arm64", gpu: "metal" }
);
check(
  "macOS arm64 picks the Metal build",
  mac === "llama-b10566-bin-macos-arm64.tar.gz"
);
const win = shared.pickLlamaAsset(
  [
    "llama-b10566-bin-win-cuda-12.4-x64.zip",
    "llama-b10566-bin-win-cpu-x64.zip",
    "llama-b10566-bin-ubuntu-x64.tar.gz",
  ],
  { platform: "win32", arch: "x64", gpu: "nvidia" }
);
check(
  "Windows NVIDIA picks the CUDA build",
  win === "llama-b10566-bin-win-cuda-12.4-x64.zip"
);
check("download percent is rounded", shared.downloadPercent(40, 100) === 40);
check(
  "the route downloads through the in-app engine",
  /downloadEngine/.test(localRoute) && /ensureEngineRunning/.test(route)
);
check(
  "the chat route forwards local host fields",
  /localBaseUrl/.test(route) && /localApiModel/.test(route)
);
check(
  "the runtime never loads weights into Node",
  !/readFileSync\([^)]*gguf|node-llama-cpp|createCompletion|LlamaModel/i.test(
    engineSrc
  )
);
check(
  "a dead local host tells you to Download in Settings",
  /Download/.test(providers.providerUnreachable("On this PC", 2))
);
check(
  "cloud hosts keep the generic unreachable copy",
  /Check the network connection/.test(providers.providerUnreachable("DeepSeek", 2))
);

console.log("\n9. A 503 from Ox / OpenCode is their outage, not the user's key");

const busy = providers.providerHttpError(503, "OpenCode", "retrying");
check(
  "a 503 does not echo the upstream word retrying as a final error",
  !/retrying/i.test(busy),
  "that is what made the bubble look like we were still going to retry"
);
check(
  "and it says the key is fine",
  /not your API key/i.test(busy),
  busy
);
check(
  "a 503 with a useful detail is kept",
  /capacity exceeded/.test(
    providers.providerHttpError(503, "OpenCode", "capacity exceeded in us-west")
  )
);
check(
  "a rejected key is still a 401, never a 503",
  /API key was rejected/.test(providers.providerHttpError(401, "OpenCode", ""))
);
check(
  "the chat route gives OpenCode extra attempts",
  /OPENCODE_RETRY/.test(route) && /emptyStreamRetries/.test(route),
  "Zen 503s last longer than three tries, and 200+empty is the other failure mode"
);
check(
  "the live retry label uses the real attempt total",
  /visibleUpstreamNotice/.test(page) && !/attempts - 1/.test(page)
);
check(
  "the retry banner is its own row so it can vanish without remounting Thinking",
  /function RetryBanner/.test(read("src/components/ChatArea.tsx")) &&
    /retryNotice && <RetryBanner/.test(read("src/components/ChatArea.tsx"))
);

console.log("\n10. OpenRouter is a second Ox Alpha host, not a second model");

const oxHost = await load("src/lib/ox-host.ts");
check("there is still only one Ox Alpha catalog entry", models.MODELS.filter((m) => m.id === "ox-alpha").length === 1);
check("Zen wire id is x-preview-f-free", oxHost.OX_HOSTS.zen.apiModel === "x-preview-f-free");
check("OpenRouter wire id is stealth/ox-alpha", oxHost.OX_HOSTS.openrouter.apiModel === "stealth/ox-alpha");

const viaOr = providers.resolveChatTarget("ox-alpha", {
  oxHost: "openrouter",
  openrouterApiKey: "sk-or-v1-test",
});
check("Ox Alpha on OpenRouter resolves", viaOr.ok);
check(
  "and hits openrouter.ai",
  viaOr.ok && viaOr.target.baseUrl.includes("openrouter.ai/api/v1"),
  viaOr.ok ? viaOr.target.baseUrl : ""
);
check(
  "and sends stealth/ox-alpha on the wire",
  viaOr.ok && viaOr.target.apiModel === "stealth/ox-alpha"
);
check(
  "and stays provider opencode so pinning/retry/tools are reused",
  viaOr.ok && viaOr.target.providerId === "opencode"
);
check(
  "OpenRouter asks for a referer header",
  viaOr.ok && providers.completionHeaders(viaOr.target)["HTTP-Referer"]
);
check(
  "an Ox attempt times out in 20s, not 280s",
  viaOr.ok && providers.attemptTimeoutMs(viaOr.target) === 20_000
);
check(
  "Zen still works when the host is left default",
  providers.resolveChatTarget("ox-alpha", { opencodeApiKey: "sk-zen-1" }).ok
);
check(
  "OpenRouter without its key is refused",
  !providers.resolveChatTarget("ox-alpha", { oxHost: "openrouter", opencodeApiKey: "sk-zen-1" }).ok
);
check(
  "the helper can use the OpenRouter key when that host is selected",
  providers.resolveHelperTarget({
    oxHost: "openrouter",
    openrouterApiKey: "sk-or-1",
  })?.oxHost === "openrouter"
);
check(
  "the helper does not silently hop to the other Ox host",
  providers.resolveHelperTarget({
    oxHost: "zen",
    openrouterApiKey: "sk-or-1",
  }) === null,
  "the user picks Zen vs OpenRouter by hand"
);
check("Settings has an OpenRouter key field", /OpenRouter API Key/.test(settings));
check(
  "Settings has Zen / OpenRouter host buttons",
  settings.includes("onOxHostChange(id)")
);
check("the page persists the OpenRouter key and host", /openrouterKey/.test(page) && /oxHost/.test(page));
check("the page sends both Ox fields with the chat request", /openrouterApiKey: openrouterKey/.test(page) && /oxHost/.test(page));
check(
  "plugin pinning still runs for the shared Ox provider",
  route.includes('target.providerId === "opencode"') && /MAXIMUM PRIORITY/.test(plugins)
);
check(
  "there is a Settings test that hits GET /models",
  settings.includes("/api/ox/test") &&
    read("src/app/api/ox/test/route.ts").includes("/models")
);
check(
  "the live banner is driven by visibleUpstreamNotice, not a late 8s hint",
  /visibleUpstreamNotice/.test(page) &&
    !/Still waiting on/.test(page) &&
    /Do not clear retryNotice here/.test(page)
);
check(
  "content and reasoning clear the banner immediately",
  /setLiveRetry\(null\)/.test(page) && /case "content":/.test(page)
);
check(
  "a 200 with no first token is retried instead of hanging the route",
  /readWithTimeout/.test(route) &&
    /OX_FIRST_TOKEN_MS/.test(route) &&
    /no first token/.test(route)
);
check(
  "the route never auto-fails over to the other Ox host",
  !/order: OxHost\[\]/.test(read("src/lib/providers.ts")) &&
    /Only the host the user picked/.test(read("src/lib/providers.ts"))
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
