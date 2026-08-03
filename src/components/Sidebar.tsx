"use client";

import { Conversation } from "@/app/page";

interface SidebarProps {
  conversations: Conversation[];
  currentConvId: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  conversations,
  currentConvId,
  isOpen,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
}: SidebarProps) {
  return (
    <div
      className={`flex flex-col bg-bg-secondary border-r border-border transition-[width] duration-300 ease-in-out ${
        isOpen ? "w-72" : "w-0"
      } overflow-hidden flex-shrink-0`}
    >
      <div className="flex flex-col h-full min-w-[288px]">
        {/* New chat — the single primary action at the top of the sidebar */}
        <div className="px-3 pt-3 pb-2">
          <button onClick={onNew} className="new-chat-btn">
            <svg
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 5v14M5 12h14"
              />
            </svg>
            New chat
          </button>
        </div>

        {/* Conversations */}
        {conversations.length > 0 && (
          <p className="px-5 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
            Recent
          </p>
        )}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-colors duration-150 ${
                currentConvId === conv.id
                  ? "bg-bg-elevated text-text-primary"
                  : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
              onClick={() => onSelect(conv.id)}
            >
              <span className="text-sm truncate flex-1 leading-5">
                {conv.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
                aria-label="Delete conversation"
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-text-muted hover:bg-danger/15 hover:text-danger transition-all duration-150"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          ))}

          {conversations.length === 0 && (
            <div className="px-4 pt-16 text-center">
              <p className="text-text-secondary text-sm">No conversations yet</p>
              <p className="text-text-muted text-xs mt-1 leading-5">
                Start a new chat to begin
              </p>
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="border-t border-border px-3 py-3">
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors duration-150 text-sm"
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
                strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
