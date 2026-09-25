"use client";

import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
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
import {
  estimateCost,
  formatCost,
  formatDuration,
  reasoningTokens,
} from "@/lib/pricing";
import { CodeBlock } from "@/components/CodeBlock";
import { PlanPanel } from "@/components/PlanPanel";
import type { PlanView } from "@/components/PlanPanel";
import { normalisePlanStepText } from "@/lib/plan-view";
import { MODELS } from "@/lib/models";

/**
 * Render fenced code blocks with a language label and copy button.
 * Defined once at module scope so the object identity is stable across
 * renders and react-markdown doesn't rebuild its renderer each time.
 */
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * The parsed markdown of one reply.
 *
 * Parsing is the single expensive part of rendering a message, and nothing
 * about it depends on anything except the text itself and whether a find bar
 * is open. Wrapping it in memo() means unrelated re-renders of the bubble
 * (meta changes, other prop updates) never re-parse, and during an in-chat
 * search only messages that actually contain the term are re-parsed at all.
 */
const MarkdownBody = memo(function MarkdownBody({
  content,
  regex,
  plain,
}: {
  content: string;
  regex: RegExp | null;
  /** Render as a plain <div> — no markdown parse, no virtual DOM beyond one
   * text node. Used by MessageList's progressive hydration: bubbles outside
   * the initially visible viewport paint instantly as text and upgrade
   * (plain flips off) in idle slices, so opening a fat chat never carries
   * the whole parse in one commit. Mutually exclusive with `regex` by
   * construction: deferred bubbles never receive a search query. */
  plain?: boolean;
}) {
  // Rebuilt only when the query changes — not when the focused match moves
  // (that is handled by flipping data-active-match on the existing marks).
  const components = useMemo<Components>(
    () => (regex ? highlightingComponents(regex) : markdownComponents),
    [regex]
  );
  if (plain) {
    return <div className="whitespace-pre-wrap">{content}</div>;
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
});

/**
 * Build a react-markdown `components` map that highlights matches inside the
 * text of each rendered block.
 *
 * Highlighting has to happen per rendered element rather than around the
 * <ReactMarkdown> element itself: at that point the markdown has not been
 * parsed, so there are no text nodes to walk. The counter is shared across
 * every block so match numbering stays continuous down the message.
 *
 * Deliberately keyed by the regex ALONE. The map (and therefore the whole
 * markdown re-parse) used to be rebuilt whenever the focused match moved on
 * next/prev; the focused match is now flipped by flipping a DOM attribute,
 * so pressing Enter to step through results never re-parses anything.
 */
function highlightingComponents(regex: RegExp): Components {
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
    }) => <Tag {...props}>{highlightNode(children, regex, counter)}</Tag>;
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
 * Flip the `data-active-match` attribute on this bubble's marks to follow
 * the focused result.
 *
 * Match numbering (counter.n) is baked into the DOM at parse time. Moving the
 * focus used to mean a new components map and a full markdown re-parse of
 * every visible bubble; marking the DOM directly is microseconds and keeps
 * next/prev buttery even in a megabyte conversation.
 */
