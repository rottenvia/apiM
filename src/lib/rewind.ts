import { listFiles } from "@/lib/workspace";
import {
  getSnapshot,
  listSnapshots,
  restoreEmpty,
  restoreSnapshot,
  type SnapshotInfo,
} from "@/lib/snapshots";
import {
  recordRestorePoint,
  rewindConversation,
  type StoredMessage,
} from "@/lib/store";
import { activeRuns } from "@/lib/runs";

/**
 * Rewind to a message: the conversation AND the workspace files go back to
 * how they were just before a question was asked.
 *
 * Restore points (lib/snapshots.ts) already copy the workspace at the start
 * of every reply, and truncateFrom already cuts a chat back — but nothing
 * tied the one to the other, so "undo the last three messages" meant
 * deleting turns by hand and then guessing which restore point matched.
 * Each question now records the restore point its reply started from
 * (`restorePoint` on the stored message), and one call puts both back.
 */

/** How the client names the question — its ids may be temp- ids. */
export interface RewindTarget {
  /** The question's id; the store only knows it after a reload. */
  messageId?: string;
  /** The reply right after it, whose server id the client does learn. */
  replyId?: string;
  /** Position among the chat's questions (steering notes not counted). */
  ordinal?: number;
  /** The question's text, to confirm a match by position. */
  content?: string;
}

/**
 * Where a question sits in the stored chat, or -1.
 *
 * In-session questions carry client temp- ids the store never saw (see
 * truncateFrom), so the id alone is not enough: the reply's id, then the
 * question's position confirmed by its text, then its text alone if it is
 * unique. Never a guess — the wrong question would lose real work.
 */
export function locateQuestion(
  messages: StoredMessage[],
  target: RewindTarget
): number {
  const isQuestion = (m: StoredMessage | undefined) => m?.role === "user";
  const same = (m: StoredMessage) =>
    typeof target.content === "string" &&
    m.content.trim() === target.content.trim();

  if (target.messageId) {
    const i = messages.findIndex((m) => m.id === target.messageId);
    if (i !== -1 && isQuestion(messages[i])) return i;
  }
  if (target.replyId) {
    const i = messages.findIndex((m) => m.id === target.replyId);
    if (i > 0 && messages[i].role === "assistant" && isQuestion(messages[i - 1])) {
      return i - 1;
    }
  }
  if (typeof target.content === "string") {
    const questions = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role === "user" && !m.note);
    if (
      typeof target.ordinal === "number" &&
      Number.isInteger(target.ordinal) &&
      target.ordinal >= 0 &&
      target.ordinal < questions.length &&
      same(questions[target.ordinal].m)
    ) {
      return questions[target.ordinal].i;
    }
    const matches = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => isQuestion(m) && same(m));
    if (matches.length === 1) return matches[0].i;
  }
  return -1;
}

export type RestorePointState =
  /** A snapshot of the files as they were. */
  | { kind: "snapshot"; snapshot: SnapshotInfo }
  /** The workspace had no files yet. */
  | { kind: "empty" }
  /** Recorded, but pruned since (only the newest MAX_SNAPSHOTS are kept). */
  | { kind: "missing" }
  /** Nothing recorded and nothing found. */
  | { kind: "none" };

/**
 * The files state from just before a question's reply started.
 *
 * Questions asked before `restorePoint` existed are matched the way the
 * snapshot was taken: labelled with the start of the question, created
 * after it was stored and before the next question. The earliest wins, as
 * a later one belongs to a retry that started from the first reply's files.
 */
