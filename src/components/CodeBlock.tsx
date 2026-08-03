"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HtmlPreview } from "@/components/HtmlPreview";

/**
 * Recursively extract plain text from a React node tree.
 * react-markdown hands us nested elements, so `children` is not always a
 * string — this is what actually gets written to the clipboard.
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeToText(props?.children);
  }
  return "";
}

/** Read the `language-xxx` class react-markdown puts on the inner <code>. */
function languageOf(node: ReactNode): string | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = languageOf(child);
      if (found) return found;
    }
    return null;
  }
  if ("props" in node) {
    const props = (node as { props?: { className?: string; children?: ReactNode } })
      .props;
    const match = /language-([\w+-]+)/.exec(props?.className ?? "");
    if (match) return match[1];
    return languageOf(props?.children);
  }
  return null;
}

/** File extension to offer when downloading a block. */
const EXTENSIONS: Record<string, string> = {
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  python: "py",
  py: "py",
  html: "html",
  css: "css",
  json: "json",
  markdown: "md",
  md: "md",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  yaml: "yml",
  yml: "yml",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  php: "php",
  ruby: "rb",
  rb: "rb",
};

/**
 * Clipboard write with a fallback for non-HTTPS origins, where
 * `navigator.clipboard` is undefined (e.g. visiting the dev server over LAN IP).
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Collapse blocks longer than this until the user expands them. */
const COLLAPSE_THRESHOLD = 28;

export function CodeBlock({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const code = useMemo(
    () => nodeToText(children).replace(/\n$/, ""),
    [children]
  );
  const language = useMemo(() => languageOf(children), [children]);

  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const isLong = lineCount > COLLAPSE_THRESHOLD;

  // Only offer a live preview for something that is actually a full document.
  const isRunnableHtml = useMemo(() => {
    if (language !== "html") return false;
    return /<html[\s>]|<!doctype html/i.test(code);
  }, [language, code]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(code);
    setState(ok ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), 2000);
  }, [code]);

  const handleDownload = useCallback(() => {
    const ext = (language && EXTENSIONS[language]) || "txt";
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on the next tick so the download has definitely started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [code, language]);

  return (
    <>
      <div className="code-block group" data-collapsed={isLong && !expanded}>
        {/* Sticky so Copy stays reachable while scrolling a long block —
            previously it scrolled away and became unusable. */}
        <div className="code-block-bar">
          <span className="code-block-lang">
            {language ?? "code"}
            <span className="code-block-lines">{lineCount} lines</span>
          </span>

          <div className="code-block-actions">
            {isRunnableHtml && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="code-action-btn code-action-run"
                title="Run this HTML in a sandboxed preview"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.5v13l11-6.5-11-6.5z" />
                </svg>
                Preview
              </button>
            )}

            <button
              type="button"
              onClick={handleDownload}
              className="code-action-btn"
              title="Download as a file"
              aria-label="Download code"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
              </svg>
            </button>

            <button
              type="button"
              onClick={handleCopy}
              className="code-action-btn"
              data-state={state}
              aria-label={state === "copied" ? "Copied" : "Copy code"}
              title={state === "copied" ? "Copied" : "Copy code"}
            >
              {state === "copied" ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                  </svg>
                  Copied
                </>
              ) : state === "failed" ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  Failed
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
        </div>

        <div className="code-block-body">
          <pre>{children}</pre>
        </div>

        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="code-expand-btn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              data-expanded={expanded}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
            {expanded ? "Show less" : `Show all ${lineCount} lines`}
          </button>
        )}
      </div>

      {previewOpen && (
        <HtmlPreview html={code} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
}
