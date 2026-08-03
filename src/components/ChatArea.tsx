"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageBubble } from "@/components/MessageBubble";
import { ThinkingEffortSelector } from "@/components/ThinkingEffortSelector";
import { ModelSelector } from "@/components/ModelSelector";
import type { Message } from "@/app/page";

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  hasKeys: boolean;
  model: string;
  thinkingEffort: string;
  webSearchEnabled: boolean;
  enabledPlugins: string[];
  sidebarOpen: boolean;
  onSend: (message: string) => void;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onToggleSearch: () => void;
  onSetThinkingEffort: (effort: string) => void;
  onSetModel: (model: string) => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
}

export function ChatArea({
  messages,
  isLoading,
  hasKeys,
  model,
  thinkingEffort,
  webSearchEnabled,
  enabledPlugins,
  sidebarOpen,
  onSend,
  onToggleSidebar,
  onNewChat,
  onToggleSearch,
  onSetThinkingEffort,
  onSetModel,
  onOpenSettings,
  onOpenPlugins,
}: ChatAreaProps) {
  const [input, setInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the UI in sync with the browser's real fullscreen state
  useEffect(() => {
    const handleChange = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    onSend(input);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSend = Boolean(input.trim()) && !isLoading && hasKeys;

  // One shared column width for the messages and the composer, and it widens
  // in fullscreen so controls are placed optimally for the user's resolution.
  const columnWidth = isFullscreen
    ? "max-w-4xl 2xl:max-w-5xl"
    : "max-w-3xl xl:max-w-4xl";

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Minimal top bar — no branding, just quiet controls */}
      <header className="flex flex-shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleSidebar}
            className="icon-btn"
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            aria-label="Toggle sidebar"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9.5 4v16" />
            </svg>
          </button>
          {!sidebarOpen && (
            <button
              onClick={onNewChat}
              className="icon-btn"
              title="New chat"
              aria-label="New chat"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 5v14M5 12h14"
                />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {enabledPlugins.length > 0 && (
            <button
              onClick={onOpenPlugins}
              className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-light hover:text-text-primary"
              title="Active plugins"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {enabledPlugins.length} plugin
              {enabledPlugins.length > 1 ? "s" : ""}
            </button>
          )}
          <button
            onClick={toggleFullscreen}
            className="icon-btn"
            title={isFullscreen ? "Exit full screen" : "Full screen"}
            aria-label="Toggle full screen"
          >
            {isFullscreen ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"
                />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState hasKeys={hasKeys} onOpenSettings={onOpenSettings} />
        ) : (
          <div
            className={`mx-auto w-full px-4 sm:px-6 py-6 transition-[max-width] duration-300 ${columnWidth}`}
          >
            <div className="space-y-6">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}

              {isLoading && <LoadingIndicator />}

              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Composer — the relative wrapper anchors the selector popovers so they
          open centered above the chat bar, never covering it */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-2 pb-4">
        <div
          className={`relative mx-auto w-full transition-[max-width] duration-300 ${columnWidth}`}
        >
          <div className="rounded-[22px] border border-border bg-bg-tertiary shadow-[0_6px_28px_rgba(0,0,0,0.28)] transition-colors focus-within:border-border-light">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                hasKeys
                  ? "Type your message…"
                  : "Add your API keys in Settings to start chatting"
              }
              disabled={!hasKeys}
              rows={1}
              className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[15px] leading-6 text-text-primary placeholder-text-muted outline-none disabled:opacity-50"
            />

            <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0.5">
              {/* Uniform chips in a single row — scrolls instead of wrapping
                  on narrow resolutions, so spacing never breaks */}
              <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                <ModelSelector value={model} onChange={onSetModel} />

                <ThinkingEffortSelector
                  value={thinkingEffort}
                  onChange={onSetThinkingEffort}
                />

                <button
                  onClick={onToggleSearch}
                  className="chip"
                  data-active={webSearchEnabled}
                  aria-pressed={webSearchEnabled}
                  title="Toggle web search"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18" />
                    <path d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z" />
                  </svg>
                  <span>Search</span>
                </button>

                <button
                  onClick={onOpenPlugins}
                  className="chip"
                  data-active={enabledPlugins.length > 0}
                  title="Open plugins"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"
                    />
                  </svg>
                  <span>
                    Plugins
                    {enabledPlugins.length > 0
                      ? ` · ${enabledPlugins.length}`
                      : ""}
                  </span>
                </button>
              </div>

              <button
                onClick={handleSubmit}
                disabled={!canSend}
                data-enabled={canSend}
                className="send-btn"
                title="Send message"
                aria-label="Send message"
              >
                {isLoading ? (
                  <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 19V5M5 12l7-7 7 7"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <p className="mt-2.5 text-center text-[11px] leading-4 text-text-muted">
            Responses are generated by AI — verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  hasKeys,
  onOpenSettings,
}: {
  hasKeys: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center animate-fade-in">
        <h1 className="font-serif text-[30px] sm:text-4xl font-medium leading-tight tracking-[-0.01em] text-text-primary">
          How can I help you today?
        </h1>

        {hasKeys ? (
          <p className="mt-3 text-sm leading-6 text-text-secondary">
            Type a message below to start a conversation.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              Connect your DeepSeek API key to start chatting. Your keys stay
              in your browser — nothing leaves this app except your requests.
            </p>
            <div className="mt-6 flex justify-center">
              <button onClick={onOpenSettings} className="btn-primary">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
                Add API keys
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="flex justify-start animate-fade-in">
      <div className="flex items-center gap-3 px-1 py-2">
        <div className="flex gap-1">
          <div
            className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "0ms" }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <div
            className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </div>
        <span className="text-xs text-text-secondary animate-thinking">
          Thinking…
        </span>
      </div>
    </div>
  );
}
