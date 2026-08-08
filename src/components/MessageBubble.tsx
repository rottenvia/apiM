"use client";

import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { ToolActivity } from "@/components/ToolActivity";
import { ApprovalPrompt } from "@/components/ApprovalPrompt";
import { QuestionPrompt } from "@/components/QuestionPrompt";
import { MessageTimeline } from "@/components/MessageTimeline";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, MessageAttachment } from "@/app/page";
import { ImageLightbox } from "@/components/ImageLightbox";
import { CompareVersions } from "@/components/CompareVersions";
import { buildSearchRegex } from "@/lib/chat-search";
import { estimateCost, formatCost, formatDuration } from "@/lib/pricing";
import { CodeBlock } from "@/components/CodeBlock";

/**
 * Render fenced code blocks with a language label and copy button.
 * Defined once at module scope so the object identity is stable across
 * renders and react-markdown doesn't rebuild its renderer each time.
 */
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * Build a react-markdown `components` map that highlights matches inside the
 * text of each rendered block.
 *
 * Highlighting has to happen per rendered element rather than around the
 * <ReactMarkdown> element itself: at that point the markdown has not been
 * parsed, so there are no text nodes to walk. The counter is shared across
 * every block so match numbering stays continuous down the message.
 */
function highlightingComponents(
  regex: RegExp,
  activeIndex: number
): Components {
  const counter = { n: 0 };
  const wrap = (Tag: keyof React.JSX.IntrinsicElements) => {
    const Highlighted = ({
      children,
      // react-markdown passes the mdast node through; forwarding it would
      // render node="[object Object]" as a DOM attribute.
      node: _node,
      ...props
    }: {
      children?: ReactNode;
      node?: unknown;
    }) => (
      <Tag {...props}>
        {highlightNode(children, regex, activeIndex, counter)}
      </Tag>
    );
    Highlighted.displayName = `Highlighted(${Tag})`;
    return Highlighted;
  };

  return {
    ...markdownComponents,
    p: wrap("p"),
    li: wrap("li"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    td: wrap("td"),
    th: wrap("th"),
    blockquote: wrap("blockquote"),
  };
}

/**
 * Wrap matches of `regex` in <mark> inside already-rendered markdown output.
 *
 * Operates on the rendered React tree rather than the raw source, so the
 * markdown is parsed normally first and highlighting can never corrupt it.
 * Code blocks are skipped: CodeBlock hands its content to the artifact panel
 * verbatim, and injecting elements there would break copy and download.
 */
function highlightNode(
  node: ReactNode,
  regex: RegExp,
  activeIndex: number,
  counter: { n: number },
  key = 0
): ReactNode {
  if (typeof node === "string") {
    regex.lastIndex = 0;
    if (!regex.test(node)) return node;
    regex.lastIndex = 0;

    const parts: ReactNode[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(node)) !== null) {
      if (match.index > cursor) parts.push(node.slice(cursor, match.index));
      const isActive = counter.n === activeIndex;
      parts.push(
        <mark
          key={`${key}-${match.index}`}
          data-active-match={isActive || undefined}
          className={
            isActive
              ? "rounded-[3px] bg-[#c96442] px-0.5 text-white"
              : "rounded-[3px] bg-[#c96442]/25 px-0.5 text-[#ede9e2]"
          }
        >
          {match[0]}
        </mark>
      );
      counter.n += 1;
      cursor = match.index + match[0].length;
      if (match[0].length === 0) break;
    }

    if (cursor < node.length) parts.push(node.slice(cursor));
    return parts;
  }

  if (Array.isArray(node)) {
    return node.map((child, i) =>
      highlightNode(child, regex, activeIndex, counter, i)
    );
  }

  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    // Leave code blocks untouched.
    if (element.type === CodeBlock) return node;

    const children = element.props?.children;
    if (children === undefined) return node;

    return cloneElement(element, {
      children: highlightNode(children, regex, activeIndex, counter, key),
    });
  }

  return node;
}

/**
 * Bouncing dots. Sized inline so they render correctly regardless of CSS
 * loading order, and small enough not to dominate the row.
 */
