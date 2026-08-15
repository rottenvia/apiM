"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The side channel, docked above the composer.
 *
 * It sits between the status line and the input on purpose. That is its
 * conceptual place: attached to the conversation, but not part of it. Putting
 * it in the message column would break the one thing a transcript guarantees
 * — that reading top to bottom is reading what happened, in order.
 *
 * Collapsed it is a single row, so an aside never pushes the reply you are
 * reading around. Expanding is the only thing that changes height, and it
 * animates from the bottom edge so the composer stays where your hands are.
 *
 * Teal rather than the accent terracotta, and never the amber used for
 * thinking. The colour is doing real work here: it says at a glance that this
 * is a different channel from the task, not another step in it.
 */

export interface BtwEntry {
  id: string;
  question: string;
  answer: string;
  /** Set while the answer is still being fetched. */
  pending: boolean;
  /** Set instead of an answer when it failed. */
  error?: string;
  usdEstimate?: number | null;
}

export function BtwDock({
  entry,
  onDismiss,
  onAskProperly,
  mainTaskRunning,
}: {
  entry: BtwEntry | null;
  onDismiss: () => void;
  /** Re-send as a real message. Only offered once the task is done. */
  onAskProperly: (question: string) => void;
  mainTaskRunning: boolean;
}) {
  /**
   * Whether the user has overridden the default open/closed state.
   *
   * Derived rather than stored: an answer opens the panel on its own, and
   * storing that in an effect meant writing state during render, which React
   * rightly complains about. Keyed by entry id so a new question starts fresh
   * without anything having to reset it.
   */
  const [override, setOverride] = useState<{ id: string; open: boolean } | null>(
    null
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  if (!entry) return null;

  // Opens itself the moment an answer lands, so it is not missed while the
  // main reply is still scrolling past above it.
  const open =
    override && override.id === entry.id ? override.open : !entry.pending;

  const toggle = () => setOverride({ id: entry.id, open: !open });

  const status = entry.pending
    ? "thinking…"
    : entry.error
      ? "couldn't answer"
      : "answered";

  return (
    <div className="btw-dock px-3 pb-1.5 sm:px-4" data-open={open}>
      <div className="mx-auto w-full max-w-3xl">
        <div className="overflow-hidden rounded-xl border border-[#6ba3a0]/25 bg-[#6ba3a0]/[0.06]">
          {/* The single collapsed row. Everything else is optional. */}
          <div className="flex items-center gap-2 px-3 py-2">
            <span
              aria-hidden="true"
              className="flex-none rounded-lg bg-[#6ba3a0]/15 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-[#6ba3a0]"
            >
              btw
            </span>

            <button
              onClick={toggle}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="truncate text-[13px] text-text-secondary">
                {entry.question}
              </span>
              <span className="flex-none text-[11px] text-[#6ba3a0]/70">
                {status}
              </span>
            </button>

            {entry.pending && (
              <span className="btw-pulse flex-none" aria-hidden="true" />
            )}

            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth={2.2} aria-hidden="true"
              className={`flex-none text-[#6ba3a0]/60 transition-transform duration-150 ${
                open ? "rotate-90" : ""
              }`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>

            {/* Its own dismiss, on its own row.
                
                Deliberately never near Stop. Stop belongs to the main task and
                must keep exactly one meaning; this closes the aside and
                nothing else. Two controls that do different things should
                never sit in the same place. */}
            <button
              onClick={onDismiss}
              title={entry.pending ? "Cancel this question" : "Dismiss"}
              aria-label={entry.pending ? "Cancel this question" : "Dismiss"}
              className="flex-none rounded-lg p-1 text-text-muted transition-colors hover:bg-[#6ba3a0]/10 hover:text-[#6ba3a0]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Grid-rows trick, same as the thinking panel: animates to the
              content's real height without anyone measuring it. */}
          <div className="btw-body" data-open={open}>
            <div>
              <div
                ref={bodyRef}
                className="btw-body-inner max-h-64 overflow-y-auto px-3 pb-2.5 [overscroll-behavior:contain]"
              >
                {entry.error ? (
                  <p className="text-[12px] leading-relaxed text-[#cf6a5f]">
                    {entry.error}
                  </p>
                ) : (
                  <div className="btw-prose text-[13px] leading-relaxed text-text-secondary">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {entry.answer || "…"}
                    </ReactMarkdown>
                  </div>
                )}

                {!entry.pending && !entry.error && (
                  <div className="mt-2 flex items-center gap-2 border-t border-[#6ba3a0]/12 pt-2">
                    <span className="text-[11px] text-text-muted">
                      Answered on the side — the task was not interrupted
                    </span>
                    {!mainTaskRunning && (
                      <button
                        onClick={() => onAskProperly(entry.question)}
                        title="Ask this again as a normal message, with tools"
                        className="ml-auto flex-none rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-[#6ba3a0] transition-colors hover:bg-[#6ba3a0]/12"
                      >
                        Ask properly
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
