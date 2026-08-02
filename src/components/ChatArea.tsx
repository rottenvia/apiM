"use client";

import { useState, useRef, useEffect } from "react";
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
  onToggleSearch,
  onSetThinkingEffort,
  onSetModel,
  onOpenSettings,
  onOpenPlugins,
}: ChatAreaProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/50 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          {!sidebarOpen && (
            <button
              onClick={onToggleSidebar}
              className="p-2 rounded-xl hover:bg-bg-hover transition-colors text-text-secondary"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
          )}
          {sidebarOpen && (
            <button
              onClick={onToggleSidebar}
              className="p-2 rounded-xl hover:bg-bg-hover transition-colors text-text-secondary"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
            </button>
          )}

          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-sm font-medium text-text-primary">
              nohomo
            </span>
            <span className="text-xs text-text-muted">API MANAGER</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {enabledPlugins.length > 0 && (
            <span className="px-2.5 py-1 rounded-lg bg-accent/10 text-accent-light text-xs font-medium border border-accent/20">
              {enabledPlugins.length} plugin{enabledPlugins.length > 1 ? "s" : ""} active
            </span>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState hasKeys={hasKeys} onOpenSettings={onOpenSettings} />
        ) : (
          <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {isLoading && <LoadingIndicator />}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="border-t border-border bg-bg-secondary/30 backdrop-blur-sm px-4 py-4 flex-shrink-0">
        <div className="max-w-4xl mx-auto">
          {/* Control buttons */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {/* Model Selector */}
            <ModelSelector value={model} onChange={onSetModel} />

            {/* Web Search Toggle */}
            <button
              onClick={onToggleSearch}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${
                webSearchEnabled
                  ? "bg-search/15 text-search border border-search/30 shadow-sm shadow-search/10"
                  : "btn-glass text-text-secondary hover:text-text-primary"
              }`}
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <circle cx="11" cy="11" r="8" />
                <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
              </svg>
              Web Search
            </button>

            {/* Thinking Effort */}
            <ThinkingEffortSelector
              value={thinkingEffort}
              onChange={onSetThinkingEffort}
            />

            {/* Plugins */}
            <button
              onClick={onOpenPlugins}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${
                enabledPlugins.length > 0
                  ? "bg-accent/15 text-accent-light border border-accent/30 shadow-sm shadow-accent/10"
                  : "btn-glass text-text-secondary hover:text-text-primary"
              }`}
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"
                />
              </svg>
              Plugins
              {enabledPlugins.length > 0 && (
                <span className="w-4 h-4 rounded-full bg-accent/30 text-[10px] flex items-center justify-center">
                  {enabledPlugins.length}
                </span>
              )}
            </button>
          </div>

          {/* Text input */}
          <div className="relative">
            <div className="flex items-end gap-2 bg-bg-tertiary rounded-2xl border border-border hover:border-border-light focus-within:border-accent/40 focus-within:shadow-lg focus-within:shadow-accent/5 transition-all duration-200 px-4 py-3">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  hasKeys
                    ? "Type your message... (Shift+Enter for new line)"
                    : "Add your API keys in Settings to start chatting"
                }
                disabled={!hasKeys}
                rows={1}
                className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-secondary resize-none outline-none max-h-[200px] leading-relaxed disabled:opacity-50"
              />
              <button
                onClick={handleSubmit}
                disabled={!input.trim() || isLoading || !hasKeys}
                className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 ${
                  input.trim() && !isLoading && hasKeys
                    ? "bg-accent text-white shadow-lg shadow-accent/25 hover:bg-accent-light hover:shadow-accent/35 active:scale-95"
                    : "bg-bg-elevated text-text-muted cursor-not-allowed"
                }`}
              >
                {isLoading ? (
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
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
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Footer info */}
          <div className="flex items-center justify-center gap-4 mt-2.5 text-[10px] text-text-muted">
            <span>DeepSeek V4</span>
            <span>•</span>
            <span>Tavily Search</span>
            <span>•</span>
            <span>nohomo API MANAGER</span>
          </div>
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
    <div className="h-full flex items-center justify-center px-4">
      <div className="max-w-lg text-center animate-fade-in">
        {/* Logo */}
        <div className="mx-auto w-20 h-20 rounded-3xl bg-gradient-to-br from-accent via-purple-500 to-blue-500 flex items-center justify-center text-white text-2xl font-black mb-6 shadow-xl shadow-accent/20 animate-pulse-glow">
          nh
        </div>

        <h2 className="text-2xl font-bold mb-2 bg-gradient-to-r from-text-primary to-text-secondary bg-clip-text text-transparent">
          Welcome to nohomo
        </h2>
        <p className="text-text-secondary text-sm mb-8 leading-relaxed">
          The smartest API manager with intelligent web search, thinking effort control, and
          a powerful plugin system.
        </p>

        {!hasKeys ? (
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2.5 px-6 py-3 rounded-2xl bg-accent text-white font-medium text-sm shadow-lg shadow-accent/25 hover:bg-accent-light hover:shadow-accent/35 transition-all duration-200 active:scale-95"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
              />
            </svg>
            Add API Keys to Get Started
          </button>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FeatureCard
              icon="🔍"
              title="Smart Search"
              description="Multi-step query planning, result validation, and intelligent re-searching"
            />
            <FeatureCard
              icon="💡"
              title="Thinking Modes"
              description="Auto-adjusting reasoning effort from quick answers to deep analysis"
            />
            <FeatureCard
              icon="🧩"
              title="Plugin System"
              description="Caveman, God Mode, Code Only, and more to customize AI behavior"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-4 rounded-2xl bg-bg-secondary border border-border hover:border-border-light transition-colors">
      <div className="text-2xl mb-2">{icon}</div>
      <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
      <p className="text-xs text-text-secondary leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="flex justify-start animate-fade-in">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex gap-1">
          <div
            className="w-2 h-2 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "0ms" }}
          />
          <div
            className="w-2 h-2 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "150ms" }}
          />
          <div
            className="w-2 h-2 rounded-full bg-accent animate-bounce"
            style={{ animationDelay: "300ms" }}
          />
        </div>
        <span className="text-xs text-text-secondary animate-thinking">
          Thinking...
        </span>
      </div>
    </div>
  );
}
