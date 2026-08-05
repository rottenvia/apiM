"use client";

import { useState } from "react";

import {
  clampDeleteDelay,
  MIN_DELETE_DELAY,
  MAX_DELETE_DELAY,
} from "@/components/DeleteChatDialog";
import { SearchBudget } from "@/components/SearchBudget";

/**
 * Settings, grouped.
 *
 * Everything used to live in one scrolling column, so the delete-confirmation
 * slider sat in the same undifferentiated stream as the DeepSeek key and
 * finding any one setting meant reading all of them. Groups also give new
 * settings an obvious home, which is the part that keeps this from needing
 * another rebuild later — adding one is a line in this array.
 */
type TabId = "keys" | "model" | "search" | "misc";

const GROUPS: {
  id: TabId;
  label: string;
  blurb: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "keys",
    label: "API keys",
    blurb: "Credentials for the services this app talks to",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a4 4 0 11-4 4m0 0L4 18v3h3l1-1v-2h2v-2h2l1.5-1.5" />
      </svg>
    ),
  },
  {
    id: "model",
    label: "Model",
    blurb: "Which model answers, and how hard it thinks",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l2.2 5 5.3.5-4 3.5 1.2 5.2L12 14.5 7.3 17.2l1.2-5.2-4-3.5L9.8 8z" />
      </svg>
    ),
  },
  {
    id: "search",
    label: "Web search",
    blurb: "How much to spend looking things up",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z" />
      </svg>
    ),
  },
  {
    id: "misc",
    label: "Safety",
    blurb: "Guards on the actions that touch your machine",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      </svg>
    ),
  },
];

interface SettingsModalProps {
  deepseekKey: string;
  tavilyKey: string;
  visionKey: string;
  visionModel: string;
  model: string;
  defaultEffort: string;
  onDeepseekKeyChange: (key: string) => void;
  onTavilyKeyChange: (key: string) => void;
  onVisionKeyChange: (key: string) => void;
  onVisionModelChange: (model: string) => void;
  onModelChange: (model: string) => void;
  onDefaultEffortChange: (effort: string) => void;
  deleteDelay: number;
  onDeleteDelayChange: (seconds: number) => void;
  autoRunCommands: boolean;
  onAutoRunCommandsChange: (enabled: boolean) => void;
  searchProfile: string;
  onSearchProfileChange: (profile: string) => void;
  onClose: () => void;
}

