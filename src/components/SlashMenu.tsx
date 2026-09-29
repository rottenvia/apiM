"use client";

import { useEffect, useRef } from "react";

/** One row of the slash menu: a command, or a value for a command's argument. */
export interface SlashItem {
  key: string;
  label: string;
  /** Argument hint for commands, or the raw value for options. */
  hint?: string;
  description?: string;
  /** Group header shown above the first item of each group. */
  group?: string;
  /** Composer text after picking this row. */
  insert: string;
  /** Enter runs it straight away (Tab only ever completes). */
  run: boolean;
  /** The option currently in force (model, theme…). */
  current?: boolean;
}

interface SlashMenuProps {
  items: SlashItem[];
  active: number;
  onHover: (index: number) => void;
  onPick: (item: SlashItem) => void;
  title?: string;
}

/**
 * The list that opens above the composer when a message starts with "/".
 *
 * Keyboard handling lives in the composer (it owns the textarea); this only
 * renders, keeps the active row in view and takes mouse picks.
 */
export function SlashMenu({ items, active, onHover, onPick, title }: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-2">
      <div className="popover-card overflow-hidden">
      <div
        ref={listRef}
        id="slash-menu"
        role="listbox"
        aria-label={title ?? "Commands"}
        className="max-h-[min(22rem,50vh)] overflow-y-auto p-1.5"
      >
        {title && (
          <div role="presentation" className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium text-text-muted">{title}</div>
        )}
        {items.map((item, i) => {
          const header = item.group && item.group !== items[i - 1]?.group ? item.group : null;
          return (
            <div key={item.key} role="presentation">
              {header && (
                <div role="presentation" className="px-2.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted first:pt-0.5">
                  {header}
                </div>
              )}
              <button
                type="button"
                role="option"
                id={`slash-opt-${i}`}
                aria-selected={i === active}
                data-index={i}
                // Keep focus in the textarea: a mousedown default would blur it.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && onHover(i)}
                onClick={() => onPick(item)}
                className={`flex w-full items-baseline gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                  i === active ? "bg-bg-hover" : ""
                }`}
              >
                <span
                  className={`flex-none font-mono text-[13px] ${
                    item.current ? "text-accent-light" : "text-text-primary"
                  }`}
                >
                  {item.label}
                </span>
                {item.hint && (
                  <span className="flex-none font-mono text-[11px] text-text-muted">{item.hint}</span>
                )}
                {item.description && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                    {item.description}
                  </span>
                )}
                {item.current && (
                  <span className="flex-none text-[11px] text-accent-light">current</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div className="hidden justify-end gap-3 border-t border-border px-3 py-1 text-[11px] text-text-muted sm:flex">
        <span>↑↓ choose</span>
        <span>Tab complete</span>
        <span>Enter run</span>
        <span>Esc close</span>
      </div>
      </div>
    </div>
  );
}
