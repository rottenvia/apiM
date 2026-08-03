"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Artifact {
  code: string;
  language: string | null;
  title: string;
  runnable: boolean;
}

type Tab = "preview" | "code";
type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORT_WIDTH: Record<Viewport, number | null> = {
  desktop: null,
  tablet: 768,
  mobile: 390,
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const EXTENSIONS: Record<string, string> = {
  javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  python: "py", py: "py", html: "html", css: "css", json: "json",
  markdown: "md", md: "md", bash: "sh", sh: "sh", shell: "sh", sql: "sql",
  yaml: "yml", yml: "yml", go: "go", rust: "rs", rs: "rs", java: "java",
  c: "c", cpp: "cpp", csharp: "cs", php: "php", ruby: "rb", rb: "rb",
};

/**
 * Slide-over panel showing one artifact, with a live preview for runnable
 * HTML and the source behind a tab. Modelled on the "open it beside the
 * conversation" pattern rather than dumping everything inline.
 */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(artifact.runnable ? "preview" : "code");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 220);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(artifact.code);
    setCopied(ok);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [artifact.code]);

  const handleDownload = useCallback(() => {
    const ext = (artifact.language && EXTENSIONS[artifact.language]) || "txt";
    const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/[^\w.-]+/g, "-").toLowerCase()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [artifact]);

  const openInNewTab = useCallback(() => {
    const blob = new Blob([artifact.code], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [artifact.code]);

  const width = VIEWPORT_WIDTH[viewport];
  const lineCount = artifact.code.split("\n").length;

  return (
    <div className="artifact-layer" data-visible={visible} role="dialog" aria-modal="true">
      <div className="artifact-scrim" onClick={handleClose} />

      <aside className="artifact-panel">
        <header className="artifact-header">
          <div className="artifact-heading">
            <span className="artifact-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="artifact-title">{artifact.title}</p>
              <p className="artifact-sub">
                {artifact.language ?? "text"} · {lineCount} lines
              </p>
            </div>
          </div>

          <div className="artifact-header-actions">
            <button onClick={handleCopy} className="artifact-btn" data-copied={copied}>
              {copied ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
                </svg>
              )}
              {copied ? "Copied" : "Copy"}
            </button>

            <button onClick={handleDownload} className="artifact-icon-btn" title="Download">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
              </svg>
            </button>

            <button ref={closeRef} onClick={handleClose} className="artifact-icon-btn artifact-close" title="Close (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {artifact.runnable && (
          <div className="artifact-subbar">
            <div className="artifact-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === "preview"}
                data-active={tab === "preview"}
                onClick={() => setTab("preview")}
                className="artifact-tab"
              >
                Preview
              </button>
              <button
                role="tab"
                aria-selected={tab === "code"}
                data-active={tab === "code"}
                onClick={() => setTab("code")}
                className="artifact-tab"
              >
                Code
              </button>
              <span className="artifact-tab-glider" data-tab={tab} aria-hidden="true" />
            </div>

            {tab === "preview" && (
              <div className="artifact-subbar-right">
                <div className="artifact-viewports" role="group" aria-label="Viewport">
                  {(Object.keys(VIEWPORT_WIDTH) as Viewport[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => setViewport(v)}
                      data-active={viewport === v}
                      className="artifact-vp"
                      title={v}
                      aria-label={v}
                    >
                      {v === "desktop" && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                          <rect x="2" y="4" width="20" height="13" rx="2" />
                          <path strokeLinecap="round" d="M8 21h8" />
                        </svg>
                      )}
                      {v === "tablet" && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                          <rect x="5" y="2" width="14" height="20" rx="2" />
                        </svg>
                      )}
                      {v === "mobile" && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                          <rect x="7" y="2" width="10" height="20" rx="2" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="artifact-icon-btn"
                  title="Reload"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2" />
                  </svg>
                </button>
                <button onClick={openInNewTab} className="artifact-icon-btn" title="Open in new tab">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}

        <div className="artifact-body">
          {artifact.runnable && tab === "preview" ? (
            <div className="artifact-stage">
              <div
                className="artifact-frame-wrap"
                style={width ? { width, maxWidth: "100%" } : undefined}
              >
                <iframe
                  key={reloadKey}
                  srcDoc={artifact.code}
                  title={artifact.title}
                  className="artifact-frame"
                  // Deliberately no allow-same-origin: scripts run in an
                  // opaque origin and cannot read this app's localStorage
                  // (where the API keys live) or touch its DOM.
                  sandbox="allow-scripts allow-forms allow-modals allow-popups"
                  referrerPolicy="no-referrer"
                />
              </div>
            </div>
          ) : (
            <pre className="artifact-code">
              <code>{artifact.code}</code>
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}
