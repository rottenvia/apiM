"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "@/app/page";
import { CodeBlock } from "@/components/CodeBlock";

/**
 * Render fenced code blocks with a language label and copy button.
 * Defined once at module scope so the object identity is stable across
 * renders and react-markdown doesn't rebuild its renderer each time.
 */
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * Bouncing dots. Sized inline so they render correctly regardless of CSS
 * loading order, and small enough not to dominate the row.
 */
export function Dots({ size = 5 }: { size?: number }) {
  return (
    <span className="inline-flex flex-none items-end gap-[3px]" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="animate-bounce rounded-full bg-current"
          style={{ width: size, height: size, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

interface MessageBubbleProps {
  message: Message;
  /** Only the newest reply offers regenerate, to avoid rewriting history. */
  isLast?: boolean;
  onRegenerate?: (assistantId: string) => void;
}

export function MessageBubble({
  message,
  isLast,
  onRegenerate,
}: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [followThinking, setFollowThinking] = useState(true);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const isUser = message.role === "user";

  // Label-only signal that reasoning is still in progress. The panel itself
  // stays closed unless the user opens it, so nothing expands and collapses
  // underneath them mid-answer.
  const isThinkingPhase = Boolean(
    message.isStreaming && message.reasoningContent && !message.content
  );

  // Keep the reasoning panel pinned to the newest text while "Follow" is on.
  useEffect(() => {
    if (!followThinking || !showThinking) return;
    const el = thinkingRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [message.reasoningContent, followThinking, showThinking]);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch {
      /* clipboard unavailable on non-secure origins */
    }
  };

  const sourceCount = message.searchResults?.length ?? 0;
  const hasMeta = Boolean(
    (message.thinkingEffort && message.thinkingEffort !== "none") ||
      message.tokenCount
  );

  // Detect a code fence that has been opened but not yet closed. An odd number
  // of ``` markers means the model is mid-block, so we hide the partial code
  // and show a progress card instead of streaming raw source into the chat.
  const { displayContent, hasPendingCode, pendingLanguage, pendingLines } =
    useMemo(() => {
      const content = message.content ?? "";
      if (!message.isStreaming) {
        return {
          displayContent: content,
          hasPendingCode: false,
          pendingLanguage: null as string | null,
          pendingLines: 0,
        };
      }

      const fenceMatches = content.match(/^```/gm);
      const openFence = (fenceMatches?.length ?? 0) % 2 === 1;
      if (!openFence) {
        return {
          displayContent: content,
          hasPendingCode: false,
          pendingLanguage: null as string | null,
          pendingLines: 0,
        };
      }

      const lastFence = content.lastIndexOf("\n```");
      const cut = lastFence === -1 ? content.indexOf("```") : lastFence + 1;
      const before = content.slice(0, cut);
      const block = content.slice(cut);
      const langMatch = /^```([\w+-]*)/.exec(block);

      return {
        displayContent: before.trimEnd(),
        hasPendingCode: true,
        pendingLanguage: langMatch?.[1] ? langMatch[1] : null,
        pendingLines: Math.max(0, block.split("\n").length - 1),
      };
    }, [message.content, message.isStreaming]);

  return (
    <div
      className={`animate-fade-in ${isUser ? "flex justify-end" : "flex justify-start"}`}
    >
      <div
        className={`max-w-[85%] md:max-w-[75%] ${
          isUser
            ? "rounded-[20px] bg-bg-elevated px-4 py-2.5"
            : "bg-transparent"
        }`}
      >
        {/* User message */}
        {isUser && (
          <div className="text-[15px] leading-6 text-text-primary">
            {message.content}
          </div>
        )}

        {/* Assistant message */}
        {!isUser && (
          <div className="space-y-3">
            {/* Compact meta row — small pills, not full-width slabs */}
            {(hasMeta || sourceCount > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {message.thinkingEffort &&
                  message.thinkingEffort !== "none" && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-[#cfa25a]/25 bg-[#cfa25a]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#cfa25a]">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z" />
                      </svg>
                      {message.thinkingEffort}
                    </span>
                  )}

                {sourceCount > 0 && (
                  <button
                    onClick={() => setShowSources((v) => !v)}
                    aria-expanded={showSources}
                    className="inline-flex items-center gap-1 rounded-md border border-[#6ba3a0]/25 bg-[#6ba3a0]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#6ba3a0] transition-colors hover:bg-[#6ba3a0]/20"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <circle cx="11" cy="11" r="8" />
                      <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                    </svg>
                    {sourceCount} {sourceCount === 1 ? "source" : "sources"}
                    <svg
                      width="8" height="8" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={3} aria-hidden="true"
                      className={`transition-transform duration-200 ${showSources ? "rotate-180" : ""}`}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                )}

                {message.tokenCount ? (
                  <span className="text-[10px] text-[#6d685d]">
                    {message.tokenCount.toLocaleString()} tokens
                  </span>
                ) : null}
              </div>
            )}

            {/* Sources list — opened from the pill above */}
            {showSources && sourceCount > 0 && (
              <div className="animate-fade-in space-y-0.5 rounded-xl border border-[#6ba3a0]/20 bg-[#141210]/60 p-1.5">
                {message.searchResults!.map((result, i) => (
                  <a
                    key={i}
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[#33302a]"
                  >
                    <span className="flex h-4 w-4 flex-none items-center justify-center rounded bg-[#6ba3a0]/15 text-[9px] font-bold text-[#6ba3a0]">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[#ede9e2] transition-colors group-hover:text-[#6ba3a0]">
                        {result.title}
                      </span>
                      <span className="block truncate text-[10px] text-[#6d685d]">
                        {result.domain}
                      </span>
                    </span>
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2} aria-hidden="true"
                      className="flex-none text-[#6d685d] opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                ))}
              </div>
            )}

            {/* Reasoning. The header shows live dots while the model is
                still thinking, and a follow/free-scroll toggle controls
                whether the panel tracks the incoming text. */}
            {message.reasoningContent && (
              <div className="overflow-hidden rounded-xl border border-[#cfa25a]/20">
                <div className="flex items-center gap-2 bg-[#cfa25a]/10 pr-1.5">
                  <button
                    onClick={() => setShowThinking((v) => !v)}
                    aria-expanded={showThinking}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2 text-left text-[13px] font-medium text-[#cfa25a] transition-colors hover:bg-[#cfa25a]/10"
                  >
                    <svg
                      width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2.2} aria-hidden="true"
                      className={`flex-none transition-transform duration-200 ${showThinking ? "rotate-90" : ""}`}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="truncate">
                      {isThinkingPhase ? "Thinking" : "View thinking process"}
                    </span>
                    {isThinkingPhase && <Dots size={4} />}
                  </button>

                  {showThinking && message.isStreaming && (
                    <button
                      onClick={() => setFollowThinking((v) => !v)}
                      title={
                        followThinking
                          ? "Following the text — click to scroll freely"
                          : "Scrolling freely — click to follow the text"
                      }
                      aria-pressed={followThinking}
                      className={`flex h-6 flex-none items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-colors ${
                        followThinking
                          ? "bg-[#cfa25a]/20 text-[#cfa25a]"
                          : "text-[#6d685d] hover:bg-[#33302a] hover:text-[#a29d92]"
                      }`}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                      </svg>
                      {followThinking ? "Follow" : "Free"}
                    </button>
                  )}
                </div>

                {showThinking && (
                  <div
                    ref={thinkingRef}
                    className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words bg-[#141210]/50 px-3.5 py-2.5 text-[13px] leading-relaxed text-[#a29d92] [overscroll-behavior:contain]"
                  >
                    {message.reasoningContent}
                  </div>
                )}
              </div>
            )}

            {/* Reply was cut short — offer to retry rather than leaving a
                silently truncated answer looking complete. */}
            {message.incomplete && !message.isStreaming && (
              <div className="flex items-center gap-2.5 rounded-xl border border-[#cfa25a]/25 bg-[#cfa25a]/8 px-3 py-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true" className="flex-none text-[#cfa25a]">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-[#cfa25a]">
                  This reply was interrupted and may be incomplete.
                </span>
                {onRegenerate && (
                  <button
                    onClick={() => onRegenerate(message.id)}
                    className="flex-none rounded-md border border-[#cfa25a]/30 px-2 py-1 text-[11px] font-medium text-[#cfa25a] transition-colors hover:bg-[#cfa25a]/15"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}

            {/* Main content. While streaming, an unterminated ``` fence is
                replaced by a placeholder card — watching code type itself line
                by line is noisy, and half-written markup renders as garbage. */}
            {(displayContent || !message.isStreaming) && (
              <div
                className={`prose-chat text-[15px] leading-relaxed ${
                  message.isError ? "text-danger" : "text-text-primary"
                }`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {displayContent}
                </ReactMarkdown>
                {message.isStreaming && displayContent && !hasPendingCode && (
                  <span className="stream-caret" aria-hidden="true" />
                )}
              </div>
            )}

            {/* Placeholder while a code block is still being generated */}
            {hasPendingCode && (
              <div className="my-3 flex w-full items-center gap-3 rounded-xl border border-[#2c2924] bg-[#141210] px-3 py-2.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[#2a2723] text-[#d97f5d]">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    aria-hidden="true"
                    className="animate-pulse"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-[#ede9e2]">
                    {pendingLanguage
                      ? `Writing ${pendingLanguage}…`
                      : "Writing code…"}
                  </span>
                  <span className="text-[11px] text-[#6d685d]">
                    {pendingLines} {pendingLines === 1 ? "line" : "lines"} so far
                  </span>
                </span>
                <span className="flex-none text-[#c96442]">
                  <Dots size={4} />
                </span>
              </div>
            )}

            {/* Actions on the newest completed reply */}
            {isLast &&
              !message.isStreaming &&
              !message.isError &&
              message.content && (
                <div className="flex items-center gap-1 pt-0.5">
                  <button
                    onClick={copyMessage}
                    title="Copy reply"
                    className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-[#6d685d] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
                  >
                    {copiedMessage ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7ba478" strokeWidth={2.2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                        </svg>
                        <span className="text-[#7ba478]">Copied</span>
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>

                  {onRegenerate && (
                    <button
                      onClick={() => onRegenerate(message.id)}
                      title="Generate a different reply"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-[#6d685d] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2" />
                      </svg>
                      Regenerate
                    </button>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
