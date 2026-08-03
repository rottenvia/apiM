"use client";

import { AVAILABLE_PLUGINS } from "@/lib/plugins";

interface PluginsModalProps {
  enabledPlugins: string[];
  onTogglePlugin: (id: string) => void;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  "token-saving": { label: "Token Saving", color: "text-success" },
  enhancement: { label: "Enhancement", color: "text-info" },
  formatting: { label: "Formatting", color: "text-accent-light" },
  safety: { label: "Safety", color: "text-warning" },
};

export function PluginsModal({
  enabledPlugins,
  onTogglePlugin,
  onClose,
}: PluginsModalProps) {
  const categories = [...new Set(AVAILABLE_PLUGINS.map((p) => p.category))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-2xl bg-bg-secondary border border-border-light rounded-3xl shadow-2xl shadow-black/50 animate-fade-in overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Plugins</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Customize AI behavior with plugins inspired by Claude Code
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
        <div className="px-6 py-5 max-h-[70vh] overflow-y-auto space-y-6">
          {/* Active count */}
          {enabledPlugins.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-accent/10 border border-accent/20">
              <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-sm text-accent-light font-medium">
                {enabledPlugins.length} plugin
                {enabledPlugins.length > 1 ? "s" : ""} active
              </span>
              <span className="text-xs text-text-secondary ml-auto">
                Applied to every message
              </span>
            </div>
          )}

          {categories.map((category) => {
            const catInfo = CATEGORY_LABELS[category] || {
              label: category,
              color: "text-text-secondary",
            };
            const plugins = AVAILABLE_PLUGINS.filter(
              (p) => p.category === category
            );

            return (
              <div key={category}>
                <h3
                  className={`text-xs font-bold uppercase tracking-wider mb-3 ${catInfo.color}`}
                >
                  {catInfo.label}
                </h3>
                <div className="space-y-2">
                  {plugins.map((plugin) => {
                    const isEnabled = enabledPlugins.includes(plugin.id);
                    return (
                      <button
                        key={plugin.id}
                        onClick={() => onTogglePlugin(plugin.id)}
                        className={`w-full flex items-start gap-3 px-4 py-3 rounded-xl text-left transition-all duration-200 ${
                          isEnabled
                            ? "bg-accent/10 border border-accent/25"
                            : "bg-bg-tertiary border border-border hover:border-border-light"
                        }`}
                      >
                        <span className="text-xl mt-0.5 flex-shrink-0">
                          {plugin.icon}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-sm font-semibold ${isEnabled ? "text-accent-light" : "text-text-primary"}`}
                            >
                              {plugin.name}
                            </span>
                          </div>
                          <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                            {plugin.description}
                          </p>
                        </div>
                        <div
                          className={`flex-shrink-0 w-10 h-5 rounded-full transition-all duration-200 relative ${
                            isEnabled ? "bg-accent" : "bg-bg-elevated"
                          }`}
                        >
                          <div
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
                              isEnabled ? "left-5" : "left-0.5"
                            }`}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Info box */}
          <div className="px-4 py-3 rounded-xl bg-info/10 border border-info/20">
            <p className="text-xs text-info leading-relaxed">
              Plugins modify the system prompt and/or user messages sent to the
              AI. They apply to every message in every conversation while
              active. Combine multiple plugins for powerful customization.
            </p>
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
