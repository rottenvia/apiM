"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Conversation } from "@/app/page";
import { DeleteChatDialog } from "@/components/DeleteChatDialog";

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
  onImported: () => void;
  onOpenSettings: () => void;
  /** How long the delete button stays locked, in seconds. */
  deleteDelay: number;
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
  onImported,
  onOpenSettings,
  deleteDelay,
}: SidebarProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importState, setImportState] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const handleImport = async (file: File) => {
    setImportState("Importing…");
    try {
      const parsed = JSON.parse(await file.text());
      const res = await fetch("/api/conversations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = (await res.json()) as {
        imported?: number;
        error?: string;
      };
      if (!res.ok) {
        setImportState(body.error ?? "Import failed");
      } else {
        setImportState(
          `Imported ${body.imported} chat${body.imported === 1 ? "" : "s"}`
        );
        onImported();
      }
    } catch {
      setImportState("That file isn't valid JSON");
    }
    setTimeout(() => setImportState(null), 4000);
  };

  const { active, archived } = useMemo(
    () => ({
      active: conversations.filter((c) => !c.archived),
      archived: conversations.filter((c) => c.archived),
    }),
    [conversations]
  );

  const visible = showArchived ? archived : active;

  // Resolved from the full list, not the filtered one: the dialog must stay
  // open even if the chat scrolls out of view or the archive tab is switched.
  const pendingDelete = confirmDelete
    ? conversations.find((c) => c.id === confirmDelete)
    : undefined;

  // Close any open popover on outside click or Escape.
  //
  // This listens for `click`, not `mousedown`. With mousedown the menu closed
  // during the press, so the button unmounted before its click event could
  // fire — Rename and Download appeared to do nothing but dismiss the menu.
  // The `[data-menu-root]` guard keeps clicks inside the menu from closing it.
  useEffect(() => {
    if (!menuFor && !exportFor) return;

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-menu-root]")) return;
      setMenuFor(null);
      setExportFor(null);
      setConfirmDelete(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuFor(null);
        setExportFor(null);
        setConfirmDelete(null);
      }
    };

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
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

  /**
   * The chat already using the name being typed, if any.
   *
   * Checked here as well as on the server so the clash is visible while
   * typing rather than only after saving. The server remains the authority.
   */
  const duplicateOf = useMemo(() => {
    if (!editingId) return null;
    const key = draft.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) return null;
    return (
      conversations.find(
        (c) =>
          c.id !== editingId &&
          c.title.trim().toLowerCase().replace(/\s+/g, " ") === key
      ) ?? null
    );
  }, [editingId, draft, conversations]);

  const commitRename = () => {
    if (!editingId) return;

    const next = draft.trim();

    // Blank, unchanged, or already taken: close without saving rather than
    // sending something the server will refuse.
    if (!next || duplicateOf) {
      setEditingId(null);
      return;
    }

    onRename(editingId, next);
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
        <div className="flex h-[60px] flex-none items-center gap-2 px-3">
          <button onClick={onNew} className="new-chat-btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            New chat
          </button>

          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImport(file);
              e.target.value = "";
            }}
          />

          <button
            onClick={() => importRef.current?.click()}
            title="Import a chat from a JSON export"
            aria-label="Import chat"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </button>

          <button
            onClick={onOpenSearch}
            title="Search chats  (Ctrl+K)"
            aria-label="Search chats"
            className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
            </svg>
          </button>

        </div>

        {importState && (
          <p className="px-3 pb-1 text-[11px] leading-4 text-text-secondary animate-fade-in">
            {importState}
          </p>
        )}

        {/* Active / Archived switch */}
        {(active.length > 0 || archived.length > 0) && (
          <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
            <button
              onClick={() => setShowArchived(false)}
              data-active={!showArchived}
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-bg-tertiary/50 hover:text-text-secondary data-[active=true]:bg-bg-tertiary data-[active=true]:text-text-primary"
            >
              Chats{active.length ? ` · ${active.length}` : ""}
            </button>
            <button
              onClick={() => setShowArchived(true)}
              data-active={showArchived}
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-bg-tertiary/50 hover:text-text-secondary data-[active=true]:bg-bg-tertiary data-[active=true]:text-text-primary"
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
                className={`group relative mb-1 flex items-center gap-1 rounded-xl border px-2.5 py-2 transition-colors duration-150 ${
                  isCurrent
                    ? "border-accent/40 bg-bg-elevated text-text-primary"
                    : "border-border/60 text-text-secondary hover:border-border-light hover:bg-bg-tertiary hover:text-text-primary"
                }`}
              >
                {editingId === conv.id ? (
                  <div className="min-w-0 flex-1" data-menu-root>
                    <input
                      ref={inputRef}
                      data-menu-root
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      aria-invalid={Boolean(duplicateOf)}
                      className={`w-full rounded-md border bg-bg-primary px-1.5 py-0.5 text-sm text-text-primary outline-none ${
                        duplicateOf ? "border-danger/60" : "border-accent/40"
                      }`}
                    />
                    {duplicateOf && (
                      <p
                        role="alert"
                        className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-danger"
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          className="mt-0.5 flex-none"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path strokeLinecap="round" d="M12 8v4M12 16h.01" />
                        </svg>
                        <span>
                          Another chat is already called that. Every chat needs
                          its own name — its files live in a folder named after
                          it.
                        </span>
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Covers the row's padding so the whole card is
                        clickable, not just the text. */}
                    <button
                      onClick={() => onSelect(conv.id)}
                      onDoubleClick={() => startRename(conv)}
                      aria-label={conv.title}
                      className="absolute inset-0 rounded-xl"
                    />
                    <span
                      className="pointer-events-none relative min-w-0 flex-1 truncate text-left text-sm leading-5"
                      title={conv.title}
                    >
                      {conv.title}
                    </span>
                  </>
                )}

                {editingId !== conv.id && (
                  <button
                    data-menu-root
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuOpen ? null : conv.id);
                      setExportFor(null);
                      setConfirmDelete(null);
                    }}
                    aria-label="Conversation options"
                    data-open={menuOpen}
                    className="relative z-10 flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-bg-hover hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 data-[open=true]:opacity-100"
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
                    data-menu-root
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

                    <MenuItem
                      onClick={() => {
                        // Close the menu first: the dialog is modal, and
                        // leaving the popover mounted behind it traps focus.
                        setMenuFor(null);
                        setConfirmDelete(conv.id);
                      }}
                      label="Delete"
                      danger
                      icon={
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      }
                    />
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

      {pendingDelete && (
        <DeleteChatDialog
          title={pendingDelete.title}
          messageCount={pendingDelete.messageCount}
          delaySeconds={deleteDelay}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = pendingDelete.id;
            setConfirmDelete(null);
            onDelete(id);
          }}
        />
      )}
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
