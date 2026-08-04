"use client";

import { formatBytes } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3">
      {attachments.map((file) => (
        <div
          key={file.id}
          className="group flex max-w-[15rem] items-center gap-2 rounded-lg border border-border bg-bg-elevated py-1 pl-2 pr-1"
          title={
            file.truncated
              ? `${file.name} — truncated, only the start was included`
              : file.name
          }
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
            className="flex-none text-text-muted"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
          </svg>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs leading-4 text-text-primary">
              {file.name}
            </span>
            <span className="block text-[10px] leading-3 text-text-muted">
              {formatBytes(file.size)}
              {file.truncated && (
                <span className="text-warning"> · truncated</span>
              )}
            </span>
          </span>

          <button
            onClick={() => onRemove(file.id)}
            aria-label={`Remove ${file.name}`}
            className="flex h-5 w-5 flex-none items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-hover hover:text-danger"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
