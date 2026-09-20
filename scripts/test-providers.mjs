/**
 * The three providers: DeepSeek, OpenRouter, and local.
 *
 * Run:  npm run test:providers
 *
 * DeepSeek used to be the only Chat Completions host. OpenRouter is the
 * second (GLM 5.3 Flash, the free Nemotron lane, and any custom model
 * the user adds); a local OpenAI-compatible host serves Qwen. The agent
 * loop stays identical — only the URL, key and on-the-wire model id
 * change. Plugin directive priority is left alone.
 *
 * (Ox Alpha / OpenCode Zen was removed 2026-09: the trial lane is the
 * free Nemotron model on OpenRouter now.)
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
const requestSize = await load("src/lib/request-size.ts");

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
  check(
    "GLM 5.3 Flash is the default model",
    models.DEFAULT_MODEL_ID === "glm-5.3-flash" && models.MODELS[0].id === "glm-5.3-flash",
    models.DEFAULT_MODEL_ID
  );
check(
  "Ox Alpha is gone from the catalog",
  !models.MODELS.some((m) => m.id === "ox-alpha")
);
const freeNemotron = models.MODELS.find(
  (m) => m.id === "nvidia-nemotron-3-ultra-free"
);
check("Nemotron 3 Ultra Free is listed", Boolean(freeNemotron));
check(
  "the free lane rides OpenRouter, not a Zen host",
  freeNemotron?.provider === "openrouter",
  freeNemotron?.provider
);
check(
  "the wire id is the official :free slug",
  freeNemotron?.apiModel === "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter.ai/nvidia lists the free lane as nemotron-3-ultra-550b-a55b:free"
);
check(
  "the old a558 typo never comes back",
  !/a558/.test(read("src/lib/models.ts")),
  "one wrong char 400'd every free-lane request as 'not a valid model ID'"
);
check(
  "an unknown model id skips every retry",
  /isUnknownModelRejection\(rejectedDetail\)/.test(route) &&
    /!modelUnknown &&/.test(route),
  "a bad model burned a 697k strip retry and a 313k composed retry to learn nothing"
);
check(
  "unknown ids fall back to the default model",
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

const noDs = providers.resolveChatTarget("deepseek-v4-pro", { openrouterApiKey: "sk-or" });
check("DeepSeek refuses without its own key", !noDs.ok);

const glmOk = providers.resolveChatTarget("glm-5.3-flash", { openrouterApiKey: "sk-or-v1-test" });
check("GLM resolves with an OpenRouter key", glmOk.ok);
check(
  "and sends z-ai/glm-5.3-flash on the wire",
  glmOk.ok && glmOk.target.apiModel === "z-ai/glm-5.3-flash"
);
check(
  "and hits openrouter.ai",
  glmOk.ok && glmOk.target.baseUrl.includes("openrouter.ai/api/v1"),
  glmOk.ok ? glmOk.target.baseUrl : ""
);

const freeOk = providers.resolveChatTarget("nvidia-nemotron-3-ultra-free", {
  openrouterApiKey: "sk-or-v1-test",
});
check("the Nemotron free lane resolves with an OpenRouter key", freeOk.ok);
check(
  "and sends the :free slug on the wire",
  freeOk.ok && freeOk.target.apiModel === "nvidia/nemotron-3-ultra-550b-a55b:free"
);

const noOr = providers.resolveChatTarget("glm-5.3-flash", { deepseekApiKey: "sk-ds" });
check("GLM refuses a DeepSeek-only setup", !noOr.ok);

const helperDs = providers.resolveHelperTarget({
  deepseekApiKey: "sk-ds",
  openrouterApiKey: "sk-or",
});
check(
  "the helper prefers Flash when a DeepSeek key exists",
  helperDs?.model.id === "deepseek-v4-flash",
  "existing DeepSeek setups keep the same cheap planning path"
);

const helperFree = providers.resolveHelperTarget({ openrouterApiKey: "sk-or" });
check(
  "the helper falls back to the Nemotron free lane without DeepSeek",
  helperFree?.model.id === "nvidia-nemotron-3-ultra-free" &&
    helperFree?.providerId === "openrouter",
  "the free judge never depends on a paid balance"
);

// The helper no longer follows the main model: it is always the cheapest
// known lane (Flash on DeepSeek, Nemotron-free on OpenRouter), and the caller
// drops it when it equals the main model. A second argument would be dead.
check(
  "DeepSeek still wins when both keys exist",
  providers.resolveHelperTarget({
    deepseekApiKey: "sk-ds",
    openrouterApiKey: "sk-or",
  })?.model.id === "deepseek-v4-flash",
  "the key paying for the reply stays the cheap side-call planner"
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
  "OpenRouter thinking-on does NOT send DeepSeek's thinking object",
  ocBody.thinking === undefined,
  "that field 400s on OpenAI-compatible hosts"
);
check("OpenRouter thinking-on sends reasoning_effort", ocBody.reasoning_effort === "max");

const ocOff = {};
providers.applyThinking(ocOff, "openai", false, "none");
check("OpenRouter thinking-off sends neither field", ocOff.thinking === undefined && ocOff.reasoning_effort === undefined);

console.log("\n4. Pricing");

check("the Nemotron free lane is in the rate table", Boolean(pricing.MODEL_RATES["nvidia-nemotron-3-ultra-free"]));
check(
  "the free lane is free",
  pricing.estimateCost(
    { prompt_tokens: 10_000, completion_tokens: 2_000, prompt_cache_miss_tokens: 10_000 },
    "nvidia-nemotron-3-ultra-free"
  ) === 0
);
check(
  "a free model does not divide-by-zero the budget cap",
  budget.maxTokensFor(budget.createBudget(0.1), "nvidia-nemotron-3-ultra-free", 65_536) === 65_536
);
check(
  "DeepSeek Pro rates are unchanged",
  pricing.MODEL_RATES["deepseek-v4-pro"].input === 0.435
);

console.log("\n5. The chat route actually uses the resolver");

check("the route accepts an OpenRouter key", /openrouterApiKey/.test(route));
check("it no longer requires a DeepSeek key for every request", !/Message and DeepSeek API key are required/.test(route));
check("it resolves the target before opening the stream", /resolveChatTarget\(model, creds, customs\)/.test(route));
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

check("Settings has a DeepSeek key field", /DeepSeek API Key/.test(settings));
check("Settings has an OpenRouter key field", /OpenRouter API Key/.test(settings));
check(
  "Settings renders the model grid from the catalog, including customs",
  /onModelChange\(m\.id\)/.test(settings) && /onModelChange\(c\.id\)/.test(settings)
);
check("the composer selector lists the catalog", /from "@\/lib\/models"/.test(selector));
check("the page persists the OpenRouter key", /openrouterKey/.test(page));
check("the page sends the OpenRouter key with the chat request", /openrouterApiKey: openrouterKey/.test(page));
check(
  "Low effort is only remapped on V4 Pro",
  /const isPro = model === "deepseek-v4-pro"/.test(effort),
  "no other model inherits Pro's silent low→high mapping"
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
  "a finished download shows Start, not another Download",
  /status\.ggufReady \?/.test(localUi) && /Start Qwen/.test(localUi)
);
check(
  "a running sidecar can be Unloaded",
  /Unload/.test(localUi) && /action === \"stop\"/.test(localRoute)
);
check(
  "download does not auto-start the sidecar",
  /Click Start when you want Qwen/.test(localRoute) &&
    !/Starting the sidecar/.test(localRoute)
);
check(
  "a 98% GGUF counts as downloaded",
  shared.ggufLooksComplete(Math.floor(shared.GGUF_BYTES * 0.99)) &&
    !shared.ggufLooksComplete(1024)
);
check(
  "switching away from Qwen unloads the sidecar",
  /action: \"stop\"/.test(page) && /settingsHydrated/.test(page)
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
  "the sidecar opens an 80K window, not 16K",
  args.includes("-c") &&
    args[args.indexOf("-c") + 1] === String(shared.SIDECAR_CTX) &&
    shared.SIDECAR_CTX >= 65_536
);
check(
  "KV cache is quantized so 80K does not add another 17 GB",
  args.includes("--cache-type-k") &&
    args[args.indexOf("--cache-type-k") + 1] === "q8_0"
);
check(
  "the sidecar turns on Qwen's built-in MTP draft head",
  args.includes("--spec-type") &&
    args[args.indexOf("--spec-type") + 1] === "draft-mtp" &&
    args[args.indexOf("--spec-draft-n-max") + 1] === "2"
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
// ------------------------------------------------- the GPU-sitting-idle case
//
// Reported: Qwen could not answer even "hi" — CPU 100%, GPU 0%. The sidecar
// offloads 99 layers, so a 0% GPU means the GPU backend never came up and
// the 27B was crawling on CPU — and the log line that says why was thrown
// away. Now it is persisted, parsed, shown, and the backend is selectable.

const WIN_ASSETS = [
  "llama-b10566-bin-win-cuda-12.4-x64.zip",
  "llama-b10566-bin-win-vulkan-x64.zip",
  "llama-b10566-bin-win-cpu-x64.zip",
  "llama-b10566-bin-ubuntu-x64.tar.gz",
  "llama-b10566-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b10566-bin-macos-arm64.tar.gz",
];
check(
  "a Vulkan choice wins over a detected NVIDIA GPU",
  shared.pickLlamaAsset(WIN_ASSETS, {
    platform: "win32",
    arch: "x64",
    gpu: "nvidia",
    build: "vulkan",
  }) === "llama-b10566-bin-win-vulkan-x64.zip",
  "the escape hatch when the CUDA build refuses the driver"
);
check(
  "a CPU choice wins over everything",
  shared.pickLlamaAsset(WIN_ASSETS, {
    platform: "win32",
    arch: "x64",
    gpu: "nvidia",
    build: "cpu",
  }) === "llama-b10566-bin-win-cpu-x64.zip"
);
check(
  "auto is unchanged when no override is set",
  shared.pickLlamaAsset(WIN_ASSETS, {
    platform: "win32",
    arch: "x64",
    gpu: "nvidia",
  }) === "llama-b10566-bin-win-cuda-12.4-x64.zip"
);
// The Windows CUDA build needs a SECOND archive (the CUDA runtime DLLs);
// without it ggml-cuda fails to load and the engine silently runs on CPU —
// the "CUDA picked but 99% CPU / ~1% GPU" report.
const WIN_WITH_RUNTIME = [
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.3-x64.zip",
  ...WIN_ASSETS,
];
check(
  "the CUDA build names its matching cudart runtime archive",
  shared.pickCudartAsset(
    WIN_WITH_RUNTIME,
    "llama-b10566-bin-win-cuda-12.4-x64.zip"
  ) === "cudart-llama-bin-win-cuda-12.4-x64.zip"
);
check(
  "a 13.x CUDA build pairs with the 13.x runtime, not the 12.x one",
  shared.pickCudartAsset(
    WIN_WITH_RUNTIME,
    "llama-b10566-bin-win-cuda-13.3-x64.zip"
  ) === "cudart-llama-bin-win-cuda-13.3-x64.zip"
);
check(
  "a CPU or Vulkan build needs no cudart archive",
  shared.needsCudart("llama-b10566-bin-win-cpu-x64.zip") === false &&
    shared.needsCudart("llama-b10566-bin-win-vulkan-x64.zip") === false &&
    shared.pickCudartAsset(WIN_WITH_RUNTIME, null) === null
);
check(
  "a GPU machine refuses to silently start the CPU-only build",
  engineSrc.includes("CPU-only") && engineSrc.includes("-cpu-x64"),
  "startEngine names the exact fix instead of running at 100% CPU"
);
check(
  "the installed backend is read from the binary itself, not only the stamp",
  /async function installedBackend\(/.test(engineSrc) &&
    /ggml-.*cuda/.test(engineSrc) &&
    /backendWrong/.test(engineSrc),
  "an un-stamped CPU binary must not be trusted as CUDA on start"
);
check(
  "Download reinstalls when the on-disk backend does not match the pick",
  /onDiskBackend !== "cuda"/.test(engineSrc) &&
    /Switching engine build/.test(engineSrc)
);
check(
  "a CUDA build missing its runtime refuses to start with an actionable error",
  /runtime libraries \(cudart/.test(engineSrc) &&
    /cudartPresent\(server\)/.test(engineSrc),
  "the missing-cudart case that fell back to CPU is now caught before spawn"
);
check(
  "the installer fetches the cudart archive and copies its DLLs next to the server",
  /pickCudartAsset\(/.test(engineSrc) &&
    /installCudart\(/.test(engineSrc) &&
    /cudartPresent\(/.test(engineSrc) &&
    /\.dll/i.test(engineSrc)
);

check(
  "there is no CUDA ubuntu asset, so cuda on Linux lands on Vulkan",
  shared.pickLlamaAsset(WIN_ASSETS, {
    platform: "linux",
    arch: "x64",
    gpu: "nvidia",
    build: "cuda",
  }) === "llama-b10566-bin-ubuntu-vulkan-x64.tar.gz",
  "Vulkan drives NVIDIA too"
);
check(
  "macOS has one build no matter what is chosen",
  shared.pickLlamaAsset(WIN_ASSETS, {
    platform: "darwin",
    arch: "arm64",
    gpu: "metal",
    build: "vulkan",
  }) === "llama-b10566-bin-macos-arm64.tar.gz"
);

const engineLib = await load("src/lib/local-engine.ts");
check(
  "the offload line settles it: GPU in use",
  (() => {
    const r = engineLib.parseGpuLog(
      "llama-server: loading model\nllama_model_loader: offloaded 36/36 layers to GPU (CUDA)\n"
    );
    return r.inUse === true && r.backend === "CUDA" && r.offloaded === "36/36";
  })()
);
check(
  "offloaded 0 layers is a confirmed CPU run",
  engineLib.parseGpuLog("offloaded 0/36 layers to GPU").inUse === false
);
check(
  "a backend failure with no offload line is a confirmed CPU fallback",
  (() => {
    const r = engineLib.parseGpuLog(
      "CUDA error: driver on the system is too old (version 12.0)\nCUDA: not available\n"
    );
    return r.inUse === false && /driver on the system is too old/.test(r.failedLine ?? "");
  })(),
  "the exact line is what the user needs to fix the driver"
);
check(
  "a young log is unknown, not CPU",
  engineLib.parseGpuLog("llama-server: serving on http://127.0.0.1:18765").inUse === null
);
check(
  "the engine tees its stderr to a log file",
  /createWriteStream\(engineLogPath\(\)/.test(engineSrc),
  "before this the 'CUDA failed, using CPU' line was discarded after 400 chars"
);
check(
  "status reports where the compute went",
  /gpu: await buildGpuState\(running\)/.test(engineSrc) &&
    /Running on the CPU/.test(engineSrc)
);
check(
  "the panel says GPU not in use when the log proves the fallback",
  /GPU not in use/.test(localUi) && /Engine backend/.test(localUi)
);
check(
  "the panel can switch the backend",
  /ENGINE_BUILDS/.test(localUi) && /setBackend\(b\.id\)/.test(localUi) &&
    /extra: spec\.extra, build \}/.test(localUi)
);
check(
  "the panel shows the engine log",
  /Engine log \(last/.test(localUi) && /logTail\.join/.test(localUi)
);
check(
  "a chosen build that is not installed asks for a Download",
  /does not match|Click Download in Settings to fetch/.test(engineSrc)
);
check(
  "first launch on a GPU machine starts flash attention on",
  /detectGpu\(\) !== "none"/.test(engineSrc) &&
    /\[\.\.\.base\.enabled, "flash"\]/.test(engineSrc),
  "the preset blurb says leave it off only on CPU — the default disagreed"
);
check(
  "a flash-attention startup failure retries once without it",
  /spec\.enabled\.includes\("flash"\)/.test(engineSrc) &&
    /id !== "flash"/.test(engineSrc)
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

console.log("\n8b. Qwen cannot take a system message after the first");

const transcript = await load("src/lib/transcript.ts");
const qwenMsgs = [
  { role: "system", content: "persona" },
  { role: "user", content: "hi" },
  { role: "system", content: "Current workspace contents: a.py" },
  { role: "assistant", content: "ok" },
  { role: "system", content: "plan" },
];
const folded = transcript.foldSystemMessagesToFront(qwenMsgs);
check(
  "later system messages are folded into the first",
  folded[0].role === "system" &&
    folded.filter((m) => m.role === "system").length === 1 &&
    folded[0].content.includes("persona") &&
    folded[0].content.includes("Current workspace contents") &&
    folded[0].content.includes("plan")
);
check(
  "user and assistant order is unchanged",
  folded[1].role === "user" && folded[2].role === "assistant"
);
const alreadyFront = qwenMsgs.slice(0, 2);
check(
  "a transcript that already has one leading system is left alone",
  transcript.foldSystemMessagesToFront(alreadyFront) === alreadyFront
);
check(
  "the chat route folds only for Qwen, not DeepSeek/Ox",
  /thinkingStyle === "qwen"/.test(route) &&
    /foldSystemMessagesToFront/.test(route)
);
check(
  "DeepSeek still gets the tail system copies on the wire",
  /serializeForApi\(/.test(route) &&
    /compacted\.messages/.test(route)
);

console.log("\n8c. Local context has to fit the sidecar window");

const localCtx = await load("src/lib/local-context.ts");
const huge = [
  { role: "system", content: "persona " + "x".repeat(20_000) },
  { role: "user", content: "do the thing" },
  {
    role: "assistant",
    content: "working",
    reasoning_content: "R".repeat(40_000),
    tool_calls: [
      {
        id: "c0",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"a.py\"}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "c0", content: "file " + "y".repeat(30_000) },
  { role: "user", content: "and then this" },
];
const fitted = localCtx.fitForLocalContext(huge, 8_000);
check(
  "a fat transcript is cut down to the local budget",
  fitted.trimmed &&
    fitted.tokens <= 8_000 &&
    fitted.messages.some((m) => m.role === "user" && m.content === "and then this")
);
check(
  "the last user question survives the cut",
  fitted.messages[fitted.messages.length - 1].role === "user"
);
check(
  "tool calls stay paired after the cut",
  (() => {
    const ids = new Set();
    const replies = new Set();
    for (const m of fitted.messages) {
      if (m.role === "assistant") for (const c of m.tool_calls ?? []) ids.add(c.id);
      if (m.role === "tool") replies.add(m.tool_call_id);
    }
    if (ids.size !== replies.size) return false;
    for (const id of ids) if (!replies.has(id)) return false;
    return true;
  })()
);
check(
  "the chat route fits Qwen before serialize",
  /fitForLocalContext/.test(route) && /localMessageBudget/.test(route)
);
check(
  "local output is capped below the sidecar window",
  /SIDECAR_MAX_OUTPUT/.test(route) &&
    shared.SIDECAR_MAX_OUTPUT + 256 < shared.SIDECAR_CTX
);
check(
  "a context-exceeded 400 tells you to restart the sidecar",
  /Restart/.test(
    providers.providerHttpError(
      400,
      "On this PC",
      "request (73667 tokens) exceeds the available context size (16384 tokens)"
    )
  )
);
check(
  "the catalog no longer advertises a 262K window the sidecar does not open",
  !/262K/.test(qwen?.specs ?? "") && /80K/.test(qwen?.specs ?? "")
);
check(
  "a sidecar still on 16K is restarted before chat",
  /readSidecarCtx/.test(engineSrc) &&
    /ctx >= SIDECAR_CTX/.test(engineSrc)
);
check(
  "a stale llama-server is killed by name, not just by the in-memory child",
  /killLlamaServerByName/.test(engineSrc) && /pkill/.test(engineSrc)
);
check(
  "chat refuses to send if the running window is still 16K",
  /ctx < SIDECAR_CTX/.test(route) && /Restart/.test(route)
);
check(
  "Settings exposes spec optimizations the user can add to",
  /Spec optimizations/.test(localUi) && /parseUserFlags/.test(sharedSrc)
);

console.log("\n9. A 503 from OpenRouter is their outage, not the user's key");

const busy = providers.providerHttpError(503, "OpenRouter", "retrying");
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
    providers.providerHttpError(503, "OpenRouter", "capacity exceeded in us-west")
  )
);
check(
  "a rejected key is still a 401, never a 503",
  /API key was rejected/.test(providers.providerHttpError(401, "OpenRouter", ""))
);
check(
  "a shared-pool 429 names the free pool, not the user's key",
  /shared pool/.test(providers.providerHttpError(429, "OpenRouter", "")) &&
    /not your key/.test(providers.providerHttpError(429, "OpenRouter", "")),
  "mornings are quiet; evenings look like the key is broken"
);
  check(
    "the chat route gives OpenRouter extra attempts",
    /OPENROUTER_RETRY/.test(route) && /emptyStreamRetries/.test(route),
    "shared-pool 503s last longer than three tries, and 200+empty is the other failure mode"
  );
  check(
    "a video round skips doomed empty-stream retries",
    /roundHasVideo/.test(route) &&
      /VIDEO_RETRY_FAST_MS/.test(route) &&
      /while ingesting/.test(route),
        "re-uploading the clip for the same prefill choke is a ritual, not a retry"
      );
    check(
      "the OpenRouter body carries a per-conversation session_id",
      /session_id/.test(route) &&
        /conv-\$\{convId\}/.test(route) &&
        /providerId === "openrouter"/.test(route),
      "sticky routing keeps every round on the endpoint holding the warm cache"
    );
check(
  "every round reports its fired request size",
  /type: "request_size";/.test(route) &&
    /type: "request_size",\s*round,\s*inputChars,/.test(route),
  "a 600k 'new message' must arrive with its cause attached, not as a mystery"
);
check(
  "the fire-time size line is quiet for small chats and clears with the run",
  /case "request_size":/.test(page) &&
    /info\.inputChars >= 100_000/.test(page) &&
    (page.match(/liveRequestSize: null/g) ?? []).length >= 5 &&
    /requestSize && <RequestSizeLine/.test(read("src/components/ChatArea.tsx")) &&
    /big context, first token may take a while/.test(
      read("src/components/ChatArea.tsx")
    ),
  "one muted line while heavy rounds run; the ctx chip keeps the record"
);
check(
  "the live retry label uses the real attempt total",
  /visibleUpstreamNotice/.test(page) && !/attempts - 1/.test(page)
);
check(
  "the retry banner is its own row so it can vanish without remounting Thinking",
  /function RetryBanner/.test(read("src/components/ChatArea.tsx")) &&
    /retryNotice && \(\s*<RetryBanner/.test(read("src/components/ChatArea.tsx"))
);
check(
  "a size rejection folds history and keeps the tools",
  /foldOldestHistory\(/.test(route) &&
    /tools kept/.test(route) &&
    /isSizeRejection\(/.test(route),
  "stripping tools keeps every offending char and fails identically with a defanged agent"
);
check(
  "a shape rejection still strips tools and media",
  /retrying without tools and media/.test(route) &&
    /sanitizeOpenRouterRequestBody/.test(route)
);
check(
  "rejection detail is unwrapped in both the retry verdict and the final error",
  /extractRejectionDetail\(earlyErrText\)/.test(route) &&
    /extractRejectionDetail\(errText, 200\)/.test(route) &&
    !/openrouter_shape_rejection/.test(route),
  "metadata.raw buries the real cause one level down; the old subject lied about size recoveries"
);
check(
  "a shape verdict with nothing to strip folds once instead of failing outright",
  /} else if \(Array\.isArray\(dsRequestBody\.messages\)\) \{/.test(route),
  "a generic wrapper names nothing — a 697k body is guilty until proven innocent"
);
check(
  "a rejected targeted retry gets one composed last chance",
  /still rejected — retrying once more/.test(route) &&
    /composedJson !== retryJson/.test(route) &&
    /stillTooBig/.test(route),
  "a double fault (oversized AND tool-shy) defeats either transform alone"
);
check(
  "the retry event carries the provider's own message",
  /detail: rejectedDetail/.test(route) &&
    /Provider said/.test(read("src/components/ChatArea.tsx")),
  "the banner must show WHY the retry exists, not just that one is running"
);
check(
  "a fat body logs which history turns hold the mass",
  /describeHistoryTurns/.test(route) && /round \${round} hist/.test(route),
  "a 479k 'history' bucket is still a mystery until the fat turns are named"
);
check(
  "history forensics name the biggest turns with their opening words",
  (() => {
    const rows = requestSize.describeHistoryTurns([
      { role: "system", content: "directives" },
      { role: "user", content: `a small question` },
      { role: "assistant", content: "wall of pasted logs " + "z".repeat(50_000) },
      { role: "user", content: "the live question" },
    ]);
    return (
      rows.length === 2 &&
      rows[0].startsWith("asst 50k") &&
      rows[0].includes("wall of pasted logs") &&
      !rows.join("\n").includes("the live question")
    );
  })(),
  "the log line must point at the fat archived turn, never the live one"
);
check(
  "the reply reports the context it cost",
  /contextChars: lastInputChars/.test(route) &&
    /k ctx/.test(read("src/components/MessageBubble.tsx")),
  "every reply carries its own receipt — no more mystery 691k requests"
);

console.log("\n10. Any OpenRouter model can be added as a custom");

const customs = [
  {
    id: "custom:anthropic/claude-opus-4-6",
    label: "Claude Opus 4.6",
    apiModel: "anthropic/claude-opus-4-6",
    vision: "helper",
    video: false,
    maxOutputTokens: 32000,
  },
];
const customInfo = models.resolveModelInfo(
  "custom:anthropic/claude-opus-4-6",
  customs
);
check(
  "a custom resolves to its own entry",
  customInfo.id === "custom:anthropic/claude-opus-4-6"
);
check(
  "and always rides OpenRouter",
  customInfo.provider === "openrouter"
);
const customTarget = providers.resolveChatTarget(
  "custom:anthropic/claude-opus-4-6",
  { openrouterApiKey: "sk-or-v1-test" },
  customs
);
check("a custom resolves with the OpenRouter key", customTarget.ok);
check(
  "and sends the typed slug on the wire",
  customTarget.ok && customTarget.target.apiModel === "anthropic/claude-opus-4-6"
);
check(
  "and is refused without the OpenRouter key",
  !providers.resolveChatTarget(
    "custom:anthropic/claude-opus-4-6",
    { deepseekApiKey: "sk-ds" },
    customs
  ).ok
);
check(
  "the helper never rides a custom",
  providers.resolveHelperTarget({ openrouterApiKey: "sk-or" }, customs)
    ?.model.id === "nvidia-nemotron-3-ultra-free",
  "a side call must ride a known-cheap lane, not a user-typed price"
);
check(
  "an unknown custom id falls back to the default model, never a crash",
  models.resolveModelInfo("custom:nope", customs).id === models.DEFAULT_MODEL_ID
);
check(
  "Settings renders the custom-model manager",
  /CustomModelsManager/.test(settings)
);
check(
  "Verify checks the id against OpenRouter's /models",
  read("src/app/api/openrouter/verify/route.ts").includes("/models")
);
check(
  "the picker lists customs with the catalog",
  /Your models/.test(selector)
);
check(
  "sanitize keeps the :free routing suffix — verified free models must be addable",
  models.sanitizeCustomModelDef({
    label: "Nemotron 3 Ultra (free)",
    apiModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    vision: "helper",
  })?.id === "custom:nvidia/nemotron-3-ultra-550b-a55b:free",
  "the pattern once rejected ':' so every :free slug verified and then refused to add"
);
check(
  "the retired 0731 id migrates to the current free lane",
  /deepseek-v4-flash-0731-free/.test(page) &&
    /setModel\(FREE_OPENROUTER_MODEL_ID\)/.test(page),
  "saved settings pointing at the pulled slug must land on Nemotron, not dangle"
);
check(
  "the live banner is driven by visibleUpstreamNotice, not a late 8s hint",
  /visibleUpstreamNotice/.test(page) &&
    !/Still waiting on/.test(page) &&
    /Do not clear retryNotice here/.test(page)
);
check(
  "content and reasoning clear the banner immediately",
  /setLiveRetry\(runConvId \?\? requestConversationId, null\)/.test(page) && /case "content":/.test(page)
);
check(
  "a 200 with no first token is retried instead of hanging the route",
  /readWithTimeout/.test(route) &&
    /OPENROUTER_FIRST_TOKEN_MS/.test(route) &&
    /no first token/.test(route)
);

console.log("\n11. GLM 5.3 Flash (OpenRouter) and the free Nemotron lane");

const glm = models.MODELS.find((m) => m.id === "glm-5.3-flash");
const free = models.MODELS.find((m) => m.id === "nvidia-nemotron-3-ultra-free");
check("GLM 5.3 Flash is in the catalog", Boolean(glm));
check(
  "its wire id is the official OpenRouter slug",
  glm?.apiModel === "z-ai/glm-5.3-flash",
  "openrouter.ai/z-ai/glm-5.3-flash"
);
check("it rides its own provider (openrouter)", glm?.provider === "openrouter");
check(
  "it runs capped like every catalog model — uncapped 401k reads fed fat fresh results into the transcript",
    glm?.openToolLimits === false
  );
check("it is a native VLM", glm?.vision === "native");
check("Nemotron 3 Ultra Free is in the catalog", Boolean(free));
check("the free lane rides the openrouter provider", free?.provider === "openrouter");
check(
  "the free lane sends the official :free slug on the wire",
  free?.apiModel === "nvidia/nemotron-3-ultra-550b-a55b:free"
);
check("Ox Alpha is gone from the catalog", !models.MODELS.some((m) => m.id === "ox-alpha"));

const glmResolved = providers.resolveChatTarget("glm-5.3-flash", {
  openrouterApiKey: "sk-or-v1-test",
});
check("GLM resolves with an OpenRouter key", glmResolved.ok);
check(
  "and hits openrouter.ai",
  glmResolved.ok && glmResolved.target.baseUrl.includes("openrouter.ai/api/v1"),
  glmResolved.ok ? glmResolved.target.baseUrl : ""
);
check(
  "and sends z-ai/glm-5.3-flash on the wire",
  glmResolved.ok && glmResolved.target.apiModel === "z-ai/glm-5.3-flash"
);
check(
  "OpenRouter asks for a referer header on GLM too",
  glmResolved.ok && providers.completionHeaders(glmResolved.target)["HTTP-Referer"]
);
check(
  "GLM is refused without the OpenRouter key",
  !providers.resolveChatTarget("glm-5.3-flash", { deepseekApiKey: "sk-ds" }).ok
);

const freeResolved = providers.resolveChatTarget("nvidia-nemotron-3-ultra-free", {
  openrouterApiKey: "sk-or-v1-test",
});
check("the free lane resolves with an OpenRouter key", freeResolved.ok);
check(
  "and hits openrouter.ai",
  freeResolved.ok && freeResolved.target.baseUrl.includes("openrouter.ai/api/v1"),
  freeResolved.ok ? freeResolved.target.baseUrl : ""
);
check(
  "and sends the :free slug on the wire",
  freeResolved.ok && freeResolved.target.apiModel === "nvidia/nemotron-3-ultra-550b-a55b:free"
);
check(
  "the free lane is refused with only a DeepSeek key",
  !providers.resolveChatTarget("nvidia-nemotron-3-ultra-free", {
    deepseekApiKey: "sk-ds",
  }).ok
);
check(
  "the client key check agrees: GLM wants the OpenRouter key",
  models.hasKeyForModel("glm-5.3-flash", { openrouterKey: "sk-or-v1" }) &&
    !models.hasKeyForModel("glm-5.3-flash", { deepseekKey: "sk-ds" })
);
check(
  "and the free lane wants the OpenRouter key too",
  models.hasKeyForModel("nvidia-nemotron-3-ultra-free", { openrouterKey: "sk-or-v1" }) &&
    !models.hasKeyForModel("nvidia-nemotron-3-ultra-free", { deepseekKey: "sk-ds" })
);

check(
  "GLM is budgeted at Z.ai list price, not the launch discount",
  pricing.MODEL_RATES["glm-5.3-flash"]?.input === 0.15 &&
    pricing.MODEL_RATES["glm-5.3-flash"]?.output === 0.5,
  "the 50% discount ends 2026-09-09; the cap must never undercount"
);
check("the free lane costs nothing in the rate table", pricing.MODEL_RATES["nvidia-nemotron-3-ultra-free"]?.input === 0 && pricing.MODEL_RATES["nvidia-nemotron-3-ultra-free"]?.output === 0);
check(
    "GLM replies are billed, so the cost chip can show real money",
    (() => {
      const r = pricing.ratesFor("glm-5.3-flash", "peak", Date.now());
      if (!r) return false;
      // Full-cache-miss shape: 1M prompt tokens billed at input, 1M completion
      // tokens at output — must equal exactly what the rate table says for the
      // window we are currently in. The old hardcoded 0.325 detonated the day
      // the launch discount expired (2026-09-09 16:00 UTC); a date-aware sum
      // can never go stale.
      return (
        pricing.estimateCost(
          { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          "glm-5.3-flash",
          "peak"
        ) ===
        r.input + r.output
      );
    })(),
    "estimateCost must bill the current window's rates — launch discount ended 2026-09-09 16:00 UTC; list $0.15 in / $0.50 out since"
  );
check(
  "GLM rates return to list after the launch window",
  pricing.ratesFor("glm-5.3-flash", "peak", Date.UTC(2026, 8, 10)).input ===
    0.15
);
check(
  "the route's resilience gates cover OpenRouter",
  (route.match(/target\.providerId === "openrouter"/g) ?? []).length >= 9,
  "pin/retry/empty-stream paths apply to OpenRouter too"
);
check(
  "Settings says one key covers every OpenRouter model",
  /One key covers every OpenRouter model/.test(settings)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
