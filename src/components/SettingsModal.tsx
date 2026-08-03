"use client";

import { useState } from "react";

interface SettingsModalProps {
  deepseekKey: string;
  tavilyKey: string;
  model: string;
  defaultEffort: string;
  onDeepseekKeyChange: (key: string) => void;
  onTavilyKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  onDefaultEffortChange: (effort: string) => void;
  onClose: () => void;
}

export function SettingsModal({
  deepseekKey,
  tavilyKey,
  model,
  defaultEffort,
  onDeepseekKeyChange,
  onTavilyKeyChange,
  onModelChange,
  onDefaultEffortChange,
  onClose,
}: SettingsModalProps) {
  const [showDsKey, setShowDsKey] = useState(false);
  const [showTvKey, setShowTvKey] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-bg-secondary border border-border-light rounded-3xl shadow-2xl shadow-black/50 animate-fade-in overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Settings</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Configure your API keys and preferences
            </p>
          </div>
          <button
            onClick={onClose}
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
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* DeepSeek API Key */}
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-1.5">
              DeepSeek API Key
              <span className="text-danger ml-1">*</span>
            </label>
            <p className="text-xs text-text-secondary mb-2">
              Get your key from{" "}
              <a
                href="https://platform.deepseek.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light underline underline-offset-2"
              >
                platform.deepseek.com
              </a>
            </p>
            <div className="relative">
              <input
                type={showDsKey ? "text" : "password"}
                value={deepseekKey}
                onChange={(e) => onDeepseekKeyChange(e.target.value)}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowDsKey(!showDsKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
              >
                {showDsKey ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            {deepseekKey && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-success" />
                <span className="text-xs text-success">Key saved</span>
              </div>
            )}
          </div>

          {/* Tavily API Key */}
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-1.5">
              Tavily API Key
              <span className="text-text-muted ml-1 text-xs font-normal">
                (for Web Search)
              </span>
            </label>
            <p className="text-xs text-text-secondary mb-2">
              Get your key from{" "}
              <a
                href="https://app.tavily.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light underline underline-offset-2"
              >
                app.tavily.com
              </a>{" "}
              — 1,000 free credits/month
            </p>
            <div className="relative">
              <input
                type={showTvKey ? "text" : "password"}
                value={tavilyKey}
                onChange={(e) => onTavilyKeyChange(e.target.value)}
                placeholder="tvly-..."
                className="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-search/50 focus:ring-1 focus:ring-search/25 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowTvKey(!showTvKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
              >
                {showTvKey ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            {tavilyKey && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-success" />
                <span className="text-xs text-success">Key saved</span>
              </div>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Model Selection */}
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-2">
              Model
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onModelChange("deepseek-v4-pro")}
                className={`px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  model === "deepseek-v4-pro"
                    ? "bg-accent/15 text-accent-light border border-accent/30"
                    : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                }`}
              >
                <span className="block font-semibold">V4 Pro</span>
                <span className="text-[10px] opacity-70">
                  49B params • Frontier
                </span>
              </button>
              <button
                onClick={() => onModelChange("deepseek-v4-flash")}
                className={`px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  model === "deepseek-v4-flash"
                    ? "bg-accent/15 text-accent-light border border-accent/30"
                    : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                }`}
              >
                <span className="block font-semibold">V4 Flash</span>
                <span className="text-[10px] opacity-70">
                  13B params • Fast
                </span>
              </button>
            </div>
          </div>

          {/* Default Thinking Effort */}
          <div>
            <label className="block text-sm font-semibold text-text-primary mb-2">
              Default Thinking Effort
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {[
                { id: "auto", label: "Auto" },
                { id: "none", label: "None" },
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
                { id: "max", label: "Max" },
              ].map((e) => (
                <button
                  key={e.id}
                  onClick={() => onDefaultEffortChange(e.id)}
                  className={`px-2 py-2.5 rounded-xl text-xs font-medium transition-all duration-200 ${
                    defaultEffort === e.id
                      ? "bg-accent/15 text-accent-light border border-accent/30"
                      : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-end">
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
