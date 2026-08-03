import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * File-backed conversation store.
 *
 * Used whenever DATABASE_URL is unset, which is the normal case when running
 * locally. Chats are written as JSON under ./data/chats relative to the
 * directory the app was launched from, so they survive restarts and are easy
 * to back up, inspect or delete by hand.
 */

const DATA_DIR = path.resolve(process.cwd(), "data", "chats");

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string | null;
  thinkingEffort?: string | null;
  webSearchUsed?: boolean;
  searchResults?: { title: string; url: string; domain: string }[] | null;
  searchQueries?: string[] | null;
  pluginsUsed?: string[] | null;
  tokenCount?: number | null;
  createdAt: string;
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

async function writeConversation(conv: StoredConversation): Promise<void> {
  await ensureDir();
  // Write to a temp file then rename, so a crash mid-write can't leave a
  // half-written file behind.
  const target = fileFor(conv.id);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(conv, null, 2), "utf8");
  await fs.rename(tmp, target);
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
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

/** Absolute path shown in the UI so the user knows where chats live. */
export function dataDirectory(): string {
  return DATA_DIR;
}
