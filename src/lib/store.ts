import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * File-backed conversation store.
 *
 * Chats are written as JSON under ./data/chats relative to the directory the
 * app was launched from, so they survive restarts, are easy to back up, and
 * need no database.
 */

const DATA_DIR = path.resolve(process.cwd(), "data", "chats");

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
  /** File operations run during this reply, so they survive a reload. */
  toolEvents?: {
    id: string;
    name: string;
    args: string;
    ok?: boolean;
    summary?: string;
    changedPath?: string;
  }[] | null;
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
function fileFor(id: string): string {
  if (!/^[\w-]{1,128}$/.test(id)) {
    throw new Error("Invalid conversation id");
  }
  return path.join(DATA_DIR, `${id}.json`);
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const out: ConversationSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, name), "utf8");
      const conv = JSON.parse(raw) as StoredConversation;
      const { messages, ...rest } = conv;
      out.push({ ...rest, messageCount: messages?.length ?? 0 });
    } catch {
      // Skip unreadable/corrupt files rather than failing the whole list.
    }
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function getConversation(
  id: string
): Promise<StoredConversation | null> {
  try {
    const raw = await fs.readFile(fileFor(id), "utf8");
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
    const target = fileFor(conv.id);
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
    conv.messages[index] = message;
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

export async function updateConversation(
  id: string,
  patch: { title?: string; archived?: boolean }
): Promise<StoredConversation | null> {
  const conv = await getConversation(id);
  if (!conv) return null;

  if (typeof patch.title === "string") {
    conv.title = patch.title.slice(0, 200);
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
  const target = fileFor(id);

  // Tombstone first: this stops writes that are already queued, and any the
  // in-flight reply issues from here on.
  deletedIds.add(id);

  let removed = false;
  // Queued like a write, so it can never overtake or be overtaken by one.
  await enqueue(id, async () => {
    try {
      await fs.unlink(target);
      removed = true;
    } catch {
      removed = false;
    }
  });

  // Sweep any temp file a racing write left behind, so the directory doesn't
  // accumulate orphans that a later readdir would trip over.
  try {
    const dir = path.dirname(target);
    const base = `${id}.json.`;
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(base) && name.endsWith(".tmp")) {
        await fs.unlink(path.join(dir, name)).catch(() => {});
      }
    }
  } catch {
    /* best effort */
  }

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
  let names: string[];
  try {
    names = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let conv: StoredConversation;
    try {
      conv = JSON.parse(
        await fs.readFile(path.join(DATA_DIR, name), "utf8")
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
