"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { memo } from "react";
import { buildChatSearchIndex } from "@/lib/chat-search";
import { estimateCost, formatCost, formatDuration } from "@/lib/pricing";
import type { ChatSearchIndex } from "@/lib/chat-search";
import { ChatSearchBar } from "@/components/ChatSearchBar";
import { AttachmentChips } from "@/components/AttachmentChips";
import {
  buildMessageWithAttachments,
  readImageFile,
  readTextFile,
  MAX_FILES,
} from "@/lib/attachments";
import { isImageFile } from "@/lib/vision";
import type { Attachment } from "@/lib/attachments";
import { Dots, MessageBubble } from "@/components/MessageBubble";
import { ThinkingEffortSelector } from "@/components/ThinkingEffortSelector";
import { ModelSelector } from "@/components/ModelSelector";
import { WebSearchToggle } from "@/components/WebSearchToggle";
import { WorkspaceToggle } from "@/components/WorkspaceToggle";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { WorkspaceDock } from "@/components/WorkspaceDock";
import { ProcessDock } from "@/components/ProcessDock";
import type { WorkspaceFileInfo } from "@/components/WorkspaceBar";
import type { Message, StatusStage } from "@/app/page";

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  statusStage: StatusStage | null;
  /** Set while a transient upstream failure is being retried. */
  retryNotice?: string | null;
  onStop: () => void;
  hasKeys: boolean;
  model: string;
  thinkingEffort: string;
  webSearchMode: "off" | "auto" | "always";
  visionKey: string;
  visionModel: string;
  enabledPlugins: string[];
  sidebarOpen: boolean;
  onSend: (
    message: string,
    options?: {
      displayContent?: string;
      attachments?: { name: string; kind: "text" | "image"; dataUrl?: string }[];
    }
  ) => void;
  onRegenerate: (assistantId: string) => void;
  onEdit: (messageId: string, newContent: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onSetSearchMode: (mode: "off" | "auto" | "always") => void;
  onSetThinkingEffort: (effort: string) => void;
  onSetModel: (model: string) => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  workspaceEnabled: boolean;
  workspaceFiles: WorkspaceFileInfo[];
  /** Paths the most recent reply changed. */
  recentlyChanged: string[];
  onSetWorkspaceEnabled: (enabled: boolean) => void;
  /** Opens the file panel, optionally jumping straight to one file. */
  onOpenWorkspace: (path?: string) => void;
  onDecideCommand: (id: string, approved: boolean, remember: boolean) => void;
  onAnswerQuestion: (id: string, answer: string) => void;
  /** Current workspace id, for the background-process dock. */
  workspaceId: string | null;
  onProcessesChanged?: () => void;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
}

