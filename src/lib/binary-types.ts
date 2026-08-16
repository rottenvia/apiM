/** Client-safe executable filename helpers shared by uploads and the server parser. */

export const MAX_PE_UPLOAD_BYTES = 256 * 1024 * 1024;

export const PE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "sys",
  "ocx",
  "scr",
  "cpl",
  "drv",
  "efi",
]);

export function isPeFilename(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return PE_EXTENSIONS.has(ext);
}

function baseName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() ?? value;
}

function safeSegment(value: string, fallback: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_.()+ -]+/g, "-")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 180) || fallback
  );
}

export function binaryUploadPath(name: string): string {
  return `uploads/binaries/${safeSegment(baseName(name), "program.exe")}`;
}

/** Preserve a picked folder's relative layout so same-named DLLs do not collide. */
export function binaryFolderUploadPath(folder: string, relative: string): string {
  const root = safeSegment(folder, "program").slice(0, 80);
  const pieces = relative
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => safeSegment(part, "file"));
  return `uploads/binaries/${root}/${pieces.join("/") || "program.exe"}`;
}

/** Deterministic output root shared by static artifacts and decompilers. */
export function binaryAnalysisRoot(name: string, sha256: string): string {
  const stem = safeSegment(baseName(name).replace(/\.[^.]+$/, ""), "binary")
    .slice(0, 80);
  return `analysis/${stem}-${sha256.slice(0, 12)}`;
}
