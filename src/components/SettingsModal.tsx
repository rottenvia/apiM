"use client";

import { useState } from "react";

import {
  clampDeleteDelay,
  MIN_DELETE_DELAY,
  MAX_DELETE_DELAY,
} from "@/components/DeleteChatDialog";
import { SearchBudget } from "@/components/SearchBudget";
import { BUDGET_PRESETS } from "@/lib/budget";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";

/**
 * Settings, grouped.
 *
 * Everything used to live in one scrolling column, so the delete-confirmation
 * slider sat in the same undifferentiated stream as the DeepSeek key and
 * finding any one setting meant reading all of them. Groups also give new
 * settings an obvious home, which is the part that keeps this from needing
 * another rebuild later — adding one is a line in this array.
 */
type TabId = "keys" | "model" | "search" | "reports" | "misc";

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
    id: "reports",
    label: "Reports",
    blurb: "What has been failing, so it can be fixed",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 3h6l4 4v14H5V3h4zM9 3v5h6" />
        <path strokeLinecap="round" d="M8.5 13h7M8.5 16.5h4.5" />
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
  exaKey: string;
  onExaKeyChange: (v: string) => void;
  tavilyEnabled: boolean;
  onTavilyEnabledChange: (v: boolean) => void;
  exaEnabled: boolean;
  onExaEnabledChange: (v: boolean) => void;
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
  lessonsEnabled: boolean;
  onLessonsEnabledChange: (v: boolean) => void;
  onAutoRunCommandsChange: (enabled: boolean) => void;
  searchProfile: string;
  onSearchProfileChange: (profile: string) => void;
  /** Spend ceiling per reply in USD, or null for no cap. */
  budgetUsd: number | null;
  onBudgetUsdChange: (usd: number | null) => void;
  onClose: () => void;
}

/**
 * On/off for one search provider.
 *
 * Separate from having a key: a spent quota should not force you to delete a
 * key you will want back next month. Reported directly — "maybe that tavily
 * is ruining that all" — and switching it off is a one-click way to find out.
 */
function ProviderToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-state={on ? "on" : "off"}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 flex-none overflow-hidden rounded-full border p-0 transition-colors duration-150 ${
        on
          ? "border-transparent bg-success/70"
          : "border-border bg-bg-tertiary"
      }`}
    >
      {/*
       * A switch moves its knob; its track never changes size.
       *
       * The first version had `position: absolute` and a transform, but no
       * horizontal anchor. CSS therefore used the span's static inline
       * position as its starting point. On some browser/font combinations the
       * apparent motion began at the right edge and looked like the control
       * was growing outwards instead of travelling left <-> right. The border
       * also existed only while off, so the two states did not share identical
       * geometry.
       *
       * A fixed left inset, a fixed border in both states, and clipping make
       * the invariant explicit: 36px track, 16px knob, 16px of travel.
       */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          on ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function SettingsModal({
  deepseekKey,
  tavilyKey,
  exaKey,
  onExaKeyChange,
  tavilyEnabled,
  onTavilyEnabledChange,
  exaEnabled,
  onExaEnabledChange,
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
  lessonsEnabled,
  onLessonsEnabledChange,
  onAutoRunCommandsChange,
  searchProfile,
  onSearchProfileChange,
  budgetUsd,
  onBudgetUsdChange,
  onClose,
}: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>("keys");
  const active = GROUPS.find((g) => g.id === tab) ?? GROUPS[0];

  const [showDsKey, setShowDsKey] = useState(false);
  const [showTvKey, setShowTvKey] = useState(false);
  const [showExaKey, setShowExaKey] = useState(false);
  const [showVsKey, setShowVsKey] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative flex h-[min(86vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl shadow-black/50 animate-fade-in">
        {/* Header */}
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-5 text-text-primary">
              Settings
            </h2>
            <p className="mt-0.5 truncate text-[12px] leading-4 text-text-muted">
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

          {/* Keyed so each tab starts at the top rather than inheriting the
              last one's scroll position. No entry animation: sliding the
              content 8px on every switch made a stable frame feel unstable. */}
          <div
            key={tab}
            className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto px-5 py-5"
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
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <label className="block text-sm font-semibold text-text-primary">
                    Tavily API Key
                    <span className="text-text-muted ml-1 text-xs font-normal">
                      {tavilyEnabled ? "(for Web Search)" : "(switched off)"}
                    </span>
                  </label>
                  <ProviderToggle
                    on={tavilyEnabled}
                    onChange={onTavilyEnabledChange}
                    label="Use Tavily for web search"
                  />
                </div>
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

              {/* Exa — the fallback when Tavily refuses.

                  Added after Tavily started answering 432, "this request
                  exceeds your plan's set usage limit". That is a hard stop
                  until the month rolls over, and with one provider it made
                  search a dead feature. Optional: leave it empty and nothing
                  changes. */}
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <label className="block text-sm font-semibold text-text-primary">
                    Exa API Key
                    <span className="text-text-muted ml-1 text-xs font-normal">
                      {exaEnabled
                        ? "(optional — searched alongside Tavily)"
                        : "(switched off)"}
                    </span>
                  </label>
                  <ProviderToggle
                    on={exaEnabled}
                    onChange={onExaEnabledChange}
                    label="Use Exa for web search"
                  />
                </div>
                <p className="text-xs text-text-secondary mb-2">
                  Get your key from{" "}
                  <a
                    href="https://dashboard.exa.ai/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-light underline underline-offset-2"
                  >
                    dashboard.exa.ai
                  </a>{" "}
                  — $10 free credit. Searched at the same time as Tavily and
                  the results merged, so a quota error on one side no longer
                  stops the search. Set either key, or both.
                </p>
                <div className="relative">
                  <input
                    type={showExaKey ? "text" : "password"}
                    value={exaKey}
                    onChange={(e) => onExaKeyChange(e.target.value)}
                    placeholder="Leave empty to skip"
                    className="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-search/50 focus:ring-1 focus:ring-search/25 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowExaKey(!showExaKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
                  >
                    {showExaKey ? (
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
                {exaKey && (
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
                  <span className="self-center text-[11px] text-text-muted">
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
                    className={`px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150 ${
                      model === "deepseek-v4-pro"
                        ? "bg-accent/15 text-accent-light border border-accent/30"
                        : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                    }`}
                  >
                    <span className="block font-semibold">V4 Pro</span>
                    <span className="text-[11px] opacity-70">
                      49B params • Frontier
                    </span>
                  </button>
                  <button
                    onClick={() => onModelChange("deepseek-v4-flash")}
                    className={`px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150 ${
                      model === "deepseek-v4-flash"
                        ? "bg-accent/15 text-accent-light border border-accent/30"
                        : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                    }`}
                  >
                    <span className="block font-semibold">V4 Flash</span>
                    <span className="text-[11px] opacity-70">
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
                      className={`px-2 py-2.5 rounded-xl text-xs font-medium transition-all duration-150 ${
                        defaultEffort === e.id
                          ? "bg-accent/15 text-accent-light border border-accent/30"
                          : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                      }`}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                  On V4 Pro, &ldquo;Low&rdquo; is mapped to &ldquo;High&rdquo; by
                  DeepSeek itself — only Max is genuinely different. Use V4 Flash
                  if you want a cheaper, shallower answer.
                </p>
              </div>

              {/* Spending limit */}
              <div>
                <label className="block text-sm font-semibold text-text-primary mb-2">
                  Spending limit per reply
                </label>
                <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
                  Stops a reply once it has cost this much. The work done so far
                  is kept and you can Resume it — nothing is thrown away. This is
                  the guard against a task the model never finishes.
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  <button
                    onClick={() => onBudgetUsdChange(null)}
                    className={`px-2 py-2.5 rounded-xl text-xs font-medium transition-all duration-150 ${
                      budgetUsd === null
                        ? "bg-accent/15 text-accent-light border border-accent/30"
                        : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                    }`}
                  >
                    Off
                  </button>
                  {BUDGET_PRESETS.map((amount) => (
                    <button
                      key={amount}
                      onClick={() => onBudgetUsdChange(amount)}
                      className={`px-2 py-2.5 rounded-xl text-xs font-medium transition-all duration-150 ${
                        budgetUsd === amount
                          ? "bg-accent/15 text-accent-light border border-accent/30"
                          : "bg-bg-tertiary text-text-secondary border border-border hover:border-border-light"
                      }`}
                    >
                      ${amount < 1 ? amount.toFixed(2) : amount.toFixed(0)}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                  For scale: an ordinary reply is a fraction of a cent. A
                  forty-round agent task on Max thinking is around $0.50.
                </p>
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

            {tab === "reports" && <DiagnosticsPanel />}

            {tab === "misc" && (
              <>
              {/* Learning from what happened */}
              <div>
                <label className="block text-sm font-semibold text-text-primary mb-2">
                  Learn from this project
                </label>
                <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
                  After a task, the assistant writes down what it proved — a
                  command that failed, a path that did not exist — into a{" "}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-[11px]">
                    LESSONS.md
                  </code>{" "}
                  in the workspace, and reads it back next time so it does not
                  repeat the same wrong turn. Only facts with evidence behind
                  them are kept, and one is corrected automatically when a
                  later run disproves it.
                </p>

                <button
                  onClick={() => onLessonsEnabledChange(!lessonsEnabled)}
                  role="switch"
                  aria-checked={lessonsEnabled}
                  className="flex w-full items-center justify-between rounded-xl border border-border bg-bg-tertiary px-3 py-2.5 text-left transition-colors hover:border-border-light"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-text-primary">
                      {lessonsEnabled ? "On" : "Off"}
                    </span>
                    <span className="block text-[11px] text-text-secondary">
                      {lessonsEnabled
                        ? "Adds a few hundred tokens per task; the file is yours to edit"
                        : "Nothing is recorded between tasks"}
                    </span>
                  </span>
                  <span
                    data-on={lessonsEnabled}
                    className="relative h-5 w-9 flex-none rounded-full bg-border transition-colors data-[on=true]:bg-accent"
                  >
                    <span
                      data-on={lessonsEnabled}
                      className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform data-[on=true]:translate-x-4"
                    />
                  </span>
                </button>
              </div>

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
                    <p className="text-[12px] leading-4 text-text-secondary">
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
