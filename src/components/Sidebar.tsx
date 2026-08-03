"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Conversation } from "@/app/page";

interface SidebarProps {
  conversations: Conversation[];
  currentConvId: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
}

const EXPORT_FORMATS = [
  { id: "md", label: "Markdown", ext: ".md" },
  { id: "json", label: "JSON", ext: ".json" },
  { id: "txt", label: "Plain text", ext: ".txt" },
  { id: "html", label: "Web page", ext: ".html" },
];

export function Sidebar({
  conversations,
  currentConvId,
  isOpen,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onArchive,
  onOpenSearch,
  onOpenSettings,
}: SidebarProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { active, archived } = useMemo(
    () => ({
      active: conversations.filter((c) => !c.archived),
      archived: conversations.filter((c) => c.archived),
    }),
    [conversations]
  );

  const visible = showArchived ? archived : active;

  // Close any open popover on outside click or Escape.
  useEffect(() => {
    if (!menuFor && !exportFor) return;
    const close = () => {
      setMenuFor(null);
      setExportFor(null);
      setConfirmDelete(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor, exportFor]);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id);
    setDraft(conv.title);
    setMenuFor(null);
  };

  const commitRename = () => {
    if (editingId) {
      const next = draft.trim();
      if (next) onRename(editingId, next);
    }
    setEditingId(null);
  };

  const download = (id: string, format: string) => {
    // A hidden anchor click keeps the server's Content-Disposition filename
    // without navigating away from the conversation.
    const a = document.createElement("a");
    a.href = `/api/conversations/${id}/export?format=${format}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setExportFor(null);
    setMenuFor(null);
  };

  return (
    <div
      className={`flex flex-col border-r border-border bg-bg-secondary transition-[width] duration-300 ease-in-out ${
        isOpen ? "w-72" : "w-0"
      } flex-shrink-0 overflow-hidden`}
    >
      <div className="flex h-full min-w-[288px] flex-col">
        {/* New chat */}
        <div className="px-3 pb-2 pt-3">
          <button onClick={onNew} className="new-chat-btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            New chat
          </button>

          <button
            onClick={onOpenSearch}
            className="mt-1.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" className="flex-none">
              <circle cx="11" cy="11" r="8" />
              <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
            </svg>
            Search chats
            <kbd className="ml-auto rounded border border-border px-1 py-px font-mono text-[9px] text-text-muted">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Active / Archived switch */}
        {(active.length > 0 || archived.length > 0) && (
          <div className="flex items-center gap-1 px-3 pb-1 pt-2">
            <button
              onClick={() => setShowArchived(false)}
              data-active={!showArchived}
              className="flex-1 rounded-lg px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:text-text-secondary data-[active=true]:bg-bg-tertiary data-[active=true]:text-text-primary"
            >
              Chats{active.length ? ` · ${active.length}` : ""}
            </button>
            <button
              onClick={() => setShowArchived(true)}
              data-active={showArchived}
              className="flex-1 rounded-lg px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:text-text-secondary data-[active=true]:bg-bg-tertiary data-[active=true]:text-text-primary"
            >
              Archive{archived.length ? ` · ${archived.length}` : ""}
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {visible.map((conv) => {
            const isCurrent = currentConvId === conv.id;
            const menuOpen = menuFor === conv.id;

            return (
              <div
                key={conv.id}
                className={`group relative flex items-center gap-1 rounded-xl px-2.5 py-2 transition-colors duration-150 ${
                  isCurrent
                    ? "bg-bg-elevated text-text-primary"
                    : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
              >
                {editingId === conv.id ? (
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-accent/40 bg-bg-primary px-1.5 py-0.5 text-sm text-text-primary outline-none"
                  />
                ) : (
                  <button
                    onClick={() => onSelect(conv.id)}
                    onDoubleClick={() => startRename(conv)}
                    className="min-w-0 flex-1 truncate text-left text-sm leading-5"
                    title={conv.title}
                  >
                    {conv.title}
                  </button>
                )}

                {editingId !== conv.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuOpen ? null : conv.id);
                      setExportFor(null);
                      setConfirmDelete(null);
                    }}
                    aria-label="Conversation options"
                    data-open={menuOpen}
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 data-[open=true]:opacity-100"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </button>
                )}

                {menuOpen && (
                  <div
                    onMouseDown={(e) => e.stopPropagation()}
                    className="absolute right-1 top-full z-30 mt-1 w-48 origin-top-right overflow-hidden rounded-xl border border-border-light bg-bg-elevated p-1 shadow-[0_18px_48px_rgba(0,0,0,0.5)] animate-fade-in"
                  >
                    <MenuItem
                      onClick={() => startRename(conv)}
                      label="Rename"
                      icon={
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      }
                    />

                    {/* Export — expands to a format list in place */}
                    <button
                      onClick={() => setExportFor(exportFor === conv.id ? null : conv.id)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true" className="flex-none">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
                      </svg>
                      Download
                      <svg
                        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth={2} aria-hidden="true"
                        className={`ml-auto flex-none transition-transform duration-200 ${exportFor === conv.id ? "rotate-90" : ""}`}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>

                    {exportFor === conv.id && (
                      <div className="mb-0.5 ml-2 space-y-0.5 border-l border-border pl-1.5 animate-fade-in">
                        {EXPORT_FORMATS.map((f) => (
                          <button
                            key={f.id}
                            onClick={() => download(conv.id, f.id)}
                            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                          >
                            {f.label}
                            <span className="font-mono text-[10px] text-text-muted">{f.ext}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <MenuItem
                      onClick={() => {
                        onArchive(conv.id, !conv.archived);
                        setMenuFor(null);
                      }}
                      label={conv.archived ? "Unarchive" : "Archive"}
                      icon={
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                      }
                    />

                    <div className="my-1 h-px bg-border" />

                    {confirmDelete === conv.id ? (
                      <div className="px-2.5 py-1.5">
                        <p className="mb-1.5 text-[11px] leading-4 text-text-secondary">
                          Delete this chat permanently?
                        </p>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => {
                              onDelete(conv.id);
                              setMenuFor(null);
                              setConfirmDelete(null);
                            }}
                            className="flex-1 rounded-md bg-danger/90 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-danger"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="flex-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <MenuItem
                        onClick={() => setConfirmDelete(conv.id)}
                        label="Delete"
                        danger
                        icon={
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {visible.length === 0 && (
            <div className="px-4 pt-16 text-center">
              <p className="text-sm text-text-secondary">
                {showArchived ? "Nothing archived" : "No conversations yet"}
              </p>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {showArchived
                  ? "Archived chats appear here"
                  : "Start a new chat to begin"}
              </p>
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="border-t border-border px-3 py-3">
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  icon,
  danger,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        danger
          ? "text-danger hover:bg-danger/12"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true" className="flex-none">
        {icon}
      </svg>
      {label}
    </button>
  );
}
