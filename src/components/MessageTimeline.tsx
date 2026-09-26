"use client";

import { memo, useDeferredValue, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolActivity } from "@/components/ToolActivity";
import type { ToolEvent } from "@/components/ToolActivity";
import { buildTimelineRows, textHasTable } from "@/lib/timeline";
import type { TimelineEntry } from "@/lib/timeline";

export type { TimelineEntry } from "@/lib/timeline";

/**
 * Narration on the left, actions on the right, in the order they happened.
 *
 * The model talks between tool calls, so "I'll create the file" and the write
 * that followed belong together. Concatenating all the prose into one block
 * loses that pairing — which is the only part worth reading when a reply
 * touched six files.
 */
const RowMarkdown = memo(function RowMarkdown({
  text,
  components,
}: {
  text: string;
  components?: React.ComponentProps<typeof ReactMarkdown>["components"];
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Shallow tool-list equality for row memoisation.
 *
 * buildTimelineRows pushes the toolEvents elements themselves (not copies)
 * into rows, so a completed row's tools keep their identity across stream
 * frames while the parent rebuilds the row objects every time.
 */
function sameTools(a: ToolEvent[], b: ToolEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const TimelineRow = memo(function TimelineRow({
  text,
  tools,
  first,
  afterThink,
  live,
  onOpenFile,
  markdownComponents,
}: {
  text: string;
  tools: ToolEvent[];
  /** First row: no separator rule above it. */
  first: boolean;
  /** Follows its round's thinking: sits close under it, no rule between. */
  afterThink?: boolean;
  /**
   * The reply is still streaming. Narration renders from a deferred copy of
   * the text: every frame grows the trailing row, and parsing the whole
   * row's markdown per frame is what made a fast model feel slow (a 20KB
   * reply costs ~36ms per full re-parse, every frame). The deferred value
   * lets React skip the re-parse on busy frames, so formatting stays live
   * but never saturates the thread; finished rows (stable text) are exact.
   */
  live?: boolean;
  onOpenFile?: (path: string) => void;
  markdownComponents?: React.ComponentProps<typeof ReactMarkdown>["components"];
}) {
        const deferredText = useDeferredValue(text);
        const shown = live ? deferredText : text;
        const hasText = shown.trim().length > 0;
        const hasTools = tools.length > 0;
        if (!hasText && !hasTools) return null;

        // A table is isolated, not split beside the tool column. Squeezed
        // into the left column it ends up a fraction of its natural width
        // with the vertical divider running alongside its cells, which reads
        // as the rule cutting straight through the table. Full width gives
        // the table the whole line; the row's tools stack below it.
        const split = hasText && hasTools && !textHasTable(shown);

        return (
          <div
            className={`grid gap-y-2 ${
              // Only split when there is something on both sides. A row that
              // is only prose uses the full width, so ordinary paragraphs
              // don't end up in a narrow column beside nothing.
              split
                ? "gap-x-0 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,20rem)]"
                : "grid-cols-1"
              /*
               * A rule between rows, not just above the first.
               *
               * Only one separator was ever drawn — above the whole timeline
               * — so every row after it ran straight into the next with
               * nothing but padding between them. The vertical divider inside
               * a row then read as the only structure on screen, which is why
               * the layout looked like disconnected columns rather than a
               * sequence of steps.
               */
            } ${
              afterThink
                ? "mt-3"
                : !first
                  ? "mt-4 border-t border-border/60 pt-4"
                  : ""
            }`}
          >
            {hasText && (
              <div
                className={`prose-chat min-w-0 break-words text-[15px] leading-relaxed text-text-primary ${
                  // Wider gutter than the divider's own spacing, so a long
                  // line ends clear of the rule instead of touching it, and
                  // break-words so an unbroken token wraps rather than
                  // spilling across it.
                  split ? "md:pr-6" : ""
                }`}
              >
                <RowMarkdown text={shown} components={markdownComponents} />
              </div>
            )}

            {/* The divider is its own grid column rather than a border on the
                prose, so it spans the full height of the taller side and the
                two columns read as genuinely separate. Hidden below md,
                where the layout stacks and a vertical rule would sit across
                the content. */}
            {split && (
              <span
                className="hidden w-px self-stretch bg-border md:block"
                aria-hidden="true"
              />
            )}

            {hasTools && (
              <div className={`min-w-0 ${split ? "md:pl-6" : ""}`}>
                <ToolActivity events={tools} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        );
}, (prev, next) =>
  prev.text === next.text &&
  prev.first === next.first &&
  prev.afterThink === next.afterThink &&
  prev.live === next.live &&
  prev.onOpenFile === next.onOpenFile &&
  prev.markdownComponents === next.markdownComponents &&
  sameTools(prev.tools, next.tools)
);

/**
 * Characters of a live think rendered while following it.
 *
 * One round of a long think is tens of thousands of tokens, and the body is
 * rewritten on every stream flush. Laying out 300KB of wrapped text ten times
 * a second is what made the text crawl on long runs. Following only ever
 * shows the bottom of the box anyway, so while live-and-following the body
 * holds the tail; the whole text is there the moment the reader scrolls up
 * (Free) or the think finishes.
 */
const LIVE_TAIL_CHARS = 12_000;

function formatTokens(chars: number): string {
  const n = chars / 4;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.max(1, Math.round(n))}`;
}

/** Seconds since this live think started, ticking. */
function ThinkClock() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums">{` · ${seconds}s`}</span>;
}

/**
 * One round's reasoning, in the place it happened.
 *
 * The reply used to keep every round's reasoning in one box at the top of
 * the message, above the plan and every tool row. On an hour-long run the
 * thinking for round thirty streamed into a box a full screen above the
 * tools it was deciding — the reader, following the bottom, saw tools
 * appear with no thought beside them, and the box itself re-rendered the
 * whole run's reasoning on every frame. Each round now thinks in its own
 * row: open while it streams, collapsed to one line once the round moves on.
 */
const ThinkRow = memo(function ThinkRow({
  source,
  start,
  end,
  live,
  first,
  onLoad,
}: {
  /** The message's whole reasoning; undefined until a stored chat loads it. */
  source: string | undefined;
  start: number;
  end: number;
  /** Reasoning is streaming into THIS row right now. */
  live: boolean;
  first: boolean;
  onLoad?: () => void;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const open = userOpen ?? live;
  const loaded = typeof source === "string";
  const slice = loaded ? source.slice(start, Math.min(end, source.length)) : "";
  const tailOnly = live && follow && slice.length > LIVE_TAIL_CHARS;
  const shown = (tailOnly ? slice.slice(-LIVE_TAIL_CHARS) : slice).replace(
    /^\s+/,
    ""
  );
  const chars = Math.max(0, end - start);

  // Pin to the newest text while following. Write-only, no layout read.
  useEffect(() => {
    if (!open || !follow || !live) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = Number.MAX_SAFE_INTEGER;
  }, [shown, open, follow, live]);

  if (loaded && !slice.trim() && !live) return null;

  return (
    // The round's divider sits above its thinking, so the thought and the
    // narration and tools it led to read as one group.
    <div className={!first ? "mt-4 border-t border-border/60 pt-4" : ""}>
      <div
        data-thinking={live}
        data-open={open}
        className="thinking-shell overflow-hidden rounded-lg"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (!open && !loaded) onLoad?.();
              setUserOpen(!open);
            }}
            aria-expanded={open}
            className="thinking-toggle flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left font-sans text-[13px] font-medium leading-5"
          >
            <svg
              width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth={2.2} aria-hidden="true"
              className={`flex-none transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className={`truncate ${live ? "thinking-shimmer" : ""}`}>
              {live ? (
                <>
                  Thinking
                  <ThinkClock />
                  {` · ${formatTokens(chars)} tok`}
                </>
              ) : (
                `Thought · ${formatTokens(chars)} tok`
              )}
            </span>
          </button>
          {open && live && (
            <button
              onClick={() => setFollow((v) => !v)}
              aria-pressed={follow}
              title={
                follow
                  ? "Following the text — click to scroll freely"
                  : "Scrolling freely — click to follow the text"
              }
              className={`mr-3 flex h-6 flex-none items-center rounded-lg px-2 text-[11px] font-medium transition-colors ${
                follow
                  ? "bg-thinking/20 text-thinking"
                  : "text-thinking/55 hover:bg-thinking/10 hover:text-thinking"
              }`}
            >
              {follow ? "Follow" : "Free"}
            </button>
          )}
        </div>
        <div className="thinking-body" data-open={open}>
          <div>
            <div
              ref={bodyRef}
              aria-hidden={!open}
              onWheel={(e) => {
                if (live && e.deltaY < 0) setFollow(false);
              }}
              className="thinking-body-text max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2.5 font-sans text-[13px] leading-5 [overscroll-behavior:contain]"
            >
              {!open ? (
                ""
              ) : !loaded ? (
                <span className="thinking-shimmer">Loading…</span>
              ) : (
                <>
                  {tailOnly && (
                    <span className="block pb-1 opacity-60">
                      … earlier thinking in this round is hidden while following — click Follow to show all of it
                    </span>
                  )}
                  {shown}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.start === next.start &&
  prev.end === next.end &&
  prev.live === next.live &&
  prev.first === next.first &&
  prev.onLoad === next.onLoad &&
  sameSlice(prev.source, next.source, next.start, next.end)
);

/**
 * Would these two reasoning strings show the same text in [start, end)?
 *
 * Reasoning only ever grows by appending, so once both strings cover the
 * range, the slice is the same — checked at its ends rather than compared
 * whole, because a full compare of every finished round on every stream
 * frame is the cost this row exists to avoid. A string arriving where there
 * was none (a stored chat's reasoning loading) always repaints.
 */
function sameSlice(
  a: string | undefined,
  b: string | undefined,
  start: number,
  end: number
): boolean {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length < end || b.length < end) return a.length === b.length;
  return (
    a.charCodeAt(start) === b.charCodeAt(start) &&
    a.charCodeAt(end - 1) === b.charCodeAt(end - 1)
  );
}

export function MessageTimeline({
  timeline,
  toolEvents,
  onOpenFile,
  markdownComponents,
  live,
  reasoning,
  thinkingLive,
  onLoadReasoning,
}: {
  timeline: TimelineEntry[];
  toolEvents: ToolEvent[];
  onOpenFile?: (path: string) => void;
  markdownComponents?: React.ComponentProps<typeof ReactMarkdown>["components"];
  /** The reply is still streaming — rows render deferred markdown (see TimelineRow). */
  live?: boolean;
  /** The message's reasoning, which think rows slice by range. */
  reasoning?: string;
  /** Reasoning is the stream arriving right now, so the last think row is live. */
  thinkingLive?: boolean;
  /** Fetch a stored reply's reasoning the first time a think row opens. */
  onLoadReasoning?: () => void;
}) {
  const rows = buildTimelineRows(timeline, toolEvents);

  if (rows.length === 0) return null;

  return (
    /*
     * No ornamental rule above the first action.
     *
     * In the reported tool-only reply the screen was: effort/tokens, one
     * full-width line, then `fetch_url`. With the reasoning panel absent, that
     * line looked exactly like a collapsed/broken thinking box. Rows after the
     * first still separate themselves below; the first needs no page break.
     */
    <div className="flex flex-col">
      {rows.map((row, i) =>
        row.think ? (
          <ThinkRow
            key={i}
            source={reasoning}
            start={row.think.start}
            end={row.think.end}
            // Live only while it is the newest row: once a tool or prose
            // lands after it, the round has moved on.
            live={Boolean(live && thinkingLive && i === rows.length - 1)}
            first={i === 0}
            onLoad={onLoadReasoning}
          />
        ) : (
        <TimelineRow
          key={i}
          text={row.text}
          tools={row.tools}
          first={i === 0}
          afterThink={Boolean(rows[i - 1]?.think)}
          live={live}
          onOpenFile={onOpenFile}
          markdownComponents={markdownComponents}
        />
        )
      )}
    </div>
  );
}
