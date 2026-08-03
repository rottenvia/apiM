"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

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

export function CodeBlock({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending reset if the block unmounts mid-timeout.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const code = nodeToText(children).replace(/\n$/, "");
  const language = languageOf(children);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(code);
    setState(ok ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), 2000);
  }, [code]);

  return (
    <div className="code-block group">
      <div className="code-block-bar">
        <span className="code-block-lang">{language ?? "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="code-copy-btn"
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"
                />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
