"use client";

import { useState } from "react";
import { normalisePlanStepText } from "@/lib/plan-view";

export interface PlanStepView {
  id: number;
  text: string;
  state: string;
  verified?: string;
  blocker?: string;
}

export interface PlanView {
  goal: string;
  steps: PlanStepView[];
  summary: string;
}

/**
 * What the agent is doing, and how far through it is.
 *
 * Without this the plan exists only inside the model's context, which is the
 * same problem the plan was built to solve — just moved to the user. A long
 * run currently shows a stream of tool calls with no sense of whether it is a
 * third of the way through or nearly done.
 *
 * Collapsed by default once there is more than a handful of steps: the point
 * is the progress line, and an expanded twenty-step list would push the
 * actual reply off the screen. The next step is always shown, because "what
 * is it doing right now" is the question this answers most often.
 */

const MARK: Record<string, { symbol: string; className: string }> = {
  done: { symbol: "✓", className: "text-[#7ea05a]" },
  doing: { symbol: "▸", className: "text-[#cfa25a]" },
  blocked: { symbol: "!", className: "text-danger" },
  todo: { symbol: "·", className: "text-text-muted" },
};

export function PlanPanel({
  plan,
  onUnblock,
  onClear,
}: {
  plan: PlanView;
  /** Reopen blocked steps and tell the agent to try again. */
  onUnblock?: () => void;
  /** Delete the saved plan entirely. */
  onClear?: () => void;
}) {
  const done = plan.steps.filter((s) => s.state === "done").length;
  const blocked = plan.steps.filter((s) => s.state === "blocked").length;
  const total = plan.steps.length;
  const complete = done === total;

  // Short plans are worth showing in full; long ones would dominate.
  const [open, setOpen] = useState(total <= 6);

  const current =
    plan.steps.find((s) => s.state === "doing") ??
    plan.steps.find((s) => s.state === "todo");

  return (
    <div className="mb-2.5 overflow-hidden rounded-xl border border-border bg-bg-secondary/60">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover/40"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
          className={`flex-none text-text-muted transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-5 text-text-primary">
            {plan.goal}
          </p>
          {!open && (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
              {complete
                ? "All steps done"
                : current
                  ? `Now: ${normalisePlanStepText(current.text) || "Untitled step"}`
                  : plan.summary}
            </p>
          )}
        </div>

        {/* A bar rather than a spinner: this has a real denominator, and a
            spinner would say "working" when the useful fact is "7 of 12". */}
        <span className="flex flex-none items-center gap-2">
          <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-bg-tertiary sm:block">
            <span
              className="block h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${total ? (done / total) * 100 : 0}%` }}
            />
          </span>
          <span
            className={`text-[11px] font-medium tabular-nums ${
              blocked ? "text-danger" : complete ? "text-[#7ea05a]" : "text-text-secondary"
            }`}
          >
            {done}/{total}
          </span>
        </span>
      </button>

      {open && (
        <ul className="border-t border-border px-3 py-2">
          {plan.steps.map((step) => {
            const mark = MARK[step.state] ?? MARK.todo;
            return (
              <li key={step.id} className="flex items-start gap-2 py-1">
                <span
                  className={`mt-0.5 w-3 flex-none text-center text-[12px] font-semibold ${mark.className}`}
                  aria-hidden="true"
                >
                  {mark.symbol}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-[12px] leading-5 ${
                      step.state === "done"
                        ? "text-text-muted line-through decoration-text-muted/40"
                        : "text-text-secondary"
                    }`}
                  >
                    {normalisePlanStepText(step.text) || "Untitled step"}
                  </span>
                  {/* Shown because it is the evidence, not decoration: a step
                      marked done without it cannot exist. */}
                  {step.state === "done" && step.verified && (
                    <span className="mt-0.5 block text-[11px] leading-4 text-text-muted">
                      checked: {step.verified}
                    </span>
                  )}
                  {step.state === "blocked" && step.blocker && (
                    <span className="mt-0.5 block text-[11px] leading-4 text-danger/80">
                      blocked: {step.blocker}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/*
       * A plan the user cannot act on is a lock, not a status. When a step
       * is blocked — most often a refusal encoded as an obstacle — the user
       * gets two exits: reopen the blocked steps and let the reply try
       * again, or delete the plan outright. Both hit the same plan store on
       * disk the agent reads, so the blocked state cannot come back on the
       * next message. Shown even when collapsed: the count is red, and the
       * whole reason it exists is the stuck case.
       */}
      {blocked > 0 && (onUnblock || onClear) && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          {onUnblock && (
            <button
              onClick={onUnblock}
              className="rounded-lg bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent"
            >
              Reopen &amp; retry
            </button>
          )}
          {onClear && (
            <button
              onClick={onClear}
              className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover/60"
            >
              Clear plan
            </button>
          )}
          <span className="ml-auto text-[11px] text-text-muted">
            Blocked steps can always be cleared
          </span>
        </div>
      )}
    </div>
  );
}