export function SettingsModal({
  deepseekKey,
  tavilyKey,
  visionKey,
  visionModel,
  model,
  defaultEffort,
  onDeepseekKeyChange,
  onTavilyKeyChange,
  onVisionKeyChange,
  onVisionModelChange,
  onModelChange,
  onDefaultEffortChange,
  deleteDelay,
  onDeleteDelayChange,
  autoRunCommands,
  onAutoRunCommandsChange,
  searchProfile,
  onSearchProfileChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>("keys");
  const active = GROUPS.find((g) => g.id === tab) ?? GROUPS[0];

  const [showDsKey, setShowDsKey] = useState(false);
  const [showTvKey, setShowTvKey] = useState(false);
  const [showVsKey, setShowVsKey] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl shadow-black/50 animate-fade-in">
        {/* Header */}
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-5 text-text-primary">
              Settings
            </h2>
            <p className="mt-0.5 truncate text-[11.5px] leading-4 text-text-muted">
              {active.blurb}
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

        {/* Two columns: a rail of groups on the left, one group's contents
            on the right. A single scrolling list meant the delete-confirmation
            slider and the DeepSeek key lived in the same undifferentiated
            stream, so finding anything meant reading everything. */}
        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-[168px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-border p-2.5"
            aria-label="Settings sections"
          >
            {GROUPS.map((group) => {
              const selected = group.id === tab;
              return (
                <button
                  key={group.id}
                  onClick={() => setTab(group.id)}
                  data-active={selected}
                  aria-current={selected ? "page" : undefined}
                  className="settings-tab"
                >
                  <span className="flex-none">{group.icon}</span>
                  <span className="truncate">{group.label}</span>
                </button>
              );
            })}
          </nav>

          <div
            key={tab}
            className="min-w-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 animate-fade-in"
          >
            {tab === "keys" && (
              <>
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

              {/* Vision — DeepSeek's API is text-only, so screenshots are
                  described by a separate model before being sent on. */}
              <div>
                <label className="block text-sm font-semibold text-text-primary mb-1.5">
                  Vision API Key
                  <span className="ml-1 text-xs font-normal text-text-muted">
                    (for screenshots)
                  </span>
                </label>
                <p className="text-xs text-text-secondary mb-2">
                  DeepSeek can&apos;t read images, so attached screenshots are
                  described by an OpenAI vision model first. Get a key from{" "}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-light underline underline-offset-2"
                  >
                    platform.openai.com
                  </a>
                </p>
                <div className="relative">
                  <input
                    type={showVsKey ? "text" : "password"}
                    value={visionKey}
                    onChange={(e) => onVisionKeyChange(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowVsKey(!showVsKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                    aria-label={showVsKey ? "Hide key" : "Show key"}
                  >
                    {showVsKey ? (
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

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {["gpt-4o-mini", "gpt-4o"].map((m) => (
                    <button
                      key={m}
                      onClick={() => onVisionModelChange(m)}
                      data-active={visionModel === m}
                      className="rounded-lg border border-border px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:bg-bg-hover data-[active=true]:border-accent/50 data-[active=true]:bg-accent/10 data-[active=true]:text-accent-light"
                    >
                      {m}
                    </button>
                  ))}
                  <span className="self-center text-[10px] text-text-muted">
                    mini is ~10x cheaper and enough for most screenshots
                  </span>
                </div>

                {visionKey && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-success" />
                    <span className="text-xs text-success">Key saved</span>
                  </div>
                )}
              </div>

              <div className="h-px bg-border" />

              </>
            )}

            {tab === "model" && (
              <>
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

              </>
            )}

            {tab === "search" && (
              <>
              {/* Search cost */}
              <SearchBudget
                searchProfile={searchProfile}
                onSearchProfileChange={onSearchProfileChange}
              />

              </>
            )}

            {tab === "misc" && (
              <>
              {/* Command approval */}
              <div>
                <label className="block text-sm font-semibold text-text-primary mb-2">
                  Running commands
                </label>
                <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
                  When the assistant writes code, it can run it to check whether it
                  works — and fix its own mistakes from the error.
                </p>

                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => onAutoRunCommandsChange(false)}
                    className="option-item"
                    data-active={!autoRunCommands}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-[13px] font-medium leading-5 ${
                            !autoRunCommands ? "text-accent-light" : "text-text-primary"
                          }`}
                        >
                          Ask me first
                        </span>
                        {!autoRunCommands && (
                          <span className="text-[11px] text-accent-light">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                        You see each command and click Run or Skip before anything
                        happens.
                      </p>
                    </div>
                  </button>

                  <button
                    onClick={() => onAutoRunCommandsChange(true)}
                    className="option-item"
                    data-active={autoRunCommands}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-[13px] font-medium leading-5 ${
                            autoRunCommands ? "text-accent-light" : "text-text-primary"
                          }`}
                        >
                          Run automatically
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                        Faster, and closer to how Arena feels. Nothing pauses to
                        ask.
                      </p>
                    </div>
                  </button>
                </div>

                {/* Shown only when it's on: a warning nobody has agreed to yet is
                    just noise, but one describing your current state is not. */}
                {autoRunCommands && (
                  <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-[#cfa25a]/30 bg-[#cfa25a]/[0.07] px-3 py-2.5">
                    <span className="mt-0.5 flex-none text-[#cfa25a]">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                        />
                      </svg>
                    </span>
                    <p className="text-[11.5px] leading-4 text-text-secondary">
                      Code the assistant writes will run on this computer without
                      asking. It can only start real interpreters, never a shell,
                      and each command is stopped after 30 seconds — but a program
                      it runs has the same access to your files that you do. Keep a
                      restore point.
                    </p>
                  </div>
                )}
              </div>

              {/* Delete confirmation delay */}
              <div>
                <label
                  htmlFor="delete-delay"
                  className="block text-sm font-semibold text-text-primary mb-2"
                >
                  Delete confirmation lock
                </label>
                <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
                  How long the Delete button stays locked when deleting a chat.
                  Deleting is permanent, so the pause is there to catch a misclick.
                </p>
                <div className="flex items-center gap-3">
                  <input
                    id="delete-delay"
                    type="range"
                    min={MIN_DELETE_DELAY}
                    max={MAX_DELETE_DELAY}
                    step={1}
                    value={deleteDelay}
                    onChange={(e) =>
                      onDeleteDelayChange(clampDeleteDelay(e.target.value))
                    }
                    className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-bg-tertiary accent-accent"
                  />
                  <input
                    type="number"
                    min={MIN_DELETE_DELAY}
                    max={MAX_DELETE_DELAY}
                    value={deleteDelay}
                    aria-label="Delete confirmation lock in seconds"
                    // Clamped on blur rather than on change, so typing "10" isn't
                    // rewritten to the minimum the moment "1" is entered.
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) onDeleteDelayChange(n);
                    }}
                    onBlur={(e) =>
                      onDeleteDelayChange(clampDeleteDelay(e.target.value))
                    }
                    className="w-16 flex-none rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-center text-sm text-text-primary outline-none focus:border-border-light"
                  />
                  <span className="flex-none text-[12px] text-text-secondary">
                    sec
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-text-muted">
                  Between {MIN_DELETE_DELAY} and {MAX_DELETE_DELAY} seconds.
                </p>
              </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-none items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <p className="min-w-0 truncate text-[11px] text-text-muted">
            Saved automatically as you change them.
          </p>
          <button onClick={onClose} className="btn-primary flex-none">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
