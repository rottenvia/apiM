"use client";

import { useState } from "react";
import { BtwDock } from "@/components/BtwDock";
import { BalanceWarning } from "@/components/BalanceWarning";
import type { BtwEntry } from "@/components/BtwDock";

/**
 * A look at the btw dock without spending anything.
 *
 * The real thing needs a running agent and an API key. This renders the same
 * component in each of its states against a mock composer, so the design can
 * be judged before deciding whether to keep it. Nothing here calls the API.
 *
 * Delete this route once the design is settled.
 */

const ANSWER = `\`chrome.storage.sync\` gives you **102,400 bytes total**, with a few limits worth knowing:

- **8,192 bytes** per item
- **512 items** maximum
- **1,800 writes per hour** (roughly one every two seconds)

If you're storing match history, use \`chrome.storage.local\` instead — it's 10MB and has no write quota.`;

const STATES: { label: string; note: string; entry: BtwEntry }[] = [
  {
    label: "Waiting",
    note: "Collapsed, one row. The dot breathes; nothing else moves.",
    entry: {
      id: "1",
      question: "what's the quota on chrome.storage.sync?",
      answer: "",
      pending: true,
    },
  },
  {
    label: "Answered",
    note: "Opens itself when the answer lands, so it isn't missed.",
    entry: {
      id: "2",
      question: "what's the quota on chrome.storage.sync?",
      answer: ANSWER,
      pending: false,
    },
  },
  {
    label: "Failed",
    note: "The task is untouched either way.",
    entry: {
      id: "3",
      question: "what's the quota on chrome.storage.sync?",
      answer: "",
      pending: false,
      error: "Insufficient DeepSeek balance for the side question.",
    },
  },
  {
    label: "Long question",
    note: "Truncates on one line rather than wrapping the dock open.",
    entry: {
      id: "4",
      question:
        "btw does the manifest v3 service worker get killed if the popup stays open for a long time, and does that affect the scanner?",
      answer: "It does — service workers are terminated after 30 seconds idle.",
      pending: false,
    },
  },
];

/** A non-functional composer, purely so the dock has its real neighbour. */
function MockComposer({ typing }: { typing: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-tertiary shadow-[0_6px_28px_rgba(0,0,0,0.28)]">
      <div className="px-4 pt-3.5 pb-1.5 text-[15px] leading-6">
        {typing ? (
          <span className="text-text-primary">
            btw what&apos;s the quota on chrome.storage.sync?
          </span>
        ) : (
          <span className="text-text-muted">
            Working… start with &quot;btw&quot; to ask something on the side
          </span>
        )}
      </div>

      {typing && (
        <div className="flex items-center gap-1.5 px-4 pb-1 text-[11px] text-[#6ba3a0]">
          <span className="btw-pulse" aria-hidden="true" />
          Asked on the side — the running task keeps going
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
            title="Ask on the side — won't interrupt the task"
            aria-label="Ask on the side"
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
          btw — the side channel
        </h1>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          A question asked while a long task runs. It never enters the
          transcript, has no tools, and Stop keeps belonging to the task. Click
          a row to expand it; the ✕ dismisses only the aside.
        </p>
      </div>

      <div className="mx-auto mt-10 w-full max-w-3xl space-y-14">
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
                working — round 12, editing content.js
              </div>

              <BtwDock
                entry={state.entry}
                onDismiss={() =>
                  setDismissed((prev) => new Set(prev).add(state.entry.id))
                }
                onAskProperly={() => {}}
                mainTaskRunning={state.entry.id !== "2"}
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
