"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Composer chip that switches the file tools on for the conversation.
 *
 * Off by default and explicit on purpose: with it on, the model can write and
 * delete files on the user's disk, which is not something to enable silently.
 */
export function WorkspaceToggle({
  enabled,
  fileCount,
  onToggle,
  onOpenFiles,
}: {
  enabled: boolean;
  fileCount: number;
  onToggle: (next: boolean) => void;
  onOpenFiles: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  return (
    <div ref={ref}>
      <button
        onClick={() => setIsOpen((o) => !o)}
        className="chip"
        data-active={enabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title="Let the assistant create and edit files"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
        <span>
          Files
          {enabled && fileCount > 0 ? ` · ${fileCount}` : enabled ? " on" : ""}
        </span>
      </button>

      {isOpen && (
        // Same anchoring as the other composer selectors, so every popover
        // opens centered above the chat bar rather than drifting per control.
        <div className="absolute bottom-full left-1/2 z-50 mb-3 w-[min(21rem,calc(100vw-1.5rem))] -translate-x-1/2">
          <div className="popover-card">
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-5 text-text-primary">
                  Workspace
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  Let the assistant create and edit real files
                </p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="popover-close"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-1.5">
              <button
                role="switch"
                aria-checked={enabled}
                className="option-item"
                data-active={enabled}
                onClick={() => onToggle(!enabled)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[13px] font-medium leading-5 ${
                        enabled ? "text-accent-light" : "text-text-primary"
                      }`}
                    >
                      {enabled ? "On" : "Off"}
                    </span>
                    <span
                      aria-hidden
                      className={`relative h-[20px] w-[34px] flex-none rounded-full transition-colors ${
                        enabled ? "bg-accent" : "bg-border"
                      }`}
                    >
                      <span
                        className={`absolute top-[3px] h-3.5 w-3.5 rounded-full bg-white transition-all ${
                          enabled ? "left-[17px]" : "left-[3px]"
                        }`}
                      />
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                    {enabled
                      ? "The assistant can read, write and delete files in this chat's folder."
                      : "The assistant can't touch any files. It will print code instead."}
                  </p>
                </div>
              </button>

              {enabled && (
                <button
                  className="option-item"
                  onClick={() => {
                    onOpenFiles();
                    setIsOpen(false);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium leading-5 text-text-primary">
                        Browse files
                      </span>
                      <span className="text-[11px] text-text-muted">
                        {fileCount === 0
                          ? "empty"
                          : `${fileCount} file${fileCount === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                      See and edit everything in this workspace.
                    </p>
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
