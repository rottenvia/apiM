"use client";

import { useState, useRef, useEffect } from "react";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

const MODELS = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    shortLabel: "V4 Pro",
    icon: "🚀",
    color: "text-purple-400",
    bgColor: "bg-purple-400/15",
    borderColor: "border-purple-400/30",
    description: "49B parameters. Frontier-level reasoning and coding. Best quality.",
    specs: "1M context • 384K output",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    shortLabel: "V4 Flash",
    icon: "⚡",
    color: "text-cyan-400",
    bgColor: "bg-cyan-400/15",
    borderColor: "border-cyan-400/30",
    description: "13B parameters. Fast inference, lower cost. Great for quick tasks.",
    specs: "1M context • 384K output",
  },
];

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.id === value) || MODELS[0];

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

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${current.bgColor} ${current.color} border ${current.borderColor} shadow-sm`}
      >
        <span>{current.icon}</span>
        <span>{current.shortLabel}</span>
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
        <div className="absolute bottom-full mb-2 left-0 w-72 bg-bg-elevated border border-border-light rounded-2xl shadow-2xl shadow-black/40 overflow-hidden z-50 animate-fade-in">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary">
              Select Model
            </h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Choose which DeepSeek model to use
            </p>
          </div>

          <div className="p-2">
            {MODELS.map((model) => (
              <button
                key={model.id}
                onClick={() => {
                  onChange(model.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-start gap-3 px-3 py-3 rounded-xl text-left transition-all duration-150 ${
                  value === model.id
                    ? `${model.bgColor} ${model.color} border ${model.borderColor}`
                    : "hover:bg-bg-hover text-text-secondary hover:text-text-primary border border-transparent"
                }`}
              >
                <span className="text-lg mt-0.5">{model.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{model.label}</p>
                  <p className="text-[11px] opacity-70 mt-0.5">
                    {model.description}
                  </p>
                  <p className="text-[10px] opacity-50 mt-1">{model.specs}</p>
                </div>
                {value === model.id && (
                  <svg
                    className="w-4 h-4 flex-shrink-0 mt-1"
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
        </div>
      )}
    </div>
  );
}
