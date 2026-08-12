"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AVAILABLE_PLUGINS,
  LEGACY_PLUGINS,
  buildPluginDirectives,
  MAX_PLUGIN_PROMPT,
  MAX_PLUGIN_TOTAL,
} from "@/lib/plugins";
import type { Plugin } from "@/lib/plugins";

interface CustomPlugin extends Plugin {
  custom: true;
}

interface PluginsModalProps {
  enabledPlugins: string[];
  onTogglePlugin: (id: string) => void;
  onClose: () => void;
}

const CATEGORIES = [
  { id: "token-saving", label: "Token saving" },
  { id: "enhancement", label: "Enhancement" },
  { id: "formatting", label: "Formatting" },
  { id: "safety", label: "Safety" },
];

const SUGGESTED_ICONS = ["✨", "🎯", "🧠", "⚡", "🔧", "📐", "🎨", "🧪", "📚", "🛠️", "🚀", "🦉"];

interface Draft {
  id?: string;
  name: string;
  icon: string;
  description: string;
  category: string;
  prompt: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  icon: "✨",
  description: "",
  category: "enhancement",
  prompt: "",
};

export function PluginsModal({
  enabledPlugins,
  onTogglePlugin,
  onClose,
}: PluginsModalProps) {
  const [custom, setCustom] = useState<CustomPlugin[]>([]);
  /*
   * Standing cost of the enabled plugins, shown in the footer.
   *
   * Counts CUSTOM plugins too. The first version listed only the built-ins,
   * so someone with a 90,000-character plugin of their own saw a reassuring
   * number that was nothing to do with what they were being billed — which
   * defeats the point of showing it at all.
   */
  const enabledChars = [...AVAILABLE_PLUGINS, ...LEGACY_PLUGINS, ...custom]
    .filter((p) => enabledPlugins.includes(p.id))
    .reduce((n, p) => n + p.prompt.length, 0);
  const pluginTokens = Math.ceil(enabledChars / 3.6);
  const overBudget = enabledChars > MAX_PLUGIN_TOTAL;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/plugins");
      if (!res.ok) return;
      const data = (await res.json()) as CustomPlugin[];
      if (Array.isArray(data)) setCustom(data);
    } catch {
      /* offline — built-ins still work */
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (draft) setDraft(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft, onClose]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        draft.id ? `/api/plugins/${draft.id}` : "/api/plugins",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        }
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not save");
        return;
      }
      await load();
      setDraft(null);
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await fetch(`/api/plugins/${id}`, { method: "DELETE" });
      if (enabledPlugins.includes(id)) onTogglePlugin(id);
      await load();
    } catch {
      /* ignore */
    }
  };

  const renderCard = (plugin: Plugin, isCustom: boolean) => {
    const enabled = enabledPlugins.includes(plugin.id);
    return (
      <div
        key={plugin.id}
        data-enabled={enabled}
        className="group flex items-start gap-3 rounded-xl border border-border bg-bg-tertiary/40 p-3 transition-colors data-[enabled=true]:border-accent/40 data-[enabled=true]:bg-accent/[0.07]"
      >
        <span className="mt-0.5 flex-none text-lg leading-none">{plugin.icon}</span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">
              {plugin.name}
            </span>
            {isCustom && (
              <span className="flex-none rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-text-muted">
                yours
              </span>
            )}
          </div>
          {plugin.description && (
            <p className="mt-0.5 text-xs leading-5 text-text-secondary">
              {plugin.description}
            </p>
          )}
        </div>

        <div className="flex flex-none items-center gap-1">
          {isCustom && (
            <>
              <button
                onClick={() =>
                  setDraft({
                    id: plugin.id,
                    name: plugin.name,
                    icon: plugin.icon,
                    description: plugin.description,
                    category: plugin.category,
                    prompt: plugin.prompt,
                  })
                }
                title="Edit"
                aria-label="Edit plugin"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted opacity-0 transition-all hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={() => remove(plugin.id)}
                title="Delete"
                aria-label="Delete plugin"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted opacity-0 transition-all hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}

          {!isCustom && (
            <button
              onClick={() =>
                setDraft({
                  name: `${plugin.name} (copy)`,
                  icon: plugin.icon,
                  description: plugin.description,
                  category: plugin.category,
                  prompt: plugin.prompt,
                })
              }
              title="Duplicate as your own"
              aria-label="Duplicate plugin"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted opacity-0 transition-all hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
              </svg>
            </button>
          )}

          {/* Toggle */}
          <button
            onClick={() => onTogglePlugin(plugin.id)}
            role="switch"
            aria-checked={enabled}
            aria-label={`${enabled ? "Disable" : "Enable"} ${plugin.name}`}
            data-on={enabled}
            className="relative h-5 w-9 flex-none rounded-full border border-border bg-bg-elevated transition-colors data-[on=true]:border-accent data-[on=true]:bg-accent"
          >
            <span
              data-on={enabled}
              className="absolute top-1/2 left-0.5 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-text-muted transition-all data-[on=true]:left-[1.125rem] data-[on=true]:bg-white"
            />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative flex h-[min(86vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl shadow-black/50 animate-fade-in">
        {/* Header */}
        <div className="flex flex-none items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-text-primary">
              {draft ? (draft.id ? "Edit plugin" : "New plugin") : "Plugins"}
            </h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              {draft
                ? "Instructions added to the system prompt when enabled"
                : "Styles and preprompts that shape how the assistant replies"}
            </p>
          </div>
          <button
            onClick={draft ? () => setDraft(null) : onClose}
            className="rounded-xl p-2 text-text-secondary transition-colors hover:bg-bg-hover"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Editor */}
        {draft ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="flex gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-primary">
                  Icon
                </label>
                <input
                  value={draft.icon}
                  onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                  className="h-10 w-14 rounded-xl border border-border bg-bg-primary text-center text-lg outline-none transition-colors focus:border-accent/60"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className="mb-1.5 block text-xs font-semibold text-text-primary">
                  Name
                </label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Rust expert"
                  maxLength={40}
                  className="h-10 w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent/60"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-1">
              {SUGGESTED_ICONS.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setDraft({ ...draft, icon: ic })}
                  className="h-8 w-8 rounded-lg text-base transition-colors hover:bg-bg-hover"
                >
                  {ic}
                </button>
              ))}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-text-primary">
                Description <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Terse Rust answers, no hand-holding"
                maxLength={140}
                className="h-10 w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent/60"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-text-primary">
                Category
              </label>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setDraft({ ...draft, category: c.id })}
                    data-active={draft.category === c.id}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover data-[active=true]:border-accent/50 data-[active=true]:bg-accent/10 data-[active=true]:text-accent-light"
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-text-primary">
                Prompt
              </label>
              <p className="mb-2 text-[11px] leading-4 text-text-muted">
                Written as an instruction to the assistant. Appended to the
                system prompt whenever this plugin is on.
              </p>
              <textarea
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder={"You are a Rust expert. Prefer idiomatic, zero-cost abstractions.\nNever explain basic syntax. Show complete compiling code."}
                rows={7}
                maxLength={MAX_PLUGIN_PROMPT}
                className="w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2.5 font-mono text-[13px] leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent/60"
              />
              {/* The character count AND what it costs.

                  The limit went from 4,000 to 20,000 because 4,000 was an
                  arbitrary guess, but a longer plugin is a real standing
                  charge: every character here is billed on every request
                  while the plugin is on. Showing the token estimate beside
                  the count is the difference between an informed long prompt
                  and an accidental one. */}
              <p className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
                <span>
                  {draft.prompt.length > 0 &&
                    `~${Math.ceil(draft.prompt.length / 3.6).toLocaleString()} tokens, added to every request`}
                </span>
                <span
                  className={
                    draft.prompt.length > MAX_PLUGIN_PROMPT * 0.9
                      ? "text-danger"
                      : undefined
                  }
                >
                  {draft.prompt.length.toLocaleString()}/
                  {MAX_PLUGIN_PROMPT.toLocaleString()}
                </span>
              </p>
            </div>

            {error && (
              <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {custom.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                  Your plugins
                </p>
                <div className="space-y-2">
                  {custom.map((p) => renderCard(p, true))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                Built in
              </p>
              <div className="space-y-2">
                {AVAILABLE_PLUGINS.map((p) => renderCard(p, false))}
              </div>
            </div>

            {/* Listed apart from the current versions, or the near-duplicate
                names read as a mistake rather than as a choice. */}
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                Classic
              </p>
              <p className="mb-2 text-[11px] leading-4 text-text-muted">
                The original wording, kept so an older chat can be continued in
                the voice it was written in. These sit earlier in the prompt
                than the current versions, so they carry less weight.
              </p>
              <div className="space-y-2">
                {LEGACY_PLUGINS.map((p) => renderCard(p, false))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex flex-none items-center justify-between gap-3 border-t border-border px-6 py-3.5">
          {draft ? (
            <>
              <button
                onClick={() => setDraft(null)}
                className="rounded-xl border border-border px-3.5 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !draft.name.trim() || !draft.prompt.trim()}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? "Saving…" : draft.id ? "Save changes" : "Create plugin"}
              </button>
            </>
          ) : (
            <>
              {/*
                What the active plugins cost, every round.

                Reported: "when i enable plugin caveman it spends more token
                than it saves". It did — the block wrapping the rules was 264
                tokens of boilerplate around a 114-token rule, and nothing on
                screen said so. A token-saving feature with an invisible
                standing charge is the one case where a number in the UI is
                worth more than any amount of tuning.

                Estimated at ~3.6 characters per token, which is the ratio
                measured against DeepSeek's own usage figures in docs/token-costs.md.
              */}
              <span className="text-xs text-text-muted">
                {enabledPlugins.length} active
                {enabledPlugins.length > 0 && (
                  <>
                    {" · "}
                    <span
                      className={overBudget ? "text-danger" : undefined}
                      title={
                        overBudget
                          ? `Over the ${MAX_PLUGIN_TOTAL.toLocaleString()} character budget — the ones past it are left out of the prompt.`
                          : "Added to every request while these are on. Cached after the first round of a conversation."
                      }
                    >
                      ~{pluginTokens.toLocaleString()} tokens per request
                      {overBudget && " — over budget, some are ignored"}
                    </span>
                  </>
                )}
              </span>
              <button
                onClick={() => {
                  setError(null);
                  setDraft({ ...EMPTY_DRAFT });
                }}
                className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-light"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                </svg>
                New plugin
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
