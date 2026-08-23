"use client";

import { useState } from "react";
import { formatBytes, STAGE_LABELS } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";
import { ImageLightbox } from "@/components/ImageLightbox";

function Spinner() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      className="flex-none animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={3} opacity={0.25} />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  /** Re-run a failed image description without re-attaching the file. */
  onRetry?: (id: string) => void;
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
          kind={preview.kind === "video" ? "video" : "image"}
          onClose={() => setPreview(null)}
        />
      )}

      {attachments
        .filter((f) => f.kind === "image" || f.kind === "video")
        .map((file) => (
          <div
            key={file.id}
            className="group relative overflow-hidden rounded-lg border border-border bg-bg-elevated"
          >
            <button
              onClick={() =>
                file.visionError && onRetry
                  ? onRetry(file.id)
                  : setPreview(file)
              }
              title={
                file.visionError
                  ? `${file.visionError} — click to retry`
                  : `${file.name} — click to enlarge`
              }
              className="block"
            >
              {file.kind === "video" ? (
                <video
                  src={file.dataUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-16 w-16 object-cover transition-transform duration-150 group-hover:scale-105"
                />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={file.dataUrl}
                  alt={file.name}
                  className="h-16 w-16 object-cover transition-transform duration-150 group-hover:scale-105"
                />
              )}

              {(file.analyzing || file.stage) && (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/65 text-[9px] font-medium text-white">
                  <Spinner />
                  <span className="animate-thinking">
                    {file.stage ? STAGE_LABELS[file.stage] : "Reading"}…
                  </span>
                </span>
              )}

              {file.visionError && !file.analyzing && (
                <span
                  className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-danger/75 px-1 text-center text-[9px] font-medium leading-tight text-white"
                  title={file.visionError}
                >
                  Failed
                  {onRetry && <span className="underline">retry</span>}
                </span>
              )}

              {file.description && !file.analyzing && (
                <span className="absolute bottom-0 left-0 right-0 truncate bg-black/70 px-1 py-0.5 text-[9px] text-white">
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
        .filter((f) => f.kind === "text")
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
            {/* While a file is being read the stage replaces the size, since
                the size is known but uninteresting and the stage is the only
                thing that changes. */}
            {file.stage ? (
              <span className="flex items-center gap-1.5 text-[11px] leading-3 text-accent-light">
                <Spinner />
                <span className="animate-thinking">
                  {STAGE_LABELS[file.stage]}…
                </span>
              </span>
            ) : (
              <span className="block text-[11px] leading-3 text-text-muted">
                {formatBytes(file.size)}
                {file.fileCount !== undefined && (
                  <span className="text-accent-light">
                    {" "}
                    · {file.fileCount} file{file.fileCount === 1 ? "" : "s"}
                  </span>
                )}
                {file.truncated && (
                  <span className="text-warning"> · truncated</span>
                )}
              </span>
            )}
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