export function ChatArea({
  messages,
  isLoading,
  statusStage,
  retryNotice,
  onStop,
  hasKeys,
  model,
  thinkingEffort,
  webSearchMode,
  visionKey,
  visionModel,
  enabledPlugins,
  sidebarOpen,
  onSend,
  onRegenerate,
  onEdit,
  onDeleteMessage,
  onToggleSidebar,
  onNewChat,
  onSetSearchMode,
  onSetThinkingEffort,
  onSetModel,
  onOpenSettings,
  onOpenPlugins,
  workspaceEnabled,
  workspaceFiles,
  recentlyChanged,
  onSetWorkspaceEnabled,
  onOpenWorkspace,
  onDecideCommand,
  onAnswerQuestion,
  workspaceId,
  onProcessesChanged,
  sidePanelOpen,
  onToggleSidePanel,
}: ChatAreaProps) {
  const [input, setInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Text attachments, read in the browser and inlined into the message.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drag events fire for child elements too, so track depth rather than
  // toggling on every enter/leave — otherwise the overlay flickers.
  const dragDepth = useRef(0);

  /** Ask the server to describe an image, then store the result on the chip. */
  const analyzeImage = useCallback(
    async (image: Attachment) => {
      if (!image.dataUrl) return;

      if (!visionKey) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === image.id
              ? {
                  ...a,
                  analyzing: false,
                  visionError:
                    "Add a vision API key in Settings to read screenshots",
                }
              : a
          )
        );
        return;
      }

      try {
        const res = await fetch("/api/vision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dataUrl: image.dataUrl,
            apiKey: visionKey,
            model: visionModel,
          }),
        });
        const body = (await res.json()) as {
          description?: string;
          error?: string;
        };

        setAttachments((prev) =>
          prev.map((a) =>
            a.id === image.id
              ? {
                  ...a,
                  analyzing: false,
                  description: body.description,
                  visionError: body.error,
                }
              : a
          )
        );
      } catch {
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === image.id
              ? { ...a, analyzing: false, visionError: "Couldn't reach the server" }
              : a
          )
        );
      }
    },
    [visionKey, visionModel]
  );

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    setAttachError(null);
    const accepted: Attachment[] = [];
    const errors: string[] = [];

    for (const file of list) {
      const { attachment, error } = isImageFile(file)
        ? await readImageFile(file)
        : await readTextFile(file);
      if (attachment) accepted.push(attachment);
      else if (error) errors.push(error);
    }

    // Images need a description before they are any use to a text-only model,
    // so kick that off as soon as they are attached rather than at send time.
    for (const image of accepted.filter((a) => a.kind === "image")) {
      void analyzeImage(image);
    }

    if (accepted.length > 0) {
      setAttachments((prev) => {
        const room = MAX_FILES - prev.length;
        if (room <= 0) {
          errors.push(`You can attach up to ${MAX_FILES} files`);
          return prev;
        }
        if (accepted.length > room) {
          errors.push(`Only the first ${room} file(s) were added`);
        }
        return [...prev, ...accepted.slice(0, room)];
      });
    }

    if (errors.length > 0) setAttachError(errors.join(" · "));
  }, [analyzeImage]);

  /** Re-run a failed description, so a transient API error isn't terminal. */
  const retryImage = useCallback(
    (id: string) => {
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, analyzing: true, visionError: undefined }
            : a
        )
      );
      const target = attachments.find((a) => a.id === id);
      if (target) void analyzeImage({ ...target, visionError: undefined });
    },
    [attachments, analyzeImage]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setAttachError(null);
  }, []);

  // In-chat find. Whole-word is the default so "calc" doesn't match
  // "calculator"; the bar's toggle switches to substring matching.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findWholeWord, setFindWholeWord] = useState(true);
  const [rawActiveMatch, setActiveMatch] = useState(0);

  const searchIndex = useMemo(
    () => buildChatSearchIndex(messages, findOpen ? findQuery : "", findWholeWord),
    [messages, findOpen, findQuery, findWholeWord]
  );

  // Clamp during render rather than syncing via an effect, so the counter can
  // never briefly show a stale index after the result set shrinks.
  const activeMatch =
    searchIndex.total === 0
      ? 0
      : Math.min(rawActiveMatch, searchIndex.total - 1);

  // Ctrl/Cmd+F opens find within the conversation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Scroll the focused match into view.
  useEffect(() => {
    if (!findOpen || searchIndex.total === 0) return;
    const id = requestAnimationFrame(() => {
      document
        .querySelector("[data-active-match]")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [findOpen, activeMatch, searchIndex.total]);

  const gotoNext = useCallback(() => {
    if (searchIndex.total === 0) return;
    setActiveMatch((activeMatch + 1) % searchIndex.total);
  }, [activeMatch, searchIndex.total]);

  const gotoPrev = useCallback(() => {
    if (searchIndex.total === 0) return;
    setActiveMatch(
      (activeMatch - 1 + searchIndex.total) % searchIndex.total
    );
  }, [activeMatch, searchIndex.total]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setActiveMatch(0);
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the UI in sync with the browser's real fullscreen state
  useEffect(() => {
    const handleChange = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  /**
   * F11 is the browser's own fullscreen, not the Fullscreen API.
   *
   * It never sets document.fullscreenElement and never fires
   * fullscreenchange, so the layout stayed narrow while the window was
   * actually maximised. Detect it by comparing the window to the screen
   * instead — that is the only signal F11 leaves behind.
   */
  useEffect(() => {
    const check = () => {
      // The API case is already handled above; only take over when it is not
      // in play, or the two would fight over the same state.
      if (document.fullscreenElement) return;

      // A small tolerance: some browsers leave a pixel or two, and a maximised
      // window with no chrome is within a few pixels of the screen height.
      const borderless =
        Math.abs(window.innerHeight - window.screen.height) <= 4 &&
        Math.abs(window.innerWidth - window.screen.width) <= 4;

      setIsFullscreen(borderless);
    };

    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Auto-scroll, but only while the user is already near the bottom. During a
  // long stream this lets them scroll up to read earlier output without the
  // view yanking back down on every token.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom < 120);
  }, []);

  useEffect(() => {
    if (!pinnedToBottom) return;
    messagesEndRef.current?.scrollIntoView({
      // Smooth scrolling can't keep up with a fast token stream, so only the
      // final settle is animated.
      behavior: isLoading ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, pinnedToBottom, isLoading]);

  const scrollToBottom = useCallback(() => {
    setPinnedToBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  const handleSubmit = () => {
    // A message of only attachments is valid — the files are the content.
    if ((!input.trim() && attachments.length === 0) || isLoading) return;
    // The model receives the file contents and image descriptions; the
    // transcript shows only what the user typed, plus attachment chips.
    onSend(buildMessageWithAttachments(input, attachments), {
      displayContent: input,
      attachments: attachments.map((a) => ({
        name: a.name,
        kind: a.kind,
        dataUrl: a.dataUrl,
      })),
    });
    setInput("");
    setAttachments([]);
    setAttachError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Running totals for the conversation, so the cost of a whole thread is
  // visible rather than only per-reply.
  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let ms = 0;
    let priced = 0;
    for (const m of messages) {
      if (m.tokenCount) tokens += m.tokenCount;
      if (m.durationMs) ms += m.durationMs;
      const c = estimateCost(m.usage, m.model ?? "");
      if (c !== null) {
        cost += c;
        priced += 1;
      }
    }
    return { tokens, cost, ms, priced };
  }, [messages]);

  // Stable identity: an inline arrow here would give every MessageBubble a
  // new prop on each keystroke and defeat the memoisation that fixed the
  // typing lag in long chats.
  const openWorkspaceFile = useCallback(
    (path: string) => onOpenWorkspace(path),
    [onOpenWorkspace]
  );

  const analyzingImages = attachments.some((a) => a.analyzing);
  const canSend =
    (Boolean(input.trim()) || attachments.length > 0) &&
    !isLoading &&
    !analyzingImages &&
    hasKeys;
  // Show the standalone indicator until the assistant bubble actually has
  // something to display. Previously an empty streaming bubble was created
  // instantly, which suppressed the indicator and left a silent gap between
  // sending and the first token.
  const streamingHasOutput = messages.some(
    (m) => m.isStreaming && (m.content || m.reasoningContent)
  );

  // One shared column width for the messages and the composer, and it widens
  // in fullscreen so controls are placed optimally for the user's resolution.
  const columnWidth = isFullscreen
    ? "max-w-4xl 2xl:max-w-5xl"
    : "max-w-3xl xl:max-w-4xl";

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Minimal top bar — no branding, just quiet controls */}
      <header className="flex h-[56px] flex-shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleSidebar}
            className="icon-btn"
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            aria-label="Toggle sidebar"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9.5 4v16" />
            </svg>
          </button>
          {!sidebarOpen && (
            <button
              onClick={onNewChat}
              className="icon-btn"
              title="New chat"
              aria-label="New chat"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 5v14M5 12h14"
                />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <ProcessDock
            workspaceId={workspaceEnabled ? workspaceId : null}
            onChanged={onProcessesChanged}
          />

          {/* Hidden while the pinned panel is showing the same thing, so the
              header isn't duplicating what's already on screen. */}
          {!(workspaceEnabled && sidePanelOpen) && (
            <WorkspaceDock
              enabled={workspaceEnabled}
              files={workspaceFiles}
              recentlyChanged={recentlyChanged}
              onEnable={() => {
                onSetWorkspaceEnabled(true);
                if (!sidePanelOpen) onToggleSidePanel();
              }}
              onOpen={() => onOpenWorkspace()}
              onOpenFile={openWorkspaceFile}
            />
          )}

          {workspaceEnabled && !sidePanelOpen && (
            <button
              onClick={onToggleSidePanel}
              className="icon-btn"
              title="Show the workspace panel"
              aria-label="Show workspace panel"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M15 4v16" />
              </svg>
            </button>
          )}

          <button
            onClick={() => setFindOpen((v) => !v)}
            className="icon-btn"
            data-active={findOpen}
            title="Find in this chat (Ctrl+F)"
            aria-label="Find in this chat"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              <circle cx="10" cy="10" r="6" />
              <path strokeLinecap="round" d="M14.5 14.5L20 20" />
              <path strokeLinecap="round" d="M7.5 10h5" />
            </svg>
          </button>

          <button
            onClick={toggleFullscreen}
            className="icon-btn"
            title={isFullscreen ? "Exit full screen" : "Full screen"}
            aria-label="Toggle full screen"
          >
            {isFullscreen ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"
                />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {findOpen && (
          <div className={`pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto w-full px-4 sm:px-6 ${columnWidth}`}>
            <ChatSearchBar
              query={findQuery}
              onQueryChange={(v) => {
                setFindQuery(v);
                setActiveMatch(0);
              }}
              wholeWord={findWholeWord}
              onWholeWordChange={(v) => {
                setFindWholeWord(v);
                setActiveMatch(0);
              }}
              total={searchIndex.total}
              current={activeMatch}
              onNext={gotoNext}
              onPrev={gotoPrev}
              onClose={closeFind}
            />
          </div>
        )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <EmptyState
            hasKeys={hasKeys}
            onOpenSettings={onOpenSettings}
            workspaceEnabled={workspaceEnabled}
            onEnableWorkspace={() => onSetWorkspaceEnabled(true)}
          />
        ) : (
          <div
            className={`mx-auto w-full px-4 sm:px-6 py-6 transition-[max-width] duration-300 ${columnWidth}`}
          >
            {totals.tokens > 0 && (
              <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-3 text-[11px] text-text-muted">
                <span className="font-medium text-text-secondary">
                  This conversation
                </span>
                <span>{totals.tokens.toLocaleString()} tokens</span>
                {totals.priced > 0 && (
                  <span title="Estimated from the models used">
                    {formatCost(totals.cost)}
                  </span>
                )}
                {totals.ms > 0 && (
                  <span title="Total time spent generating">
                    {formatDuration(totals.ms)}
                  </span>
                )}
                <span className="ml-auto">
                  {messages.filter((m) => m.role === "user").length} messages
                </span>
              </div>
            )}

            {/* The dock in the header covers the "what files exist" job, so
                this only remains as the nudge to switch the workspace on. */}
            {!workspaceEnabled && (
            <WorkspaceBar
              enabled={workspaceEnabled}
              files={workspaceFiles}
              recentlyChanged={recentlyChanged}
              onEnable={() => onSetWorkspaceEnabled(true)}
              onOpen={() => onOpenWorkspace()}
              onOpenFile={openWorkspaceFile}
            />
            )}

            <div className="space-y-6">
              <MessageList
                messages={messages}
                onRegenerate={onRegenerate}
                onEdit={onEdit}
                onDeleteMessage={onDeleteMessage}
                searchQuery={findOpen ? findQuery : undefined}
                searchWholeWord={findWholeWord}
                searchIndex={searchIndex}
                activeMatch={activeMatch}
                revealAll={findOpen && findQuery.trim().length > 0}
                onOpenWorkspaceFile={openWorkspaceFile}
                onDecideCommand={onDecideCommand}
                onAnswerQuestion={onAnswerQuestion}
              />

              {/* Only shown before the first token lands; afterwards the
                  streaming bubble itself is the feedback. */}
              {isLoading && !streamingHasOutput && (
                <LoadingIndicator stage={statusStage} retryNotice={retryNotice} />
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Jump-to-latest — appears only when scrolled away during a stream */}
      {!pinnedToBottom && messages.length > 0 && (
        <div className="pointer-events-none relative z-10">
          <button
            onClick={scrollToBottom}
            className="scroll-bottom-btn"
            aria-label="Scroll to latest"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 5v14M5 12l7 7 7-7"
              />
            </svg>
          </button>
        </div>
      )}
      </div>

      {/* Composer — the relative wrapper anchors the selector popovers so they
          open centered above the chat bar, never covering it */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-2 pb-4">
        <div
          className={`relative mx-auto w-full transition-[max-width] duration-300 ${columnWidth}`}
        >
          <div
            onDragEnter={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              dragDepth.current += 1;
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setIsDragging(false);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.files?.length) return;
              e.preventDefault();
              dragDepth.current = 0;
              setIsDragging(false);
              void addFiles(e.dataTransfer.files);
            }}
            data-dragging={isDragging}
            className="relative rounded-[22px] border border-border bg-bg-tertiary shadow-[0_6px_28px_rgba(0,0,0,0.28)] transition-colors focus-within:border-border-light data-[dragging=true]:border-accent data-[dragging=true]:bg-accent/[0.06]"
          >
            {isDragging && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[22px] bg-bg-tertiary/85 backdrop-blur-[1px]">
                <span className="flex items-center gap-2 text-sm font-medium text-accent-light">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                  </svg>
                  Drop text files to attach
                </span>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                // Reset so re-picking the same file still fires onChange.
                e.target.value = "";
              }}
            />

            <AttachmentChips
              attachments={attachments}
              onRemove={removeAttachment}
              onRetry={retryImage}
            />

            {attachError && (
              <p className="px-3 pt-2 text-[11px] leading-4 text-danger">
                {attachError}
              </p>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                // Pasting a file (e.g. from a file manager) attaches it.
                const files = Array.from(e.clipboardData.files ?? []);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              placeholder={
                hasKeys
                  ? attachments.length > 0
                    ? "Add a question about these files…"
                    : "Type your message…"
                  : "Add your API keys in Settings to start chatting"
              }
              disabled={!hasKeys}
              rows={1}
              className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[15px] leading-6 text-text-primary placeholder-text-muted outline-none disabled:opacity-50"
            />

            <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0.5">
              {/* Uniform chips in a single row — scrolls instead of wrapping
                  on narrow resolutions, so spacing never breaks */}
              <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="chip"
                  data-active={attachments.length > 0}
                  title="Attach text files"
                  aria-label="Attach files"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                  {attachments.length > 0 && <span>{attachments.length}</span>}
                </button>

                <ModelSelector value={model} onChange={onSetModel} />

                <ThinkingEffortSelector
                  value={thinkingEffort}
                  onChange={onSetThinkingEffort}
                />

                <WebSearchToggle
                  value={webSearchMode}
                  onChange={onSetSearchMode}
                />

                <WorkspaceToggle
                  enabled={workspaceEnabled}
                  fileCount={workspaceFiles.length}
                  onToggle={onSetWorkspaceEnabled}
                  onOpenFiles={() => onOpenWorkspace()}
                />

                <button
                  onClick={onOpenPlugins}
                  className="chip"
                  data-active={enabledPlugins.length > 0}
                  title="Open plugins"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"
                    />
                  </svg>
                  <span>
                    Plugins
                    {enabledPlugins.length > 0
                      ? ` · ${enabledPlugins.length}`
                      : ""}
                  </span>
                </button>
              </div>

              {/* While generating, this becomes a Stop control — you can
                  interrupt a long answer and keep whatever arrived. */}
              {isLoading ? (
                <button
                  onClick={onStop}
                  className="send-btn stop-btn"
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!canSend}
                  data-enabled={canSend}
                  className="send-btn"
                  title="Send message"
                  aria-label="Send message"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 19V5M5 12l7-7 7 7"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <p className="mt-2.5 text-center text-[11px] leading-4 text-text-muted">
            Responses are generated by AI — verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  hasKeys,
  onOpenSettings,
  workspaceEnabled,
  onEnableWorkspace,
}: {
  hasKeys: boolean;
  onOpenSettings: () => void;
  workspaceEnabled: boolean;
  onEnableWorkspace: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 pb-16 sm:px-6">
      <div className="flex w-full max-w-xl flex-col items-center text-center animate-fade-in">
        <h1 className="font-serif text-[30px] sm:text-4xl font-medium leading-tight tracking-[-0.01em] text-text-primary">
          How can I help you today?
        </h1>

        {hasKeys ? (
          <>
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              Type a message below to start a conversation.
            </p>

            {/* Sized to its own content and centred under the heading. A
                one-line hint stretched to the full column reads as a banner
                rather than as a note. */}
            <div className="mt-7 inline-flex max-w-full items-center gap-2.5 rounded-full border border-border px-3.5 py-2 text-left">
              <span
                className={`flex-none ${
                  workspaceEnabled ? "text-accent-light" : "text-text-muted"
                }`}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                  />
                </svg>
              </span>
              <p className="min-w-0 text-[12px] leading-4 text-text-muted">
                {workspaceEnabled ? (
                  <>
                    <span className="text-text-secondary">Workspace is on.</span>{" "}
                    Ask for a file and it gets written to disk.
                  </>
                ) : (
                  <>
                    <span className="text-text-secondary">Workspace is off.</span>{" "}
                    Turn it on to have files written instead of printed.
                  </>
                )}
              </p>
              {!workspaceEnabled && (
                <button
                  onClick={onEnableWorkspace}
                  className="flex-none rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
                >
                  Turn on
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              Connect your DeepSeek API key to start chatting. Your keys stay
              in your browser — nothing leaves this app except your requests.
            </p>
            <div className="mt-6 flex justify-center">
              <button onClick={onOpenSettings} className="btn-primary">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                  />
                </svg>
                Add API keys
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Memoised message list.
 *
 * The composer's `input` state lives in ChatArea, so every keystroke
 * re-rendered this subtree. With 70 messages that meant re-parsing every
 * message's markdown on each character — measured at ~240ms — which is what
 * made typing feel laggy. This subtree now only re-renders when the messages
 * themselves change.
 */
/** How many recent messages to render before the user asks for more. */
const WINDOW_SIZE = 60;
/** How many additional messages each "load earlier" click reveals. */
const WINDOW_STEP = 60;

const MessageList = memo(function MessageList({
  messages,
  onRegenerate,
  onEdit,
  onDeleteMessage,
  searchQuery,
  searchWholeWord,
  searchIndex,
  activeMatch,
  revealAll,
  onOpenWorkspaceFile,
  onDecideCommand,
  onAnswerQuestion,
}: {
  messages: Message[];
  onRegenerate: (assistantId: string) => void;
  onEdit: (messageId: string, newContent: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onDecideCommand: (id: string, approved: boolean, remember: boolean) => void;
  onAnswerQuestion: (id: string, answer: string) => void;
  searchQuery?: string;
  searchWholeWord: boolean;
  searchIndex: ChatSearchIndex;
  activeMatch: number;
  revealAll: boolean;
}) {
  // Only the most recent slice is mounted. Rendering every bubble cost ~650ms
  // at 1000 messages and grew linearly, so a long conversation became slow to
  // open and to scroll. Older messages stay one click away and are still fully
  // searchable and exportable, since those read from disk rather than the DOM.
  const [limit, setLimit] = useState(WINDOW_SIZE);

  // A new conversation should start from the bottom again.
  const firstId = messages[0]?.id;
  const prevFirstId = useRef(firstId);
  useEffect(() => {
    if (prevFirstId.current !== firstId) {
      prevFirstId.current = firstId;
      setLimit(WINDOW_SIZE);
    }
  }, [firstId]);

  // While searching, mount everything from the earliest match onward so a hit
  // in an old message isn't hidden behind the "show earlier" control.
  const effectiveLimit =
    revealAll && searchIndex.firstMatchIndex >= 0
      ? Math.max(limit, messages.length - searchIndex.firstMatchIndex)
      : limit;

  const hidden = Math.max(0, messages.length - effectiveLimit);
  const visible = hidden > 0 ? messages.slice(hidden) : messages;
  const lastId = messages[messages.length - 1]?.id;

  // Map each visible message to where its matches start globally, so only the
  // bubble containing the focused match highlights it as active.
  const offsetById = new Map(
    searchIndex.entries.map((e) => [e.messageId, e] as const)
  );

  return (
    <>
      {hidden > 0 && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => setLimit((n) => n + WINDOW_STEP)}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 15l-6-6-6 6" />
            </svg>
            Show {Math.min(hidden, WINDOW_STEP)} earlier
            {hidden > WINDOW_STEP ? ` of ${hidden}` : ""}
          </button>
        </div>
      )}

      {visible.map((msg) => {
        const entry = offsetById.get(msg.id);
        const localActive =
          entry &&
          activeMatch >= entry.offset &&
          activeMatch < entry.offset + entry.count
            ? activeMatch - entry.offset
            : -1;
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            isLast={msg.id === lastId}
            onRegenerate={onRegenerate}
            onEdit={msg.role === "user" ? onEdit : undefined}
            onDelete={msg.role === "user" ? onDeleteMessage : undefined}
            searchQuery={searchQuery}
            searchWholeWord={searchWholeWord}
            activeMatchIndex={localActive}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onDecideCommand={onDecideCommand}
            onAnswerQuestion={onAnswerQuestion}
          />
        );
      })}
    </>
  );
});

const STAGE_LABELS: Record<StatusStage, string> = {
  deciding: "Checking if I need the web",
  searching: "Searching the web",
  thinking: "Thinking",
  writing: "Writing",
  working: "Working on your files",
};

/**
 * Bouncing-dots indicator. Sizes come from inline styles rather than custom
 * CSS classes so it renders correctly even if a stale stylesheet is served.
 */
function LoadingIndicator({
  stage,
  retryNotice,
}: {
  stage: StatusStage | null;
  retryNotice?: string | null;
}) {
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="flex flex-col gap-1 px-1 py-2">
        <div className="flex items-center gap-2.5">
          <span className="text-[#c96442]">
            <Dots size={5} />
          </span>
          <span className="animate-thinking text-xs text-[#a29d92]">
            {STAGE_LABELS[stage ?? "thinking"]}…
          </span>
        </div>
        {/* Shown rather than hidden: an unexplained pause reads as a freeze,
            and the point is that the work so far is not lost. */}
        {retryNotice && (
          <span className="pl-[18px] text-[11px] text-[#cfa25a]">
            {retryNotice}
          </span>
        )}
      </div>
    </div>
  );
}
