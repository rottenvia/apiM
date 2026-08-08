"use client";

import { useEffect, useRef } from "react";

export interface PendingCommand {
  id: string;
  command: string;
  args: string[];
  display: string;
  reason: string;
}

/**
 * Asks before running a command the model wrote.
 *
 * Inline in the transcript rather than a modal: it belongs to the reply it
 * interrupted, and a modal appearing over the chat while text is streaming is
 * jarring. Skip is focused, so a reflexive Enter does not run anything.
 */
export function ApprovalPrompt({
  pending,
  onDecide,
}: {
  pending: PendingCommand;
  onDecide: (id: string, approved: boolean, remember: boolean) => void;
}) {
  const skipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    skipRef.current?.focus();
  }, [pending.id]);

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-accent/30 bg-accent/[0.05]">
      <div className="flex items-start gap-2.5 px-3 pt-2.5">
        <span className="mt-0.5 flex-none text-accent-light">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 9l3 3-3 3m5 0h3M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5 text-text-primary">
            Run this command?
          </p>
          {pending.reason && (
            <p className="mt-0.5 text-[12px] leading-4 text-text-muted">
              {pending.reason}
            </p>
          )}
        </div>
      </div>

      <pre className="mx-3 mt-2 overflow-x-auto rounded-lg border border-border bg-bg-primary px-2.5 py-2 font-mono text-[12px] text-text-secondary">
        <span className="select-none text-text-muted">$ </span>
        {pending.display}
      </pre>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-accent/15 px-3 py-2">
        <button
          onClick={() => onDecide(pending.id, true, false)}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-light"
        >
          Run
        </button>

        <button
          ref={skipRef}
          onClick={() => onDecide(pending.id, false, false)}
          className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          Skip
        </button>

        {/* Scoped to this exact command in this chat, so trusting one thing
            never quietly approves something else. */}
        <button
          onClick={() => onDecide(pending.id, true, true)}
          title={`Run this, and don't ask again for "${pending.display}" in this chat`}
          className="ml-auto rounded-lg px-2.5 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          Always allow this
        </button>
      </div>
    </div>
  );
}
