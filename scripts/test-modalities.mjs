/**
 * Per-model vision and video: DeepSeek is blind, Ox and Qwen see pixels.
 *
 * Run:  npm run test:modalities
 *
 * The reported bugs:
 *   - Ox Alpha is multimodal but the app always called /api/vision
 *   - extracted text showed on Ox (helper ran, or helper balance died)
 *   - MP4 was refused for every model
 *   - Qwen 3.8 27B is a native VLM and must not need a vision key
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

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const models = await load("src/lib/models.ts");
const A = await load("src/lib/attachments.ts");
const mm = await load("src/lib/multimodal.ts");
const shared = await load("src/lib/local-engine-shared.ts");

const chatSrc = read("src/components/ChatArea.tsx");
const route = read("src/app/api/chat/route.ts");
const settings = read("src/components/SettingsModal.tsx");
const chips = read("src/components/AttachmentChips.tsx");
const lightbox = read("src/components/ImageLightbox.tsx");
const plugins = read("src/lib/plugins.ts");
const history = read("src/lib/chat-history.ts");
const engine = read("src/lib/local-engine.ts");

console.log("\napiM modality checks\n");

console.log("1. Catalog capabilities");

const pro = models.MODELS.find((m) => m.id === "deepseek-v4-pro");
const flash = models.MODELS.find((m) => m.id === "deepseek-v4-flash");
const glm = models.MODELS.find((m) => m.id === "glm-5.3-flash");
const freeNemotron = models.MODELS.find((m) => m.id === "nvidia-nemotron-3-ultra-free");
const qwen = models.MODELS.find((m) => m.id === "qwen-3.8-27b");

check("DeepSeek Pro uses the vision helper", pro?.vision === "helper" && pro?.video === false);
check("DeepSeek Flash uses the vision helper", flash?.vision === "helper" && flash?.video === false);
check("GLM 5.3 Flash is a native VLM with video", glm?.vision === "native" && glm?.video === true);
check("Qwen 3.8 27B is a native VLM with video", qwen?.vision === "native" && qwen?.video === true);

check("Pro needs the helper", models.modelNeedsVisionHelper("deepseek-v4-pro"));
check("Flash needs the helper", models.modelNeedsVisionHelper("deepseek-v4-flash"));
check("GLM does not need the helper", models.modelNeedsVisionHelper("glm-5.3-flash") === false);
check("Qwen does not need the helper", models.modelNeedsVisionHelper("qwen-3.8-27b") === false);

    check("the Nemotron free lane cannot watch video", models.modelSeesVideo("nvidia-nemotron-3-ultra-free") === false);
    check("Qwen can watch video", models.modelSeesVideo("qwen-3.8-27b"));
    check("GLM can watch video", models.modelSeesVideo("glm-5.3-flash"));
check("Pro cannot watch video", models.modelSeesVideo("deepseek-v4-pro") === false);
check(
  "V4.1 Flash is a native VLM without video",
  models.MODELS.find((m) => m.id === "deepseek-v4.1-flash")?.vision === "native" &&
    models.modelSeesVideo("deepseek-v4.1-flash") === false &&
    models.modelNeedsVisionHelper("deepseek-v4.1-flash") === false
);
check("all catalog models can receive images somehow", models.MODELS.every((m) => models.modelSeesImages(m.id)));

console.log("\n2. Wire format");

const shot = {
  name: "screen.png",
  kind: "image",
  dataUrl: "data:image/png;base64,aaa",
  description: "a red button",
};
const clip = {
  name: "clip.mp4",
  kind: "video",
  dataUrl: "data:video/mp4;base64,bbb",
};

const native = mm.buildUserContent("what is this?", [shot, clip], "native");
check("native content is an array of parts", Array.isArray(native));
check(
  "native sends the typed text plus image_url and video_url",
  Array.isArray(native) &&
    native.some((p) => p.type === "text" && p.text === "what is this?") &&
    native.some((p) => p.type === "image_url" && p.image_url.url === shot.dataUrl) &&
    native.some((p) => p.type === "video_url" && p.video_url.url === clip.dataUrl)
);
check(
  "native does not inline the helper description",
  Array.isArray(native) &&
    !native.some((p) => p.type === "text" && /a red button/.test(p.text))
);

const helperNow = mm.buildUserContent(
  `<image name="screen.png">\na red button\n</image>\n\nwhat is this?`,
  [shot],
  "helper"
);
check(
  "helper current turn keeps the already-inlined description",
  typeof helperNow === "string" && helperNow.includes("a red button")
);

const helperReplay = mm.buildUserContent("what is this?", [shot], "helper");
check(
  "helper history rebuilds <image> from the stored description",
  typeof helperReplay === "string" &&
    helperReplay.includes('<image name="screen.png">') &&
    helperReplay.includes("a red button")
);

const emptyNative = mm.buildUserContent("", [shot], "native");
check("a screenshot-only native turn is still content", mm.userHasContent(emptyNative));
check("empty string is not content", mm.userHasContent("") === false);

console.log("\n3. Composer builder");

const imageAtt = {
  id: "1",
  name: "screen.png",
  size: 12,
  content: "",
  truncated: false,
  kind: "image",
  dataUrl: shot.dataUrl,
  description: "a red button",
};
const textAtt = {
  id: "2",
  name: "notes.txt",
  size: 4,
  content: "hi",
  truncated: false,
  kind: "text",
};

const helperBuilt = A.buildMessageWithAttachments("look", [imageAtt, textAtt], "helper");
check(
  "helper inlines the description for DeepSeek",
  helperBuilt.includes("<image name=\"screen.png\">") && helperBuilt.includes("a red button")
);
check("helper still inlines text files", helperBuilt.includes("```txt") && helperBuilt.includes("hi"));

const nativeBuilt = A.buildMessageWithAttachments("look", [imageAtt, textAtt], "native");
check(
  "native does not dump extracted text into the typed message",
  !nativeBuilt.includes("<image") && !nativeBuilt.includes("a red button")
);
check("native still inlines text files", nativeBuilt.includes("hi"));

check("mp4 is recognised", A.isVideoFile({ type: "video/mp4", name: "clip.mp4" }));
check("a .mov is not treated as supported video", A.isVideoFile({ type: "video/quicktime", name: "clip.mov" }) === false);
check(
  "the text reader still refuses mp4",
  /video/.test(A.binaryFormatNote("clip.mp4") ?? "")
);

console.log("\n4. Composer does not call the helper on a seeing model");

check(
  "ChatArea gates /api/vision on modelNeedsVisionHelper",
  /if \(!modelNeedsVisionHelper\(model\)\) return/.test(chatSrc) &&
    /modelNeedsVisionHelper\(model\)/.test(chatSrc)
);
check(
  "ChatArea only analyzes accepted images on a helper model",
  /if \(modelNeedsVisionHelper\(model\)\) \{\s*for \(const image of accepted/.test(chatSrc)
);
check(
  "readImageFile is told not to spin the helper chip on native",
  /analyze: modelNeedsVisionHelper\(model\)/.test(chatSrc)
);
  check(
    "MP4 is refused on DeepSeek with a model-specific error",
    /cannot ` \+\s*`watch video/.test(chatSrc) || /cannot watch video/.test(chatSrc)
  );
check("ChatArea persists helper descriptions", /description: a\.description/.test(chatSrc));
check(
  "send is blocked while a video is attached to a blind model",
  /blockedVideo/.test(chatSrc)
);

console.log("\n5. Chat route and history");

check("the route builds multimodal user content", /buildUserContent\(userText, attachments, vision\)/.test(route));
check("history attachments are replayed", /buildUserContent\(\s*msg\.content/.test(route));
check("history keeps screenshot-only turns", /entry\.attachments\?\.length/.test(history));
check(
  "an empty typed message is allowed when files are attached",
  /!userText\.trim\(\) && !attachments\?\.length/.test(route)
);
check(
  "plugin directives are still appended last every round",
  /while \(true\) \{\s*round \+= 1;\s*appendPluginDirectives\(\)/.test(route)
);
check(
  "the directive marker is unchanged",
  /ACTIVE USER CONFIGURATION — RESPONSE BEHAVIOR/.test(plugins)
);

console.log("\n6. Extracted-text UI");

check(
  "chips only overlay helper description when one exists",
  /file\.description && !file\.analyzing/.test(chips)
);
check(
  "the lightbox offers text for ANY image, not only helper-described ones",
  /\(description \|\| kind === "image"\) && \(/.test(lightbox),
  "on a native VLM there is no description, and the button used to vanish " +
    "entirely — so a screenshot could not be read by the human either"
);
check(
  "…and on-demand extraction is labelled as the user's copy, not the model's input",
  /this text was never/.test(lightbox) && /extract/i.test(lightbox)
);
check(
  "OCR output is scrubbed before it is rendered",
  /tidyExtractedText/.test(lightbox),
  "control characters and replacement glyphs are what made it look bugged"
);
check(
  "Settings no longer claims every model is DeepSeek-blind",
  /currentModel\.vision === "helper"/.test(settings) &&
    !/DeepSeek can&apos;t read images, so attached screenshots are\s+described by an OpenAI vision model first\./.test(
      settings
    )
);
check(
  "Settings says Ox/Qwen see images themselves",
  /sees images/.test(settings) && /no\s+vision provider is used/.test(settings)
);

console.log("\n7. Qwen sidecar vision projector");

check("mmproj URL is the official bartowski f16 file", /mmproj-Qwen3\.8-27B-f16\.gguf/.test(shared.MMPROJ_URL));
check("the mmproj URL is allow-listed", shared.isAllowedDownloadUrl(shared.MMPROJ_URL));
const withProj = shared.sidecarArgs("/tmp/qwen.gguf", "/tmp/mmproj.gguf");
check(
  "sidecarArgs adds --mmproj when the projector is on disk",
  withProj.includes("--mmproj") && withProj[withProj.indexOf("--mmproj") + 1] === "/tmp/mmproj.gguf"
);
const noProj = shared.sidecarArgs("/tmp/qwen.gguf");
check("sidecarArgs without a projector stays text-only", !noProj.includes("--mmproj"));
check("downloadEngine pulls the projector", /MMPROJ_URL/.test(engine) && /mmprojPath\(\)/.test(engine));
check("startEngine passes the projector into sidecarArgs", /sidecarArgs\(gguf, mmproj/.test(engine));

console.log("\n8. Free OCR fallback for blind models");

const ocr = await load("src/lib/ocr.ts");
const visionRoute = read("src/app/api/vision/route.ts");
const toolsSrc = read("src/lib/tools.ts");

const scraped = ocr.formatOcrDescription("ERROR: file not found\n  at main.ts:12");
check(
  "OCR wraps scraped text with an honest note",
  scraped.startsWith("ERROR: file not found") && /\[OCR —/.test(scraped)
);
check("empty OCR says no readable text", /no readable text/i.test(ocr.formatOcrDescription("   \n")));
check("OCR descriptions are recognisable", ocr.isOcrDescription(scraped));
check("a vision description is not labelled OCR", ocr.isOcrDescription("a red button") === false);

check(
  "vision helper falls back to OCR",
  /describeImageWithFallback/.test(read("src/lib/ocr.ts")) &&
    typeof ocr.describeImageWithFallback === "function"
);
check(
  "vision.ts stays out of the browser OCR graph",
  !/tesseract|from \"@\/lib\/ocr\"|from '@\/lib\/ocr'/.test(read("src/lib/vision.ts"))
);
check(
  "ChatArea never imports ocr or tesseract",
  !/tesseract|@\/lib\/ocr/.test(chatSrc)
);
check(
  "the vision route does not require an API key",
  /describeImageWithFallback/.test(visionRoute) &&
    !/if \(!apiKey\)/.test(visionRoute)
);
check(
  "ChatArea still calls /api/vision without a key",
  /apiKey: visionKey \|\| undefined/.test(chatSrc) &&
    !/Add a vision API key in Settings to read screenshots/.test(chatSrc)
);
check(
  "Settings says OCR is free when there is no OpenAI key",
  /free OCR/.test(settings) && /no OpenAI key or/.test(settings)
);
check(
  "view_image uses the OCR fallback instead of refusing",
  /describeImageWithFallback/.test(toolsSrc) &&
    !/No vision key is configured, so images cannot be viewed/.test(toolsSrc)
);

console.log("\n9. Open tool limits are a custom-model opt-in; the catalog stays capped");

const limits = await load("src/lib/tool-limits.ts");

check(
  "no catalog model opts into open tool limits",
  models.MODELS.every((m) => m.openToolLimits === false)
);
check("DeepSeek Pro stays capped", pro?.openToolLimits === false);
check("DeepSeek Flash stays capped", flash?.openToolLimits === false);
check("Qwen 3.8 27B stays capped", qwen?.openToolLimits === false);
check(
  "every catalog model declares the flag",
  models.MODELS.every((m) => typeof m.openToolLimits === "boolean")
);
check(
  "modelHasOpenToolLimits honors the custom override",
  limits.modelHasOpenToolLimits("custom:anything", true) === true
);
check(
  "without the override a custom stays capped",
  limits.modelHasOpenToolLimits("custom:anything") === false
);
check(
  "DeepSeek Pro is not open",
  limits.modelHasOpenToolLimits("deepseek-v4-pro") === false
);
check(
  "Qwen is not open",
  limits.modelHasOpenToolLimits("qwen-3.8-27b") === false
);
check(
  "an unknown id falls back to the capped default",
  limits.modelHasOpenToolLimits("nope") === false
);

const defaultLimits = limits.toolLimitsFor("deepseek-v4-pro");
const openLimits = limits.toolLimitsFor("deepseek-v4-pro", true);
const qwenLimits = limits.toolLimitsFor("qwen-3.8-27b");
check(
  "default ceilings are unchanged",
  defaultLimits.readFiles === 60 &&
    defaultLimits.writeFiles === 30 &&
    defaultLimits.batchEdits === 40 &&
    defaultLimits.readChars === 400_000 &&
    defaultLimits.searchHits === 60 &&
    defaultLimits.fetchChars === 200_000 &&
    defaultLimits.docChars === 800_000 &&
    defaultLimits.open === false
);
check(
  "the open ceilings are high enough that a real project is not cut",
  openLimits.open === true &&
    openLimits.readFiles >= 10_000 &&
    openLimits.writeFiles >= 10_000 &&
    openLimits.batchEdits >= 10_000 &&
    openLimits.readChars >= 8_000_000 &&
    openLimits.searchHits >= 10_000 &&
    openLimits.fetchChars >= 4_000_000 &&
    openLimits.docChars >= 8_000_000
);
check(
  "the override is per-call, not sticky",
  limits.toolLimitsFor("deepseek-v4-pro").open === false
);
check(
  "Qwen still uses the default ceilings",
  qwenLimits.readFiles === defaultLimits.readFiles &&
    qwenLimits.readChars === defaultLimits.readChars &&
    qwenLimits.open === false
);

// Isolate workspace/tools under a temp data root. Those modules snapshot
// APIM_DATA_ROOT at import time, so this has to happen before they load.
const { mkdtemp, rm } = await import("node:fs/promises");
const os = await import("node:os");
const tmpData = await mkdtemp(path.join(os.tmpdir(), "apim-open-limits-"));
process.env.APIM_DATA_ROOT = tmpData;

const toolsMod = await load("src/lib/tools.ts");
const isolatedWs = await load("src/lib/workspace.ts");
const defaultTools = toolsMod.workspaceToolsFor("deepseek-v4-pro");
const unlockedTools = toolsMod.workspaceToolsFor("deepseek-v4-pro", true);
const qwenTools = toolsMod.workspaceToolsFor("qwen-3.8-27b");
const readFilesDefault = defaultTools.find((t) => t.function.name === "read_files");
const readFilesOpen = unlockedTools.find((t) => t.function.name === "read_files");
check(
  "DeepSeek still sees the 60-file cap in the schema",
  /up to 60/.test(JSON.stringify(readFilesDefault))
);
check(
  "an open-limits model is not told to stop at 60 files",
  /No per-call cap/.test(JSON.stringify(readFilesOpen)) &&
    !/up to 60/.test(JSON.stringify(readFilesOpen))
);
check(
  "Qwen gets the same capped schema as DeepSeek",
  JSON.stringify(qwenTools) === JSON.stringify(defaultTools)
);
check(
  "the default export still lists the same tools",
  toolsMod.WORKSPACE_TOOLS.map((t) => t.function.name).join(",") ===
    defaultTools.map((t) => t.function.name).join(",")
);

check(
  "the chat route builds the tool list per model",
  /workspaceToolsFor\(\s*model,[\s\S]{0,60}target\.model\.openToolLimits/.test(route) && !/WORKSPACE_TOOLS\.filter/.test(route)
);
check(
  "every runTool call carries the model id",
  (route.match(/modelId: model/g) ?? []).length >= 3
);
check(
  "an open-limits model can view_image without a vision key",
  /Boolean\(visionApiKey\) \|\| modelHasOpenToolLimits\(model,[^)]*\)/.test(route)
);
check(
  "the workspace prompt tells open models the ceilings are off",
  /This model has no per-call tool ceilings/.test(route)
);
check(
  "plugin directives are still appended last every round",
  /while \(true\) \{\s*round \+= 1;\s*appendPluginDirectives\(\)/.test(route)
);
check(
  "the directive marker is unchanged",
  /ACTIVE USER CONFIGURATION — RESPONSE BEHAVIOR/.test(plugins)
);
check(
  "vision.ts still stays out of the browser OCR graph",
  !/tesseract|from "@\/lib\/ocr"|from '@\/lib\/ocr'/.test(read("src/lib/vision.ts"))
);

const liveWs = "custom-open-limits";
const oversized = `${"x".repeat(401_000)}TAIL-MARKER`;
await isolatedWs.writeFile(liveWs, "big.txt", oversized);

const defaultRead = await toolsMod.runTool(liveWs, "read_file", {
  path: "big.txt",
});
const openRead = await toolsMod.runTool(
  liveWs,
  "read_file",
  { path: "big.txt" },
  { modelId: "custom:big", openLimits: true }
);
const qwenRead = await toolsMod.runTool(
  liveWs,
  "read_file",
  { path: "big.txt" },
  { modelId: "qwen-3.8-27b" }
);
check(
  "a 401k file is truncated for the default model",
  defaultRead.ok &&
    /truncated/.test(defaultRead.content) &&
    !defaultRead.content.includes("TAIL-MARKER")
);
check(
  "an open-limits custom reads the whole 401k file",
  openRead.ok &&
    openRead.content.includes("TAIL-MARKER") &&
    !/truncated/.test(openRead.content)
);
check(
  "Qwen is still truncated at the default ceiling",
  qwenRead.ok &&
    /truncated/.test(qwenRead.content) &&
    !qwenRead.content.includes("TAIL-MARKER")
);

const overflow = Array.from({ length: 63 }, (_, i) => `missing-${i}.txt`);
const defaultBatch = await toolsMod.runTool(liveWs, "read_files", {
  paths: overflow,
});
const openBatch = await toolsMod.runTool(
  liveWs,
  "read_files",
  { paths: overflow },
  { modelId: "custom:big", openLimits: true }
);
const flashBatch = await toolsMod.runTool(
  liveWs,
  "read_files",
  { paths: overflow },
  { modelId: "deepseek-v4-flash" }
);
check(
  "default read_files still drops paths past 60",
  /NOT READ/.test(defaultBatch.content) && /missing-60\.txt/.test(defaultBatch.content)
);
check(
  "an open-limits custom read_files keeps all 63 paths",
  !/NOT READ/.test(openBatch.content) && /missing-62\.txt/.test(openBatch.content)
);
check(
  "DeepSeek Flash still drops paths past 60",
  /NOT READ/.test(flashBatch.content)
);

  // Video rides native by default; frames mode stays one click away

  const framesAtt = {
    name: "clip.mp4",
    kind: "video",
    frames: [
      { dataUrl: "data:image/jpeg;base64,AAAA", t: 0 },
      { dataUrl: "data:image/jpeg;base64,BBBB", t: 2 },
      { dataUrl: "data:image/jpeg;base64,CCCC", t: 4 },
    ],
    durationSec: 6,
    frameIntervalSec: 2,
  };

  const framesParts = mm.buildUserContent(
    "what is the speed at second 5?",
    [framesAtt],
    "native"
  );
  check(
    "a frames video rides as image parts with a timing header, no video_url",
    framesParts.some((p) => p.type === "text" && /one every 2s/.test(p.text)) &&
      framesParts.filter((p) => p.type === "image_url").length === 3 &&
      !framesParts.some((p) => p.type === "video_url"),
    "the video pipeline that chokes on long prefills is never touched"
  );

  const framesWindowed = mm.buildUserContent("hi", [framesAtt], "native", {
    mediaWindow: { images: true, videos: false },
  });
  check(
    "a frames video windows exactly like a native video",
    !framesWindowed.some((p) => p.type === "image_url") &&
      framesWindowed.some(
        (p) => p.type === "text" && /video as frames/.test(p.text)
      ),
    "32 stills must not re-bill on every old round"
  );

  const nativeStill = mm.buildUserContent(
    "hi",
    [{ name: "old.mp4", kind: "video", dataUrl: "data:video/mp4;base64,AAAA" }],
    "native"
  );
  check(
    "old native videos still ride as video_url",
    nativeStill.some((p) => p.type === "video_url"),
    "stored conversations from before frames mode keep working"
  );

  const chipsSrc = read("src/components/AttachmentChips.tsx");
  const bubbleSrc = read("src/components/MessageBubble.tsx");
  check(
    "the composer attaches videos natively; the chip toggle opts into frames",
    /readVideoFile\(item\.file\)/.test(chatSrc) &&
      /readVideoFileFrames\(file, \{ id \}\)/.test(chatSrc),
    "the native MP4 is the default ride; extraction stays one click away"
  );
  check(
    "the chip and bubble render the frame strip and offer the native toggle",
    /frames\[0\]\.dataUrl/.test(chipsSrc) &&
      /onSwitchVideoMode/.test(chipsSrc) &&
      /frames\[0\]\.dataUrl/.test(bubbleSrc),
    "first frame is the thumbnail; the toggle keeps audio reachable"
  );

  console.log("\n10. Videos ride once — the 54M-body leak is closed");

  const videoMsg = {
    role: "user",
    content: [
      { type: "text", text: "what is the speed at second 10?" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
    ],
  };
  const stripped = mm.stripRideAlongVideos(
    [
      { role: "system", content: "sys" },
      videoMsg,
      { role: "assistant", content: "around 140" },
      { role: "user", content: "okay where did you land the new update?" },
    ],
    false
  );
  check(
    "a resumed/mid-run round replaces the old clip with a reference",
    !JSON.stringify(stripped).includes('"video_url"') &&
      JSON.stringify(stripped).includes("already rode once") &&
      typeof stripped[3].content === "string",
    "the provider ingested the frames on the first ride; replaying ~54M chars of base64 priced OpenRouter's estimate past small balances"
  );
  check(
    "the opening request of a fresh send still carries the clip",
    mm
      .stripRideAlongVideos(
        [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: [
              { type: "video_url", video_url: { url: "data:video/mp4;base64,CCC" } },
            ],
          },
        ],
        true
      )
      .some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((p) => p.type === "video_url")
      ),
    "the round that introduces the clip still needs the pixels"
  );
  check(
    "the strip is a wire-copy only — stored transcripts keep their originals",
    videoMsg.content.some((p) => p.type === "video_url")
  );
  check(
    "a frames-mode group (cadence header + stills) is stripped on resume rounds",
    (() => {
      const framesRide = {
        role: "user",
        content: [
          {
            type: "text",
            text: '[Video "run.mp4" — 3 still frames, one every 2s]',
          },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,FFF1" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,FFF2" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,FFF3" } },
        ],
      };
      const out = mm.stripRideAlongVideos(
        [framesRide, { role: "user", content: "next" }],
        false
      );
      return (
        !JSON.stringify(out).includes("image_url") &&
        JSON.stringify(out).includes("already rode once")
      );
    })(),
    "the video-only guard was blind to image groups — a frames clip re-rode every resumed round"
  );
  check(
    "inline base64 blobs inside string content are stripped (legacy carriers)",
    (() => {
      const blob =
        "before data:image/jpeg;base64," + "A".repeat(150000) + " after";
      const out = mm.stripRideAlongVideos(
        [{ role: "user", content: blob }, { role: "user", content: "next" }],
        false
      );
      return (
        typeof out[0].content === "string" &&
        !out[0].content.includes("AAAA") &&
        out[0].content.includes("[media omitted")
      );
    })(),
    "a string sails past any part-based guard — the last unguarded encoding"
  );
  check(
    "string content without media passes through byte-identical",
    (() => {
      const out = mm.stripRideAlongVideos(
        [{ role: "user", content: "plain text question" }],
        false
      );
      return out[0].content === "plain text question";
    })(),
    "the legacy path pays nothing when there is nothing to strip"
  );

  await rm(tmpData, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
