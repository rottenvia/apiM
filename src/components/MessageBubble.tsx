"use client";

import { useMemo, useState } from "react";
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

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const isUser = message.role === "user";

  // Label-only signal that reasoning is still in progress. The panel itself
  // stays closed unless the user opens it, so nothing expands and collapses
  // underneath them mid-answer.
  const isThinkingPhase = Boolean(
    message.isStreaming && message.reasoningContent && !message.content
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
            {/* Status badges */}
            <div className="flex flex-wrap items-center gap-2">
              {message.thinkingEffort && message.thinkingEffort !== "none" && (
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-thinking-glow text-thinking text-xs font-medium border border-thinking/20">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z" />
                  </svg>
                  Think: {message.thinkingEffort}
                </span>
              )}
              {message.webSearchUsed && (
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-search-glow text-search text-xs font-medium border border-search/20">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="8" />
                    <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                  </svg>
                  Web search
                  {message.searchesPerformed ? ` · ${message.searchesPerformed}` : ""}
                </span>
              )}
              {message.tokenCount && (
                <span className="text-text-muted text-xs">
                  {message.tokenCount.toLocaleString()} tokens
                </span>
              )}
            </div>

            {/* Reasoning — collapsed by default, click to read. Rendered as
                plain text so a partial stream can never emit broken markup. */}
            {message.reasoningContent && (
              <div className="overflow-hidden rounded-xl border border-[#cfa25a]/20">
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  aria-expanded={showThinking}
                  className="flex w-full items-center gap-2 bg-[#cfa25a]/10 px-4 py-2.5 text-sm font-medium text-[#cfa25a] transition-colors hover:bg-[#cfa25a]/15"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                    className={`transition-transform duration-200 ${showThinking ? "rotate-90" : ""}`}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  {isThinkingPhase ? "Thinking…" : "View thinking process"}
                </button>
                {showThinking && (
                  <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words bg-[#141210]/50 px-4 py-3 text-sm leading-relaxed text-[#a29d92] [overscroll-behavior:contain]">
                    {message.reasoningContent}
                  </div>
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
                <span className="flex items-end gap-1" aria-hidden="true">
                  {[0, 150, 300].map((d) => (
                    <span
                      key={d}
                      className="animate-bounce rounded-full bg-[#c96442]"
                      style={{ width: 5, height: 5, animationDelay: `${d}ms` }}
                    />
                  ))}
                </span>
              </div>
            )}

            {/* Search sources (collapsible) */}
            {message.searchResults && message.searchResults.length > 0 && (
              <div className="border border-search/20 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowSources(!showSources)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-search-glow text-search text-sm font-medium hover:bg-search/15 transition-colors"
                >
                  <svg
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${showSources ? "rotate-90" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Sources · {message.searchResults.length}
                  {message.searchQueries && (
                    <span className="text-xs opacity-70 ml-1 truncate">
                      — {message.searchQueries.slice(0, 2).map((q) => `"${q}"`).join(", ")}
                    </span>
                  )}
                </button>
                {showSources && (
                  <div className="px-4 py-3 space-y-2 bg-bg-secondary/50">
                    {message.searchResults.map((result, i) => (
                      <a
                        key={i}
                        href={result.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover transition-colors group"
                      >
                        <div className="w-5 h-5 rounded-md bg-search/10 flex items-center justify-center text-search text-xs font-bold flex-shrink-0">
                          {i + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-text-primary truncate group-hover:text-search transition-colors">
                            {result.title}
                          </p>
                          <p className="text-xs text-text-muted truncate">
                            {result.domain}
                          </p>
                        </div>
                        <svg className="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
