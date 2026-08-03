"use client";

import { useState } from "react";
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

  // While the model is still reasoning there is nothing else to look at, so
  // open the panel automatically — then collapse it once the answer starts.
  const isThinkingPhase = Boolean(
    message.isStreaming && message.reasoningContent && !message.content
  );
  const thinkingOpen = showThinking || isThinkingPhase;

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

            {/* Thinking content (collapsible) */}
            {message.reasoningContent && (
              <div className="border border-thinking/20 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-thinking-glow text-thinking text-sm font-medium hover:bg-thinking/15 transition-colors"
                >
                  <svg
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${thinkingOpen ? "rotate-90" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  {isThinkingPhase ? "Thinking…" : "View thinking process"}
                </button>
                {thinkingOpen && (
                  <div className="thinking-scroll px-4 py-3 text-sm text-text-secondary leading-relaxed bg-bg-secondary/50 max-h-96 overflow-y-auto">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {message.reasoningContent}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            )}

            {/* Main content */}
            {(message.content || !message.isStreaming) && (
              <div
                className={`prose-chat text-[15px] leading-relaxed ${
                  message.isError ? "text-danger" : "text-text-primary"
                }`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {message.content}
                </ReactMarkdown>
                {message.isStreaming && message.content && (
                  <span className="stream-caret" aria-hidden="true" />
                )}
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
