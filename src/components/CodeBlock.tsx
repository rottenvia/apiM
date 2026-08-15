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
  if (language) return `${language} snippet`;
  return "Snippet";
}

/** Blocks longer than this collapse to a card instead of rendering inline. */
const CARD_THRESHOLD = 14;

/**
 * NOTE ON STYLING: every rule here is a Tailwind utility rather than a custom
 * class in globals.css. Custom classes broke badly once when a browser served
 * a cached stylesheet against new markup — unstyled SVGs with only a viewBox
 * expand to fill their container, which produced a full-screen icon. Utilities
 * are content-hashed with the page, and the SVGs also carry explicit
 * width/height attributes so they can never blow up even with no CSS at all.
 */
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
    () => open({ code, language, title }),
    [open, code, language, title]
  );

  // Long output becomes a compact card that opens beside the conversation.
  if (lineCount > CARD_THRESHOLD) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={openArtifact}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openArtifact();
          }
        }}
        className="group my-3 flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[#2c2924] bg-[#141210] px-3 py-2.5 text-left transition-colors duration-150 hover:border-[#403c34] hover:bg-[#201e1b]"
      >
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[#2a2723] text-[#d97f5d]">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12"
            />
          </svg>
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-[#ede9e2]">
            {title}
          </span>
          <span className="text-[11px] text-[#6d685d]">
            {language ?? "text"} · {lineCount} lines · click to open
          </span>
        </span>

        <button
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy code"}
          aria-label="Copy code"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[#6d685d] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
        >
          {copied ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7ba478" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
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
    <div className="group my-3 overflow-hidden rounded-xl border border-[#2c2924] bg-[#141210]">
      <div className="flex items-center justify-between gap-3 border-b border-[#2c2924] bg-[#201e1b] py-1.5 pl-3.5 pr-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-[#6d685d]">
          {language ?? "code"}
        </span>
        <button
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy code"}
          aria-label="Copy code"
          className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[#a29d92] opacity-0 transition-all duration-150 hover:bg-[#33302a] hover:text-[#ede9e2] focus-visible:opacity-100 group-hover:opacity-100"
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
      </div>
      <div className="overflow-auto [overscroll-behavior:contain]">
        <pre className="!m-0 !rounded-none !border-0 !bg-transparent">
          {children}
        </pre>
      </div>
    </div>
  );
}
