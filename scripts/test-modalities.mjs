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
const ox = models.MODELS.find((m) => m.id === "ox-alpha");
const qwen = models.MODELS.find((m) => m.id === "qwen-3.8-27b");

check("DeepSeek Pro uses the vision helper", pro?.vision === "helper" && pro?.video === false);
check("DeepSeek Flash uses the vision helper", flash?.vision === "helper" && flash?.video === false);
check("Ox Alpha is a native VLM with video", ox?.vision === "native" && ox?.video === true);
check("Qwen 3.8 27B is a native VLM with video", qwen?.vision === "native" && qwen?.video === true);

check("Pro needs the helper", models.modelNeedsVisionHelper("deepseek-v4-pro"));
check("Flash needs the helper", models.modelNeedsVisionHelper("deepseek-v4-flash"));
check("Ox does not need the helper", models.modelNeedsVisionHelper("ox-alpha") === false);
check("Qwen does not need the helper", models.modelNeedsVisionHelper("qwen-3.8-27b") === false);

check("Ox can watch video", models.modelSeesVideo("ox-alpha"));
check("Qwen can watch video", models.modelSeesVideo("qwen-3.8-27b"));
check("Pro cannot watch video", models.modelSeesVideo("deepseek-v4-pro") === false);
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
  /cannot ` \+\s*`watch MP4/.test(chatSrc) || /cannot watch MP4/.test(chatSrc)
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
  "lightbox Extracted text is gated on description",
  /\{description && \(/.test(lightbox)
);
check(
  "Settings no longer claims every model is DeepSeek-blind",
  /modelNeedsVisionHelper\(model\)/.test(settings) &&
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
check("startEngine passes the projector into sidecarArgs", /sidecarArgs\(gguf, mmproj\)/.test(engine));

console.log("\n8. Free OCR fallback for blind models");

const ocr = await load("src/lib/ocr.ts");
const vision = await load("src/lib/vision.ts");
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
  /describeImageWithFallback/.test(read("src/lib/vision.ts")) &&
    typeof vision.describeImageWithFallback === "function"
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

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);
