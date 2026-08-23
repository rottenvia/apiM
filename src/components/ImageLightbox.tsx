"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Full-size preview for an attached image.
 *
 * Opens from the small composer thumbnail, closes on Escape or a click
 * outside, and shows the extracted description beside the picture so the user
 * can check what the model will actually receive.
 */
export function ImageLightbox({
  src,
  name,
  description,
  source,
  kind = "image",
  onClose,
}: {
  src: string;
  name: string;
  description?: string;
  source?: "vision" | "ocr";
  kind?: "image" | "video";
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [showText, setShowText] = useState(false);
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
    // Capture phase so this closes before any other Escape handler runs.
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

  // Rendered in a portal so the overlay escapes the message bubble's
  // transformed ancestor and can actually cover the viewport.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${name}`}
    >
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity duration-150 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        className={`relative flex max-h-full max-w-full flex-col overflow-hidden rounded-2xl border border-[#403c34] bg-[#141210] shadow-[0_28px_80px_rgba(0,0,0,0.6)] transition-all duration-150 ${
          visible ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"
        }`}
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-[#2c2924] px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              aria-hidden="true"
              className="flex-none text-[#d97f5d]"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
            </svg>
            <p className="truncate text-sm font-medium text-[#ede9e2]">{name}</p>
          </div>

          <div className="flex flex-none items-center gap-1.5">
            {description && (
              <button
                onClick={() => setShowText((v) => !v)}
                data-active={showText}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-[#2c2924] px-2.5 text-xs font-medium text-[#a29d92] transition-colors hover:border-[#403c34] hover:bg-[#33302a] hover:text-[#ede9e2] data-[active=true]:border-[#c96442]/40 data-[active=true]:bg-[#c96442]/10 data-[active=true]:text-[#d97f5d]"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
                </svg>
                {showText ? "Hide text" : source === "ocr" ? "OCR text" : "Extracted text"}
              </button>
            )}
            <button
              ref={closeRef}
              onClick={handleClose}
              title="Close (Esc)"
              aria-label="Close preview"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#cf6a5f]/15 hover:text-[#cf6a5f]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-[#0e0d0c] p-2">
            {kind === "video" ? (
              <video
                src={src}
                controls
                playsInline
                className={`max-h-[calc(100vh-8rem)] rounded-lg object-contain ${
                  showText && description
                    ? "max-w-[calc(100vw-26rem)]"
                    : "max-w-[calc(100vw-4rem)]"
                }`}
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={src}
                alt={name}
                className={`max-h-[calc(100vh-8rem)] rounded-lg object-contain ${
                  showText && description
                    ? "max-w-[calc(100vw-26rem)]"
                    : "max-w-[calc(100vw-4rem)]"
                }`}
              />
            )}
          </div>

          {showText && description && (
            <div className="max-h-56 min-h-0 shrink-0 overflow-y-auto border-t border-[#2c2924] bg-[#141210] p-3.5 md:max-h-none md:w-80 md:border-l md:border-t-0 [overscroll-behavior:contain]">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6d685d]">
                {source === "ocr"
                  ? "OCR — visible text only"
                  : "What the assistant receives"}
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[#a29d92]">
                {description}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}