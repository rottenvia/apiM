"use client";

/**
 * The mid-run note channel, docked above the composer.
 *
 * "btw …" while a task runs is steering, not a side question: the note goes
 * to the RUNNING task, which reads it at its next thinking step and folds it
 * into its reasoning. The dock is the hand-off confirmation — where the note
 * is (passing / passed / read at step N) — while the permanent record is the
 * note chip that appears in the transcript itself once the task reads it.
 *
 * It sits between the status line and the input on purpose. That is its
 * conceptual place: attached to the conversation, but not part of it. Putting
 * it in the message column would break the one thing a transcript guarantees
 * — that reading top to bottom is reading what happened, in order.
 *
 * Collapsed it is a single row, so a note never pushes the reply you are
 * reading around. Teal rather than the accent terracotta, and never the amber
 * used for thinking: the colour says at a glance that this is a different
 * channel from the task, not another step in it.
 */

export interface BtwEntry {
  id: string;
  note: string;
  /** sending → POST in flight; queued → saved, waiting for the next round
   *  boundary; accepted → the running task read it (chip is in the
   *  transcript now). */
  status: "sending" | "queued" | "accepted";
  /** Which round read it, once accepted. */
  round?: number;
  /** Files the note carried (screenshot, binary, …) — names only, shown
   *  so a note with an attachment is never mistaken for a text-only one. */
  attachmentNames?: string[];
  /** Set instead of a status when it failed. */
  error?: string;
}

export function BtwDock({
  entry,
  onDismiss,
}: {
  entry: BtwEntry | null;
  onDismiss: () => void;
}) {
  if (!entry) return null;

  const status = entry.error
    ? "couldn't pass it along"
    : entry.status === "sending"
      ? "passing it to the running task…"
      : entry.status === "accepted"
        ? `read by the task at step ${entry.round ?? "?"}`
        : "passed — the task folds it in at its next thinking step";

  return (
    <div className="btw-dock px-3 pb-1.5 sm:px-4" data-open="false">
      <div className="mx-auto w-full max-w-3xl">
        <div className="overflow-hidden rounded-xl border border-[#6ba3a0]/25 bg-[#6ba3a0]/[0.06]">
          <div className="flex items-center gap-2 px-3 py-2">
            <span
              aria-hidden="true"
              className="flex-none rounded-lg bg-[#6ba3a0]/15 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-[#6ba3a0]"
            >
              btw
            </span>

            <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">
              {entry.note}
              {entry.attachmentNames?.length ? (
                <span className="text-text-muted">
                  {" "}
                  · {entry.attachmentNames.join(", ")}
                </span>
              ) : null}
            </span>

            <span
              className={`flex-none text-[11px] ${
                entry.error
                  ? "text-[#cf6a5f]"
                  : entry.status === "accepted"
                    ? "text-[#6ba3a0]"
                    : "text-[#6ba3a0]/70"
              }`}
            >
              {status}
            </span>

            {entry.status === "sending" && (
              <span className="btw-pulse flex-none" aria-hidden="true" />
            )}

            {/* Its own dismiss, on its own row.
                Deliberately never near Stop. Stop belongs to the main task
                and must keep exactly one meaning; this closes the dock and
                nothing else. Two controls that do different things should
                never sit in the same place. */}
            <button
              onClick={onDismiss}
              title={entry.status === "sending" ? "Cancel this note" : "Dismiss"}
              aria-label={entry.status === "sending" ? "Cancel this note" : "Dismiss"}
              className="flex-none rounded-lg p-1 text-text-muted transition-colors hover:bg-[#6ba3a0]/10 hover:text-[#6ba3a0]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* One line of context under the collapsed row, always visible:
              a note is easy to confuse with a message, so the dock says
              plainly what happened to it. */}
          <div className="border-t border-[#6ba3a0]/12 px-3 py-1.5">
            <p className="text-[11px] leading-4 text-text-muted">
              {entry.error
                ? entry.error
                : entry.status === "accepted"
                  ? "The task was not interrupted — it read your note mid-run. It is part of the conversation now."
                  : "The task keeps running exactly as it was; your note joins its thinking at the next step."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
