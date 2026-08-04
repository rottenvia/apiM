"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface Version {
  content: string;
  model?: string;
  createdAt?: string;
  label: string;
}

/**
 * Side-by-side (stacked) comparison of two replies to the same prompt.
 *
 * Each pane scrolls independently with `overscroll-behavior: contain`, so a
 * pane reaching its end does not start scrolling the page behind it.
 */
export function CompareVersions({
  versions,
  onClose,
}: {
  versions: Version[];
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(Math.max(0, versions.length - 2));
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [handleClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const top = versions[index];
  const bottom = versions[index + 1] ?? versions[versions.length - 1];
  const canPage = versions.length > 2;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Compare replies"
    >
      {/* Blurred backdrop — the conversation stays visible but recedes. */}
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        className={`relative flex h-full max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#403c34] bg-[#141210] shadow-[0_28px_80px_rgba(0,0,0,0.6)] transition-all duration-200 ${
          visible ? "scale-100 opacity-100" : "scale-[0.98] opacity-0"
        }`}
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-[#2c2924] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden="true"
              className="text-[#d97f5d]"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <p className="text-sm font-semibold text-[#ede9e2]">
              Compare replies
            </p>
            <span className="text-[11px] text-[#6d685d]">
              {versions.length} versions
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {canPage && (
              <>
                <button
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0}
                  aria-label="Earlier pair"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2] disabled:opacity-30"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() =>
                    setIndex((i) => Math.min(versions.length - 2, i + 1))
                  }
                  disabled={index >= versions.length - 2}
                  aria-label="Later pair"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2] disabled:opacity-30"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </>
            )}
            <button
              ref={closeRef}
              onClick={handleClose}
              title="Close (Esc)"
              aria-label="Close comparison"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#cf6a5f]/15 hover:text-[#cf6a5f]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <Pane version={top} tone="muted" />
          <div className="h-px flex-none bg-[#2c2924]" />
          <Pane version={bottom} tone="current" />
        </div>
      </div>
    </div>
  );
}

function Pane({
  version,
  tone,
}: {
  version: Version;
  tone: "muted" | "current";
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 px-4 py-1.5">
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            tone === "current"
              ? "bg-[#c96442]/15 text-[#d97f5d]"
              : "bg-[#2a2723] text-[#6d685d]"
          }`}
        >
          {version.label}
        </span>
        {version.model && (
          <span className="text-[10px] text-[#6d685d]">{version.model}</span>
        )}
      </div>

      {/* Independent scroll, contained so the page behind stays put. */}
      <div className="prose-chat min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-[14px] leading-relaxed text-[#ede9e2] [overscroll-behavior:contain]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {version.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
