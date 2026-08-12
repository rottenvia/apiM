"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const MIN_DELETE_DELAY = 1;
export const MAX_DELETE_DELAY = 30;
export const DEFAULT_DELETE_DELAY = 5;

/** Keeps a stored/typed value inside the allowed range. */
export function clampDeleteDelay(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DELETE_DELAY;
  return Math.min(MAX_DELETE_DELAY, Math.max(MIN_DELETE_DELAY, n));
}

/**
 * Confirmation for deleting a chat, with a countdown before the button arms.
 *
 * The delay is the point: deleting a conversation destroys every message in
 * it and there is no undo, so the pause forces a beat of attention rather
 * than a reflex click.
 */
export function DeleteChatDialog({
  title,
  messageCount,
  /**
   * Titles of the other chats going with this one, when several are selected.
   *
   * Kept separate from `title` rather than folded into one string: the first
   * chat still gets the same prominent line it always had, and the rest are
   * listed underneath. Deleting eleven chats should not look like deleting
   * one with a long name.
   */
  alsoTitles,
  delaySeconds,
  onConfirm,
  onCancel,
}: {
  title: string;
  messageCount?: number;
  alsoTitles?: string[];
  delaySeconds: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const extra = alsoTitles?.length ?? 0;
  const totalChats = extra + 1;
  const total = clampDeleteDelay(delaySeconds);
  const [remaining, setRemaining] = useState(total);
  const [visible, setVisible] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const armed = remaining <= 0;

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Tick from a deadline rather than decrementing a counter: background tabs
  // throttle timers, and a plain counter would drift or stall.
  useEffect(() => {
    const deadline = Date.now() + total * 1000;
    const tick = () => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      setRemaining(left > 0 ? left : 0);
    };
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [total]);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(onCancel, 150);
  }, [onCancel]);

  useEffect(() => {
    // Focus lands on Cancel, so a stray Enter can't confirm the destruction.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const progress = total > 0 ? (total - remaining) / total : 1;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        onClick={close}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-150 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-chat-title"
        className={`relative w-full max-w-[26rem] overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl transition-all duration-150 ${
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
      >
        <div className="px-5 pt-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-danger/12 text-danger">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </span>

            <div className="min-w-0">
              <h2
                id="delete-chat-title"
                className="text-[15px] font-semibold leading-6 text-text-primary"
              >
                {totalChats > 1 ? `Delete ${totalChats} chats?` : "Are you sure?"}
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-text-secondary">
                You will lose all data of{" "}
                {totalChats > 1 ? "these chats" : "this chat"}. This cannot be
                undone.
              </p>
            </div>
          </div>

          <div className="mt-3.5 rounded-xl border border-border bg-bg-primary px-3 py-2.5">
            <p className="truncate text-[13px] font-medium text-text-primary" title={title}>
              {title || "Untitled chat"}
            </p>

            {/*
              Name every chat, up to a point.

              A confirmation that says only "12 chats" asks you to trust your
              own memory of what you ticked, which is exactly the thing the
              countdown exists to slow down. The list is scrollable and capped
              so a hundred selected chats cannot push the buttons off screen.
            */}
            {extra > 0 && (
              <div className="mt-1.5 max-h-28 overflow-y-auto border-t border-border pt-1.5">
                {alsoTitles!.slice(0, 40).map((t, i) => (
                  <p
                    key={i}
                    className="truncate text-[12px] leading-5 text-text-secondary"
                    title={t}
                  >
                    {t || "Untitled chat"}
                  </p>
                ))}
                {extra > 40 && (
                  <p className="text-[12px] leading-5 text-text-muted">
                    and {extra - 40} more…
                  </p>
                )}
              </div>
            )}

            <p className="mt-1 text-[12px] text-text-muted">
              {totalChats > 1
                ? `${totalChats} chats, and every message in them, will be deleted.`
                : messageCount === undefined
                  ? "Every message in it will be deleted."
                  : `${messageCount} message${
                      messageCount === 1 ? "" : "s"
                    } will be deleted.`}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 border-t border-border px-5 py-3.5">
          <p className="min-w-0 flex-1 text-[12px] leading-4 text-text-muted">
            {armed ? (
              "You can delete it now."
            ) : (
              <>Unlocking in {remaining}s…</>
            )}
          </p>

          <button
            ref={cancelRef}
            onClick={close}
            className="flex-none rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            Cancel
          </button>

          <button
            onClick={() => armed && onConfirm()}
            disabled={!armed}
            aria-disabled={!armed}
            title={
              armed
                ? totalChats > 1
                  ? `Delete these ${totalChats} chats`
                  : "Delete this chat"
                : `Unlocks in ${remaining}s`
            }
            className={`relative flex-none overflow-hidden rounded-lg px-3 py-1.5 text-[13px] font-medium text-white transition-colors ${
              armed
                ? "cursor-pointer bg-danger/90 hover:bg-danger"
                : "cursor-not-allowed bg-danger/25"
            }`}
          >
            {/* Fills left-to-right as the lock expires, so the wait reads as
                progress rather than an unexplained dead button. */}
            {!armed && (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-danger/35 transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            )}
            <span className="relative">
              {armed
                ? totalChats > 1
                  ? `Delete ${totalChats}`
                  : "Delete"
                : `Delete (${remaining})`}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
