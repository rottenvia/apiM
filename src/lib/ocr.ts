/**
 * Free local OCR for text-only models.
 *
 * DeepSeek's hosted API cannot see pixels. When the user has no OpenAI
 * vision key — or the key is out of credit — we scrape the visible
 * characters here instead of refusing the screenshot. Tesseract on the
 * machine is used when it is installed; otherwise tesseract.js runs in
 * this process. Nothing is sent to a paid API.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const OCR_NOTE =
  "[OCR — free local scrape of visible text only. Layout and non-text details are not described. Add an OpenAI vision key in Settings for a full description.]";

export const OCR_EMPTY =
  "[OCR found no readable text. A photo or a UI without labels needs an OpenAI vision key in Settings.]";

export type { DescriptionSource } from "@/lib/vision";

export function tidyOcrText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Wrap scraped text so DeepSeek knows this is not a full visual description. */
export function formatOcrDescription(raw: string): string {
  const text = tidyOcrText(raw);
  if (!text) return OCR_EMPTY;
  return `${text}\n\n${OCR_NOTE}`;
}

export function isOcrDescription(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes("[OCR —") || text.includes("[OCR found");
}

function tessCacheDir(): string {
  const root = process.env.APIM_DATA_ROOT
    ? path.resolve(process.env.APIM_DATA_ROOT)
    : path.resolve(process.cwd(), "data");
  return path.join(root, "tessdata");
}

function dataUrlToBuffer(
  dataUrl: string
): { buffer: Buffer; ext: string } | null {
  const match = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg")
    ? "jpg"
    : mime.includes("webp")
      ? "webp"
      : mime.includes("gif")
        ? "gif"
        : mime.includes("bmp")
          ? "bmp"
          : "png";
  try {
    return { buffer: Buffer.from(match[2], "base64"), ext };
  } catch {
    return null;
  }
}

/** System Tesseract when the user already has it — faster, no WASM download. */
async function ocrWithCli(buffer: Buffer, ext: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "apim-ocr-"));
  } catch {
    return null;
  }
  const file = path.join(dir, `shot.${ext}`);
  try {
    await writeFile(file, buffer);
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn(
      "tesseract",
      [file, "stdout", "-l", "eng", "--psm", "6"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 45_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      void unlink(file).catch(() => {});
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      void unlink(file).catch(() => {});
      resolve(code === 0 ? out : null);
    });
  });
}

type RecognizeWorker = {
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
};

let workerPromise: Promise<RecognizeWorker> | null = null;
let workerQueue: Promise<unknown> = Promise.resolve();

async function getJsWorker(): Promise<RecognizeWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const cachePath = tessCacheDir();
      await mkdir(cachePath, { recursive: true });
      const { createWorker } = await import("tesseract.js");
      return createWorker("eng", 1, {
        cachePath,
        logger: () => {},
      });
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function ocrWithJs(buffer: Buffer): Promise<string> {
  const worker = await getJsWorker();
  let text = "";
  const run = workerQueue.then(async () => {
    const result = await worker.recognize(buffer);
    text = result.data.text ?? "";
  });
  workerQueue = run.catch(() => {});
  await run;
  return text;
}

export async function extractTextFromImage(
  dataUrl: string
): Promise<{ text?: string; error?: string }> {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) return { error: "Couldn't decode the image for OCR" };
  if (parsed.buffer.length > 8 * 1024 * 1024) {
    return { error: "Image is too large for OCR" };
  }

  const fromCli = await ocrWithCli(parsed.buffer, parsed.ext);
  if (fromCli != null) return { text: fromCli };

  try {
    return { text: await ocrWithJs(parsed.buffer) };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Local OCR failed: ${error.message}`
          : "Local OCR failed",
    };
  }
}

export async function describeWithOcr(
  dataUrl: string
): Promise<{ description?: string; error?: string; source: "ocr" }> {
  const result = await extractTextFromImage(dataUrl);
  if (result.text == null && result.error) {
    return { error: result.error, source: "ocr" };
  }
  return {
    description: formatOcrDescription(result.text ?? ""),
    source: "ocr",
  };
}
