"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORTS: Record<Viewport, { label: string; width: number | null }> = {
  desktop: { label: "Desktop", width: null },
  tablet: { label: "Tablet", width: 768 },
  mobile: { label: "Mobile", width: 390 },
};

/**
 * Sandboxed live preview for a full HTML document.
 *
 * Security: the iframe uses `srcDoc` with `sandbox="allow-scripts"` and
 * deliberately WITHOUT `allow-same-origin`. That combination gives the page a
 * unique opaque origin, so scripts can run (needed for a game) but cannot
 * reach this app's cookies, localStorage — where the API keys live — or DOM.
 */
export function HtmlPreview({
  html,
  onClose,
}: {
  html: string;
  onClose: () => void;
}) {
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Play the entry transition on the frame after mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Run the exit animation before unmounting.
  const handleClose = useCallback(() => {
    setClosing(true);
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  // Escape to close, and keep focus trapped on the dialog's close button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Prevent the page behind the overlay from scrolling.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const openInNewTab = useCallback(() => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [html]);

  const frameWidth = VIEWPORTS[viewport].width;

  return (
    <div
      className="preview-overlay"
      data-visible={visible}
      data-closing={closing}
      role="dialog"
      aria-modal="true"
      aria-label="HTML preview"
    >
      <div className="preview-backdrop" onClick={handleClose} />

      <div className="preview-panel">
        <header className="preview-toolbar">
          <div className="preview-toolbar-group">
            <span className="preview-dot preview-dot-red" />
            <span className="preview-dot preview-dot-amber" />
            <span className="preview-dot preview-dot-green" />
            <span className="preview-title">Preview</span>
          </div>

          <div className="preview-segmented" role="group" aria-label="Viewport size">
            {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => (
              <button
                key={key}
                onClick={() => setViewport(key)}
                data-active={viewport === key}
                className="preview-segment"
                title={VIEWPORTS[key].label}
              >
                {VIEWPORTS[key].label}
              </button>
            ))}
          </div>

          <div className="preview-toolbar-group">
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="preview-icon-btn"
              title="Reload preview"
              aria-label="Reload preview"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2" />
              </svg>
            </button>
            <button
              onClick={openInNewTab}
              className="preview-icon-btn"
              title="Open in new tab"
              aria-label="Open in new tab"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            <button
              ref={closeRef}
              onClick={handleClose}
              className="preview-icon-btn preview-icon-close"
              title="Close preview (Esc)"
              aria-label="Close preview"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="preview-stage">
          <div
            className="preview-frame-wrap"
            style={frameWidth ? { width: frameWidth, maxWidth: "100%" } : undefined}
          >
            <iframe
              key={reloadKey}
              srcDoc={html}
              title="HTML preview"
              className="preview-frame"
              // No allow-same-origin: scripts run in an opaque origin and
              // cannot touch this app's storage or DOM.
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
