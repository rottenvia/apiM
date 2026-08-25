"use client";

import { useState } from "react";
import { BtwDock } from "@/components/BtwDock";
import { BalanceWarning } from "@/components/BalanceWarning";
import { MessageBubble } from "@/components/MessageBubble";
import type { BtwEntry } from "@/components/BtwDock";

/**
 * A look at the btw note channel without spending anything.
 *
 * The real thing needs a running agent and an API key. This renders the same
 * components in each of their states against a mock composer, so the design
 * can be judged before deciding whether to keep it. Nothing here calls the
 * API.
 *
 * Delete this route once the design is settled.
 */

const NOTE = "it's a dead DLL — don't touch it, don't waste time on it";

const STATES: { label: string; note: string; entry: BtwEntry }[] = [
  {
    label: "Passing",
    note: "One row, one breathing dot. The task above is untouched.",
    entry: { id: "1", note: NOTE, status: "sending" },
  },
  {
    label: "Passed",
    note: "Saved. The task folds it in at its next thinking step — no restart.",
    entry: { id: "2", note: NOTE, status: "queued" },
  },
  {
    label: "Read",
    note: "The task read it mid-run. The chip in the transcript is the record; the dock confirms.",
    entry: { id: "3", note: NOTE, status: "accepted", round: 4 },
  },
  {
    label: "Failed",
    note: "Only the note failed. The task keeps running either way.",
    entry: {
      id: "4",
      note: NOTE,
      status: "queued",
      error: "Couldn't pass the note to the running task.",
    },
  },
];

/** A non-functional composer, purely so the dock has its real neighbour. */
function MockComposer({ typing }: { typing: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-tertiary shadow-[0_6px_28px_rgba(0,0,0,0.28)]">
      <div className="px-4 pt-3.5 pb-1.5 text-[15px] leading-6">
        {typing ? (
          <span className="text-text-primary">btw {NOTE}</span>
        ) : (
          <span className="text-text-muted">
            Working… start with &quot;btw&quot; to tell it something
          </span>
        )}
      </div>

      {typing && (
        <div className="flex items-center gap-1.5 px-4 pb-1 text-[11px] text-[#6ba3a0]">
          <span className="btw-pulse" aria-hidden="true" />
          Passes it to the running task — nothing stops
        </div>
      )}

      <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted">
            Web
          </span>
          <span className="rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted">
            Plugins
          </span>
        </div>
        {typing ? (
          <button
            className="send-btn btw-send"
            title="Pass it to the running task — won't interrupt it"
            aria-label="Pass it to the running task"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5" />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z"
              />
            </svg>
          </button>
        ) : (
          <button className="send-btn stop-btn" title="Stop generating" aria-label="Stop">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default function PreviewBtw() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  return (
    <div className="min-h-dvh bg-bg-primary px-6 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <h1 className="text-[15px] font-semibold text-text-primary">
          btw — notes for the running task
        </h1>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          A note added while a long task runs. It reaches the task at its next
          thinking step, changes nothing that was running, and stays in the
          transcript as a compact chip. Click a dock&apos;s ✕ to dismiss it;
          the task itself never sees a dismiss.
        </p>
      </div>

      <div className="mx-auto mt-10 w-full max-w-3xl space-y-14">
        {/* The note, where it lives permanently: in the transcript. */}
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-[13px] font-semibold text-text-primary">
              In the transcript
            </h2>
            <span className="text-[12px] text-text-muted">
              A chip, not a bubble — information handed to a running task, not a new one.
            </span>
          </div>
          <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary/40 p-4">
            <MessageBubble
              message={{
                id: "note-demo",
                role: "user",
                content: NOTE,
                isNote: true,
              }}
            />
            <MessageBubble
              message={{
                id: "reply-demo",
                role: "assistant",
                content:
                  "Understood — dropping the DLL from the analysis plan. Continuing with the PE header next, so the dead dependency stays out of the report.",
              }}
              isLast
            />
          </div>
        </section>

        {/* The interrupted banner, which is where Resume lives. */}
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-[13px] font-semibold text-text-primary">
              A reply that stopped early
            </h2>
            <span className="text-[12px] text-text-muted">
              Resume is the primary action; Start over stays quiet beside it.
            </span>
          </div>
          <MessageBubble
            message={{
              id: "interrupted-demo",
              role: "assistant",
              content:
                "I've set up the engine and started on the renderer. Writing the draw loop now",
              incomplete: true,
              canResume: true,
              errorNotice: "Your DeepSeek account has insufficient balance.",
              toolEvents: [
                { id: "t1", name: "write_file", args: "{}", ok: true, summary: "Created engine.js" },
              ],
            }}
            isLast
            onResume={() => {}}
            onRegenerate={() => {}}
            onOpenWorkspaceFile={() => {}}
            onDecideCommand={() => {}}
            onAnswerQuestion={() => {}}
          />
        </section>

        {/* The balance warning, in each of the states it can reach. */}
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-[13px] font-semibold text-text-primary">
              Balance warnings
            </h2>
            <span className="text-[12px] text-text-muted">
              Silent above $0.50. Appears on the way down, before it is too late to act.
            </span>
          </div>
          <div className="space-y-2">
            {[
              { total: 0.42, available: true },
              { total: 0.09, available: true },
              { total: -0.53, available: true },
            ].map((b) => (
              <BalanceWarning
                key={b.total}
                total={b.total}
                available={b.available}
                checking={false}
                onRefresh={() => {}}
                onDismiss={() => {}}
              />
            ))}
          </div>
        </section>

        {/* What it looks like as you type one */}
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-[13px] font-semibold text-text-primary">
              Composing
            </h2>
            <span className="text-[12px] text-text-muted">
              The prefix is recognised; the send button is no longer Stop.
            </span>
          </div>
          <MockComposer typing />
        </section>

        {/* Each state of the dock, above a real composer */}
        {STATES.map((state) =>
          dismissed.has(state.entry.id) ? null : (
            <section key={state.entry.id}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-[13px] font-semibold text-text-primary">
                  {state.label}
                </h2>
                <span className="text-[12px] text-text-muted">{state.note}</span>
              </div>

              {/* The status line the dock sits under, for context */}
              <div className="mb-1.5 flex items-center gap-2 px-3 text-[12px] text-text-muted">
                <span className="btw-pulse" aria-hidden="true" />
                working — round 3, decompiling main.dll
              </div>

              <BtwDock
                entry={state.entry}
                onDismiss={() =>
                  setDismissed((prev) => new Set(prev).add(state.entry.id))
                }
              />

              <MockComposer typing={false} />
            </section>
          )
        )}

        {dismissed.size > 0 && (
          <button
            onClick={() => setDismissed(new Set())}
            className="text-[12px] text-[#6ba3a0] hover:underline"
          >
            Bring back the dismissed ones
          </button>
        )}
      </div>
    </div>
  );
}
