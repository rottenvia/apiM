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
      className={`flex flex-col bg-bg-secondary border-r border-border transition-all duration-300 ease-in-out ${
        isOpen ? "w-72" : "w-0"
      } overflow-hidden flex-shrink-0`}
    >
      <div className="flex flex-col h-full min-w-[288px]">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-purple-400 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-accent/20">
            nh
          </div>
          <div>
            <h1 className="text-base font-bold text-text-primary tracking-tight">
              nohomo
            </h1>
            <p className="text-[10px] text-text-secondary tracking-wider uppercase">
              API MANAGER
            </p>
          </div>
        </div>

        {/* New Chat Button */}
        <div className="px-3 py-3">
          <button
            onClick={onNew}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-accent/10 hover:bg-accent/20 text-accent-light border border-accent/20 hover:border-accent/40 transition-all duration-200 text-sm font-medium"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Chat
          </button>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-150 ${
                currentConvId === conv.id
                  ? "bg-bg-elevated border border-border-light text-text-primary"
                  : "hover:bg-bg-tertiary text-text-secondary hover:text-text-primary border border-transparent"
              }`}
              onClick={() => onSelect(conv.id)}
            >
              <svg
                className="w-4 h-4 flex-shrink-0 opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              <span className="text-sm truncate flex-1">{conv.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-danger/20 hover:text-danger transition-all duration-150"
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
            <div className="text-center py-12 px-4">
              <div className="text-3xl mb-3">💬</div>
              <p className="text-text-secondary text-sm">No conversations yet</p>
              <p className="text-text-muted text-xs mt-1">
                Start a new chat to begin
              </p>
            </div>
          )}
        </div>

        {/* Bottom Settings */}
        <div className="border-t border-border px-3 py-3">
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition-all duration-200 text-sm"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
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
