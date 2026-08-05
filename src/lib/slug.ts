/**
 * Turns a chat title into a folder name.
 *
 * The point is that `data/` should be readable — "hello-world" rather than
 * "2ff12f96-e9af-4e33-b5c2-7d454023f66c". Everything here exists because a
 * title is arbitrary user text and a folder name is not.
 */

/**
 * Names Windows refuses regardless of extension, inherited from DOS devices.
 * Creating `con/` on Windows fails in a way that looks like a permissions bug.
 */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Long enough to stay readable, short enough to survive path length limits. */
export const MAX_SLUG_LENGTH = 48;

/**
 * Converts a title to a safe folder name.
 *
 * Returns an empty string when nothing usable survives — a title of only
 * emoji, or only punctuation — so the caller can fall back to an id rather
 * than creating a folder named "-".
 */
export function slugify(title: string): string {
  if (typeof title !== "string") return "";

  let s = title
    .normalize("NFKD")
    // Strip accents, so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  // Anything not a plain letter, digit or dash becomes a dash. Deliberately
  // strict: this covers path separators, quotes, NUL, control characters and
  // every reserved Windows character in one rule.
  s = s.replace(/[^a-z0-9]+/g, "-");

  s = s.replace(/^-+|-+$/g, "");

  if (s.length > MAX_SLUG_LENGTH) {
    s = s.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  }

  // Windows silently strips a trailing dot, which would make two different
  // names collide on disk.
  s = s.replace(/\.+$/g, "");

  if (!s) return "";
  if (RESERVED.has(s)) return `${s}-chat`;

  return s;
}

/**
 * A slug that no existing folder is using.
 *
 * Two chats called "hello" must not share a folder, so the second becomes
 * "hello-2". The suffix is appended after truncation so the result still fits.
 */
export function uniqueSlug(
  title: string,
  taken: Set<string>,
  fallback: string
): string {
  const base = slugify(title) || slugify(fallback) || "chat";

  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const trimmed =
      base.length + suffix.length > MAX_SLUG_LENGTH
        ? base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "")
        : base;
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Pathological case: fall back to something guaranteed unique.
  return `${base}-${Date.now().toString(36)}`;
}
