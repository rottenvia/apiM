import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceDirectory } from "@/lib/workspace";

/**
 * What the agent has learned about this project, and how it unlearns it.
 *
 * The existing "Self-Critic" plugin is a sentence in the prompt telling the
 * model to review its work. Nothing is written down and nothing persists, so
 * every reply starts from zero and the same wrong turn gets taken again. It
 * is advice, not learning.
 *
 * A lesson here is different in one specific way: it must come from something
 * that actually happened. A command exited non-zero, a tool returned an
 * error, a test passed. Speculation — "there might be a race condition here"
 * — is exactly what the plugin already does badly and is not a lesson.
 *
 * The important part is that lessons are falsifiable. Each one records the
 * evidence that produced it, so when reality later contradicts it, it can be
 * corrected automatically rather than sitting there being wrong forever. The
 * arbiter is the exit code, not the model's opinion of its own note.
 *
 * Scope is one workspace, which is one chat. Lessons about a Chrome extension
 * are noise in a Roblox project, and worse than noise if the model tries to
 * apply them.
 */

/** Where the file lives. Visible in the file panel on purpose. */
export const LESSONS_FILE = "LESSONS.md";

/**
 * Ceiling on how many lessons are kept.
 *
 * The point of a lesson is to be cheaper than the mistake it prevents. An
 * unbounded file stops being that: it is carried on every round of every
 * later task, which is precisely the bloat that made long runs expensive in
 * the first place. Forty short lines is a few hundred tokens.
 */
export const MAX_LESSONS = 40;

/** A single line's ceiling, so one lesson cannot become an essay. */
export const MAX_LESSON_CHARS = 240;

