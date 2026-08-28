/**
 * One verifier instead of fifteen hand-forged ones.
 *
 * From the retro: "I hand-forged fifteen verify scripts this campaign alone —
 * every one the same skeleton: required/absent literals in UTF-8 and
 * UTF-16LE, size, sha256, honest failures." That is a tool wearing a script's
 * clothes. Worse, each re-clone was a chance to get it subtly wrong, and a
 * verifier that is subtly wrong is more dangerous than none: it signs off on
 * a build nobody checked.
 *
 * The design rules that matter here:
 *
 *   - **Both encodings, always.** A C++ string literal lands as UTF-8; the
 *     same words in a wide literal, a .rc file or a managed assembly land as
 *     UTF-16LE. Searching one encoding is how a marker "goes missing" from a
 *     binary that contains it.
 *
 *   - **Absent means absent in BOTH.** The v16 suffix that was supposed to be
 *     extinct has to be gone from the wide strings too, or the check is
 *     theatre.
 *
 *   - **Failures are specific.** "ALL MARKERS OK 4/4" is only worth anything
 *     if the failing case says which marker, in which encoding, and where the
 *     nearest thing to it was found.
 */

import { createHash } from "node:crypto";

export interface MarkerSpec {
  /** Literals that MUST be present. */
  required?: string[];
  /** Literals that must NOT be present — the ones you deleted. */
  absent?: string[];
  /** Expected sha256, when you have one to compare against. */
  sha256?: string | null;
  /** Exact expected size in bytes. */
  bytes?: number | null;
  minBytes?: number | null;
  maxBytes?: number | null;
  /** Default ["utf8", "utf16le"]. */
  encodings?: ("utf8" | "utf16le")[];
}

export interface MarkerHit {
  marker: string;
  kind: "required" | "absent";
  ok: boolean;
  /** Where it was found, per encoding. */
  found: { encoding: string; offset: number }[];
}

export interface MarkerReport {
  bytes: number;
  sha256: string;
  hits: MarkerHit[];
  /** Size/hash checks that were asked for and their verdicts. */
  checks: { label: string; ok: boolean; detail: string }[];
  ok: boolean;
  passed: number;
  total: number;
}

/** Byte offset of `needle` in `haystack`, or -1. Plain Boyer-Moore-free scan. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  const first = needle[0];
  const limit = haystack.length - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function encode(text: string, encoding: "utf8" | "utf16le"): Uint8Array {
  return new Uint8Array(Buffer.from(text, encoding));
}

/** Check a file's bytes against a marker spec. Reads nothing itself. */
export function verifyMarkers(
  bytes: Uint8Array,
  spec: MarkerSpec
): MarkerReport {
  const encodings = spec.encodings?.length
    ? spec.encodings
    : (["utf8", "utf16le"] as const);

  const hash = createHash("sha256").update(bytes).digest("hex");
  const hits: MarkerHit[] = [];

  for (const marker of spec.required ?? []) {
    const found: { encoding: string; offset: number }[] = [];
    for (const encoding of encodings) {
      const at = indexOfBytes(bytes, encode(marker, encoding));
      if (at >= 0) found.push({ encoding, offset: at });
    }
    // Present in EITHER encoding is present: a UTF-8 literal is not expected
    // to also exist as a wide string.
    hits.push({ marker, kind: "required", ok: found.length > 0, found });
  }

  for (const marker of spec.absent ?? []) {
    const found: { encoding: string; offset: number }[] = [];
    for (const encoding of encodings) {
      const at = indexOfBytes(bytes, encode(marker, encoding));
      if (at >= 0) found.push({ encoding, offset: at });
    }
    // Absent means absent in every encoding checked.
    hits.push({ marker, kind: "absent", ok: found.length === 0, found });
  }

  const checks: MarkerReport["checks"] = [];
  if (spec.sha256) {
    const want = spec.sha256.trim().toLowerCase();
    // A prefix is accepted because that is how humans quote a hash.
    const ok = hash === want || hash.startsWith(want);
    checks.push({
      label: "sha256",
      ok,
      detail: ok ? `${hash} matches` : `expected ${want}, got ${hash}`,
    });
  }
  if (typeof spec.bytes === "number") {
    const ok = bytes.length === spec.bytes;
    checks.push({
      label: "size",
      ok,
      detail: ok
        ? `${bytes.length} bytes as expected`
        : `expected ${spec.bytes} bytes, got ${bytes.length} (${
            bytes.length - spec.bytes > 0 ? "+" : ""
          }${bytes.length - spec.bytes})`,
    });
  }
  if (typeof spec.minBytes === "number") {
    const ok = bytes.length >= spec.minBytes;
    checks.push({
      label: "min size",
      ok,
      detail: `${bytes.length} bytes vs minimum ${spec.minBytes}`,
    });
  }
  if (typeof spec.maxBytes === "number") {
    const ok = bytes.length <= spec.maxBytes;
    checks.push({
      label: "max size",
      ok,
      detail: `${bytes.length} bytes vs maximum ${spec.maxBytes}`,
    });
  }

  const passed =
    hits.filter((h) => h.ok).length + checks.filter((c) => c.ok).length;
  const total = hits.length + checks.length;

  return {
    bytes: bytes.length,
    sha256: hash,
    hits,
    checks,
    ok: passed === total,
    passed,
    total,
  };
}

export function formatMarkerReport(
  report: MarkerReport,
  label: string
): string {
  const out: string[] = [
    `${label} — ${report.bytes.toLocaleString()} bytes, sha256 ${report.sha256}`,
    "",
    report.total === 0
      ? "No markers were requested, so nothing was verified — this is a size " +
        "and hash reading only."
      : report.ok
        ? `ALL MARKERS OK ${report.passed}/${report.total}`
        : `MARKER CHECK FAILED — ${report.passed}/${report.total} passed`,
  ];

  if (report.hits.length) out.push("");
  for (const hit of report.hits) {
    const where = hit.found
      .map((f) => `${f.encoding}@${f.offset}`)
      .join(", ");
    if (hit.kind === "required") {
      out.push(
        hit.ok
          ? `  OK      present: ${JSON.stringify(hit.marker)} (${where})`
          : `  MISSING required: ${JSON.stringify(hit.marker)} — not found ` +
            `as UTF-8 or UTF-16LE. Either the build did not pick up your ` +
            `change, or the literal is spelled differently in the source.`
      );
    } else {
      out.push(
        hit.ok
          ? `  OK      absent: ${JSON.stringify(hit.marker)}`
          : `  STILL THERE: ${JSON.stringify(hit.marker)} at ${where} — the ` +
            `old text survived the build, so this binary is not the one you ` +
            `think it is.`
      );
    }
  }

  if (report.checks.length) {
    out.push("");
    for (const check of report.checks) {
      out.push(`  ${check.ok ? "OK     " : "FAILED "} ${check.label}: ${check.detail}`);
    }
  }

  return out.join("\n");
}