function markActiveHit(root: HTMLElement | null, activeIndex: number) {
  if (!root) return;
  const marks = root.querySelectorAll<HTMLElement>(".search-hit");
  marks.forEach((el) => {
    if (el.dataset.matchN === String(activeIndex)) {
      el.setAttribute("data-active-match", "");
    } else {
      el.removeAttribute("data-active-match");
    }
  });
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
      parts.push(
        <mark
          key={`${key}-${match.index}`}
          data-match-n={counter.n}
          className="search-hit rounded-[3px] px-0.5"
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
      highlightNode(child, regex, counter, i)
    );
  }

  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    // Leave code blocks untouched.
    if (element.type === CodeBlock) return node;

    const children = element.props?.children;
    if (children === undefined) return node;

    return cloneElement(element, {
      children: highlightNode(children, regex, counter, key),
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

/**
 * "12s", "3m 04s" — the finished thinking label ("Thought for 12s").
 *
 * Fed by the server's first-to-last reasoning-token span, so it measures
 * thought rather than network. Rounds to whole seconds; a sub-second think
 * still reads as 1s, because "Thought for 0s" would look broken.
 */
function formatThoughtTime(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * "12.4k" / "860" — thinking volume in the header. Live it is estimated from
 * characters (~4 per token); finished it is the billed reasoning count.
 */
function formatThinkTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.max(0, Math.round(n))}`;
}

/**
 * Ticking seconds beside the live "Thinking" label.
 *
 * The status row's clock unmounts at the first token, so a reasoning stream
 * that stalls mid-thought used to sit frozen with no liveness signal at
 * all — "stuck at thinking, don't know why". This mounts fresh on each
 * thinking phase, so it reads as the CURRENT stall, not the run total:
 * tokens moving means alive, clock ticking over frozen text means stalled.
 * No synchronous setState — the interval callback is the only writer, so
 * the mount never trips the set-state-in-effect rule.
 */
function ThinkingClock() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span
      className="tabular-nums"
      title="Wall-clock in this thinking phase — if the text below is frozen while this ticks, the stream has stalled"
    >
      {` · ${seconds}s`}
    </span>
  );
}

interface MessageBubbleProps {
  message: Message;
  /** Only the newest reply offers regenerate, to avoid rewriting history. */
  isLast?: boolean;
  /** Render the body as instant plain text; MessageList flips this off in
   * idle slices to upgrade the bubble to full markdown (progressive
   * hydration — see MarkdownBody's `plain`). */
  deferred?: boolean;
  onRegenerate?: (assistantId: string) => void;
  /** Continue an interrupted reply instead of redoing it. */
  /**
   * Continue an interrupted reply.
   *
   * `model` overrides which model finishes it — the saved transcript is just
   * messages, so a run that stalled on Pro can be finished on Flash.
   */
  onResume?: (assistantId: string, model?: string) => void;
  /** Called the first time the reasoning panel is opened. */
  onLoadReasoning?: (messageId: string) => void;
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
  /** Reopen blocked plan steps on disk. */
  onUnblockPlan?: () => void;
  /** Delete the saved plan on disk. */
  onClearPlan?: () => void;
}

function MessageBubbleImpl({
  message,
  isLast,
  deferred,
  onRegenerate,
  onResume,
  onLoadReasoning,
  onEdit,
  onDelete,
  searchQuery,
  searchWholeWord = true,
  activeMatchIndex = -1,
  onOpenWorkspaceFile,
  onDecideCommand,
  onAnswerQuestion,
  onUnblockPlan,
  onClearPlan,
}: MessageBubbleProps) {
  /**
   * Whether this bubble was born as the live reply.
   *
   * A live panel must stay a BOX after prose begins and after the stream ends.
   * Collapsing it on the first answer token is exactly the reported "thinking
   * is a line" regression: the text technically existed, but disappeared
   * before there was time to read it. Capturing this once gives the useful
   * distinction we actually need:
   *
   * - a reply watched live stays expanded so its reasoning remains readable;
   * - a reply mounted later from chat history starts compact, and opens on
   *   request.
   *
   * A click still wins permanently through `userSetThinking` below.
   */
  const [startedLive] = useState(() => Boolean(message.isStreaming));
  // Latches true once this bubble is observed streaming. Leaving/returning to
  // the site and pressing Resume flips isStreaming to true on a bubble that
  // mounted as a completed (non-live) message; without this the thinking
  // panel never auto-opens for the continuation and the existing reasoning
  // appears to vanish until manually expanded.
  const wentLiveRef = useRef(startedLive);
  if (message.isStreaming) wentLiveRef.current = true;
  const wentLive = wentLiveRef.current;
  const [userSetThinking, setUserSetThinking] = useState<boolean | null>(null);

  /*
   * Detect while reasoning is arriving — which is NOT the same as "before the
   * answer starts".
   *
   * The previous rule was `isStreaming && !message.content`, and it was wrong
   * in a way that only shows up against a real reply. Measured by replaying
   * actual frames through this logic: the stream sends meta, then reasoning,
   * then content — and the very first content token flips `!message.content`
   * to false. So the panel was open for exactly ONE frame and then slammed
   * shut, which is why it reads as a line that flashes and disappears.
   *
   * Reported twice. My first fix mounted the panel earlier, which was a real
   * bug too, but it was not this one: mounting it does no good if it closes a
   * moment later.
   *
   * The honest signal is whether reasoning is still GROWING. DeepSeek streams
   * reasoning and content in that order, so once the reasoning stops
   * lengthening it is genuinely finished, whatever else is arriving. A ref
   * holds the last length seen — comparing during render rather than storing
   * derived state, so there is still no effect to keep in step.
   */
  const reasoningLen = message.reasoningContent?.length ?? 0;
  /*
   * How much reasoning there is, for the collapsed label.
   *
   * A stored chat sends only the length and fetches the body on demand, so
   * both sources have to be considered or an old chat shows nothing.
   */
  const reasoningChars = reasoningLen || message.reasoningLength || 0;
  const thinkingRequested = Boolean(
    message.thinkingEffort && message.thinkingEffort !== "none"
  );
  /*
   * The panel represents the configured thinking mode, not only text that
   * happened to arrive.
   *
   * The previous gate included `message.isStreaming`, so a high-effort reply
   * with no `reasoning_content` vanished as soon as `done` changed that flag
   * to false. The screenshot then showed the timeline's divider and fetch_url
   * with no thinking control anywhere. If DeepSeek returns no trace, keep the
   * box and say so; absence of data must not masquerade as absence of UI.
   */
  const hasThinking = reasoningChars > 0 || thinkingRequested;

  /*
   * Which stream is arriving right now — reasoning or prose.
   *
   * The old rule latched "done" the first frame prose appeared and never
   * un-latched. That was right for DeepSeek, which streams reasoning then
   * prose and never goes back — but the high-effort models INTERLEAVE:
   * reasoning, prose, more reasoning. On those, the first prose token grayed
   * the box and dropped the Follow/Free control while reasoning was still
   * streaming. Reported as "the buttons disappear and the box goes gray".
   *
   * The honest signal is which of the two streams grew LAST. During a
   * reasoning burst the box is live (amber, Follow/Free usable, because new
   * reasoning text is arriving); during a prose burst it rests. Bursts are
   * runs of many tokens, not per-token alternation, so the state changes at
   * burst boundaries — no flicker.
   *
   * A ref compared during render, as before: it must not schedule its own
   * re-render, and the value is read in the same render that set it.
   */
  const contentLen = message.content?.length ?? 0;
  const arriveRef = useRef<{
    r: number;
    c: number;
    last: "reasoning" | "content" | null;
  } | null>(null);
  /*
   * When the most recent text arrived. The inter-round gap — the host
   * reading tool results back, then prefilling — has no events at all, so
   * without this the bubble can only guess from "has it EVER streamed".
   * This state flips false ~1.5s after the last token, which is what the
   * "reading results" indicator below keys off. The interval runs only on
   * live bubbles and costs one render a second while streaming.
   *
   * Time alone cannot tell the true between-rounds gap from a quiet spell
   * inside a long think (reasoning tokens arrive in sparse bursts, with
   * gaps well over 1.5s). `lastActivityRef` therefore also records WHAT
   * arrived last: the "reading results" row is only honest when tools have
   * all finished and nothing of the next round has started yet. Labeling a
   * mid-think pause "reading results" is what made long thinking look
   * frozen on that row.
   */
  const [streamIdle, setStreamIdle] = useState(false);
  const lastArrivalRef = useRef(Date.now());
  const lastActivityRef = useRef<"text" | "toolsDone" | null>(null);
  useEffect(() => {
    lastArrivalRef.current = Date.now();
    // Any reasoning or prose means a round is actively producing; the model
    // is thinking or writing, not sitting between rounds.
    lastActivityRef.current = "text";
    setStreamIdle(false);
  }, [message.reasoningContent, message.content]);
  const toolEventCount = message.toolEvents?.length ?? 0;
  const resolvedToolCount =
    message.toolEvents?.filter((e) => e.ok !== undefined).length ?? 0;
  // When a tool result lands (and no text has arrived since), we are at the
  // end of a round's tool work. Keyed on the RESOLVED count so a new call
  // starting does not mark the round finished.
  useEffect(() => {
    if (resolvedToolCount === 0) return;
    lastArrivalRef.current = Date.now();
    lastActivityRef.current = "toolsDone";
    setStreamIdle(false);
  }, [resolvedToolCount]);
  useEffect(() => {
    if (!message.isStreaming) {
      setStreamIdle(false);
      return;
    }
    const t = setInterval(() => {
      setStreamIdle(Date.now() - lastArrivalRef.current > 1500);
    }, 1000);
    return () => clearInterval(t);
  }, [message.isStreaming]);
  /**
   * The genuine gap: every tool call this round has resolved, and no
   * reasoning/prose of the NEXT round has arrived since. This is the only
   * state in which "reading the results and deciding the next step" is
   * literally true; a quiet moment inside a think is not it.
   */
  const betweenToolRounds =
    toolEventCount > 0 &&
    resolvedToolCount === toolEventCount &&
    lastActivityRef.current === "toolsDone";

  if (arriveRef.current === null) {
    // First render: seed with what is already here. A resumed reply that
    // already carries prose is mid-answer (the reasoning had its moment), so
    // assume the prose stream; a fresh one is still in the reasoning seat.
    arriveRef.current = {
      r: reasoningLen,
      c: contentLen,
      last: contentLen > 0 ? "content" : "reasoning",
    };
  } else {
    // Content is checked first and reasoning second, so a frame that carries
    // both deltas keeps the box live rather than resting.
    if (contentLen > arriveRef.current.c) {
      arriveRef.current.c = contentLen;
      arriveRef.current.last = "content";
    }
    if (reasoningLen > arriveRef.current.r) {
      arriveRef.current.r = reasoningLen;
      arriveRef.current.last = "reasoning";
    }
  }

  /*
   * Keep the reasoning visible for the lifetime of a reply that was watched
   * live. This intentionally does not depend on `isStreaming` now: that flag
   * turning false must not collapse a box the reader is in the middle of
   * reading. A historical bubble mounts with `startedLive === false`, so old
   * conversations remain compact until asked for.
   */
  const autoOpen = Boolean(wentLive && hasThinking);

  const showThinking = userSetThinking ?? autoOpen;
  const setShowThinking = (next: boolean | ((v: boolean) => boolean)) =>
    setUserSetThinking((prev) => {
      const current = prev ?? autoOpen;
      return typeof next === "function" ? next(current) : next;
    });
  /** Open state of the "resume with a different model" menu. */
  const [resumeMenuOpen, setResumeMenuOpen] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [followThinking, setFollowThinking] = useState(true);
  const [copiedMessage, setCopiedMessage] = useState(false);
  const [previewImage, setPreviewImage] = useState<MessageAttachment | null>(
    null
  );
  const [comparing, setComparing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  /** A long steering note truncates to one quiet line; this expands it. */
  const [noteExpanded, setNoteExpanded] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  /** Scroll target for the plan pill in the meta row. */
  const planRef = useRef<HTMLDivElement>(null);
  const isUser = message.role === "user";
  /**
   * A mid-run steering note ("btw …" sent while a reply was running).
   *
   * It is a real user message in the conversation — the model acted on it —
   * but it was handed into a task that was already running, so it renders
   * as a slim centered event row (see the early return below), never as a
   * message bubble: a wall of old note bubbles buries the real conversation.
   */
  const isNote = isUser && message.isNote === true;

  /*
   * The step the plan is on, for the pill in the meta row.
   *
   * "doing" if the model marked one, otherwise the first thing not yet done —
   * which is what it is about to pick up. Null once everything is finished.
   */
  const planCurrent =
    message.plan?.steps.find((s) => s.state === "doing") ??
    message.plan?.steps.find((s) => s.state === "todo") ??
    null;
  const planBlocked =
    message.plan?.steps.filter((s) => s.state === "blocked").length ?? 0;

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
  /*
   * Same correction as the open state above, plus the interleaving fix:
   * "live" means reasoning is the stream arriving right now (or has not
   * arrived yet), not merely "prose has not started". That is what keeps the
   * amber tint and the Follow/Free control present through a reasoning burst
   * that lands after the answer has begun.
   */
  const isThinkingPhase = Boolean(
      message.isStreaming &&
        hasThinking &&
        (reasoningLen === 0 || arriveRef.current?.last === "reasoning")
    );

  /**
   * Does the panel have anything real to show right now?
   *
   * This gates the CLOCK and the BODY, not the mount. The shell mounts
   * through the silent gap — streaming, thinking requested, no reasoning
   * text yet — but hides while the status row below covers the wait (see
   * thinkHidden): the row already says "Thinking" with the visible clock,
   * and the shimmer header above it stacked a second "Thinking" over it.
   * The panel's clock keeps counting invisibly and is revealed the moment
   * text lands, which is also when the status row unmounts — one visible
   * timer at all times, reading the whole phase.
   */
  const panelHasContent = Boolean(
    message.reasoningNotice ||
      (typeof message.reasoningContent === "string" &&
        message.reasoningContent.trim().length > 0)
  );

  /** Live, but the first reasoning token has not landed yet: header only. */
  const thinkLoading = isThinkingPhase && !panelHasContent;
  /**
   * The covered gap: live, and nothing on screen yet — no reasoning text,
   * no notice, no prose. The status row below is the thinking voice here,
   * so the shell hides (staying mounted: its clock keeps counting and is
   * revealed reading the whole phase when text lands, the same frame the
   * row unmounts). Once prose streams the row is gone and the header stays
   * visible: it is the only voice left, and the frame still warms in
   * around it without shifting a pixel.
   */
  const thinkHidden = thinkLoading && !message.content.trim();
  /** The body stays shut through the silent gap — an open frame around
   * nothing was the empty outline this replaced. */
  const thinkBodyOpen = showThinking && !thinkLoading;

  /**
   * The finished label's duration. Present once `done` lands; a dropped
   * stream or an older stored reply has no timing and falls back to a bare
   * "Thinking" rather than guessing.
   */
  const thoughtMs =
    !isThinkingPhase &&
    typeof message.reasoningMs === "number" &&
    message.reasoningMs > 0
      ? message.reasoningMs
      : 0;

  // Keep the reasoning panel pinned to the newest text while "Follow" is on.
  // A user scroll upward turns Follow off — same rule as the chat pane, so
  // the incoming tokens do not drag the box back down under their finger.
  const ignoreThinkScroll = useRef(false);
  useEffect(() => {
    if (!followThinking || !showThinking) return;
    const el = thinkingRef.current;
    if (!el) return;
    ignoreThinkScroll.current = true;
    // Write-only (see stickToBottom): no scrollHeight read, no forced layout
    // on every reasoning frame.
    el.scrollTop = Number.MAX_SAFE_INTEGER;
    requestAnimationFrame(() => {
      ignoreThinkScroll.current = false;
    });
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

  /**
   * Focused-match highlighting is DOM-only.
   *
   * The <mark> elements carry their global match number; moving the active
   * result flips one attribute, which must not trigger React to re-parse the
   * markdown (that was the 30-second freeze: every next/prev keypress
   * re-parsed every visible message).
   */
  const bubbleRootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!searchRegex) return;
    markActiveHit(bubbleRootRef.current, activeMatchIndex);
  }, [searchRegex, activeMatchIndex]);

  const sourceCount = message.searchResults?.length ?? 0;

  const modelCost = useMemo(
    () => estimateCost(message.usage, message.model ?? ""),
    [message.usage, message.model]
  );
  /*
   * How much of the output was thinking. Billed at the output rate, and on
   * high effort it dwarfs the answer — the line that explains a $1 reply
   * for a short answer. Zero/absent on lanes that do not report the split.
   */
  const thinkingTokens = useMemo(
    () => reasoningTokens(message.usage),
    [message.usage]
  );
  /*
   * True model speed: billed reasoning tokens over the first-to-last-token
   * span, so it measures generation rather than network. When thinking feels
   * slow this number says whether the lane is slow or the essay is just long.
   */
  const thinkRate =
    thoughtMs > 0 && thinkingTokens > 0
      ? ` · ${formatThinkTokens(thinkingTokens / (thoughtMs / 1000))} tok/s`
      : "";

  /*
   * One number, because one number is what was spent.
   *
   * The model cost and the search cost were shown side by side as
   * "$0.0009 +$0.184 search", leaving the reader to add them — and the two
   * are not comparable at a glance, since the search figure is routinely two
   * orders of magnitude larger. Worse, the token count sat beside them and
   * appeared to explain them: "161,136 tokens $0.0009" reads as nonsense
   * until you know the tokens are the model's and almost all cached, while
   * the search dollars come from a per-query fee that has no token count at
   * all.
   *
   * The total is the honest headline. The split stays available on hover for
   * when it matters.
   */
  const searchCost = message.searchUsd ?? 0;
  const cost =
    modelCost === null && searchCost === 0 ? null : (modelCost ?? 0) + searchCost;

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
      message.searchUsd ||
      // The plan pill lives in this row, so a reply with a plan and no
      // timing yet — which is every reply while it is still running, and
      // exactly when the step matters most — has to render it.
      (message.plan && message.plan.steps.length > 0)
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

  /*
   * Live formatting that cannot saturate the thread. While the reply
   * streams every frame grows the content, and parsing the whole reply's
   * markdown per frame is O(n-squared) — a 20KB reply costs ~36ms per
   * re-parse inside a 16ms frame. The deferred value lets React skip the
   * MarkdownBody re-render on busy frames (its memo holds on the unchanged
   * string), so formatting follows the text a few frames behind instead of
   * blocking it; the finished reply renders the exact text.
   */
  const deferredContent = useDeferredValue(displayContent);
  const liveContent = message.isStreaming ? deferredContent : displayContent;

  /*
   * A steering note is a record, not a message: one quiet centered line —
   * chip, caption, text — instead of a right-aligned bubble. Long notes
   * truncate with a click to expand; attachments ride as tiny name chips
   * with the same lightbox behind them.
   */
  if (isNote) {
    const text = message.content ?? "";
    const long = text.length > 140;
    const shown =
      noteExpanded || !long ? text : text.slice(0, 140).trimEnd() + "…";
    return (
      <div
        ref={bubbleRootRef}
        className="animate-fade-in flex justify-center px-4"
      >
        <div className="flex min-w-0 max-w-[90%] flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 text-center">
          <span className="rounded-lg bg-search/20 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-search">
            note
          </span>
          <span className="text-[11px] text-text-muted">
            passed while the task was running
          </span>
          <button
            type="button"
            onClick={() => long && setNoteExpanded((v) => !v)}
            title={long ? (noteExpanded ? "Collapse" : "Expand") : undefined}
            className={`min-w-0 text-xs leading-5 text-text-secondary ${long ? "cursor-pointer hover:text-text-primary" : "cursor-default"}`}
          >
            <span className="whitespace-pre-wrap break-words">{shown}</span>
            {long && (
              <span className="ml-1 text-[11px] text-text-muted">
                {noteExpanded ? "show less" : "more"}
              </span>
            )}
          </button>
          {(message.attachments ?? []).map((file, i) => {
            const peekable =
              (file.kind === "image" || file.kind === "video") &&
              (file.dataUrl || file.frames?.length);
            const chip = (
              <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-bg-secondary/60 px-1.5 py-0.5 text-[11px] text-text-secondary">
                {file.name}
              </span>
            );
            return peekable ? (
              <button
                key={i}
                type="button"
                onClick={() => setPreviewImage(file)}
                title={`${file.name} — click to enlarge`}
                className="transition-transform hover:scale-[1.03]"
              >
                {chip}
              </button>
            ) : (
              <span key={i}>{chip}</span>
            );
          })}
        </div>

        {previewImage?.dataUrl && (
          <ImageLightbox
            src={previewImage.dataUrl}
            name={previewImage.name}
            description={previewImage.description}
            source={previewImage.descriptionSource}
            kind={previewImage.kind === "video" ? "video" : "image"}
            onClose={() => setPreviewImage(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={bubbleRootRef}
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
                  (file.kind === "image" || file.kind === "video") &&
                  (file.dataUrl || file.frames?.length) ? (
                    <button
                      key={i}
                      onClick={() => setPreviewImage(file)}
                      title={`${file.name} — click to enlarge`}
                      className="overflow-hidden rounded-lg border border-border transition-transform hover:scale-[1.03]"
                    >
                      {file.kind === "video" && file.dataUrl ? (
                        <video
                          src={file.dataUrl}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-24 w-auto max-w-[12rem] object-cover"
                        />
                      ) : file.kind === "video" && file.frames?.length ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={file.frames[0].dataUrl}
                          alt={file.name}
                          className="h-24 w-auto max-w-[12rem] object-cover"
                        />
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={file.dataUrl}
                          alt={file.name}
                          className="h-24 w-auto max-w-[12rem] object-cover"
                        />
                      )}
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
                  rows={Math.max(
                    3,
                    Math.min(12, draft.split("\n").length + 1),
                    Math.min(12, message.content.split("\n").length + 1)
                  )}
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
                        {/* Clustered on one side — the old justify-between
                            scattered Edit and Delete to opposite edges. */}
                        <div className="mt-1 flex items-center justify-end gap-1">
                          <button
                            onClick={() => {
                              void navigator.clipboard.writeText(message.content);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1200);
                            }}
                            title="Copy message text"
                            aria-label="Copy message"
                            className="flex h-6 items-center gap-1 rounded-lg px-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                          >
                            {copied ? (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                              </svg>
                            ) : (
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                                <rect x="9" y="9" width="11" height="11" rx="2" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                              </svg>
                            )}
                            {copied ? "Copied" : "Copy"}
                          </button>
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
                              title="Delete this question and the reply — both forget it"
                              aria-label="Delete this exchange"
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
            description={previewImage.description}
            source={previewImage.descriptionSource}
            kind={previewImage.kind === "video" ? "video" : "image"}
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
                    <span className="inline-flex items-center gap-1 rounded-lg border border-thinking/25 bg-thinking/10 px-1.5 py-0.5 text-[11px] font-medium text-thinking">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z" />
                      </svg>
                      {message.thinkingEffort}
                    </span>
                  )}

                {/* Which step the plan is on, in one pill.
 
                    Asked for directly: "a mini button like sources to see on
                    which step of planning is model". The full panel stays —
                    it is where the whole plan lives — but during a long run
                    the only question most of the time is "where is it now",
                    and that should not need scrolling up to a twenty-step
                    list to answer.
 
                    It scrolls to the panel rather than duplicating it. Two
                    places showing the same steps would drift, and the panel
                    already renders them properly. */}
                {message.plan && message.plan.steps.length > 0 && (
                  <button
                    onClick={() => {
                      planRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                    }}
                    title={
                      planCurrent
                        ? `Step ${planCurrent.id}: ${normalisePlanStepText(planCurrent.text) || "Untitled step"}`
                        : "Every step is done"
                    }
                    className={`inline-flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      planBlocked > 0
                        ? "border-danger/25 bg-danger/10 text-danger hover:bg-danger/20"
                        : planCurrent
                          ? "border-warning/25 bg-warning/10 text-warning hover:bg-warning/20"
                          : "border-success/25 bg-success/10 text-success hover:bg-success/20"
                    }`}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 11l3 3L22 4" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                    </svg>
                    {planCurrent
                      ? `Step ${planCurrent.id}/${message.plan.steps.length}`
                      : `${message.plan.steps.length}/${message.plan.steps.length} done`}
                    {planBlocked > 0 && ` · ${planBlocked} blocked`}
                  </button>
                )}

                {/* Search reason lives on the sources pill — the control it
                    explains — rather than as another separate badge. */}
                {sourceCount > 0 && (
                  <button
                    onClick={() => setShowSources((v) => !v)}
                    aria-expanded={showSources}
                    title={searchTooltip}
                    className="inline-flex items-center gap-1 rounded-lg border border-search/25 bg-search/10 px-1.5 py-0.5 text-[11px] font-medium text-search transition-colors hover:bg-search/20"
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
                    className="text-[11px] text-text-muted"
                    /*
                     * The cache split belongs here.
                     *
                     * "161,136 tokens" beside a cost of a tenth of a cent
                     * looks impossible until you know almost all of those
                     * tokens were cache hits, which DeepSeek bills at 1/120th
                     * of the normal input rate. Showing the split turns an
                     * apparent error into the explanation.
                     */
                    title={
                      message.usage
                        ? [
                            `${(message.usage.prompt_tokens ?? 0).toLocaleString()} in · ${(message.usage.completion_tokens ?? 0).toLocaleString()} out`,
                            thinkingTokens > 0
                              ? `${thinkingTokens.toLocaleString()} of the output was thinking, billed at the output rate`
                              : null,
                            message.usage.prompt_cache_hit_tokens
                              ? `${message.usage.prompt_cache_hit_tokens.toLocaleString()} of the input was cached, billed at 1/120th the rate`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n")
                        : undefined
                    }
                  >
                    {message.tokenCount.toLocaleString()} tokens
                  </span>
                ) : null}

                {cost !== null && (
                  <span
                    className="text-[11px] font-medium text-text-muted"
                    title={
                      [
                        `Model: ${formatCost(modelCost ?? 0)}`,
                        searchCost > 0 ? `Web search: ${formatCost(searchCost)}` : null,
                        message.searchCacheHits
                          ? `${message.searchCacheHits} search(es) reused from cache at no cost`
                          : null,
                        "Estimated from published rates",
                      ]
                        .filter(Boolean)
                        .join("\n")
                    }
                  >
                    {formatCost(cost)}
                    {searchCost > 0 ? " total" : ""}
                  </span>
                )}

                {message.durationMs ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-text-muted"
                    title="Time from sending to the last token"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path strokeLinecap="round" d="M12 7v5l3 2" />
                    </svg>
                    {formatDuration(message.durationMs)}
                  </span>
                ) : null}

                {message.contextChars ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-text-muted"
                    title={
                      message.contextBreakdown &&
                      message.contextBreakdown.length > 0
                        ? `Context sent with the final request:\n${message.contextBreakdown
                            .map(
                              (part) =>
                                `${part.label} ${
                                  part.chars >= 1000
                                    ? `${(part.chars / 1000).toFixed(0)}k`
                                    : `${part.chars}`
                                }`
                            )
                            .join("\n")}`
                        : "Context sent with the final request"
                    }
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
                    </svg>
                    {message.contextChars >= 1000
                      ? `~${(message.contextChars / 1000).toFixed(0)}k ctx`
                      : `${message.contextChars} ctx`}
                  </span>
                ) : null}

                {message.ending &&
                (message.ending.finish ||
                  message.ending.continuedOutput > 0 ||
                  message.ending.continuedConnection > 0 ||
                  message.ending.thinkOnlyStalls >= 2) ? (
                  <span
                    className="text-[11px] text-text-muted"
                    /*
                     * Why the reply is exactly as long as it is. A short
                     * answer with `stop` and zero continuations means the
                     * model ended it itself — nothing cut it, and Resume
                     * (not a bug report) is the remedy. Anything else names
                     * the cutter and what the continuation pools spent.
                     */
                    title={
                      `Final finish_reason: ${message.ending.finish ?? "none (stream ended mid-content)"}` +
                      `\nOutput-limit continuations: ${message.ending.continuedOutput}` +
                      `\nConnection-cut continuations: ${message.ending.continuedConnection}` +
                      (message.ending.thinkOnlyStalls > 0
                        ? `\nThink-only stalls: ${message.ending.thinkOnlyStalls} (thinking ate the whole output budget without producing anything; thinking was then switched off)`
                        : "")
                    }
                  >
                    · {message.ending.finish ?? "cut"}
                    {message.ending.continuedOutput +
                      message.ending.continuedConnection >
                    0
                      ? ` +${message.ending.continuedOutput + message.ending.continuedConnection} cont`
                      : ""}
                    {message.ending.thinkOnlyStalls >= 2
                      ? ` · thought ${message.ending.thinkOnlyStalls}×, empty`
                      : ""}
                  </span>
                ) : null}
              </div>
            )}

            {/* Sources list — opened from the pill above */}
            {showSources && sourceCount > 0 && (
              <div className="animate-fade-in space-y-0.5 rounded-xl border border-search/20 bg-bg-secondary/60 p-1.5">
                {message.searchResults!.map((result, i) => (
                  <a
                    key={i}
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-bg-hover"
                  >
                    <span className="flex h-4 w-4 flex-none items-center justify-center rounded bg-search/15 text-[9px] font-bold text-search">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text-primary transition-colors group-hover:text-search">
                        {result.title}
                      </span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {result.domain}
                      </span>
                    </span>
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2} aria-hidden="true"
                      className="flex-none text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
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
            {/* Shown when there is reasoning, whether or not its text has
                arrived — a stored chat sends only the length, and the body is
                fetched when the panel is opened. */}
            {/* Two elements, not one: the outer .thinking-panel animates its
                own height from zero so the messages below are eased apart
                instead of jumping, and the inner .thinking-shell carries the
                border and background. Putting both on one element would mean
                animating grid-template-rows on the same box that draws the
                frame, and the frame would squash. */}
            {/*
              Mounted while thinking is EXPECTED, not only once text arrives.

              This tested `reasoningContent || reasoningLength`, and a new
              streaming message starts with reasoningContent set to "" — which
              is falsy. So during the seconds before the first reasoning token
              lands there was no panel at all, and on a short reply where the
              model thinks briefly and answers fast, that is the whole of it.
              Reported as "no thinking showing": nothing was broken downstream,
              the panel was simply never mounted.

              The sweep animation had the same cause. It lives inside this
              block, so it could not run before the block existed.

              `thinkingEffort` is set from the resolved effort the moment the
              stream opens, so it is the earliest honest signal that reasoning
              is coming. "none" means the model was told not to think, and
              then there is correctly nothing to show.
            */}
            {hasThinking && (
              <div className="thinking-panel">
                <div
                  data-thinking={isThinkingPhase}
                  data-open={thinkBodyOpen}
                  data-loading={thinkLoading}
                  className={`thinking-shell overflow-hidden rounded-lg ${thinkHidden ? "hidden" : ""}`}
                >
                {/* The loader IS the header — once prose streams. Before the
                    first reasoning token the shell is frameless — just a
                    shimmering "Thinking" — and when text lands the same node
                    gains its border, background and body over one 0.3s ease.
                    Nothing spawns; the waiting state warms into the box.
                    Through the covered gap (no prose yet) the whole shell
                    hides and the status row below carries the wait alone —
                    one Thinking, not two stacked (see thinkHidden).
                    The row geometry never changes
                    (same padding, chevron kept mounted but hidden, Follow
                    kept mounted but hidden), so the transform cannot shift a
                    pixel sideways. */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      // Asked on every open; the loader returns immediately
                      // when the text is already present.
                      if (!showThinking) onLoadReasoning?.(message.id);
                      // From here on the reader owns this panel: the
                      // derived default stops applying.
                      setShowThinking((v) => !v);
                    }}
                    aria-expanded={showThinking}
                    className="thinking-toggle flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left font-sans text-[13px] font-medium leading-5"
                  >
                    <svg
                      width="13" height="13" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2.2} aria-hidden="true"
                      className={`flex-none transition-transform duration-150 ${showThinking ? "rotate-90" : ""} ${thinkLoading ? "invisible" : ""}`}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    {/* Live the label shimmers with a ticking token count, so a
                        long think reads as progress rather than a hang;
                        finished it states how long the model thought plus the
                        true generation rate ("Thought for 3m 20s · 71 tok/s").
                        The old "Thought for 40.9k characters" confused a length
                        for a duration and read as an error — the character
                        count survives only as the collapsed row's tooltip, for
                        the curious. */}
                    <span
                      className={`truncate ${isThinkingPhase ? "thinking-shimmer" : ""}`}
                      title={
                        thoughtMs > 0 && reasoningChars > 0
                          ? `${reasoningChars.toLocaleString()} characters of reasoning`
                          : undefined
                      }
                    >
                      {isThinkingPhase ? (
                        <>
                          Thinking
                          {/* Counting invisibly through the silent gap: the
                              status row owns the visible clock until the
                              first token, then this one is revealed already
                              showing the whole phase — one timer, no shift. */}
                          <span className={thinkLoading ? "invisible" : undefined}>
                            <ThinkingClock />
                          </span>
                          {reasoningChars > 0 && (
                            <> · {formatThinkTokens(reasoningChars / 4)}</>
                          )}
                        </>
                      ) : thoughtMs > 0
                          ? `Thought for ${formatThoughtTime(thoughtMs)}${thinkRate}`
                          : "Thinking"}
                    </span>
                    {isThinkingPhase && <Dots size={3} />}
                  </button>

                  {/* Mounted for the whole open body, interactive only while
                      reasoning is actually arriving.
                      
                      It used to mount and unmount with the thinking phase, so
                      finishing visibly re-centred the header — the "unsymmetric
                      box". Now the finished body keeps the same right-hand
                      control at zero opacity: the living row and the finished
                      row are geometrically identical. (Kept mounted rather
                      than `hidden` for the same reason the chevron is: no
                      layout shift at the transform moment.)
                      
                      Before that it was tied to `message.isStreaming`, so it
                      stayed on screen through the whole reply — long after the
                      reasoning had stopped updating. Toggling it then did
                      nothing at all, which is what made it feel broken: the
                      control was live but the thing it controlled had
                      finished. The right-hand margin also read as misaligned
                      because it was 8px against the label's 12px padding; both
                      edges now match. */}
                  {thinkBodyOpen && (
                    <button
                      onClick={() => setFollowThinking((v) => !v)}
                      title={
                        followThinking
                          ? "Following the text — click to scroll freely"
                          : "Scrolling freely — click to follow the text"
                      }
                      aria-pressed={followThinking}
                      aria-hidden={!isThinkingPhase}
                      tabIndex={isThinkingPhase ? 0 : -1}
                      className={`mr-3 flex h-6 flex-none items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors ${
                        isThinkingPhase ? "" : "pointer-events-none invisible"
                      } ${
                        followThinking
                          ? "bg-thinking/20 text-thinking"
                          : "text-thinking/55 hover:bg-thinking/10 hover:text-thinking"
                      }`}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                      </svg>
                      {followThinking ? "Follow" : "Free"}
                    </button>
                  )}
                </div>

                {/* Always mounted, so the body can animate its height open
                    and shut. Rendering it only when open meant the text
                    appeared instantly at full size with nothing to ease. */}
                <div className="thinking-body" data-open={thinkBodyOpen}>
                  <div>
                    <div
                      ref={thinkingRef}
                      aria-hidden={!showThinking}
                      onWheel={(e) => {
                        if (e.deltaY < 0) setFollowThinking(false);
                      }}
                      onScroll={() => {
                        if (ignoreThinkScroll.current || !followThinking) return;
                        const el = thinkingRef.current;
                        if (!el) return;
                        if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) {
                          setFollowThinking(false);
                        }
                      }}
                      className="thinking-body-text max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2.5 font-sans text-[13px] leading-5 [overscroll-behavior:contain]"
                    >
                      {/*
                        Four states, not two. `undefined` on a stored reply
                        means its text has not been fetched. An empty string on
                        a LIVE reply means the first reasoning token has not
                        landed yet. Only an empty finished reply means there
                        genuinely was nothing to record.
                      */}
                      {typeof message.reasoningContent === "string" ? (
                        message.reasoningContent.trim() ? (
                          message.reasoningContent
                        ) : message.reasoningNotice ? (
                          <span className="opacity-70">
                            {message.reasoningNotice}
                          </span>
                        ) : isThinkingPhase ? (
                          <span className="thinking-shimmer">
                            Waiting for reasoning text…
                          </span>
                        ) : (
                          <span className="opacity-60">
                            Thinking was enabled, but no reasoning text was received for this reply.
                          </span>
                        )
                      ) : showThinking ? (
                        <span className="thinking-shimmer">Loading…</span>
                      ) : (
                        ""
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </div>
            )}

            {/* The plan sits directly under the thinking: the two are the
                frame the rest of the message is read inside, and a tool run
                between them pushed the thinking far from the plan it was
                reasoning about. Still above the reply, so it is seen rather
                than found. */}
            {message.plan && (
              <div ref={planRef}>
                <PlanPanel
                  plan={message.plan}
                  onUnblock={onUnblockPlan}
                  onClear={onClearPlan}
                />
              </div>
            )}

            {/* Reply was cut short — offer to retry rather than leaving a
                silently truncated answer looking complete. */}
            {message.incomplete && !message.isStreaming && (
              /*
               * The interrupted banner.
               *
               * This was a thin row with an 11px pill on the right, and it was
               * missed entirely — the reply it belongs to had run for minutes
               * and the way to recover it was smaller than the timestamp
               * beneath it. An action worth tens of cents should not be the
               * quietest thing in its own notice.
               *
               * Resume is now a full-width button on its own line, labelled
               * with what it does rather than with a bare verb.
               */
              <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/[0.07]">
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true" className="mt-0.5 flex-none text-warning">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>

                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-warning">
                      {/* The reason, when there is one. "Insufficient balance"
                          is far more use than a generic "interrupted", and it
                          names the one thing to fix before Resume will work. */}
                      {message.errorNotice ?? "This reply stopped before it finished"}
                    </p>
                    {message.canResume ? (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
                        Everything it did is saved — the files it wrote, what it
                        read, and its reasoning. Resuming carries on from there
                        and only pays for what is left.
                      </p>
                    ) : message.isError ? (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
                        Nothing arrived, so there is nothing to resume — Try
                        again re-sends the turn.
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
                        This one is from before resuming existed, so it can only
                        be run again from the start.
                      </p>
                    )}
                    {/*
                      "Show / Hide what arrived" was here and has been removed.
                      
                      It appeared to do nothing, and it genuinely did nothing
                      on most replies: it gated the plain-markdown branch far
                      below, but any reply with tool activity renders through
                      the timeline instead, which was never gated. So on
                      exactly the long agent runs where an interruption
                      matters, the button toggled a label and changed no
                      pixels.
                      
                      Rather than extend the gate to the timeline — hiding work
                      the user just paid for, behind a control they have to
                      find — the partial reply is now always visible. It is the
                      most useful thing on screen after an interruption.
                    */}
                  </div>
                </div>

                {/* Actions on their own line, full width. Resume dominates
                    because it is nearly always right: it keeps every file
                    already written and pays only for the remaining rounds.
                    Starting over buys the same work a second time, so it stays
                    reachable but quiet. */}
                <div className="flex items-stretch gap-1.5 border-t border-warning/20 p-1.5">
                  {onResume && message.canResume && (
                    /*
                     * Resume, with the option of a different model.
                     *
                     * Asked for directly: "idk if I can pick the model when I
                     * click resume, if it's possible add it, so model sees the
                     * same thing but I can choose another one."
                     *
                     * It is possible, and it is genuinely useful — the saved
                     * transcript is just messages, so any model can pick it
                     * up. The common case is a Pro run that stalled: finish it
                     * on Flash for a sixth of the price, or the reverse when
                     * Flash got stuck on something hard.
                     *
                     * A split button rather than a menu: the plain Resume path
                     * stays one click, and the chevron is there when the model
                     * matters. Anything that makes the ordinary case slower to
                     * save a rare one is a bad trade.
                     */
                    <div className="relative flex flex-1 items-stretch">
                      <button
                        onClick={() => onResume(message.id)}
                        title="Carry on from where it stopped, keeping the work already done"
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg rounded-r-none bg-warning px-3 py-2 text-[13px] font-semibold text-bg-primary transition-colors hover:brightness-110"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        Resume
                      </button>
                      <button
                        onClick={() => setResumeMenuOpen((v) => !v)}
                        aria-expanded={resumeMenuOpen}
                        aria-haspopup="menu"
                        title="Resume with a different model"
                        className="flex flex-none items-center rounded-lg rounded-l-none border-l border-bg-primary/20 bg-warning px-2 text-bg-primary transition-colors hover:brightness-110"
                      >
                        <svg
                          width="13" height="13" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth={2.4} aria-hidden="true"
                          className={`transition-transform duration-150 ${resumeMenuOpen ? "rotate-180" : ""}`}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                        </svg>
                      </button>

                      {resumeMenuOpen && (
                        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-lg">
                          <p className="border-b border-border px-3 py-2 text-[11px] leading-4 text-text-muted">
                            Continue the same work with:
                          </p>
                          {MODELS.map((m) => ({
                            id: m.id,
                            label: m.shortLabel,
                            blurb: m.resumeBlurb,
                          })).map((m) => (
                            <button
                              key={m.id}
                              onClick={() => {
                                setResumeMenuOpen(false);
                                onResume(message.id, m.id);
                              }}
                              className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-hover"
                            >
                              <span className="text-[13px] font-medium text-text-primary">
                                {m.label}
                              </span>
                              <span className="text-[11px] text-text-muted">
                                {m.blurb}
                              </span>
                              {message.model === m.id && (
                                <span className="ml-auto text-[11px] text-text-muted">
                                  used before
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {onRegenerate && (
                    <button
                      onClick={() => onRegenerate(message.id)}
                      title={
                        message.canResume
                          ? "Discard what was done and answer again from scratch"
                          : "Answer again from the beginning"
                      }
                      className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                        message.canResume
                          ? "flex-none text-warning hover:bg-warning/15"
                          : "flex-1 bg-warning text-bg-primary hover:brightness-110"
                      }`}
                    >
                      {message.canResume ? "Start over" : "Try again"}
                    </button>
                  )}
                </div>
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

            {/* Between tool rounds.

                After the last tool result lands, the host still has to read
                every tool result back and prefill the next round. On a long
                context that is the slowest stretch of the whole reply — tens
                of seconds where nothing types, every tool row shows its green
                check, and the reasoning panel has gone quiet. It looks done;
                it is the opposite of done. This row is only that gap: it
                appears once the tool work is finished and vanishes the moment
                any new reasoning or prose streams in. Shown in both the flat
                and timeline layouts (the comment block above the plan is the
                one both branches render before). Purely presentational —
                zero server work, nothing about the run changes. */}
            {message.isStreaming &&
              betweenToolRounds &&
              streamIdle && (
                <div className="mb-2.5 flex items-center gap-2 text-[13px] text-text-secondary">
                  <span className="text-accent-light">
                    <Dots size={4} />
                  </span>
                  <span className="animate-thinking">
                    Reading the results and deciding the next step
                  </span>
                </div>
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
                // Deferred while streaming: rows parse narration from a
                // lagging copy, so formatting stays live without a full
                // re-parse on every frame.
                live={message.isStreaming}
              />
            )}

            {/* Main content. While streaming, an unterminated ``` fence is
                replaced by a placeholder card — watching code type itself line
                by line is noisy, and half-written markup renders as garbage. */}
            {!useTimeline && (displayContent || !message.isStreaming) && (
              <div
                className={`prose-chat text-[15px] leading-relaxed ${
                  message.isError
                    ? "text-danger"
                    : message.incomplete
                      ? "text-text-secondary"
                      : "text-text-primary"
                }`}
              >
                <MarkdownBody content={liveContent} regex={searchRegex} plain={deferred} />
                {message.isStreaming && displayContent && !hasPendingCode && (
                  <span className="stream-caret" aria-hidden="true" />
                )}
              </div>
            )}

            {/* The question goes UNDER the sentence that asks it.

                It used to sit above the reply, so the screen read:

                  [ pick one: A / B / C ]
                  Sure — I need to know one thing first.

                which is backwards. You met the buttons before the reason for
                them, and the explanation arrived after the decision. Below
                the text the order matches how it is spoken: ask, then offer
                the options. */}
            {message.pendingQuestion && onAnswerQuestion && (
              <QuestionPrompt
                pending={message.pendingQuestion}
                onAnswer={onAnswerQuestion}
              />
            )}

            {/* Placeholder while a code block is still being generated */}
            {onDelete && !isLast && !message.isStreaming && (
              <div className="group/del pt-0.5">
                <button
                  onClick={() => onDelete(message.id)}
                  title="Delete this reply and your question — both forget it"
                  aria-label="Delete this exchange"
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-text-muted opacity-0 transition-opacity hover:bg-danger/12 hover:text-danger group-hover/del:opacity-100 focus:opacity-100"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
                  </svg>
                  Delete
                </button>
              </div>
            )}

            {hasPendingCode && (
              <div className="my-3 flex w-full items-center gap-3 rounded-xl border border-border bg-bg-secondary px-3 py-2.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-bg-elevated text-accent-light">
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
                  <span className="truncate text-sm font-medium text-text-primary">
                    {pendingLanguage
                      ? `Writing ${pendingLanguage}…`
                      : "Writing code…"}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    {pendingLines} {pendingLines === 1 ? "line" : "lines"} so far
                  </span>
                </span>
                <span className="flex-none text-accent">
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
                    className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                  >
                    {copiedMessage ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7ba478" strokeWidth={2.2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20 6L9 17l-5-5" />
                        </svg>
                        <span className="text-success">Copied</span>
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
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-accent-light transition-colors hover:bg-accent/12"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      Compare
                      <span className="text-text-muted">
                        {(message.previousVersions?.length ?? 0) + 1}
                      </span>
                    </button>
                  )}

                  {onRegenerate && (
                    <button
                      onClick={() => onRegenerate(message.id)}
                      title="Generate a different reply"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20 9A8 8 0 006 5.3L4 7m0 8a8 8 0 0014 3.7l2-2" />
                      </svg>
                      Regenerate
                    </button>
                  )}

                  {onDelete && (
                    <button
                      onClick={() => onDelete(message.id)}
                      title="Delete this reply and your question — both forget it"
                      aria-label="Delete this exchange"
                      className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-text-muted transition-colors hover:bg-danger/12 hover:text-danger"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
                      </svg>
                      Delete
                    </button>
                  )}
                </div>
              )}

            {isLast &&
              onDelete &&
              !message.isStreaming &&
              (message.isError || !message.content) && (
                <button
                  onClick={() => onDelete(message.id)}
                  title="Delete this reply and your question — both forget it"
                  aria-label="Delete this exchange"
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-text-muted transition-colors hover:bg-danger/12 hover:text-danger"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
                  </svg>
                  Delete
                </button>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Applies highlighting to plain text (user bubbles, which are not markdown).
 *
 * The active-match attribute is set imperatively after render for the same
 * reason as MarkdownBody: stepping next/prev must not re-highlight.
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
  const ref = useRef<HTMLSpanElement>(null);
  const regex = useMemo(
    () => (query ? buildSearchRegex(query, wholeWord) : null),
    [query, wholeWord]
  );

  useLayoutEffect(() => {
    if (!regex) return;
    markActiveHit(ref.current, activeIndex);
  }, [regex, activeIndex]);

  if (!regex) return <>{children}</>;
  return <span ref={ref}>{highlightNode(children, regex, { n: 0 })}</span>;
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
    a.reasoningNotice === b.reasoningNotice &&
    a.isStreaming === b.isStreaming &&
    a.isError === b.isError &&
    a.isNote === b.isNote &&
    a.incomplete === b.incomplete &&
    a.canResume === b.canResume &&
    a.errorNotice === b.errorNotice &&
    a.tokenCount === b.tokenCount &&
    a.thinkingEffort === b.thinkingEffort &&
    a.searchResults === b.searchResults &&
    a.attachments === b.attachments &&
    a.usage === b.usage &&
    a.durationMs === b.durationMs &&
    a.contextChars === b.contextChars &&
    a.contextBreakdown === b.contextBreakdown &&
    a.ending === b.ending &&
    a.previousVersions === b.previousVersions &&
    // New array identity on every tool frame, so this is what makes the
    // "Writing app.py" lines appear as they happen.
    a.toolEvents === b.toolEvents &&
    a.timeline === b.timeline &&
    a.pendingCommand === b.pendingCommand &&
    a.pendingQuestion === b.pendingQuestion &&
    // New object identity on every plan update, which is what makes the
    // progress bar move as the agent works.
    a.plan === b.plan &&
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
    // Missing from this list was half of the "Loading… forever" bug: a bubble
    // that skipped re-rendering kept whichever onLoadReasoning it first
    // received, and that closure knew only the conversation open at the time.
    // The callback is now identity-stable so this can never go stale again,
    // but an omitted prop in a comparator is a trap either way.
        prev.onLoadReasoning === next.onLoadReasoning &&
        prev.onAnswerQuestion === next.onAnswerQuestion &&
        // The hydration upgrade: when MessageList flips this, the bubble must
        // re-render to swap its plain-text body for full markdown. An omitted
        // prop here would swallow every upgrade — the same trap as the comment
        // below documents for onLoadReasoning.
        prev.deferred === next.deferred
      );
    });
