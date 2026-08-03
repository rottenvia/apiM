"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Artifact {
  code: string;
  language: string | null;
  title: string;
}

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
 * Slide-over panel showing one code artifact.
 *
 * Styled entirely with Tailwind utilities and explicit SVG width/height so it
 * cannot break if a stale stylesheet is ever served against fresh markup.
 */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
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
    // Let the slide-out transition finish before unmounting.
    setTimeout(onClose, 200);
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
    const name = artifact.title.replace(/[^\w.-]+/g, "-").toLowerCase() || "snippet";
    const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [artifact]);

  const lineCount = artifact.code.split("\n").length;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
      {/* Scrim */}
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <aside
        className={`relative flex h-full w-full flex-col border-l border-[#403c34] bg-[#141210] shadow-[-24px_0_60px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:w-[min(860px,100%)] ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <header className="flex flex-none items-center justify-between gap-3 border-b border-[#2c2924] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-[#2a2723] text-[#d97f5d]">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#ede9e2]">
                {artifact.title}
              </p>
              <p className="text-[11px] text-[#6d685d]">
                {artifact.language ?? "text"} · {lineCount} lines
              </p>
            </div>
          </div>

          <div className="flex flex-none items-center gap-1.5">
            <button
              onClick={handleCopy}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[#2c2924] px-2.5 text-xs font-medium text-[#a29d92] transition-colors hover:border-[#403c34] hover:bg-[#33302a] hover:text-[#ede9e2]"
            >
              {copied ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7ba478" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                  </svg>
                  <span className="text-[#7ba478]">Copied</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
                  </svg>
                  Copy
                </>
              )}
            </button>

            <button
              onClick={handleDownload}
              title="Download"
              aria-label="Download"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
              </svg>
            </button>

            <button
              ref={closeRef}
              onClick={handleClose}
              title="Close (Esc)"
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a29d92] transition-colors hover:bg-[#cf6a5f]/15 hover:text-[#cf6a5f]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {/* Code */}
        <pre className="m-0 min-h-0 flex-1 overflow-auto bg-[#141210] px-4 py-3.5 font-mono text-[13px] leading-relaxed text-[#ede9e2] [overscroll-behavior:contain] [tab-size:2]">
          <code>{artifact.code}</code>
        </pre>
      </aside>
    </div>
  );
}
