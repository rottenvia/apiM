"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useArtifact } from "@/components/ArtifactContext";

/**
 * Recursively extract plain text from a React node tree.
 * react-markdown hands us nested elements, so `children` is not always a
 * string — this is what actually gets copied.
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
    const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
    const match = /language-([\w+-]+)/.exec(props?.className ?? "");
    if (match) return match[1];
    return languageOf(props?.children);
  }
  return null;
}

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

/** Guess a friendly title from the code itself. */
function deriveTitle(code: string, language: string | null): string {
  const titleTag = /<title>([^<]{1,60})<\/title>/i.exec(code);
  if (titleTag) return titleTag[1].trim();
  if (language === "html") return "HTML document";
  if (language) return `${language} snippet`;
  return "Snippet";
}

/** Blocks longer than this collapse to a compact card instead of inlining. */
const CARD_THRESHOLD = 14;

export function CodeBlock({ children }: { children?: ReactNode }) {
  const { open } = useArtifact();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const code = useMemo(() => nodeToText(children).replace(/\n$/, ""), [children]);
  const language = useMemo(() => languageOf(children), [children]);
  const lineCount = useMemo(() => code.split("\n").length, [code]);

  const runnable = useMemo(
    () => language === "html" && /<html[\s>]|<!doctype html/i.test(code),
    [language, code]
  );
  const title = useMemo(() => deriveTitle(code, language), [code, language]);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const ok = await copyText(code);
      setCopied(ok);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    },
    [code]
  );

  const openArtifact = useCallback(
    () => open({ code, language, title, runnable }),
    [open, code, language, title, runnable]
  );

  // Long or runnable output becomes a compact card that opens beside the
  // conversation — inlining hundreds of lines buries the actual reply.
  if (runnable || lineCount > CARD_THRESHOLD) {
    return (
      <div
        className="artifact-card"
        role="button"
        tabIndex={0}
        onClick={openArtifact}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openArtifact();
          }
        }}
      >
        <span className="artifact-card-icon">
          {runnable ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.5v13l11-6.5-11-6.5z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12" />
            </svg>
          )}
        </span>

        <span className="artifact-card-text">
          <span className="artifact-card-title">{title}</span>
          <span className="artifact-card-meta">
            {runnable ? "Click to run · " : "Click to open · "}
            {language ?? "text"} · {lineCount} lines
          </span>
        </span>

        <button onClick={handleCopy} className="artifact-card-copy" title="Copy code" aria-label="Copy code">
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
        </button>
      </div>
    );
  }

  // Short snippets stay inline — a card would be more friction than the code.
  return (
    <div className="code-block group">
      <div className="code-block-bar">
        <span className="code-block-lang">{language ?? "code"}</span>
        <button
          onClick={handleCopy}
          className="code-action-btn"
          data-state={copied ? "copied" : "idle"}
          title={copied ? "Copied" : "Copy code"}
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
              </svg>
              Copied
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
      <div className="code-block-body">
        <pre>{children}</pre>
      </div>
    </div>
  );
}
