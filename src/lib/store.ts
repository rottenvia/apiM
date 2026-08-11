import { promises as fs } from "node:fs";
import path from "node:path";
import { slugify, uniqueSlug } from "@/lib/slug";
import {
  renameWorkspaceFolder,
  setWorkspaceFolderName,
} from "@/lib/workspace";
import { stopAll } from "@/lib/processes";
import { forgetWorkspace } from "@/lib/approvals";
import { deleteAllSnapshots } from "@/lib/snapshots";

/**
 * File-backed conversation store.
 *
 * Chats are written as JSON under ./data/chats relative to the directory the
 * app was launched from, so they survive restarts, are easy to back up, and
 * need no database.
 */

/** Overridable so parallel test suites do not share one chat store. */
const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT, "chats")
  : path.resolve(process.cwd(), "data", "chats");

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Files sent with this message, so chips survive a reload. */
  attachments?: {
    name: string;
    kind: "text" | "image";
    dataUrl?: string;
  }[] | null;
  reasoningContent?: string | null;
  thinkingEffort?: string | null;
  webSearchUsed?: boolean;
  searchResults?: { title: string; url: string; domain: string }[] | null;
  searchQueries?: string[] | null;
  pluginsUsed?: string[] | null;
  tokenCount?: number | null;
  /** Full usage breakdown, for cost estimation. */
  usage?: Record<string, number> | null;
  /** Model that produced this reply, needed to price it. */
  model?: string | null;
  /** Wall-clock time the reply took. */
  durationMs?: number | null;
  createdAt: string;
  /**
   * True while the reply is still streaming. If the process dies or the tab
   * closes mid-answer the flag stays set, which is how the UI knows to offer
   * a retry instead of silently showing a truncated message as final.
   */
  incomplete?: boolean;
  /** Text and actions in the order they happened, for the split view. */
  timeline?: (
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string }
  )[] | null;
  /** File operations run during this reply, so they survive a reload. */
  toolEvents?: {
    id: string;
    name: string;
    args: string;
    ok?: boolean;
    summary?: string;
    changedPath?: string;
  }[] | null;
  /**
   * The exact API turns this reply was built from.
   *
   * `toolEvents` records *that* a file was read; this records *what it said*,
   * along with the model's reasoning and the raw tool calls. Without it a
   * stopped reply could not be resumed: the evidence the model had gathered
   * — sometimes dozens of rounds of it, already paid for — was thrown away,
   * so "Try again" had no choice but to redo everything from the first token.
   *
   * Stored on the assistant turn it belongs to, and only while the reply is
   * unfinished; a completed reply drops it, since resuming a finished answer
   * is meaningless and the transcript is by far the largest thing here.
   */
  resumeState?: {
    /** Rounds already spent, so a resumed reply does not get a fresh budget. */
    toolRounds: number;
    /** Continuations already used against the output ceiling. */
    continuations: number;
    /** Verbatim API messages, including reasoning and tool results. */
    messages: unknown[];
  } | null;
}

export interface StoredConversation {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

/** Summary shape returned to the sidebar (messages omitted). */
export type ConversationSummary = Omit<StoredConversation, "messages"> & {
  messageCount: number;
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Reject anything that isn't a plain id, so a crafted value can never escape
 * the data directory (e.g. "../../etc/passwd").
 */
function assertId(id: string): void {
  if (!/^[\w-]{1,128}$/.test(id)) {
    throw new Error("Invalid conversation id");
  }
}

/**
 * Maps conversation id to folder name.
 *
 * Chats live in `data/chats/<slug>/chat.json`, where the slug comes from the
 * title — so the folder is readable rather than a UUID. The id remains the
 * identity: the folder is only a label, because a title can change and two
 * chats can share one.
 *
 * Built by scanning on demand rather than kept in a file, since a stale index
 * and the real directory disagreeing is worse than the scan cost at this size.
 */
/**
 * Moves chats saved in the old flat layout into folders.
 *
 * Earlier versions stored `data/chats/<uuid>.json`. Those would simply stop
 * appearing once listing only looks at directories, so they are migrated in
 * place the first time the directory is read. Runs once per process.
 */
let migrated = false;

async function migrateFlatFiles(): Promise<void> {
  if (migrated) return;
  migrated = true;

  let names: string[];
  try {
    names = await fs.readdir(DATA_DIR);
  } catch {
    return;
  }

  const taken = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) taken.add(name);
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;

    const oldPath = path.join(DATA_DIR, name);
    try {
      const raw = await fs.readFile(oldPath, "utf8");
      const conv = JSON.parse(raw) as { id?: string; title?: string };
      if (!conv.id) continue;

      const folder = uniqueSlug(conv.title ?? "", taken, conv.id);
      taken.add(folder);

      const dir = path.join(DATA_DIR, folder);
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(oldPath, path.join(dir, "chat.json"));

      // The workspace was named by id before, so move it to match.
      await renameWorkspaceFolder(conv.id, folder);
      setWorkspaceFolderName(conv.id, folder);
    } catch {
      // Leave anything unreadable where it is rather than losing it.
    }
  }
}

