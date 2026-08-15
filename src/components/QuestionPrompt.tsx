"use client";

import { useEffect, useRef, useState } from "react";

export interface PendingQuestion {
  id: string;
  question: string;
  options: string[];
  context: string;
}

/**
 * A question the model asked mid-task.
 *
 * Inline in the transcript rather than a modal: it belongs to the reply that
 * paused for it, and a dialog appearing over streaming text is jarring. Unlike
 * the approval prompt there is no safe default here — an unanswered question
 * means the model guesses — so the input is focused rather than a cancel.
 */
export function QuestionPrompt({
  pending,
  onAnswer,
}: {
  pending: PendingQuestion;
  onAnswer: (id: string, answer: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [pending.id]);

  const submit = () => {
    const answer = text.trim();
    if (answer) onAnswer(pending.id, answer);
  };

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
            <circle cx="12" cy="12" r="9" />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5 text-text-primary">
            {pending.question}
          </p>
          {pending.context && (
            <p className="mt-0.5 text-[12px] leading-4 text-text-muted">
              {pending.context}
            </p>
          )}
        </div>
      </div>

      {pending.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {pending.options.map((option) => (
            <button
              key={option}
              onClick={() => onAnswer(pending.id, option)}
              className="rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5 border-t border-accent/15 px-3 py-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            pending.options.length > 0
              ? "Or type your own answer…"
              : "Type your answer…"
          }
          aria-label="Your answer"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-light"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="flex-none rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
