"use client";

import { useState, useRef, useEffect } from "react";

interface ThinkingEffortSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

const EFFORTS = [
  {
    id: "auto",
    label: "Auto",
    icon: "✨",
    color: "text-purple-400",
    bgColor: "bg-purple-400/15",
    borderColor: "border-purple-400/30",
    description:
      "Automatically determines the best effort level based on your message complexity. Uses minimal effort for simple queries and maximum for complex ones.",
    warning:
      "⚠️ Auto mode may use high effort for complex messages, which consumes more tokens. If you want to save tokens, use a fixed effort level.",
  },
  {
    id: "none",
    label: "None",
    icon: "⚡",
    color: "text-green-400",
    bgColor: "bg-green-400/15",
    borderColor: "border-green-400/30",
    description:
      "Disables thinking entirely. Fastest responses, lowest token usage. Best for simple questions.",
    warning: null,
  },
  {
    id: "low",
    label: "Low",
    icon: "💫",
    color: "text-blue-400",
    bgColor: "bg-blue-400/15",
    borderColor: "border-blue-400/30",
    description:
      "Light reasoning. Good balance of speed and quality for moderate questions.",
    warning: null,
  },
  {
    id: "high",
    label: "High",
    icon: "🧠",
    color: "text-amber-400",
    bgColor: "bg-amber-400/15",
    borderColor: "border-amber-400/30",
    description:
      "Deep reasoning chain. Significantly better for complex problems, debugging, and analysis.",
    warning: null,
  },
  {
    id: "max",
    label: "Max",
    icon: "🔥",
    color: "text-red-400",
    bgColor: "bg-red-400/15",
    borderColor: "border-red-400/30",
    description:
      "Maximum reasoning depth. Uses up to 50K+ tokens internally. Best for proofs, architecture, and complex multi-step problems.",
    warning:
      "⚠️ Max effort can use 50K+ thinking tokens per message. This significantly increases cost. Use only for genuinely complex tasks.",
  },
];

export function ThinkingEffortSelector({
  value,
  onChange,
}: ThinkingEffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const current = EFFORTS.find((e) => e.id === value) || EFFORTS[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hoveredEffort = hoveredId
    ? EFFORTS.find((e) => e.id === hoveredId)
    : null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${current.bgColor} ${current.color} border ${current.borderColor} shadow-sm`}
      >
        <span>{current.icon}</span>
        <span>Think: {current.label}</span>
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-2 left-0 w-80 bg-bg-elevated border border-border-light rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-50 animate-fade-in">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary">
              Thinking Effort
            </h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Control how deeply the AI reasons about your messages
            </p>
          </div>

          <div className="p-2">
            {EFFORTS.map((effort) => (
              <button
                key={effort.id}
                onClick={() => {
                  onChange(effort.id);
                  setIsOpen(false);
                }}
                onMouseEnter={() => setHoveredId(effort.id)}
                onMouseLeave={() => setHoveredId(null)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150 ${
                  value === effort.id
                    ? `${effort.bgColor} ${effort.color} border ${effort.borderColor}`
                    : "hover:bg-bg-hover text-text-secondary hover:text-text-primary border border-transparent"
                }`}
              >
                <span className="text-base">{effort.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{effort.label}</p>
                  <p className="text-[11px] opacity-70 truncate">
                    {effort.description.substring(0, 60)}...
                  </p>
                </div>
                {value === effort.id && (
                  <svg
                    className="w-4 h-4 flex-shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>

          {/* Hover detail panel */}
          {hoveredEffort && (
            <div className="border-t border-border px-4 py-3 bg-bg-secondary/50">
              <p className="text-xs text-text-secondary leading-relaxed">
                {hoveredEffort.description}
              </p>
              {hoveredEffort.warning && (
                <p className="text-xs text-warning mt-2 leading-relaxed">
                  {hoveredEffort.warning}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
