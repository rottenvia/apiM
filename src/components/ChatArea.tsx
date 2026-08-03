"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Dots, MessageBubble } from "@/components/MessageBubble";
import { ThinkingEffortSelector } from "@/components/ThinkingEffortSelector";
import { ModelSelector } from "@/components/ModelSelector";
import type { Message, StatusStage } from "@/app/page";

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  statusStage: StatusStage | null;
  onStop: () => void;
  hasKeys: boolean;
  model: string;
  thinkingEffort: string;
  webSearchEnabled: boolean;
  enabledPlugins: string[];
  sidebarOpen: boolean;
  onSend: (message: string) => void;
  onRegenerate: (assistantId: string) => void;
  onOpenSearch: () => void;
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
  statusStage,
  onStop,
  hasKeys,
  model,
  thinkingEffort,
  webSearchEnabled,
  enabledPlugins,
  sidebarOpen,
  onSend,
  onRegenerate,
  onOpenSearch,
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

  // Auto-scroll, but only while the user is already near the bottom. During a
  // long stream this lets them scroll up to read earlier output without the
  // view yanking back down on every token.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom < 120);
  }, []);

  useEffect(() => {
    if (!pinnedToBottom) return;
    messagesEndRef.current?.scrollIntoView({
      // Smooth scrolling can't keep up with a fast token stream, so only the
      // final settle is animated.
      behavior: isLoading ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, pinnedToBottom, isLoading]);

  const scrollToBottom = useCallback(() => {
    setPinnedToBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

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
  // Show the standalone indicator until the assistant bubble actually has
  // something to display. Previously an empty streaming bubble was created
  // instantly, which suppressed the indicator and left a silent gap between
  // sending and the first token.
  const streamingHasOutput = messages.some(
    (m) => m.isStreaming && (m.content || m.reasoningContent)
  );

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
          <button
            onClick={onOpenSearch}
            className="icon-btn"
            title="Search chats (Ctrl+K)"
            aria-label="Search chats"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              <circle cx="11" cy="11" r="8" />
              <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
            </svg>
          </button>
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
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <EmptyState hasKeys={hasKeys} onOpenSettings={onOpenSettings} />
        ) : (
          <div
            className={`mx-auto w-full px-4 sm:px-6 py-6 transition-[max-width] duration-300 ${columnWidth}`}
          >
            <div className="space-y-6">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isLast={msg.id === messages[messages.length - 1]?.id}
                  onRegenerate={onRegenerate}
                />
              ))}

              {/* Only shown before the first token lands; afterwards the
                  streaming bubble itself is the feedback. */}
              {isLoading && !streamingHasOutput && (
                <LoadingIndicator stage={statusStage} />
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Jump-to-latest — appears only when scrolled away during a stream */}
      {!pinnedToBottom && messages.length > 0 && (
        <div className="pointer-events-none relative z-10">
          <button
            onClick={scrollToBottom}
            className="scroll-bottom-btn"
            aria-label="Scroll to latest"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 5v14M5 12l7 7 7-7"
              />
            </svg>
          </button>
        </div>
      )}

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

              {/* While generating, this becomes a Stop control — you can
                  interrupt a long answer and keep whatever arrived. */}
              {isLoading ? (
                <button
                  onClick={onStop}
                  className="send-btn stop-btn"
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!canSend}
                  data-enabled={canSend}
                  className="send-btn"
                  title="Send message"
                  aria-label="Send message"
                >
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
                </button>
              )}
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

const STAGE_LABELS: Record<StatusStage, string> = {
  searching: "Searching the web",
  thinking: "Thinking",
  writing: "Writing",
};

/**
 * Bouncing-dots indicator. Sizes come from inline styles rather than custom
 * CSS classes so it renders correctly even if a stale stylesheet is served.
 */
function LoadingIndicator({ stage }: { stage: StatusStage | null }) {
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="flex items-center gap-2.5 px-1 py-2">
        <span className="text-[#c96442]">
          <Dots size={5} />
        </span>
        <span className="animate-thinking text-xs text-[#a29d92]">
          {STAGE_LABELS[stage ?? "thinking"]}…
        </span>
      </div>
    </div>
  );
}