export function Dots({ size = 5 }: { size?: number }) {
  return (
    <span className="inline-flex flex-none items-end gap-[3px]" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="animate-bounce rounded-full bg-current"
          style={{ width: size, height: size, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

interface MessageBubbleProps {
  message: Message;
  /** Only the newest reply offers regenerate, to avoid rewriting history. */
  isLast?: boolean;
  onRegenerate?: (assistantId: string) => void;
  /** Continue an interrupted reply instead of redoing it. */
  onResume?: (assistantId: string) => void;
  /** Resend a user message with edited text, replacing everything after it. */
  onEdit?: (messageId: string, newContent: string) => void;
  /** Remove a message and the reply that followed it. */
  onDelete?: (messageId: string) => void;
  /** Active in-chat search term, highlighted in the reply text. */
  searchQuery?: string;
  searchWholeWord?: boolean;
  /** Global index of the focused match, or -1 when the term is elsewhere. */
  activeMatchIndex?: number;
  /** Opens the workspace panel at a file the assistant changed. */
  onOpenWorkspaceFile?: (path: string) => void;
  /** Answers a pending command approval. */
  onDecideCommand?: (id: string, approved: boolean, remember: boolean) => void;
  /** Answers a question the model asked. */
  onAnswerQuestion?: (id: string, answer: string) => void;
}

function MessageBubbleImpl({
  message,
  isLast,
  onRegenerate,
  onResume,
  onEdit,
  onDelete,
  searchQuery,
  searchWholeWord = true,
  activeMatchIndex = -1,
  onOpenWorkspaceFile,
  onDecideCommand,
  onAnswerQuestion,
}: MessageBubbleProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [followThinking, setFollowThinking] = useState(true);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const [previewImage, setPreviewImage] = useState<MessageAttachment | null>(
    null
  );
  const [comparing, setComparing] = useState(false);
  const [showInterrupted, setShowInterrupted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const thinkingRef = useRef<HTMLDivElement>(null);
  const isUser = message.role === "user";

  /**
   * Whether to show the split view.
   *
   * Only worth it when actions and narration are actually interleaved — a
   * reply that is purely prose, or one where every tool ran before a single
   * closing paragraph, reads better as one column. Searching also falls back,
   * since highlighting is applied by the flat renderer.
   */
  const useTimeline = Boolean(
    message.timeline &&
      message.timeline.length > 1 &&
      message.toolEvents?.length &&
      !searchQuery
  );

  // Label-only signal that reasoning is still in progress. The panel itself
  // stays closed unless the user opens it, so nothing expands and collapses
  // underneath them mid-answer.
  const isThinkingPhase = Boolean(
    message.isStreaming && message.reasoningContent && !message.content
  );

  // Keep the reasoning panel pinned to the newest text while "Follow" is on.
  useEffect(() => {
    if (!followThinking || !showThinking) return;
    const el = thinkingRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [message.reasoningContent, followThinking, showThinking]);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    } catch {
      /* clipboard unavailable on non-secure origins */
    }
  };

  const searchRegex = useMemo(
    () => (searchQuery ? buildSearchRegex(searchQuery, searchWholeWord) : null),
    [searchQuery, searchWholeWord]
  );

  const sourceCount = message.searchResults?.length ?? 0;

  const cost = useMemo(
    () => estimateCost(message.usage, message.model ?? ""),
    [message.usage, message.model]
  );

  const searchTooltip = useMemo(() => {
    const parts: string[] = [];
    if (message.searchReason) parts.push(`Searched because: ${message.searchReason}`);
    if (message.searchRounds && message.searchRounds > 1) {
      parts.push(`${message.searchRounds} rounds`);
    }
    if (message.searchStopReason) parts.push(message.searchStopReason);
    if (message.searchCacheHits) {
      parts.push(`${message.searchCacheHits} reused from cache`);
    }
    return parts.join(" · ") || undefined;
  }, [
    message.searchReason,
    message.searchRounds,
    message.searchStopReason,
    message.searchCacheHits,
  ]);
  const hasMeta = Boolean(
    (message.thinkingEffort && message.thinkingEffort !== "none") ||
      message.tokenCount ||
      message.durationMs ||
      message.searchUsd
  );

  // Detect a code fence that has been opened but not yet closed. An odd number
  // of ``` markers means the model is mid-block, so we hide the partial code
  // and show a progress card instead of streaming raw source into the chat.
  const { displayContent, hasPendingCode, pendingLanguage, pendingLines } =
    useMemo(() => {
      const content = message.content ?? "";
      if (!message.isStreaming) {
        return {
          displayContent: content,
          hasPendingCode: false,
          pendingLanguage: null as string | null,
          pendingLines: 0,
        };
      }

      const fenceMatches = content.match(/^```/gm);
      const openFence = (fenceMatches?.length ?? 0) % 2 === 1;
      if (!openFence) {
        return {
          displayContent: content,
          hasPendingCode: false,
          pendingLanguage: null as string | null,
          pendingLines: 0,
        };
      }

      const lastFence = content.lastIndexOf("\n```");
      const cut = lastFence === -1 ? content.indexOf("```") : lastFence + 1;
      const before = content.slice(0, cut);
      const block = content.slice(cut);
      const langMatch = /^```([\w+-]*)/.exec(block);

      return {
        displayContent: before.trimEnd(),
        hasPendingCode: true,
        pendingLanguage: langMatch?.[1] ? langMatch[1] : null,
        pendingLines: Math.max(0, block.split("\n").length - 1),
      };
    }, [message.content, message.isStreaming]);

  return (
    <div
      className={`animate-fade-in ${isUser ? "flex justify-end" : "flex justify-start"}`}
    >
      <div
        className={`max-w-[85%] md:max-w-[75%] ${
          isUser
            ? "rounded-2xl bg-bg-elevated px-4 py-2.5"
            : "bg-transparent px-4"
        }`}
      >
        {/* User message */}
        {isUser && (
          <div className="space-y-2">
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {message.attachments.map((file, i) =>
                  file.kind === "image" && file.dataUrl ? (
                    <button
                      key={i}
                      onClick={() => setPreviewImage(file)}
                      title={`${file.name} — click to enlarge`}
                      className="overflow-hidden rounded-lg border border-border transition-transform hover:scale-[1.03]"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={file.dataUrl}
                        alt={file.name}
                        className="h-24 w-auto max-w-[12rem] object-cover"
                      />
                    </button>
                  ) : (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-secondary/60 px-2 py-1 text-xs text-text-secondary"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
                      </svg>
                      {file.name}
                    </span>
                  )
                )}
              </div>
            )}

            {editing ? (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(false);
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim()) {
                        onEdit?.(message.id, draft.trim());
                        setEditing(false);
                      }
                    }
                  }}
                  autoFocus
                  rows={Math.min(10, draft.split("\n").length + 1)}
                  className="w-full resize-y rounded-lg border border-accent/40 bg-bg-primary px-3 py-2 text-[15px] leading-6 text-text-primary outline-none"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-lg px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (!draft.trim()) return;
                      onEdit?.(message.id, draft.trim());
                      setEditing(false);
                    }}
                    disabled={!draft.trim()}
                    className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-light disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
              </div>
            ) : (
              message.content && (
                <div className="group/msg relative">
                  <div className="text-[15px] leading-6 text-text-primary">
                    <SearchHighlight
                      query={searchQuery}
                      wholeWord={searchWholeWord}
                      activeIndex={activeMatchIndex}
                    >
                      {message.content}
                    </SearchHighlight>
                  </div>

                  {(onEdit || onDelete) && (
                    <div className="grid grid-rows-[0fr] opacity-0 transition-all duration-150 focus-within:grid-rows-[1fr] focus-within:opacity-100 group-hover/msg:grid-rows-[1fr] group-hover/msg:opacity-100">
                      <div className="overflow-hidden">
                        <div className="mt-1 flex items-center justify-between gap-2">
                      {onEdit && (
                        <button
                          onClick={() => {
                            setDraft(message.content);
                            setEditing(true);
                          }}
                          title="Edit and resend"
                          aria-label="Edit message"
                          className="flex h-6 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          Edit
                        </button>
                      )}

                      {onDelete && (
                        <button
                          onClick={() => onDelete(message.id)}
                          title="Delete this message and its reply"
                          aria-label="Delete message"
                          className="flex h-6 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-danger/12 hover:text-danger"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
                          </svg>
                          Delete
                        </button>
                      )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        )}

        {comparing && (message.previousVersions?.length ?? 0) > 0 && (
          <CompareVersions
            versions={[
              ...(message.previousVersions ?? []).map((v, i) => ({
                ...v,
                label: `Version ${i + 1}`,
              })),
              {
                content: message.content,
                model: message.model,
                createdAt: message.createdAt,
                label: "Current",
              },
            ]}
            onClose={() => setComparing(false)}
          />
        )}

        {previewImage?.dataUrl && (
          <ImageLightbox
            src={previewImage.dataUrl}
            name={previewImage.name}
            onClose={() => setPreviewImage(null)}
          />
        )}

        {/* Assistant message */}
        {!isUser && (
          <div className="space-y-3">
            {/* Compact meta row — small pills, not full-width slabs */}
            {(hasMeta || sourceCount > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {message.thinkingEffort &&
                  message.thinkingEffort !== "none" && (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-[#cfa25a]/25 bg-[#cfa25a]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#cfa25a]">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z" />
                      </svg>
                      {message.thinkingEffort}
                    </span>
                  )}

                {/* Search reason lives on the sources pill — the control it
                    explains — rather than as another separate badge. */}
                {sourceCount > 0 && (
                  <button
                    onClick={() => setShowSources((v) => !v)}
                    aria-expanded={showSources}
                    title={searchTooltip}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#6ba3a0]/25 bg-[#6ba3a0]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#6ba3a0] transition-colors hover:bg-[#6ba3a0]/20"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <circle cx="11" cy="11" r="8" />
                      <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                    </svg>
                    {sourceCount} {sourceCount === 1 ? "source" : "sources"}
                    <svg
                      width="8" height="8" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={3} aria-hidden="true"
                      className={`transition-transform duration-150 ${showSources ? "rotate-180" : ""}`}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                )}

                {message.tokenCount ? (
                  <span
                    className="text-[11px] text-[#6d685d]"
                    title={
                      message.usage
                        ? `${(message.usage.prompt_tokens ?? 0).toLocaleString()} in · ${(message.usage.completion_tokens ?? 0).toLocaleString()} out`
                        : undefined
                    }
                  >
                    {message.tokenCount.toLocaleString()} tokens
                  </span>
                ) : null}

                {cost !== null && (
                  <span
                    className="text-[11px] text-[#6d685d]"
                    title={`Estimated from ${message.model ?? "model"} pricing`}
                  >
                    {formatCost(cost)}
                  </span>
                )}

                {/* Search is billed separately from the model, so it gets its
                    own figure rather than being folded into the token cost. */}
                {message.searchUsd ? (
                  <span
                    className="text-[11px] text-[#6d685d]"
                    title={
                      message.searchCacheHits
                        ? `Web search, estimated · ${message.searchCacheHits} query(s) reused from cache at no cost`
                        : "Web search, estimated"
                    }
                  >
                    +{formatCost(message.searchUsd)} search
                  </span>
                ) : null}

                {message.durationMs ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-[#6d685d]"
                    title="Time from sending to the last token"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path strokeLinecap="round" d="M12 7v5l3 2" />
                    </svg>
                    {formatDuration(message.durationMs)}
                  </span>
                ) : null}
              </div>
            )}

            {/* Sources list — opened from the pill above */}
            {showSources && sourceCount > 0 && (
              <div className="animate-fade-in space-y-0.5 rounded-xl border border-[#6ba3a0]/20 bg-[#141210]/60 p-1.5">
                {message.searchResults!.map((result, i) => (
                  <a
                    key={i}
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[#33302a]"
                  >
                    <span className="flex h-4 w-4 flex-none items-center justify-center rounded bg-[#6ba3a0]/15 text-[9px] font-bold text-[#6ba3a0]">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[#ede9e2] transition-colors group-hover:text-[#6ba3a0]">
                        {result.title}
                      </span>
                      <span className="block truncate text-[11px] text-[#6d685d]">
                        {result.domain}
                      </span>
                    </span>
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2} aria-hidden="true"
                      className="flex-none text-[#6d685d] opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                ))}
              </div>
            )}

            {/* Reasoning. The header shows live dots while the model is
                still thinking, and a follow/free-scroll toggle controls
                whether the panel tracks the incoming text. */}
            {message.reasoningContent && (
              <div
                data-thinking={isThinkingPhase}
                className="thinking-panel thinking-shell overflow-hidden rounded-lg"
              >
                {/* The box and the amber arrive, rather than appearing.
                    
                    Previously the row was plain text one frame and a filled
                    amber panel the next, which is the jump that read as a
                    glitch. Border, background and text colour now all ease
                    from transparent over the same 0.3s, so the label starts
                    as ordinary metadata and warms into the panel — the change
                    is legible as a transition rather than a repaint. */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowThinking((v) => !v)}
                    aria-expanded={showThinking}
                    className="thinking-toggle flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left font-sans text-[13px] font-medium leading-5"
                  >
                    <svg
                      width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2.2} aria-hidden="true"
                      className={`flex-none transition-transform duration-150 ${showThinking ? "rotate-90" : ""}`}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="truncate">Thinking</span>
                  </button>

                  {/* Only while reasoning is actually arriving.
                      
                      It used to be tied to `message.isStreaming`, so it stayed
                      on screen through the whole reply — long after the
                      reasoning had stopped updating. Toggling it then did
                      nothing at all, which is what made it feel broken: the
                      control was live but the thing it controlled had
                      finished. The right-hand margin also read as misaligned
                      because it was 8px against the label's 12px padding; both
                      edges now match. */}
                  {showThinking && isThinkingPhase && (
                    <button
                      onClick={() => setFollowThinking((v) => !v)}
                      title={
                        followThinking
                          ? "Following the text — click to scroll freely"
                          : "Scrolling freely — click to follow the text"
                      }
                      aria-pressed={followThinking}
                      className={`mr-3 flex h-6 flex-none items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors ${
                        followThinking
                          ? "bg-[#cfa25a]/20 text-[#cfa25a]"
                          : "text-[#cfa25a]/55 hover:bg-[#cfa25a]/10 hover:text-[#cfa25a]"
                      }`}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                      </svg>
                      {followThinking ? "Follow" : "Free"}
                    </button>
                  )}
                </div>

                {/* A hairline under the label while reasoning is arriving.
                    
                    Bouncing dots read as a stalled spinner — motion that
                    repeats forever says "waiting", not "working". A bar that
                    sweeps once and fades is closer to progress, and because
                    it is one pixel of low-contrast colour it registers
                    without competing with the reply. */}
                {isThinkingPhase && (
                  <span
                    className="thinking-line"
                    aria-hidden="true"
                  />
                )}

                {/* Always mounted, so the body can animate its height open
                    and shut. Rendering it only when open meant the text
                    appeared instantly at full size with nothing to ease. */}
                <div className="thinking-body" data-open={showThinking}>
                  <div>
                    <div
                      ref={thinkingRef}
                      aria-hidden={!showThinking}
                      className="thinking-body-text max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2.5 font-sans text-[13px] leading-5 [overscroll-behavior:contain]"
                    >
                      {message.reasoningContent}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Reply was cut short — offer to retry rather than leaving a
                silently truncated answer looking complete. */}
            {message.incomplete && !message.isStreaming && (
              <div className="flex items-center gap-2.5 rounded-xl border border-[#cfa25a]/25 bg-[#cfa25a]/8 px-3 py-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true" className="flex-none text-[#cfa25a]">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <button
                  onClick={() => setShowInterrupted((v) => !v)}
                  className="min-w-0 flex-1 text-left text-[12px] leading-snug text-[#cfa25a] hover:underline"
                >
                  {/* The reason, when there is one. "Insufficient balance"
                      is far more use than a generic "interrupted", and it
                      tells the user the one thing they have to fix before
                      Continue will work. */}
                  {message.errorNotice ?? "This reply was interrupted"}
                  {message.content ? (
                    <span className="ml-1 opacity-70">
                      · {showInterrupted ? "hide" : "show"} what arrived
                    </span>
                  ) : null}
                </button>
                {/* Continue is offered first, and styled as the primary
                    action, because it is nearly always the right one: it
                    keeps every file already written and every result already
                    gathered, and pays only for the rounds still left. Start
                    over throws all of that away and buys the same work twice,
                    so it stays available but quiet. */}
                {onResume && message.canResume && (
                  <button
                    onClick={() => onResume(message.id)}
                    title="Carry on from where it stopped, keeping the work already done"
                    className="flex-none rounded-lg bg-[#cfa25a]/20 px-2 py-1 text-[11px] font-medium text-[#cfa25a] transition-colors hover:bg-[#cfa25a]/30"
                  >
                    Continue
                  </button>
                )}
                {onRegenerate && (
                  <button
                    onClick={() => onRegenerate(message.id)}
                    title={
                      message.canResume
                        ? "Discard what was done and answer again from scratch"
                        : "Answer again from the beginning"
                    }
                    className="flex-none rounded-lg border border-[#cfa25a]/30 px-2 py-1 text-[11px] font-medium text-[#cfa25a] transition-colors hover:bg-[#cfa25a]/15"
                  >
                    {message.canResume ? "Start over" : "Try again"}
                  </button>
                )}
              </div>
            )}

            {/* File operations, above the reply: they happen before the
                model summarises them, so this matches the real order.
                Skipped when a timeline exists, which renders them in place
                beside the sentence each one belongs to. */}
            {!useTimeline &&
              message.toolEvents &&
              message.toolEvents.length > 0 && (
                <ToolActivity
                  events={message.toolEvents}
                  onOpenFile={onOpenWorkspaceFile}
                />
              )}

            {message.pendingQuestion && onAnswerQuestion && (
              <QuestionPrompt
                pending={message.pendingQuestion}
                onAnswer={onAnswerQuestion}
              />
            )}

            {message.pendingCommand && onDecideCommand && (
              <ApprovalPrompt
                pending={message.pendingCommand}
                onDecide={onDecideCommand}
              />
            )}

            {useTimeline && (
              <MessageTimeline
                timeline={message.timeline ?? []}
                toolEvents={message.toolEvents ?? []}
                onOpenFile={onOpenWorkspaceFile}
                markdownComponents={markdownComponents}
              />
            )}

            {/* Main content. While streaming, an unterminated ``` fence is
                replaced by a placeholder card — watching code type itself line
                by line is noisy, and half-written markup renders as garbage. */}
            {!useTimeline &&
              (displayContent || !message.isStreaming) &&
              !(message.incomplete && !message.isStreaming && !showInterrupted) && (
              <div
                className={`prose-chat text-[15px] leading-relaxed ${
                  message.isError
                    ? "text-danger"
                    : message.incomplete
                      ? "text-text-secondary"
                      : "text-text-primary"
                }`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={
                    searchRegex
                      ? highlightingComponents(searchRegex, activeMatchIndex)
                      : markdownComponents
                  }
                >
                  {displayContent}
                </ReactMarkdown>
                {message.isStreaming && displayContent && !hasPendingCode && (
                  <span className="stream-caret" aria-hidden="true" />
                )}
              </div>
            )}

            {/* Placeholder while a code block is still being generated */}
            {hasPendingCode && (
              <div className="my-3 flex w-full items-center gap-3 rounded-xl border border-[#2c2924] bg-[#141210] px-3 py-2.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[#2a2723] text-[#d97f5d]">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    aria-hidden="true"
                    className="animate-pulse"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l-3 3 3 3m8-6l3 3-3 3M13.5 6l-3 12" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-[#ede9e2]">
                    {pendingLanguage
                      ? `Writing ${pendingLanguage}…`
                      : "Writing code…"}
                  </span>
                  <span className="text-[11px] text-[#6d685d]">
                    {pendingLines} {pendingLines === 1 ? "line" : "lines"} so far
                  </span>
                </span>
                <span className="flex-none text-[#c96442]">
                  <Dots size={4} />
                </span>
              </div>
            )}

            {/* Actions on the newest completed reply */}
            {isLast &&
              !message.isStreaming &&
              !message.isError &&
              message.content && (
                <div className="flex items-center gap-1 pt-0.5">
                  <button
                    onClick={copyMessage}
                    title="Copy reply"
                    className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-[#6d685d] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
                  >
                    {copiedMessage ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7ba478" strokeWidth={2.2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                        </svg>
                        <span className="text-[#7ba478]">Copied</span>
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>

                  {(message.previousVersions?.length ?? 0) > 0 && (
                    <button
                      onClick={() => setComparing(true)}
                      title="Compare with the previous reply"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-[#d97f5d] transition-colors hover:bg-[#c96442]/12"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      Compare
                      <span className="text-[#6d685d]">
                        {(message.previousVersions?.length ?? 0) + 1}
                      </span>
                    </button>
                  )}

                  {onRegenerate && (
                    <button
                      onClick={() => onRegenerate(message.id)}
                      title="Generate a different reply"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-[#6d685d] transition-colors hover:bg-[#33302a] hover:text-[#ede9e2]"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2" />
                      </svg>
                      Regenerate
                    </button>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Applies highlighting to plain text (user bubbles, which are not markdown).
 */
function SearchHighlight({
  query,
  wholeWord,
  activeIndex,
  children,
}: {
  query?: string;
  wholeWord: boolean;
  activeIndex: number;
  children: ReactNode;
}) {
  const regex = useMemo(
    () => (query ? buildSearchRegex(query, wholeWord) : null),
    [query, wholeWord]
  );

  if (!regex) return <>{children}</>;
  return <>{highlightNode(children, regex, activeIndex, { n: 0 })}</>;
}

/**
 * Memoised so typing in the composer doesn't re-render the whole transcript.
 *
 * Re-parsing markdown for every message on each keystroke cost ~240ms at 70
 * messages, which is what made typing feel laggy in long chats. Only the
 * fields that affect rendering are compared; the streaming message still
 * updates because its content changes on every frame.
 */
export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  const a = prev.message;
  const b = next.message;
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.reasoningContent === b.reasoningContent &&
    a.isStreaming === b.isStreaming &&
    a.isError === b.isError &&
    a.incomplete === b.incomplete &&
    a.canResume === b.canResume &&
    a.errorNotice === b.errorNotice &&
    a.tokenCount === b.tokenCount &&
    a.thinkingEffort === b.thinkingEffort &&
    a.searchResults === b.searchResults &&
    a.attachments === b.attachments &&
    a.usage === b.usage &&
    a.durationMs === b.durationMs &&
    a.previousVersions === b.previousVersions &&
    // New array identity on every tool frame, so this is what makes the
    // "Writing app.py" lines appear as they happen.
    a.toolEvents === b.toolEvents &&
    a.timeline === b.timeline &&
    a.pendingCommand === b.pendingCommand &&
    a.pendingQuestion === b.pendingQuestion &&
    prev.isLast === next.isLast &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onResume === next.onResume &&
    prev.onEdit === next.onEdit &&
    prev.onDelete === next.onDelete &&
    prev.searchQuery === next.searchQuery &&
    prev.searchWholeWord === next.searchWholeWord &&
    prev.activeMatchIndex === next.activeMatchIndex &&
    prev.onOpenWorkspaceFile === next.onOpenWorkspaceFile &&
    prev.onDecideCommand === next.onDecideCommand &&
    prev.onAnswerQuestion === next.onAnswerQuestion
  );
});