export interface Lesson {
  /** Stable id, so a later pass can revise this exact lesson. */
  id: string;
  /** What was learned, in one line. */
  text: string;
  /**
   * What proved it: a command and its exit code, a tool error, a test result.
   * A lesson without evidence is a guess, and guesses are refused.
   */
  evidence: string;
  /** How many times reality has since agreed with it. */
  confirmed: number;
  /** How many times reality has since contradicted it. */
  contradicted: number;
  /** Set when a later run disproved it, with what replaced it. */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

function lessonsPath(workspaceId: string): string {
  return path.join(workspaceDirectory(workspaceId), LESSONS_FILE);
}

/**
 * Confidence in a lesson, from how reality has voted on it.
 *
 * Deliberately not the model's own estimate. A model asked how sure it is
 * will say "high" about a thing it invented; a count of how often a command
 * actually worked cannot be talked into anything.
 */
export function confidenceOf(lesson: Lesson): "high" | "medium" | "low" {
  if (lesson.contradicted > lesson.confirmed) return "low";
  if (lesson.confirmed >= 2) return "high";
  return "medium";
}

/**
 * The file is Markdown, not JSON, because it is meant to be read.
 *
 * It sits in the workspace where the user can open it, and a JSON blob of
 * escaped strings is not something anyone reads voluntarily. The structured
 * fields ride along in an HTML comment, which Markdown hides.
 */
function serialise(lessons: Lesson[]): string {
  const lines = [
    "# What I've learned about this project",
    "",
    "Written by the agent from things that actually happened — a command that",
    "failed, a test that passed, a tool that errored. Each entry keeps the",
    "evidence behind it. When Learning is enabled, a later completed run can",
    "revise a contradicted entry. Safe to edit or delete by hand.",
    "",
  ];

  for (const l of lessons) {
    const confidence = confidenceOf(l);
    const mark = l.supersededBy ? "~~" : "";
    lines.push(
      `- ${mark}${l.text}${mark}  ` +
        `<sub>${confidence} confidence · ${l.evidence}</sub>`
    );
    lines.push(
      `  <!--lesson ${JSON.stringify({
        id: l.id,
        confirmed: l.confirmed,
        contradicted: l.contradicted,
        supersededBy: l.supersededBy,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        evidence: l.evidence,
        text: l.text,
      })}-->`
    );
  }

  return lines.join("\n") + "\n";
}

function parse(raw: string): Lesson[] {
  const out: Lesson[] = [];
  for (const match of raw.matchAll(/<!--lesson ([\s\S]*?)-->/g)) {
    try {
      const parsed = JSON.parse(match[1]) as Partial<Lesson>;
      if (!parsed.id || !parsed.text) continue;
      out.push({
        id: parsed.id,
        text: parsed.text,
        evidence: parsed.evidence ?? "",
        confirmed: parsed.confirmed ?? 0,
        contradicted: parsed.contradicted ?? 0,
        supersededBy: parsed.supersededBy,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      });
    } catch {
      // A hand-edited file with a broken comment should lose one lesson, not
      // the whole file.
    }
  }
  return out;
}

export async function readLessons(workspaceId: string): Promise<Lesson[]> {
  try {
    return parse(await fs.readFile(lessonsPath(workspaceId), "utf8"));
  } catch {
    return []; // No file yet, which is the normal case.
  }
}

/**
 * Delete the workspace's learned lessons (its "memory").
 *
 * Returns how many were removed. Used by the forget tool and by the user
 * clicking "clear memory" — lessons are a convenience, not a record the
 * app has to keep, and a stale lesson about a file that no longer exists
 * is worse than none.
 */
export async function clearLessons(workspaceId: string): Promise<number> {
  const existing = await readLessons(workspaceId);
  try {
    await fs.unlink(lessonsPath(workspaceId));
  } catch {
    // Already gone — count is still accurate from the read.
  }
  return existing.length;
}

/**
 * Drop lessons about files that no longer exist in the workspace and
 * lessons older than `maxAgeDays` that were never confirmed.
 *
 * This is what stops "focused-functions.c is 5700 lines" being carried
 * into every future task long after the sample directory was deleted.
 * Cheap to run at the start of a turn.
 */
export async function pruneLessons(
  workspaceId: string,
  options: { maxAgeDays?: number } = {}
): Promise<number> {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const lessons = await readLessons(workspaceId);
  if (lessons.length === 0) return 0;

  const now = Date.now();
  const kept = lessons.filter((l) => {
    const ageDays = (now - new Date(l.updatedAt).getTime()) / 86_400_000;
    // Keep anything the model has confirmed.
    if (l.confirmed > 0) return true;
    // Drop unconfirmed lessons older than the cutoff (stale guesses).
    if (ageDays > maxAgeDays) return false;
    return true;
  });

  if (kept.length !== lessons.length) {
    await serialised(workspaceId, () => writeLessons(workspaceId, kept));
  }
  return lessons.length - kept.length;
}

async function writeLessons(
  workspaceId: string,
  lessons: Lesson[]
): Promise<void> {
  const dir = workspaceDirectory(workspaceId);
  await fs.mkdir(dir, { recursive: true });

  // Write then rename, the same way the chat store does. A plain writeFile
  // truncates first, so a crash — or the sandbox being reset — mid-write
  // leaves a half-written file, and a half-written lesson file parses into
  // *some* lessons, which is worse than none: the model would silently be
  // working from a truncated set it believes is complete.
  const target = lessonsPath(workspaceId);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, serialise(lessons), "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Serialises refine passes per workspace.
 *
 * `applyLessons` is read-modify-write. Two passes finishing at once — easy
 * enough with several chats open on the same workspace — would both read the
 * old file and the second would overwrite the first's lessons. Chaining on a
 * per-workspace promise keeps them ordered without blocking other workspaces.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serialised<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeChains.set(workspaceId, next);
  // Cleared when it is the last one queued, so the map does not grow for the
  // lifetime of the process.
  void next.catch(() => {}).finally(() => {
    if (writeChains.get(workspaceId) === next) writeChains.delete(workspaceId);
  });
  return next;
}

/**
 * Drop the least useful lessons once over the cap.
 *
 * Disproved ones go first — they are actively harmful, since the model would
 * read and believe them. Then the least confirmed, then the oldest. A lesson
 * that keeps being proved right survives indefinitely, which is the intent.
 */
function trim(lessons: Lesson[]): Lesson[] {
  if (lessons.length <= MAX_LESSONS) return lessons;
  const ranked = [...lessons].sort((a, b) => {
    const aDead = a.supersededBy ? 1 : 0;
    const bDead = b.supersededBy ? 1 : 0;
    if (aDead !== bDead) return aDead - bDead;
    const aScore = a.confirmed - a.contradicted;
    const bScore = b.confirmed - b.contradicted;
    if (aScore !== bScore) return bScore - aScore;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return ranked.slice(0, MAX_LESSONS);
}

export interface LessonUpdate {
  /** A new thing learned. */
  text: string;
  /** What proved it. Required — a lesson without it is refused. */
  evidence: string;
  /**
   * Id of a lesson this disproves.
   *
   * This is the self-correcting path: the model does not delete the old note,
   * it supersedes it, so the record shows what was believed, what happened,
   * and what replaced it.
   */
  replaces?: string;
}

export interface ApplyResult {
  added: number;
  revised: number;
  confirmed: number;
  /** Refused for having no evidence, being a duplicate, or being empty. */
  rejected: { text: string; reason: string }[];
  total: number;
}

/** Loose match, so "use pnpm install" and "Use pnpm install." are one lesson. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Apply a refine pass.
 *
 * Everything here is defensive about the model's output. It is being asked to
 * write to durable state that will steer its own future behaviour, which is
 * exactly the situation where an unchecked hallucination compounds.
 */
export async function applyLessons(
  workspaceId: string,
  updates: LessonUpdate[],
  confirmedIds: string[] = []
): Promise<ApplyResult> {
  // Queued, so two refine passes cannot both read the old file and have the
  // second silently discard the first's lessons.
  return serialised(workspaceId, () =>
    applyLessonsInner(workspaceId, updates, confirmedIds)
  );
}

async function applyLessonsInner(
  workspaceId: string,
  updates: LessonUpdate[],
  confirmedIds: string[]
): Promise<ApplyResult> {
  const lessons = await readLessons(workspaceId);
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const result: ApplyResult = {
    added: 0,
    revised: 0,
    confirmed: 0,
    rejected: [],
    total: 0,
  };

  // Reality agreed with these, so they get more trustworthy.
  for (const id of confirmedIds) {
    const existing = byId.get(id);
    if (existing && !existing.supersededBy) {
      existing.confirmed += 1;
      existing.updatedAt = new Date().toISOString();
      result.confirmed += 1;
    }
  }

  for (const update of updates) {
    const text = (update.text ?? "").trim().slice(0, MAX_LESSON_CHARS);
    const evidence = (update.evidence ?? "").trim().slice(0, MAX_LESSON_CHARS);

    if (!text) {
      result.rejected.push({ text: "", reason: "empty" });
      continue;
    }
    // The rule that separates this from the Self-Critic plugin. No evidence,
    // no lesson — otherwise it degrades into speculative advice.
    if (!evidence) {
      result.rejected.push({ text, reason: "no evidence" });
      continue;
    }

    const now = new Date().toISOString();

    if (update.replaces) {
      const old = byId.get(update.replaces);
      if (old) {
        // Self-correction. The old lesson is marked wrong rather than erased,
        // so a lesson that keeps flip-flopping is visible as such.
        old.contradicted += 1;
        old.updatedAt = now;
        const replacement: Lesson = {
          id: `l${Date.now().toString(36)}${lessons.length}`,
          text,
          evidence,
          confirmed: 1,
          contradicted: 0,
          createdAt: now,
          updatedAt: now,
        };
        old.supersededBy = replacement.id;
        lessons.push(replacement);
        byId.set(replacement.id, replacement);
        result.revised += 1;
        continue;
      }
      // Named a lesson that does not exist. Treated as a new one rather than
      // dropped, since the content may still be worth keeping.
    }

    const duplicate = lessons.find(
      (l) => !l.supersededBy && normalise(l.text) === normalise(text)
    );
    if (duplicate) {
      // Learning the same thing twice is confirmation, not a second entry.
      duplicate.confirmed += 1;
      duplicate.updatedAt = now;
      result.confirmed += 1;
      continue;
    }

    const lesson: Lesson = {
      id: `l${Date.now().toString(36)}${lessons.length}`,
      text,
      evidence,
      confirmed: 1,
      contradicted: 0,
      createdAt: now,
      updatedAt: now,
    };
    lessons.push(lesson);
    byId.set(lesson.id, lesson);
    result.added += 1;
  }

  const kept = trim(lessons);
  await writeLessons(workspaceId, kept);
  result.total = kept.length;
  return result;
}

/**
 * The block injected into the prompt.
 *
 * Disproved lessons are left out entirely — the file keeps them as a record,
 * but sending the model something already known to be false would be actively
 * harmful. Low-confidence ones are marked rather than hidden, so the model can
 * weigh them instead of trusting them blindly.
 */
export function formatLessonsForPrompt(lessons: Lesson[]): string {
  const live = lessons.filter((l) => !l.supersededBy);
  if (live.length === 0) return "";

  const lines = live.map((l) => {
    const confidence = confidenceOf(l);
    const flag = confidence === "low" ? " (unverified — check before relying on it)" : "";
    return `- [${l.id}] ${l.text}${flag}`;
  });

  return (
    `\n\nWhat you have already learned about this project, from things that ` +
    `actually happened here:\n\n${lines.join("\n")}\n\n` +
    `These came from real command output and tool results in this workspace. ` +
    `Use them instead of rediscovering the same facts. If one turns out to be ` +
    `wrong, say so plainly and quote its [id] — it will be corrected.`
  );
}
