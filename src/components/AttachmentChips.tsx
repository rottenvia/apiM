"use client";

import { useState } from "react";
import { formatBytes } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";
import { ImageLightbox } from "@/components/ImageLightbox";

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Attachment | null>(null);

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3">
      {preview?.dataUrl && (
        <ImageLightbox
          src={preview.dataUrl}
          name={preview.name}
          description={preview.description}
          onClose={() => setPreview(null)}
        />
      )}

      {attachments
        .filter((f) => f.kind === "image")
        .map((file) => (
          <div
            key={file.id}
            className="group relative overflow-hidden rounded-lg border border-border bg-bg-elevated"
          >
            <button
              onClick={() => setPreview(file)}
              title={`${file.name} — click to enlarge`}
              className="block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.dataUrl}
                alt={file.name}
                className="h-16 w-16 object-cover transition-transform duration-200 group-hover:scale-105"
              />

              {file.analyzing && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/65 text-[9px] font-medium text-white">
                  Reading…
                </span>
              )}

              {file.visionError && !file.analyzing && (
                <span
                  className="absolute inset-0 flex items-center justify-center bg-danger/75 px-1 text-center text-[9px] font-medium leading-tight text-white"
                  title={file.visionError}
                >
                  Failed
                </span>
              )}

              {file.description && !file.analyzing && (
                <span className="absolute bottom-0 left-0 right-0 truncate bg-black/70 px-1 py-0.5 text-[8px] text-white">
                  {file.description.replace(/\s+/g, " ").slice(0, 24)}…
                </span>
              )}
            </button>

            <button
              onClick={() => onRemove(file.id)}
              aria-label={`Remove ${file.name}`}
              className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/65 text-white opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}

      {attachments
        .filter((f) => f.kind !== "image")
        .map((file) => (
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