async function folderIndex(): Promise<Map<string, string>> {
  await ensureDir();
  await migrateFlatFiles();
  const index = new Map<string, string>();

  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return index;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(
        path.join(DATA_DIR, entry.name, "chat.json"),
        "utf8"
      );
      const conv = JSON.parse(raw) as { id?: string };
      if (conv.id) {
        index.set(conv.id, entry.name);
        // Rebuilds the workspace mapping too. Without this, a restart would
        // leave the workspace resolving to the raw id while the chat used its
        // slug, and the two would point at different folders.
        setWorkspaceFolderName(conv.id, entry.name);
      }
    } catch {
      // A directory without a readable chat.json isn't ours.
    }
  }

  return index;
}

/** Existing folder for a conversation, or null if it has none yet. */
async function folderFor(id: string): Promise<string | null> {
  assertId(id);
  return (await folderIndex()).get(id) ?? null;
}

/** Path to a conversation's file, given its folder. */
function fileIn(folder: string): string {
  return path.join(DATA_DIR, folder, "chat.json");
}

/**
 * Picks the folder for a conversation, creating or renaming as needed.
 *
 * When the title changes the folder is renamed to match, which is the whole
 * point — otherwise a chat renamed to "Budget" keeps a folder called
 * "untitled". A failed rename is not fatal: the old folder still holds the
 * data and the id still resolves.
 */
