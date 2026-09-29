"use client";

import { useEffect, useRef, useState } from "react";

/** What a rewind to a message would do (a dry run of it). */
export type RewindPreview =
  | {
      ok: true;
      /** Messages removed, the question itself included. */
      removedMessages: number;
      files: {
        available: boolean;
        kind: "snapshot" | "empty" | "missing" | "none";
        createdAt?: string;
        fileCount?: number;
      };
    }
  | { ok: false; error: string };

/** A finished rewind: `question` goes back into the composer. */
export type RewindDone =
  | {
      ok: true;
      question: string;
      /** The line shown under the composer. */
      text: string;
      /** Put the files back as they were before the rewind. */
      undoFiles?: () => Promise<{ ok: boolean; text: string }>;
    }
  | { ok: false; error: string };

export interface RewindHandlers {
  preview: (messageId: string) => Promise<RewindPreview>;
  run: (messageId: string, restoreFiles: boolean) => Promise<RewindDone>;
}

/** "the 3 after it" / "the reply after it" / "" — what else a rewind removes. */
export function laterMessagesPhrase(removedMessages: number): string {
  const later = removedMessages - 1;
  if (later <= 0) return "";
  if (later === 1) return "the reply after it";
  return `the ${later} messages after it`;
}

/** One line on what happens to the files, for the popover and /rewind. */
export function rewindFilesLine(files: Extract<RewindPreview, { ok: true }>["files"]): string {
  switch (files.kind) {
    case "snapshot": {
      const at = files.createdAt ? new Date(files.createdAt) : null;
      const when =
        at && !Number.isNaN(at.getTime())
          ? ` (restore point from ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`
          : "";
      return `Files go back to how they were before this message${when}. The current files are saved first, so that can be undone.`;
    }
    case "empty":
      return "There were no files before this message, so rewinding the files removes them all. They are saved first, so that can be undone.";
    case "missing":
      return "This message's file restore point has been pruned (only the newest are kept) — only the chat can rewind.";
    default:
      return "No file restore point was taken for this message — only the chat can rewind.";
  }
}

/**
 * The confirm step for "Rewind" on a question.
 *
 * Asks the server what a rewind would do before offering it: how many
 * messages go, and whether the files can go back too — a restore point can
 * be missing (workspace off, or pruned), and offering a files rewind that
 * then fails would be worse than not offering it.
 */
export function RewindPopover({
  messageId,
  handlers,
  onClose,
}: {
  messageId: string;
  handlers: RewindHandlers;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [busy, setBusy] = useState<"files" | "chat" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    handlers.preview(messageId).then(
      (p) => live && setPreview(p),
      () => live && setPreview({ ok: false, error: "Couldn't reach the server." })
    );
    return () => {
      live = false;
    };
  }, [handlers, messageId]);

  // Escape or a click elsewhere closes it — but not mid-rewind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!busy && rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [busy, onClose]);

  const go = async (restoreFiles: boolean) => {
    setBusy(restoreFiles ? "files" : "chat");
    setError(null);
    const result = await handlers
      .run(messageId, restoreFiles)
      .catch(() => ({ ok: false as const, error: "Rewinding failed." }));
    setBusy(null);
    if (result.ok) onClose();
    else setError(result.error);
  };

  const ready = preview?.ok ? preview : null;
  const later = ready ? laterMessagesPhrase(ready.removedMessages) : "";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Rewind to this message"
      data-rewind-popover
      className="absolute right-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] origin-top-right rounded-xl border border-border-light bg-bg-elevated p-3 text-left shadow-[0_18px_48px_rgba(0,0,0,0.5)] animate-fade-in"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
        <RewindIcon />
        Rewind to before this message
      </div>

      {!preview && <p className="text-[12px] leading-5 text-text-muted">Checking what would change…</p>}
      {preview && !preview.ok && (
        <p className="text-[12px] leading-5 text-danger">{preview.error}</p>
      )}
      {ready && (
        <div className="space-y-1.5 text-[12px] leading-5 text-text-secondary">
          <p>
            Removes this message{later ? ` and ${later}` : ""}. Its text goes back in the box to edit and resend.
          </p>
          <p className={ready.files.available ? "" : "text-text-muted"}>
            {rewindFilesLine(ready.files)}
          </p>
        </div>
      )}
      {error && <p className="mt-1.5 text-[12px] leading-5 text-danger">{error}</p>}

      <div className="mt-3 flex flex-col gap-1.5">
        {ready?.files.available && (
          <button
            onClick={() => void go(true)}
            disabled={busy !== null}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-light disabled:opacity-50"
          >
            {busy === "files" ? "Rewinding…" : "Rewind chat and files"}
          </button>
        )}
        <button
          onClick={() => void go(false)}
          disabled={!ready || busy !== null}
          className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
            ready?.files.available
              ? "border border-border-light text-text-primary hover:bg-bg-hover"
              : "bg-accent text-white hover:bg-accent-light"
          }`}
        >
          {busy === "chat" ? "Rewinding…" : "Rewind chat only"}
        </button>
        <button
          onClick={onClose}
          disabled={busy !== null}
          className="rounded-lg px-3 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function RewindIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5" />
    </svg>
  );
}