export async function findRestorePoint(
  workspaceId: string,
  messages: StoredMessage[],
  index: number
): Promise<RestorePointState> {
  const question = messages[index];
  if (!question) return { kind: "none" };

  const recorded = question.restorePoint;
  if (recorded) {
    if (recorded.snapshotId === null) return { kind: "empty" };
    const snapshot = await getSnapshot(workspaceId, recorded.snapshotId);
    return snapshot ? { kind: "snapshot", snapshot } : { kind: "missing" };
  }

  const from = Date.parse(question.createdAt);
  if (Number.isNaN(from)) return { kind: "none" };
  const next = messages
    .slice(index + 1)
    .find((m) => m.role === "user" && !m.note);
  const until = next ? Date.parse(next.createdAt) : Infinity;
  const text = question.content.trim();
  const candidates = (await listSnapshots(workspaceId).catch(() => []))
    .filter((s) => {
      const at = Date.parse(s.createdAt);
      const label = s.label.trim();
      return at >= from && at < until && label.length > 0 && text.startsWith(label);
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return candidates[0]
    ? { kind: "snapshot", snapshot: candidates[0] }
    : { kind: "none" };
}

/**
 * Called by the chat route right after it takes the start-of-reply
 * snapshot. `snapshot` is null when nothing was saved, which is either an
 * empty workspace (worth recording: rewinding there means "no files") or a
 * failed snapshot (not recorded — better no files option than a wrong one).
 * Never throws; a reply must not fail over its restore point.
 */
export async function linkRestorePoint(
  conversationId: string,
  workspaceId: string,
  replyId: string,
  snapshot: SnapshotInfo | null
): Promise<void> {
  try {
    let snapshotId: string | null;
    if (snapshot) {
      snapshotId = snapshot.id;
    } else {
      const files = await listFiles(workspaceId).catch(() => null);
      if (!files || files.length > 0) return;
      snapshotId = null;
    }
    await recordRestorePoint(conversationId, replyId, snapshotId);
  } catch (error) {
    console.error("Recording the restore point failed:", error);
  }
}

export interface RewindFiles {
  /** Whether "rewind chat and files" can run. */
  available: boolean;
  kind: RestorePointState["kind"];
  snapshotId?: string;
  createdAt?: string;
  fileCount?: number;
}

export type RewindOutcome =
  | {
      ok: true;
      dryRun: boolean;
      /** The stored id of the question rewound to. */
      messageId: string;
      /** Its text, for the composer. */
      question: string;
      /** Messages removed, the question included. */
      removedMessages: number;
      files: RewindFiles;
      /** Set when files were restored. */
      filesRestored: { restored: number; removed: number } | null;
      /** The pre-rewind state of the files — restore it to undo. */
      safetySnapshotId: string | null;
    }
  | { ok: false; status: number; error: string };

const RUNNING_ERROR =
  "A reply is still running in this chat. Stop it or wait for it to finish, then rewind.";

function describe(point: RestorePointState): RewindFiles {
  if (point.kind === "snapshot") {
    return {
      available: true,
      kind: "snapshot",
      snapshotId: point.snapshot.id,
      createdAt: point.snapshot.createdAt,
      fileCount: point.snapshot.fileCount,
    };
  }
  return { available: point.kind === "empty", kind: point.kind, fileCount: 0 };
}

/**
 * Rewind a chat to just before one of its questions.
 *
 * The question and everything after it leave the stored conversation, and
 * with `restoreFiles` the workspace goes back to that question's restore
 * point — after a safety snapshot of the current files, whose id is
 * returned so the rewind itself can be undone. Refused while a reply is
 * running: it is reading this history and writing these files.
 * `dryRun` only reports what would happen (the confirm popover).
 */
export async function rewindChat(
  conversationId: string,
  options: RewindTarget & {
    restoreFiles: boolean;
    dryRun?: boolean;
    workspaceId?: string;
  }
): Promise<RewindOutcome> {
  if (activeRuns(conversationId).length > 0) {
    return { ok: false, status: 409, error: RUNNING_ERROR };
  }
  const workspaceId = options.workspaceId || conversationId;

  const outcome = await rewindConversation<RewindOutcome>(
    conversationId,
    async (conv) => {
      // Again inside the write slot: a send may have started meanwhile.
      if (activeRuns(conversationId).length > 0) {
        return { cut: null, result: { ok: false, status: 409, error: RUNNING_ERROR } };
      }
      const index = locateQuestion(conv.messages, options);
      if (index === -1) {
        return {
          cut: null,
          result: {
            ok: false,
            status: 404,
            error: "That message is not in the saved chat — reload it and try again.",
          },
        };
      }
      const question = conv.messages[index];
      const point = await findRestorePoint(workspaceId, conv.messages, index);
      const files = describe(point);
      const base = {
        ok: true as const,
        messageId: question.id,
        question: question.content,
        removedMessages: conv.messages.length - index,
        files,
      };

      if (options.dryRun) {
        return {
          cut: null,
          result: { ...base, dryRun: true, filesRestored: null, safetySnapshotId: null },
        };
      }

      if (options.restoreFiles && !files.available) {
        return {
          cut: null,
          result: {
            ok: false,
            status: 409,
            error:
              point.kind === "missing"
                ? "The restore point for that message has been pruned — only the newest ones are kept. Nothing was changed."
                : "There is no restore point for that message, so its files cannot be put back. Nothing was changed.",
          },
        };
      }

      let filesRestored: { restored: number; removed: number } | null = null;
      let safetySnapshotId: string | null = null;
      if (options.restoreFiles) {
        // Files first: if restoring throws, the chat is left as it was.
        const safetyLabel = `Before rewinding to: ${question.content.trim()}`.slice(0, 120);
        const result =
          point.kind === "snapshot"
            ? await restoreSnapshot(workspaceId, point.snapshot.id, { safetyLabel })
            : await restoreEmpty(workspaceId, { safetyLabel });
        filesRestored = { restored: result.restored, removed: result.removed };
        safetySnapshotId = result.safety?.id ?? null;
      }

      return {
        cut: index,
        result: { ...base, dryRun: false, filesRestored, safetySnapshotId },
      };
    }
  );

  return (
    outcome ?? {
      ok: false,
      status: 404,
      error: "This chat has not been saved yet.",
    }
  );
}