async function resolveFolder(
  id: string,
  title: string
): Promise<string> {
  assertId(id);
  const index = await folderIndex();
  const existing = index.get(id);

  const taken = new Set(index.values());
  if (existing) taken.delete(existing);

  const desired = uniqueSlug(title, taken, id);

  if (!existing) {
    await fs.mkdir(path.join(DATA_DIR, desired), { recursive: true });

    // Files can arrive before the chat is named. Attachments are uploaded
    // while the composer is still empty, so they land in a workspace named
    // after the raw id — and naming the chat here would silently repoint the
    // workspace at a different folder, orphaning everything already in it.
    // That is why an uploaded zip vanished the moment the first message was
    // sent: the files were never lost, the app just stopped looking where it
    // had put them.
    await renameWorkspaceFolder(id, desired);

    setWorkspaceFolderName(id, desired);
    return desired;
  }

  // Already correct, or differs only by the numeric suffix we appended to
  // avoid a collision — renaming then would churn folders on every save.
  if (existing === desired) {
    setWorkspaceFolderName(id, existing);
    return existing;
  }
  if (existing.replace(/-\d+$/, "") === slugify(title)) {
    setWorkspaceFolderName(id, existing);
    return existing;
  }

  try {
    await fs.rename(
      path.join(DATA_DIR, existing),
      path.join(DATA_DIR, desired)
    );
    // The workspace folder follows the chat, so both stay in step.
    await renameWorkspaceFolder(existing, desired);
    setWorkspaceFolderName(id, desired);
    return desired;
  } catch {
    setWorkspaceFolderName(id, existing);
    return existing;
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureDir();
  await migrateFlatFiles();
  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  /*
   * The sidebar needs a title and a date, not a transcript.
   *
   * This read and JSON.parsed every conversation in full to produce a list of
   * names — on forty chats that is twelve megabytes of text parsed, and the
   * cost grows with everything ever written rather than with the number of
   * rows displayed. It runs on load and again after every reply.
   *
   * The summary is now cached per file, keyed by size and mtime, so an
   * unchanged conversation is never re-read. Only the chat that was just
   * written is parsed again.
   */
  const out: ConversationSummary[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const file = fileIn(entry.name);

      try {
        const stat = await fs.stat(file);
        const fingerprint = `${stat.size}:${stat.mtimeMs}`;
        const cached = summaryCache.get(file);
        if (cached && cached.fingerprint === fingerprint) {
          out.push(cached.summary);
          return;
        }

        const raw = await fs.readFile(file, "utf8");
        const conv = JSON.parse(raw) as StoredConversation;
        const { messages, ...rest } = conv;
        const summary: ConversationSummary = {
          ...rest,
          messageCount: messages?.length ?? 0,
        };
        summaryCache.set(file, { fingerprint, summary });
        out.push(summary);
      } catch {
        // Skip unreadable/corrupt files rather than failing the whole list.
      }
    })
  );

  // Entries for folders that no longer exist would otherwise accumulate for
  // the life of the process.
  if (summaryCache.size > entries.length * 2) {
    const live = new Set(entries.map((e) => fileIn(e.name)));
    for (const key of summaryCache.keys()) {
      if (!live.has(key)) summaryCache.delete(key);
    }
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function getConversation(
  id: string
): Promise<StoredConversation | null> {
  try {
    const folder = await folderFor(id);
    if (!folder) return null;
    const raw = await fs.readFile(fileIn(folder), "utf8");
    return JSON.parse(raw) as StoredConversation;
  } catch {
    return null;
  }
}

/**
 * Serialises writes per conversation.
 *
 * A streaming checkpoint and the final save can otherwise overlap: both write
 * the same `.tmp` path, the first rename consumes it, and the second fails
 * with ENOENT — losing that write. Chaining on a per-id promise keeps writes
 * ordered without blocking other conversations.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Parsed sidebar summaries, keyed by file path.
 *
 * Invalidated by size and mtime rather than by hand, so an edit made outside
 * the app — or by a restore — is picked up without anyone having to remember
 * to clear this.
 */
const summaryCache = new Map<
  string,
  { fingerprint: string; summary: ConversationSummary }
>();

/**
 * Conversations deleted during this process's lifetime.
 *
 * A delete has to outrank writes that were already queued behind it, and also
 * any that a streaming reply issues *after* it: a checkpoint captured its data
 * before the delete and would otherwise write the file back out. Deleting a
 * chat mid-reply is exactly when that happens, which is why deletes appeared
 * to silently fail — the row vanished and then returned.
 */
const deletedIds = new Set<string>();

/** Runs `task` after any pending write for this conversation. */
function enqueue(id: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeQueues.set(id, next);
  return next.finally(() => {
    if (writeQueues.get(id) === next) writeQueues.delete(id);
  });
}

async function writeConversation(conv: StoredConversation): Promise<void> {
  // Checked before queueing and again inside, since the delete may land while
  // this write is still waiting its turn.
  if (deletedIds.has(conv.id)) return;

  return enqueue(conv.id, async () => {
    if (deletedIds.has(conv.id)) return;

    await ensureDir();
    // Resolves the folder from the current title, renaming it if the title
    // changed. Inside the write queue so a rename can't race a save.
    const folder = await resolveFolder(conv.id, conv.title);
    const target = fileIn(folder);
    // Unique suffix so two writers can never collide on the same temp path.
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(conv, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  });
}

export async function appendMessages(
  conversationId: string,
  title: string,
  newMessages: StoredMessage[]
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getConversation(conversationId);

  const conv: StoredConversation = existing ?? {
    id: conversationId,
    title,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  conv.messages.push(...newMessages);
  conv.updatedAt = now;
  await writeConversation(conv);
}

/**
 * Insert or update a single message in place, matched by id.
 *
 * Used to checkpoint a reply while it streams: the same assistant message is
 * rewritten repeatedly as content arrives, so closing the tab mid-answer
 * leaves the text on disk rather than losing it entirely.
 */
export async function upsertMessage(
  conversationId: string,
  title: string,
  message: StoredMessage
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getConversation(conversationId);

  const conv: StoredConversation = existing ?? {
    id: conversationId,
    title,
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  const index = conv.messages.findIndex((m) => m.id === message.id);
  if (index === -1) {
    conv.messages.push(message);
  } else {
    /*
     * `resumeState` is preserved when the update omits it.
     *
     * It is by far the largest field — around a megabyte on a long agent run
     * — so it is deliberately not resent on every checkpoint. Replacing the
     * message wholesale would therefore erase it a few seconds after it was
     * written, and the reply would look resumable while having nothing to
     * resume from.
     *
     * `null` still clears it, which is how a finished reply drops it. Only
     * `undefined` — the field being absent — means "leave what is there".
     */
    const previous = conv.messages[index];
    conv.messages[index] =
      message.resumeState === undefined && previous.resumeState
        ? { ...message, resumeState: previous.resumeState }
        : message;
  }

  conv.updatedAt = now;
  await writeConversation(conv);
}

/**
 * Drop trailing messages starting at the given id.
 * Used by regenerate, which discards the old reply before producing a new one.
 */
export async function truncateFrom(
  conversationId: string,
  messageId: string
): Promise<boolean> {
  const conv = await getConversation(conversationId);
  if (!conv) return false;

  const index = conv.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return false;

  conv.messages = conv.messages.slice(0, index);
  conv.updatedAt = new Date().toISOString();
  await writeConversation(conv);
  return true;
}

/** Thrown when a rename would collide with another chat. */
export class DuplicateTitleError extends Error {
  constructor(public readonly title: string) {
    super(`A chat named "${title}" already exists`);
    this.name = "DuplicateTitleError";
  }
}

/** Comparison form: case and surrounding space shouldn't make titles distinct. */
function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The chat using this title, if any.
 *
 * Titles are compared rather than folder names because two titles can slug to
 * the same folder while reading as different chats — and because the message
 * the user needs is about the name they typed, not the directory.
 */
export async function findByTitle(
  title: string,
  exceptId?: string
): Promise<ConversationSummary | null> {
  const key = titleKey(title);
  if (!key) return null;

  for (const conv of await listConversations()) {
    if (conv.id === exceptId) continue;
    if (titleKey(conv.title) === key) return conv;
  }
  return null;
}

/**
 * A title nobody is using, by appending a number.
 *
 * For titles the app generates itself, where silently picking "Hello 2" is
 * better than refusing to save the message.
 */
export async function availableTitle(
  desired: string,
  exceptId?: string
): Promise<string> {
  const base = desired.trim() || "New chat";
  if (!(await findByTitle(base, exceptId))) return base;

  const taken = new Set(
    (await listConversations())
      .filter((c) => c.id !== exceptId)
      .map((c) => titleKey(c.title))
  );

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(titleKey(candidate))) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

export async function updateConversation(
  id: string,
  patch: { title?: string; archived?: boolean }
): Promise<StoredConversation | null> {
  const conv = await getConversation(id);
  if (!conv) return null;

  if (typeof patch.title === "string") {
    const next = patch.title.slice(0, 200).trim();

    // Renaming to the same thing is a no-op, not an error — otherwise
    // clicking Save without editing would look like a failure.
    if (titleKey(next) !== titleKey(conv.title)) {
      const clash = await findByTitle(next, id);
      if (clash) throw new DuplicateTitleError(next);
    }

    conv.title = next;
  }
  if (typeof patch.archived === "boolean") {
    conv.archived = patch.archived;
  }
  conv.updatedAt = new Date().toISOString();

  await writeConversation(conv);
  return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
  // Validate before marking, so a bad id can't poison the tombstone set.
  assertId(id);
  const folder = await folderFor(id);

  // Tombstone first: this stops writes that are already queued, and any the
  // in-flight reply issues from here on.
  deletedIds.add(id);

  // A deleted chat must not leave a dev server running against files that no
  // longer exist, nor snapshots of a workspace nobody can reach.
  stopAll(id);
  void deleteAllSnapshots(id);

  /*
   * Drop any commands the user approved with "always allow" here.
   *
   * These were kept in memory keyed by workspace and never cleared, so
   * deleting a chat left its standing permissions behind. Ids are uuids and
   * would not normally be reused, but a permission that outlives the thing it
   * was granted for is the wrong default in either direction: at best it
   * leaks a little memory for the life of the process, at worst a recreated
   * workspace inherits consent the user gave to something that no longer
   * exists. Consent should not survive its subject.
   */
  forgetWorkspace(id);

  let removed = false;
  // Queued like a write, so it can never overtake or be overtaken by one.
  await enqueue(id, async () => {
    if (!folder) return;
    try {
      // Removes the folder and anything in it, including temp files a racing
      // write may have left behind.
      await fs.rm(path.join(DATA_DIR, folder), {
        recursive: true,
        force: true,
      });
      removed = true;
    } catch {
      removed = false;
    }
  });

  return removed;
}


export interface SearchHit {
  conversationId: string;
  title: string;
  archived: boolean;
  updatedAt: string;
  /** Number of matching messages in this conversation. */
  matchCount: number;
  /** Whether the title itself matched. */
  titleMatch: boolean;
  /** Short excerpts around the first few matches. */
  snippets: { role: "user" | "assistant"; text: string }[];
}

function buildSnippet(content: string, needle: string): string {
  const at = content.toLowerCase().indexOf(needle);
  if (at === -1) return content.slice(0, 120).trim();

  const start = Math.max(0, at - 45);
  const end = Math.min(content.length, at + needle.length + 75);
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}

/**
 * Full-text search across stored conversations.
 *
 * A linear scan is deliberate: this runs against local JSON files for a
 * personal chat history, where the file count stays small enough that an
 * index would add complexity without a measurable benefit.
 */
export async function searchConversations(
  rawQuery: string,
  limit = 30
): Promise<SearchHit[]> {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return [];

  await ensureDir();
  await migrateFlatFiles();

  /*
   * Chats live in folders, not loose .json files.
   *
   * This still looked for names ending in .json in the data directory — the
   * layout from before conversations were given their own folder — so it
   * matched nothing at all. Searching appeared to work and silently returned
   * no results for everything, which reads as "not found" rather than as a
   * bug.
   */
  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let conv: StoredConversation;
    try {
      conv = JSON.parse(
        await fs.readFile(fileIn(entry.name), "utf8")
      ) as StoredConversation;
    } catch {
      continue;
    }

    const titleMatch = conv.title.toLowerCase().includes(needle);
    const matching = (conv.messages ?? []).filter((m) =>
      m.content?.toLowerCase().includes(needle)
    );

    if (!titleMatch && matching.length === 0) continue;

    hits.push({
      conversationId: conv.id,
      title: conv.title,
      archived: conv.archived,
      updatedAt: conv.updatedAt,
      matchCount: matching.length,
      titleMatch,
      snippets: matching.slice(0, 3).map((m) => ({
        role: m.role,
        text: buildSnippet(m.content, needle),
      })),
    });
  }

  // Title matches first, then more matches, then most recent.
  hits.sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
    if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return hits.slice(0, limit);
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Import conversations from an exported JSON file.
 *
 * Accepts either a single conversation object or an array of them, and
 * tolerates partial records — anything with recognisable messages is taken.
 * Imported chats always get a fresh id so they can never overwrite an
 * existing conversation, which also means a delete tombstone can never
 * shadow an import.
 */
export async function importConversations(
  raw: unknown
): Promise<ImportResult> {
  const candidates: unknown[] = Array.isArray(raw) ? raw : [raw];
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      result.skipped += 1;
      continue;
    }

    const conv = candidate as Partial<StoredConversation>;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];

    const cleaned: StoredMessage[] = messages
      .filter(
        (m): m is StoredMessage =>
          !!m &&
          typeof m === "object" &&
          typeof (m as StoredMessage).content === "string" &&
          ((m as StoredMessage).role === "user" ||
            (m as StoredMessage).role === "assistant")
      )
      .map((m, i) => ({
        ...m,
        // Regenerate ids so an import can't collide with existing messages.
        id: `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        createdAt: m.createdAt ?? new Date().toISOString(),
      }));

    if (cleaned.length === 0) {
      result.skipped += 1;
      result.errors.push(
        `"${String(conv.title ?? "untitled").slice(0, 40)}" had no usable messages`
      );
      continue;
    }

    const now = new Date().toISOString();
    const imported: StoredConversation = {
      id: `imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title:
        typeof conv.title === "string" && conv.title.trim()
          ? conv.title.slice(0, 200)
          : "Imported chat",
      archived: false,
      createdAt: typeof conv.createdAt === "string" ? conv.createdAt : now,
      updatedAt: now,
      messages: cleaned,
    };

    try {
      await writeConversation(imported);
      result.imported += 1;
    } catch {
      result.skipped += 1;
      result.errors.push(`Couldn't save "${imported.title}"`);
    }
  }

  return result;
}

/** Absolute path shown in the UI so the user knows where chats live. */
export function dataDirectory(): string {
  return DATA_DIR;
}
