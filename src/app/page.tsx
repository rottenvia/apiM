"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { Sidebar } from "@/components/Sidebar";
import { ChatArea } from "@/components/ChatArea";
import type { RewindDone, RewindPreview } from "@/components/RewindPopover";
import type { BtwEntry } from "@/components/BtwDock";
import { SettingsModal } from "@/components/SettingsModal";
import { PluginsModal } from "@/components/PluginsModal";
import { ArtifactProvider } from "@/components/ArtifactContext";
import { SearchModal } from "@/components/SearchModal";
import { McpConsole } from "@/components/McpConsole";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { WorkspaceSidePanel } from "@/components/WorkspaceSidePanel";
import type { WorkspaceFileInfo } from "@/components/WorkspaceBar";
import type { ToolEvent } from "@/components/ToolActivity";
import type { PendingCommand } from "@/components/ApprovalPrompt";
import type { PendingQuestion } from "@/components/QuestionPrompt";
import type { PlanView, PlanStepView } from "@/components/PlanPanel";
import type { TimelineEntry } from "@/components/MessageTimeline";
import { appendThinkRange } from "@/lib/timeline";
import { StreamPacer } from "@/lib/pacer";
import { clampDeleteDelay, DEFAULT_DELETE_DELAY } from "@/components/DeleteChatDialog";
import { warmRoutes } from "@/lib/warmup";
import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  FREE_OPENROUTER_MODEL_ID,
  MODELS,
  contextWindowFor,
  hasKeyForModel,
  resolveModelInfo,
  sanitizeCustomModelDef,
} from "@/lib/models";
import { EXPORT_FORMATS } from "@/lib/export";
import { parseBudget, type SlashOption } from "@/lib/slash-commands";
import type { ContextSummaryInfo } from "@/components/ContextMeter";
import type { CustomModelDef } from "@/lib/models";
import type { UsageLike } from "@/lib/pricing";
import {
  applyThemeById,
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  getTheme,
  sanitizeSeeds,
  THEMES,
} from "@/lib/themes";
import type { CustomThemeSeeds } from "@/lib/themes";
import { replyCanContinue } from "@/lib/resume-target";
import {
  shouldAutoResumeOnTimeout,
  visibleUpstreamNotice,
  type UpstreamNotice,
} from "@/lib/retry";

export interface Message {
  id: string;
  /**
   * Stable React identity for a reply created in this browser.
   *
   * The server replaces the temporary streaming id with the persisted message
   * id on `done`. Using `id` as the React key remounted the whole bubble at
   * that exact moment and erased its open thinking panel. This key never
   * changes during the live reply and is intentionally not persisted.
   */
  clientRenderKey?: string;
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string | null;
  /** Why a requested trace is absent, based on upstream stream metadata. */
  reasoningNotice?: string;
  thinkingEffort?: string;
  webSearchUsed?: boolean;
  searchResults?: { title: string; url: string; domain: string }[] | null;
  searchQueries?: string[];
  searchesPerformed?: number;
  pluginsUsed?: string[];
  tokenCount?: number;
  createdAt?: string;
  /** True while deltas are still arriving for this message. */
  isStreaming?: boolean;
  /** Renders the bubble in the error style instead of as a normal reply. */
  isError?: boolean;
  /**
   * How long the reasoning is, when the text itself has not been loaded.
   *
   * A stored chat sends this instead of the chain of thought, which on a long
   * conversation was about half the payload and is collapsed by default. The
   * text arrives only if the panel is opened.
   */
  reasoningLength?: number;
  /** How long the model spent reasoning, in ms — the "Thought for 12s" label. */
  reasoningMs?: number;
  /** Reply was cut short (tab closed / connection dropped) and can be retried. */
  incomplete?: boolean;
  /**
   * The interrupted reply kept everything it had worked out, so it can carry
   * on instead of starting again. Only set when that state was saved — an
   * older reply, from before this existed, can still be retried but not
   * resumed, and the UI must not promise otherwise.
   */
  canResume?: boolean;
  /**
   * Why an otherwise-resumable reply stopped, e.g. the balance running out.
   * Shown on the interrupted banner so the reason is visible without
   * discarding the work that was already done.
   */
  errorNotice?: string;
  /** Why auto-search did or didn't run, shown as a tooltip. */
  searchReason?: string;
  /** Files sent with this message, rendered as chips on the bubble. */
  attachments?: MessageAttachment[];
  /**
   * A steering note added while a reply was running ("btw …").
   *
   * It is a real user message in the conversation — the model acted on it —
   * but it rendered as a full bubble it would read like a new task started.
   * The compact note chip shows what it was: information handed to a task
   * that was already running.
   */
  isNote?: boolean;
  /** Full token usage, for cost estimation. */
  usage?: UsageLike | null;
  /** Model that produced the reply, needed to price it. */
  model?: string;
  /** Wall-clock time the reply took. */
  durationMs?: number;
  /** Chars in the final upstream request — the context this reply cost. */
  contextChars?: number;
  /** Tokens the final round occupied in the context window. */
  contextTokens?: number;
  /** Where those bytes lived, largest first. */
  contextBreakdown?: { label: string; chars: number }[];
  /** How the reply ended: final finish_reason plus continuations spent. */
  ending?: {
    finish: string | null;
    continuedOutput: number;
    continuedConnection: number;
    thinkOnlyStalls: number;
  };
  /** How many search rounds ran, and why the loop stopped. */
  searchRounds?: number;
  searchStopReason?: string;
  /** Searches answered from cache, which cost nothing. */
  searchCacheHits?: number;
  /** Estimated search spend for this reply, in USD. */
  searchUsd?: number;
  /**
   * Previous versions of this reply, kept when a message is edited or
   * regenerated so the two can be compared side by side.
   */
  previousVersions?: { content: string; model?: string; createdAt?: string }[];
  /** Text and actions in the order they happened, for the split view. */
  timeline?: TimelineEntry[];
  /** File operations the model ran while producing this reply. */
  toolEvents?: ToolEvent[];
  /** A command waiting on the user's Run / Skip decision. */
  pendingCommand?: PendingCommand | null;
  /** A question the model asked, waiting on an answer. */
  pendingQuestion?: PendingQuestion | null;
  /** The agent's plan for this reply, when it wrote one. */
  plan?: PlanView | null;
}

/** Lightweight record of an attachment, for display only. */
export interface MessageAttachment {
  name: string;
  kind: "text" | "image" | "video";
  /** Images and video: data URL for the inline thumbnail. */
  dataUrl?: string;
  /**
   * Videos in frames mode: the sampled stills; the first doubles as the
   * thumbnail. dataUrl present means a native clip instead. Never both.
   */
  frames?: { dataUrl: string; t: number }[];
  /** Frames metadata, display only. */
  durationSec?: number;
  frameIntervalSec?: number;
  /** Helper path only: what vision or OCR extracted. */
  description?: string;
  descriptionSource?: "vision" | "ocr";
}

/** What the assistant is currently doing, for the live status indicator. */
export type StatusStage =
  | "deciding"
  | "searching"
  | "thinking"
  | "writing"
  | "working";

/**
 * Normalise a stored `search_results` value. Newer rows hold real jsonb
 * arrays; older rows were written as a JSON *string*, so both are accepted.
 */
function parseSearchResults(
  value: unknown
): { title: string; url: string; domain: string }[] | null {
  if (!value) return null;
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  return Array.isArray(raw)
    ? (raw as { title: string; url: string; domain: string }[])
    : null;
}

/** Frames of the SSE protocol served by /api/chat. */
type StreamEvent =
  | { type: "status"; stage: StatusStage }
  | {
      type: "tool_drafting";
      name: string;
      chars: number;
      path: string | null;
      calls: number;
    }
  | {
      type: "request_size";
      round: number;
      inputChars: number;
      breakdown: { label: string; chars: number }[];
    }
  | {
      type: "meta";
      conversationId: string | null;
      messageId: string;
      title: string;
      resolvedEffort: string;
      thinkingEnabled: boolean;
      webSearchUsed: boolean;
      searchReason: string;
      searchRounds: number;
      searchStopReason: string;
      searchResults: { title: string; url: string; domain: string }[] | null;
      searchQueries: string[] | null;
      searchesPerformed: number;
      searchCacheHits: number;
      searchUsd: number;
    }
  | { type: "reasoning"; delta: string }
  | {
      type: "reasoning_status";
      status: "missing_round";
      round: number;
      model: string;
      effort: string;
      fieldsSeen: string[];
    }
  | {
      type: "retrying";
      phase?: "attempt" | "backoff" | "clear";
      attempt: number;
      attempts: number;
      delayMs: number;
      reason: string;
      detail?: string;
      host?: string;
      providerId?: string;
      inputChars?: number;
      breakdown?: { label: string; chars: number }[];
    }
  | { type: "continuing"; reason: string; n: number; of: number }
  | { type: "context_pruned"; collapsed: number; tokensSaved: number }
  | { type: "context_compacted"; rounds: number; tokensSaved: number }
  | {
      /** The running task read a mid-run note at a round boundary: it is a
       *  user message in the transcript now (chip), not a dock item. */
      type: "btw_note_accepted";
      id: string;
      note: string;
      round: number;
      attachments?: { name: string; kind: "text" | "image" | "video" }[];
    }
  | {
      type: "plan";
      goal: string;
      steps: PlanStepView[];
      summary: string;
    }
  | { type: "budget_warning"; spentUsd: number; limitUsd: number }
  | {
      type: "budget_stopped";
      spentUsd: number;
      limitUsd: number;
      reason: string;
    }
  | { type: "tool_start"; id: string; name: string; args: string }
  | {
      type: "approval_request";
      id: string;
      command: string;
      args: string[];
      display: string;
      reason: string;
    }
  | { type: "approval_resolved"; id: string; approved: boolean }
  | {
      type: "question";
      id: string;
      question: string;
      options: string[];
      context: string;
    }
  | { type: "question_resolved"; id: string; answered: boolean }
  | { type: "usage"; usage: UsageLike; model: string; contextTokens?: number }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      changedPath?: string;
    }
  | {
      type: "web_search";
      results: { title: string; url: string; domain: string }[];
      queries: string[];
      searchesPerformed: number;
      cacheHits: number;
      usd: number;
    }
  | { type: "content"; delta: string }
  | {
      type: "done";
      id: string;
      conversationId: string | null;
      persisted: boolean;
      usage: unknown;
      durationMs: number;
      reasoningMs?: number;
      contextChars?: number;
      contextTokens?: number;
      contextBreakdown?: { label: string; chars: number }[];
      ending?: {
        finish: string | null;
        continuedOutput: number;
        continuedConnection: number;
        thinkOnlyStalls: number;
      };
      model: string;
      incomplete?: boolean;
      canResume?: boolean;
      stopReason?: string;
      reasoningDiagnostic: {
        expected: boolean;
        chars: number;
        fieldsUsed: string[];
        fieldsSeen: string[];
      };
    }
  | { type: "error"; error: string; autoResume?: boolean };

export interface Conversation {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

/** Shape of a successful POST /api/chat response. */
interface ChatResponse {
  id?: string;
  conversationId?: string | null;
  content?: string;
  reasoningContent?: string | null;
  resolvedEffort?: string;
  webSearchUsed?: boolean;
  searchResults?: { title: string; url: string; domain: string }[] | null;
  searchQueries?: string[];
  searchesPerformed?: number;
  pluginsUsed?: string[];
  persisted?: boolean;
  usage?: { total_tokens?: number };
}

/**
 * One chat's transcript plus its run-level UI state, as a unit.
 *
 * The app shows one chat at a time, but switching to another chat must not
 * erase the one that is still working: a generation keeps streaming
 * server-side, and its frames need somewhere to land when the user is
 * looking at a different conversation. Each session is keyed by the
 * workspace/conversation id; the React states the screen renders are just a
 * mirror of whichever session is currently on top.
 */
/**
 * Stream events that neither add a row nor end the reply. The paced text
 * reveal flows straight through them; every other event is a boundary that
 * releases the backlog first, so rows never overtake the text before them.
 */
const PACE_THROUGH_EVENTS: ReadonlySet<string> = new Set([
  "reasoning",
  "content",
  "status",
  "usage",
  "request_size",
  "tool_drafting",
  "retrying",
  "context_pruned",
  "context_compacted",
]);

/**
 * The round in flight: its size, when it was fired, and whether anything
 * has come back yet. `answered` flips on the round's first reasoning,
 * prose or tool frame — until then the reply is waiting on the provider
 * (upload + prefill + first token), which on a big request is minutes of
 * a bubble that otherwise looks finished.
 */
type LiveRequest = {
  round: number;
  inputChars: number;
  breakdown: { label: string; chars: number }[];
  firedAt: number;
  answered: boolean;
};

/** The tool call the model is still writing — see the tool_drafting event. */
type LiveDrafting = {
  name: string;
  chars: number;
  path: string | null;
  calls: number;
  since: number;
};

type ChatSession = {
  messages: Message[];
  loading: boolean;
  stage: StatusStage | null;
  /** Persistent notice ("spending limit…", "connection dropped…"). */
  retryNotice: string | null;
  /** Transient retry/backoff, ticked by the 200ms clock while visible. */
  liveRetry: (UpstreamNotice & { receivedAt: number }) | null;
  /** Latest fired request's size, while its round is still running. */
  liveRequestSize: LiveRequest | null;
  /** A tool call streaming in (a file being written), until it completes. */
  liveDrafting: LiveDrafting | null;
  /** Server-side id of the in-flight reply, for the stop endpoint. */
  runMessageId: string | null;
  /** Set by Stop / new-chat: a pending auto-resume must not fire. */
  cancelResume: boolean;
};

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);

  /**
   * The workspace a new chat will use, allocated before it has been saved.
   *
   * A conversation only gets an id once its first message reaches the server,
   * but files are attached before that — so uploading a zip into a brand new
   * chat had nowhere to unpack to and was silently skipped. Reserving the id
   * up front means the workspace exists from the moment anything is dropped
   * on it, and the first message adopts the same id rather than creating a
   * second one.
   */
  const [draftConvId, setDraftConvId] = useState<string>(() => uuidv4());
  const workspaceId = currentConvId ?? draftConvId;
  /*
   * Per-conversation sessions (see ChatSession above).
   *
   * Every stream frame of a backgrounded chat is written into its own
   * session here — never dropped — so the task keeps filling its transcript
   * while the user chats in another conversation. Switching back shows the
   * complete, up-to-date reply. `sessionsVersion` bumps on any session change
   * so memoised UI (the sidebar's "running" dots) recomputes; the on-screen
   * states below are only a mirror of the active session and are synced
   * whenever the view changes OR the active session is written.
   */
  const sessionsRef = useRef<Map<string, ChatSession>>(new Map());
  const [sessionsVersion, setSessionsVersion] = useState(0);
  /**
   * The id the mirrored React states below belong to.
   *
   * Starts on the draft chat, not null. Only New chat and opening a chat
   * ever set it, so on a fresh page load it stayed null — and the first
   * message sent was written into the draft's session, which was not the
   * one on screen: the text box cleared, the reply ran (files appeared in
   * the workspace), and the chat itself stayed on "How can I help you
   * today?" until the user clicked it in the sidebar.
   */
  const mirroredIdRef = useRef<string | null>(draftConvId);

  const getSession = (id: string | null | undefined): ChatSession => {
    const key = id ?? "__none__";
    let s = sessionsRef.current.get(key);
    if (!s) {
      s = {
        messages: [],
        loading: false,
        stage: null,
        retryNotice: null,
        liveRetry: null,
        liveRequestSize: null,
        liveDrafting: null,
        runMessageId: null,
        cancelResume: false,
      };
      sessionsRef.current.set(key, s);
    }
    return s;
  };

  // Mirror of the active session. Setters route to the session via the
  // helpers below; writing these directly would desync on chat switch.
  const [messages, setMessagesState] = useState<Message[]>([]);
  const [isLoading, setIsLoadingState] = useState(false);
  const [statusStage, setStatusStageState] = useState<StatusStage | null>(
    null
  );
  // A persistent run notice ("spending limit…", "connection dropped…").
  const [retryNotice, setRetryNoticeState] = useState<string | null>(null);
  // Where the in-flight request's bytes live — the retry banner's tooltip.
  const [retryBreakdown, setRetryBreakdownState] = useState<
    { label: string; chars: number }[] | null
  >(null);
  // The provider's own message behind a rejection-driven retry.
  const [retryDetail, setRetryDetailState] = useState<string | null>(null);
  // Fire-time request size for the active run's latest round, if heavy.
  const [requestSize, setRequestSizeState] = useState<LiveRequest | null>(
    null
  );
  const [drafting, setDraftingState] = useState<LiveDrafting | null>(null);

  /** Copy a session's UI state into the mirrored React states. */
  const mirrorSession = useCallback((s: ChatSession) => {
    messagesRef.current = s.messages;
    setMessagesState(s.messages);
    setIsLoadingState(s.loading);
    setStatusStageState(s.stage);
    setRetryNoticeState(s.retryNotice);
    setRetryBreakdownState(s.liveRetry?.breakdown ?? null);
    setRetryDetailState(s.liveRetry?.detail ?? null);
    setRequestSizeState(s.liveRequestSize);
    setDraftingState(s.liveDrafting);
  }, []);

  /**
   * Point the mirrored states at a conversation's session, creating it
   * empty if needed. Used whenever the view changes chats.
   */
  const activateSession = useCallback(
    (id: string) => {
      mirroredIdRef.current = id;
      mirrorSession(getSession(id));
    },
    [mirrorSession]
  );

  /** Update one session's messages and its transcript cache in one move. */
  const writeMessages = useCallback(
    (
      id: string | null | undefined,
      updater: (prev: Message[]) => Message[],
      opts: { cache?: boolean } = {}
    ) => {
      const key = id ?? "__none__";
      const s = getSession(key);
      const next = updater(s.messages);
      s.messages = next;
      if (opts.cache !== false) conversationCache.current.set(key, next);
      // Only the visible chat drives the rendered transcript. Background
      // chats just accumulate into their session until the user switches.
      if (mirroredIdRef.current === key) {
        messagesRef.current = next;
        setMessagesState(next);
      }
      setSessionsVersion((v) => v + 1);
    },
    []
  );

  /** Patch one session's run-level UI fields, mirroring it if it is active. */
  const patchSession = useCallback(
    (
      id: string | null | undefined,
      patch: Partial<Omit<ChatSession, "messages">>
    ) => {
      const key = id ?? "__none__";
      const s = getSession(key);
      Object.assign(s, patch);
      if (mirroredIdRef.current === key) {
        if (patch.loading !== undefined) {
          messagesRef.current = s.messages;
          setMessagesState(s.messages);
          setIsLoadingState(s.loading);
        }
        if (patch.stage !== undefined) setStatusStageState(s.stage);
        if (patch.retryNotice !== undefined)
          setRetryNoticeState(s.retryNotice);
        if (patch.liveRetry !== undefined) {
          setRetryBreakdownState(s.liveRetry?.breakdown ?? null);
          setRetryDetailState(s.liveRetry?.detail ?? null);
        }
        if (patch.liveRequestSize !== undefined)
          setRequestSizeState(s.liveRequestSize);
        if (patch.liveDrafting !== undefined)
          setDraftingState(s.liveDrafting);
      }
      setSessionsVersion((v) => v + 1);
    },
    []
  );

  const setIsLoading = useCallback(
    (id: string | null | undefined, loading: boolean) =>
      patchSession(id, { loading }),
    [patchSession]
  );
  const setStatusStage = useCallback(
    (id: string | null | undefined, stage: StatusStage | null) =>
      patchSession(id, { stage }),
    [patchSession]
  );
  const setRetryNotice = useCallback(
    (id: string | null | undefined, notice: string | null) =>
      patchSession(id, { retryNotice: notice }),
    [patchSession]
  );
  /** Transient upstream failure being retried; shown rather than hidden. */
  const setLiveRetry = useCallback(
    (
      id: string | null | undefined,
      info: (UpstreamNotice & { receivedAt: number }) | null
    ) => {
      patchSession(id, {
        liveRetry: info,
        retryNotice: info ? visibleUpstreamNotice(info, Date.now()) : null,
      });
    },
    [patchSession]
  );
  /**
   * Fire-time request size, kept for every round: the bubble shows a live
   * "waiting for the model" row from here until the round's first frame.
   */
  const setLiveRequestSize = useCallback(
    (id: string | null | undefined, info: LiveRequest | null) => {
      patchSession(id, { liveRequestSize: info });
    },
    [patchSession]
  );
  /** The round's first frame arrived — the wait row goes. Cheap per delta. */
  const markRoundAnswered = useCallback(
    (id: string | null | undefined) => {
      const live = getSession(id).liveRequestSize;
      if (live && !live.answered) {
        patchSession(id, { liveRequestSize: { ...live, answered: true } });
      }
    },
    [patchSession]
  );

  /**
   * Move a draft conversation's whole client state under the real id the
   * server just assigned. The session, transcript cache and abort controller
   * all travel, so a run started before the chat was saved keeps streaming
   * into the conversation it actually belongs to.
   */
  const migrateSession = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const sessions = sessionsRef.current;
      const from = sessions.get(fromId);
      if (from) {
        const existing = sessions.get(toId);
        sessions.set(toId, existing ? { ...existing, ...from } : from);
        sessions.delete(fromId);
      }
      const cached = conversationCache.current.get(fromId);
      if (cached) {
        conversationCache.current.set(toId, cached);
        conversationCache.current.delete(fromId);
      }
      const ac = abortRefs.current.get(fromId);
      if (ac) {
        abortRefs.current.set(toId, ac);
        abortRefs.current.delete(fromId);
      }
      setSessionsVersion((v) => v + 1);
    },
    []
  );

  // The backoff countdown ticker: every 200ms re-derive the visible form of
  // the ACTIVE chat's transient retry so "retrying in 8s…" counts down.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = sessionsRef.current.get(mirroredIdRef.current ?? "__none__");
      const info = s?.liveRetry;
      if (!info) return;
      const next = visibleUpstreamNotice(info, Date.now());
      if (s.retryNotice !== next) {
        s.retryNotice = next;
        setRetryNoticeState(next);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  /** Ids of conversations with a reply in flight, for sidebar activity dots. */
  const runningIds = useMemo(() => {
    void sessionsVersion; // recompute when any session changes
    const ids = new Set<string>();
    for (const [id, s] of sessionsRef.current) {
      if (id === "__none__") continue;
      if (s.loading || s.messages.some((m) => m.isStreaming)) ids.add(id);
    }
    return ids;
  }, [sessionsVersion]);

  const [showSettings, setShowSettings] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /*
   * Phones start with the sidebar closed, and it floats over the chat.
   *
   * Reported (audit): below the md breakpoint the sidebar opened by default
   * as a 288px in-flow column, leaving ~87px of a 375px phone for the chat
   * itself. Checked on mount, not during SSR (the server has no viewport);
   * the startup splash covers the first paint, so there is no flash. Below
   * md the Sidebar renders as an overlay with a backdrop, and picking a
   * chat closes it (closeSidebarIfOverlay).
   */
  const isOverlayViewport = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches;
  useEffect(() => {
    queueMicrotask(() => {
      if (isOverlayViewport()) setSidebarOpen(false);
    });
  }, []);
  const closeSidebarIfOverlay = () => {
    if (isOverlayViewport()) setSidebarOpen(false);
  };

  // Workspace. The id follows the conversation so each chat gets its own
  // folder; `pendingWorkspaceId` covers a brand-new chat that has no id yet.
  // Always on. Every command still goes through the approval gate, and the
  // model only reaches for a file when a file is the answer — so switching
  // this off just meant code printed in chat for the user to save by hand.
  const workspaceEnabled = true;
  const [lessonsEnabled, setLessonsEnabled] = useState(false);
  /** When on, commands run without asking. Off by default, deliberately. */
  const [autoRunCommands, setAutoRunCommands] = useState(false);
  // Defaults to the balanced profile: the opening round skims and only the
  // gap the sufficiency check finds is worth a full-page read. "quality"
  // reproduces the original always-deep behaviour if this ever reads thin.
  const [searchProfile, setSearchProfile] = useState("balanced");
  /*
   * Which providers may be used, independent of whether a key is saved.
   *
   * Asked for after Tavily's quota died: "make that i can enable or disable
   * providers maybe that tavily is ruining that all". Deleting the key would
   * also work, but then you have to paste it back when the month rolls over.
   * A switch keeps the key and stops the calls.
   */
  const [tavilyEnabled, setTavilyEnabled] = useState(true);
  const [exaEnabled, setExaEnabled] = useState(true);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** The pinned workspace panel. Open by default once files exist. */
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [workspaceHighlight, setWorkspaceHighlight] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileInfo[]>([]);
  /** Paths the last reply touched, highlighted in the workspace bar. */
  const [recentlyChanged, setRecentlyChanged] = useState<string[]>([]);

  // Settings
  const [deepseekKey, setDeepseekKey] = useState("");
  const [openrouterKey, setOpenrouterKey] = useState("");
  /**
   * The user's own OpenRouter models. Sanitized on load, on add (Settings
   * only adds Verify-shaped entries) and again on the server per request.
   */
  const [customModels, setCustomModels] = useState<CustomModelDef[]>([]);
  const [themeId, setThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [customTheme, setCustomTheme] = useState<CustomThemeSeeds>(() =>
    sanitizeSeeds(null)
  );
  const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localApiModel, setLocalApiModel] = useState(DEFAULT_LOCAL_API_MODEL);

  /*
   * The low-balance banner was removed at the user's request: it covered the
   * composer on every lane (it read DeepSeek's balance even while chatting on
   * OpenRouter) and a real spending stop already surfaces as the reply's own
   * "insufficient balance" notice with Resume. No balance polling either —
   * one request after every reply for a figure nobody asked to see.
   */
  const [tavilyKey, setTavilyKey] = useState("");
  /** Optional fallback provider, used only when Tavily refuses. */
  const [exaKey, setExaKey] = useState("");
  const [visionKey, setVisionKey] = useState("");
  const [visionModel, setVisionModel] = useState("gpt-4o-mini");
  const [model, setModel] = useState("deepseek-v4-pro");
  /** False until localStorage has been read, so we don't unload Qwen on the default model. */
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [thinkingEffort, setThinkingEffort] = useState("auto");
  const [webSearchMode, setWebSearchMode] = useState<"off" | "auto" | "always">("auto");
  const [enabledPlugins, setEnabledPlugins] = useState<string[]>([]);
  /** Seconds the delete button stays locked in the confirmation dialog. */
  const [deleteDelay, setDeleteDelay] = useState(DEFAULT_DELETE_DELAY);
  /**
   * Spend ceiling per reply, in USD. `null` is no cap, which is the default:
   * a limit nobody chose that stops a task halfway is its own kind of bug.
   */
  const [budgetUsd, setBudgetUsd] = useState<number | null>(null);

  const hasKeys = hasKeyForModel(
    model,
    {
      deepseekKey,
      openrouterKey,
      localBaseUrl,
    },
    customModels
  );
  // Catalog or custom — labels, provider and key gating all read this.
  const activeModelInfo = useMemo(
    () => resolveModelInfo(model, customModels),
    [model, customModels]
  );
  const initialLoadDone = useRef(false);
  /** Current workspace id, readable from callbacks without re-creating them. */
  const workspaceIdRef = useRef<string | null>(workspaceId);
  /** Latest conversation list, so rename can restore the old title on failure. */
  const conversationsRef = useRef<Conversation[]>([]);
  /** Lets the Stop button cancel an in-flight stream. */
  // One AbortController per in-flight conversation. Switching chats must NOT
  // abort another chat's generation; frames route to their own conversation
  // by message id, so multiple chats can generate simultaneously and the user
  // can browse another chat while one streams.
  const abortRefs = useRef<Map<string, AbortController>>(new Map());
  const abortFor = (id: string | null | undefined) =>
    id ? abortRefs.current.get(id) : undefined;
  /**
   * Per-chat run state — server-side message id (for Stop), the pending
   * auto-resume bubble id, and the Stop/new-chat cancel flag — lives on the
   * ChatSession now, not in globals: two chats running at once must not share
   * one "the" running message or cancel each other's resume.
   */
  const autoResumeCounts = useRef(new Map<string, number>());

  /*
   * The mid-run note channel.
   *
   * "btw …" while a task runs is steering for the RUNNING task: the note is
   * queued on the conversation and the agent loop folds it into the
   * transcript at the next round boundary — so the model reads it as a fresh
   * user message mid-think, and nothing that was running is interrupted.
   *
   * The dock state is transient (passing → passed → read at step N); the
   * permanent record is the note chip the `btw_note_accepted` stream event
   * adds to `messages`, which is why the chip — not the dock — is what
   * survives a reload.
   *
   * Its own AbortController too, deliberately not `abortRef` — Stop belongs
   * to the main task and dismissing the note must not touch it.
   */
  const [btwEntry, setBtwEntry] = useState<BtwEntry | null>(null);
  /*
   * Per chat: the stored summary standing in for older turns (from the
   * conversation file, refreshed by /compact), and after /compact the
   * estimated window until the next reply reports its real size.
   */
  const [summaryByConv, setSummaryByConv] = useState<
    Record<string, (ContextSummaryInfo & { upToId: string }) | null>
  >({});
  const [estimateByConv, setEstimateByConv] = useState<
    Record<string, { tokens: number; afterMessageId: string | null }>
  >({});
  const btwAbortRef = useRef<AbortController | null>(null);
  // The dock is a confirmation, not a record. A queued note gets its record
  // in the transcript the moment the task reads it, so the popup gets out of
  // the way on its own. A failed note stays until dismissed — that one needs
  // to be seen.
  const btwDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearBtwDismiss = () => {
    if (btwDismissTimer.current) {
      clearTimeout(btwDismissTimer.current);
      btwDismissTimer.current = null;
    }
  };

  const scheduleBtwDismiss = (id: string) => {
    clearBtwDismiss();
    btwDismissTimer.current = setTimeout(() => {
      btwDismissTimer.current = null;
      setBtwEntry((prev) => (prev && prev.id === id ? null : prev));
    }, 1800);
  };

  useEffect(() => clearBtwDismiss, []);

  const dismissBtw = useCallback(() => {
    clearBtwDismiss();
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    setBtwEntry(null);
  }, []);

  const sendBtwNote = useCallback(
    async (
      note: string,
      wireText: string,
      attachments: MessageAttachment[]
    ) => {
      const text = note.trim();
      /*
       * The run's conversation, read from the ref at send time — not the
       * rendered `currentConvId`.
       *
       * Reported (audit): during the FIRST run of a new chat currentConvId
       * stayed null until `done`, so every btw note in that window was
       * silently dropped — after ChatArea had already cleared the input.
       * The ref holds the id this chat's run was sent under (the draft id
       * the server adopts, or the real id once `meta` migrated it).
       */
      const convId = workspaceIdRef.current;
      if (!text || !convId) return;

      // One at a time in the dock. A second note replaces the first's
      // display rather than stacking — both notes still reach the task,
      // they are queued server-side.
      clearBtwDismiss();
      btwAbortRef.current?.abort();
      const controller = new AbortController();
      btwAbortRef.current = controller;

      const id = `btw-${Date.now()}`;
      setBtwEntry({
        id,
        note: text,
        status: "sending",
        attachmentNames: attachments.map((a) => a.name),
      });

      try {
        const res = await fetch("/api/btw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          // wireText + attachments are the same pair a normal send posts:
          // the model-facing text (file blocks inlined) and the stored
          // attachment metadata (pixels, image descriptions).
          body: JSON.stringify({
            conversationId: convId,
            // Lets a "don't run it" note skip a pending approval in the
            // right scope instead of landing after the user clicked.
            workspaceId: convId,
            note: text,
            wireText,
            attachments,
          }),
        });

        const data = (await res.json()) as {
          queued?: boolean;
          error?: string;
          skippedApprovals?: number;
        };
        if (controller.signal.aborted) return;

        const queued = res.ok && !data.error;
        const skipped =
          typeof data.skippedApprovals === "number" && data.skippedApprovals > 0
            ? data.skippedApprovals
            : undefined;
        setBtwEntry((prev) =>
          prev && prev.id === id
            ? res.ok
              ? { ...prev, status: "queued", skippedApprovals: skipped }
              : { ...prev, status: "queued", error: data.error ?? `HTTP ${res.status}` }
            : prev
        );
        // A clean hand-off confirms and fades on its own; the transcript chip
        // that appears when the task reads the note is the record.
        if (queued) scheduleBtwDismiss(id);
      } catch (err) {
        if (controller.signal.aborted) return;
        setBtwEntry((prev) =>
          prev && prev.id === id
            ? {
                ...prev,
                error:
                  err instanceof Error
                    ? `Couldn't pass the note to the running task: ${err.message}`
                    : "Couldn't pass the note to the running task.",
              }
            : prev
        );
      }
    },
    []
  );
  /** Latest messages + sender, so stable callbacks can read them. */
  const messagesRef = useRef<Message[]>([]);
  const sendMessageRef = useRef<
    | ((
        content: string,
        options?: {
          regenerateFromId?: string;
          resumeMessageId?: string;
          /** Extra instruction typed alongside "resume". */
          resumeNote?: string;
          /** Answer with this model instead of the selected one. */
          modelOverride?: string;
          previousVersions?: Message["previousVersions"];
          /** Skip the in-flight guard so a timeout can resume itself. */
          force?: boolean;
          /**
           * Run in a specific conversation, even if the user has since
           * switched to another. Used by a background run's auto-resume.
           */
          conversationId?: string;
          /** Files to send with the message (Retry / Edit re-send them). */
          attachments?: MessageAttachment[];
          /** Edit: the question's new text, for the stored copy. */
          editedContent?: string;
        }
      ) => void)
    | null
  >(null);

  // Load settings from localStorage after mount (deferred to a microtask so
  // state updates don't cascade synchronously through the first commit)
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        /*
         * The read itself is inside the try, and the hydrated flag is set in
         * `finally`.
         *
         * Reported (audit): localStorage.getItem sat outside the try/catch.
         * It throws in a locked-down or storage-disabled browser, and then
         * settingsHydrated never became true — the startup splash waited
         * for it and hung the full 12s fallback. A failed read now just
         * means default settings.
         */
        try {
          const saved = localStorage.getItem("nexusai-settings");
          if (saved) {
            const s = JSON.parse(saved);
            if (s.deepseekKey) setDeepseekKey(s.deepseekKey);
            if (s.openrouterKey) setOpenrouterKey(s.openrouterKey);
            if (Array.isArray(s.customModels)) {
              const clean: CustomModelDef[] = [];
              for (const entry of s.customModels) {
                const def = sanitizeCustomModelDef(entry);
                if (def) clean.push(def);
              }
              // Stored ids predate the slug rules; re-slug without renaming.
              setCustomModels(clean);
            }
            if (
              typeof s.themeId === "string" &&
              (s.themeId === CUSTOM_THEME_ID || getTheme(s.themeId).id === s.themeId)
            ) {
              setThemeId(s.themeId);
            }
            if (s.customTheme) setCustomTheme(sanitizeSeeds(s.customTheme));
            if (typeof s.localBaseUrl === "string" && s.localBaseUrl.trim()) {
              setLocalBaseUrl(s.localBaseUrl);
            }
            if (typeof s.localApiKey === "string") setLocalApiKey(s.localApiKey);
            if (typeof s.localApiModel === "string" && s.localApiModel.trim()) {
              setLocalApiModel(s.localApiModel);
            }
            if (s.tavilyKey) setTavilyKey(s.tavilyKey);
            if (s.exaKey) setExaKey(s.exaKey);
            // Explicit false only: an older saved settings object has neither
            // field, and the default is on.
            if (s.tavilyEnabled === false) setTavilyEnabled(false);
            if (s.exaEnabled === false) setExaEnabled(false);
            if (s.visionKey) setVisionKey(s.visionKey);
            if (s.visionModel) setVisionModel(s.visionModel);
            // Retired ids land on the lane that replaced them: Ox, the
            // first free Flash, and the pulled 0731 free slug all merge
            // into the current free id. A dangling custom id (a deleted
            // model, a hand-edited blob) falls back to the default
            // rather than displaying a model that no longer exists.
            if (
              s.model === "ox-alpha" ||
              s.model === "deepseek-v4-flash-free" ||
              s.model === "deepseek-v4-flash-0731-free"
            ) {
              setModel(FREE_OPENROUTER_MODEL_ID);
            } else if (typeof s.model === "string" && s.model) {
              const dangling =
                s.model.startsWith("custom:") &&
                !(
                  Array.isArray(s.customModels) &&
                  s.customModels.some(
                    (c: unknown) => sanitizeCustomModelDef(c)?.id === s.model
                  )
                );
              setModel(dangling ? DEFAULT_MODEL_ID : s.model);
            }
            if (s.thinkingEffort) setThinkingEffort(s.thinkingEffort);
            if (s.enabledPlugins) setEnabledPlugins(s.enabledPlugins);
            if (s.webSearchMode) setWebSearchMode(s.webSearchMode);
            // Only a literal true switches this on, so a corrupted or
            // half-written settings blob can never silently enable it.
            if (s.autoRunCommands === true) setAutoRunCommands(true);
            if (s.lessonsEnabled === true) setLessonsEnabled(true);
            if (typeof s.searchProfile === "string") {
              setSearchProfile(s.searchProfile);
            }
            if (s.sidePanelOpen === false) setSidePanelOpen(false);
            // Only a positive number is a cap. Anything else — null, 0, a
            // corrupted string — means no limit, never "stop immediately".
            if (typeof s.budgetUsd === "number" && s.budgetUsd > 0) {
              setBudgetUsd(s.budgetUsd);
            }
            // Clamped on read as well as write: a hand-edited or older
            // localStorage value must not produce an un-closable dialog.
            if (s.deleteDelay !== undefined) {
              setDeleteDelay(clampDeleteDelay(s.deleteDelay));
            }
          }
        } catch {
          /* ignore — unreadable or corrupt settings fall back to defaults */
        } finally {
          initialLoadDone.current = true;
          setSettingsHydrated(true);
        }
      }
    });
  }, []);

  // Save settings
  useEffect(() => {
    if (initialLoadDone.current && typeof window !== "undefined") {
      localStorage.setItem(
        "nexusai-settings",
        JSON.stringify({
          deepseekKey,
          openrouterKey,
          customModels,
          themeId,
          customTheme,
          localBaseUrl,
          localApiKey,
          localApiModel,
          tavilyKey,
          exaKey,
          tavilyEnabled,
          exaEnabled,
          visionKey,
          visionModel,
          model,
          thinkingEffort,
          enabledPlugins,
          webSearchMode,
          autoRunCommands,
          lessonsEnabled,
          searchProfile,
          sidePanelOpen,
          deleteDelay,
          budgetUsd,
        })
      );
    }
  }, [
    deepseekKey,
    openrouterKey,
    customModels,
    themeId,
    customTheme,
    localBaseUrl,
    localApiKey,
    localApiModel,
    tavilyKey,
    exaKey,
    tavilyEnabled,
    exaEnabled,
    visionKey,
    visionModel,
    model,
    thinkingEffort,
    enabledPlugins,
    webSearchMode,
    autoRunCommands,
    lessonsEnabled,
    searchProfile,
    sidePanelOpen,
    deleteDelay,
    budgetUsd,
  ]);

  // The palette is CSS vars on :root, so switching is instant and every
  // component follows — including bubbles rendered before the change.
  useEffect(() => {
    applyThemeById(themeId, customTheme);
  }, [themeId, customTheme]);

  /** Sends the user's Run / Skip answer back to the waiting request. */
  const decideCommand = useCallback(
    async (id: string, approved: boolean, remember: boolean) => {
      // Clear immediately: the server confirms separately, and leaving the
      // buttons live invites a second click that would 404.
      writeMessages(
        workspaceIdRef.current,
        (prev) =>
          prev.map((m) =>
            m.pendingCommand?.id === id ? { ...m, pendingCommand: null } : m
          )
      );
      try {
        await fetch("/api/chat/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, approved, remember }),
        });
      } catch {
        /* the request times out on its own if this never lands */
      }
    },
    [writeMessages]
  );

  /** Sends the user's answer back to the waiting request. */
  const answerQuestion = useCallback(
    async (id: string, answer: string) => {
      // Cleared immediately: the server confirms separately, and leaving the
      // input live invites a second submit that would 404.
      writeMessages(
        workspaceIdRef.current,
        (prev) =>
          prev.map((m) =>
            m.pendingQuestion?.id === id ? { ...m, pendingQuestion: null } : m
          )
      );
      try {
        await fetch("/api/chat/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, answer }),
        });
      } catch {
        /* the request times out on its own if this never lands */
      }
    },
    [writeMessages]
  );

  /**
   * User acted on the plan panel.
   *
   * "unblock" reopens blocked steps on disk (the agent reads it next reply);
   * "clear" deletes plan.json outright. Both reflect immediately in the UI —
   * a stuck red step that stays on screen after the click would look like
   * the action did nothing.
   */
  const planAction = useCallback(
    async (action: "unblock" | "clear") => {
      const id = workspaceIdRef.current;
      if (!id) return;

      writeMessages(id, (prev) =>
        prev.map((m) => {
          if (!m.plan) return m;
          if (action === "clear") return { ...m, plan: undefined };
          return {
            ...m,
            plan: {
              ...m.plan,
              steps: m.plan.steps.map((s) =>
                s.state === "blocked"
                  ? { ...s, state: "todo", blocker: undefined }
                  : s
              ),
            },
          };
        })
      );

      try {
        if (action === "clear") {
          await fetch(`/api/workspace/${id}/plan`, { method: "DELETE" });
        } else {
          await fetch(`/api/workspace/${id}/plan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "unblock" }),
          });
        }
      } catch {
        /* The UI already moved; a disk failure just means the next reply
           re-sees the old plan — recoverable, not worth an error toast. */
      }
    },
    [writeMessages]
  );

  /**
   * Stable identity so it can be passed down to memoized message bubbles
   * without giving them a new prop on every render.
   */
  const openWorkspace = useCallback((filePath?: string) => {
    setWorkspaceHighlight(filePath ?? null);
    setShowWorkspace(true);
  }, []);

  /**
   * Refresh the file count shown on the composer chip.
   *
   * Reads through a ref because the id can be assigned mid-stream, when the
   * server creates the conversation — a captured value would be stale.
   */
  const refreshWorkspaceFiles = useCallback(async () => {
    const id = workspaceIdRef.current;
    if (!id) {
      setWorkspaceFiles([]);
      return;
    }
    try {
      const res = await fetch(`/api/workspace/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as { files?: WorkspaceFileInfo[] };
      // Ignore a response that arrived after the user switched chats, or the
      // bar would list another conversation's files.
      if (workspaceIdRef.current !== id) return;
      setWorkspaceFiles(Array.isArray(data.files) ? data.files : []);
    } catch {
      /* cosmetic — leave the last known list rather than blanking it */
    }
  }, []);

  /**
   * The same refresh, but at most a few times a second.
   *
   * Every completed write asked the server for the whole file list, and each
   * of those is a full recursive walk of the workspace. One `write_files`
   * call creating thirty files therefore fired thirty walks back to back —
   * measured at 1.2 seconds of disk work and 1.5MB of JSON to arrive at a
   * single final state, while the agent was still running.
   *
   * Trailing rather than leading: during a burst only the last state is
   * interesting, and asking after the writes have stopped is what makes the
   * answer correct. The panel still updates during a long run, which is the
   * behaviour this must not lose — it just stops asking thirty times for the
   * same answer.
   */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleWorkspaceRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refreshWorkspaceFiles();
    }, 300);
  }, [refreshWorkspaceFiles]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    []
  );

  // Load the conversation list. Guarded against non-JSON responses so a
  // backend problem degrades to "no history" instead of throwing.
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) setConversations(data as Conversation[]);
    } catch {
      /* ignore */
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  /** The first chat-list fetch has answered (either way). */
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  // Lift the startup splash (see layout.tsx) once the app can actually be
  // used: settings read and the chat list in.
  useEffect(() => {
    if (!settingsHydrated || !conversationsLoaded) return;
    const splash = document.getElementById("app-splash");
    if (!splash) return;
    // Hidden, not removed: the node belongs to the server-rendered layout,
    // and pulling it out from under React can break a later reconcile.
    splash.classList.add("is-done");
  }, [settingsHydrated, conversationsLoaded]);

  useEffect(() => {
    // Deferred to a microtask so the fetch's setState never lands
    // synchronously inside the effect body and cascade a re-render.
    queueMicrotask(() => {
      void refreshConversations();
      // Compile the workspace-backed routes while the page is still being
      // read. Without this the first chat click of a session pays ~600ms of
      // one-off module compilation that every later click avoids.
      warmRoutes();
    });
  }, [refreshConversations]);

  // Ctrl/Cmd+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /** Cache of loaded conversations, so switching back is instant. */
  const conversationCache = useRef(new Map<string, Message[]>());
  const loadSeq = useRef(0);
  /** Aborts the in-flight chat load when another chat is clicked. */
  const loadAbortRef = useRef<AbortController | null>(null);
  /** Chat id currently loading from disk — the skeleton shows for it. */
  const [loadingConv, setLoadingConv] = useState<string | null>(null);

  /*
   * Rejoin a run that is still going on the server.
   *
   * Runs deliberately outlive their tab (only Stop ends one), but a reloaded
   * or reopened app showed such a chat as just the question: no reply, no
   * progress, no Stop — as if the run had died, inviting a second send that
   * started a parallel run. Now an unfinished last reply is checked against
   * the server's live runs; if it is live, the bubble shows as streaming
   * (spinner, Stop, composer locked) and follows the server's saved
   * progress every couple of seconds until the run ends.
   */
  /*
   * One cancel token per conversation's rejoin loop.
   *
   * Reported (audit): the polling loop below was never cancelled. Stop did
   * not end it, so it kept writing the disk copy over the bubble every 2s —
   * including over a Resume's live bubble (stale text, isStreaming from the
   * old run) — and its `finally` set loading:false on a NEW run in the same
   * chat, unlocking the composer mid-reply. Starting a rejoin, Stop, a new
   * send in that chat and unmount all cancel it; it also stands down the
   * moment a live stream owns the chat (abortRefs), which is the stream's
   * job to render.
   */
  const rejoinTokens = useRef<Map<string, { cancelled: boolean }>>(new Map());
  const cancelRejoin = useCallback((convId: string | null | undefined) => {
    if (!convId) return;
    const token = rejoinTokens.current.get(convId);
    if (token) token.cancelled = true;
    rejoinTokens.current.delete(convId);
  }, []);
  useEffect(() => {
    const tokens = rejoinTokens.current;
    return () => {
      for (const token of tokens.values()) token.cancelled = true;
      tokens.clear();
    };
  }, []);
  const rejoinRun = useCallback(
    async (
      convId: string,
      knownMessageId: string | null,
      opts: {
        /**
         * The caller left the chat's composer locked (a stream that dropped
         * while its server run may still be going): if the run turns out
         * not to be live, unlock it here instead of leaving it stuck.
         */
        heldLoading?: boolean;
      } = {}
    ) => {
      // One loop per chat. A second call (reopening the chat while its
      // loop runs) leaves the running one alone; a dropped stream's call
      // (heldLoading) replaces it, since it knows the exact reply to follow.
      const running = rejoinTokens.current.get(convId);
      if (running && !running.cancelled && !opts.heldLoading) return;
      cancelRejoin(convId);
      const token = { cancelled: false };
      rejoinTokens.current.set(convId, token);
      const cancelled = () =>
        token.cancelled || abortRefs.current.has(convId);
      const release = () => {
        if (rejoinTokens.current.get(convId) === token) {
          rejoinTokens.current.delete(convId);
        }
      };
      /*
       * null = the check itself failed (offline, server restarting), which
       * is not the same as "no run". A dropped stream is usually exactly
       * that moment: treating a failed check as "not live" gave up on the
       * run on the spot and unlocked the composer while it kept going.
       */
      const runningIds = async (): Promise<string[] | null> => {
        try {
          const r = await fetch(
            `/api/chat/stop?conversationId=${encodeURIComponent(convId)}`
          );
          if (!r.ok) return null;
          const j = (await r.json()) as { running?: string[] };
          return Array.isArray(j.running) ? j.running : [];
        } catch {
          return null;
        }
      };
      const RECHECK_MS = 2000;
      /** ~1 minute of failed checks before a rejoin gives up. */
      const MAX_FAILED_CHECKS = 30;
      // Unknown id: the run has not saved its reply yet (still waiting for
      // its first tokens), so the chat on disk ends with the question.
      let checked = await runningIds();
      // A dropped stream keeps asking through a short outage.
      for (
        let tries = 0;
        checked === null && opts.heldLoading && tries < MAX_FAILED_CHECKS;
        tries++
      ) {
        if (cancelled()) break;
        await new Promise((r) => setTimeout(r, RECHECK_MS));
        if (cancelled()) break;
        checked = await runningIds();
      }
      const first = checked ?? [];
      const messageId = knownMessageId ?? first[0] ?? null;
      if (
        cancelled() ||
        !messageId ||
        !first.includes(messageId)
      ) {
        // Nothing to follow. A composer held locked for this check is
        // released — unless a newer run or Stop owns the chat by now.
        if (opts.heldLoading && !cancelled()) {
          patchSession(convId, {
            loading: false,
            stage: null,
            runMessageId: null,
          });
        }
        release();
        return;
      }
      let failedChecks = 0;
      /** Unknown (a failed check) counts as live, up to MAX_FAILED_CHECKS. */
      const isLive = async () => {
        const ids = await runningIds();
        if (ids === null) {
          failedChecks += 1;
          return failedChecks < MAX_FAILED_CHECKS;
        }
        failedChecks = 0;
        return ids.includes(messageId);
      };
      if (!knownMessageId) {
        writeMessages(convId, (prev) => {
          if (prev.some((m) => m.id === messageId)) return prev;
          const fresh: Message = {
            id: messageId,
            role: "assistant",
            content: "",
            isStreaming: true,
            createdAt: new Date().toISOString(),
          };
          // A stream that died before its `meta` frame left a provisional
          // `stream-…` bubble. The server run it started is this one, so
          // it takes that bubble's place rather than stacking a second.
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.id.startsWith("stream-")) {
            return [
              ...prev.slice(0, -1),
              { ...fresh, clientRenderKey: last.clientRenderKey ?? last.id },
            ];
          }
          return [...prev, fresh];
        });
      } else {
        // The run is live: show it as running now, not after the first
        // 2s poll — a dropped stream marked this bubble interrupted.
        writeMessages(convId, (prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  isStreaming: true,
                  incomplete: false,
                  canResume: false,
                  ...(m.isError ? { isError: false, content: "" } : {}),
                }
              : m
          )
        );
      }
      getSession(convId).runMessageId = messageId;
      patchSession(convId, { loading: true, stage: "working" });
      let reasoningShown = -1;
      try {
        for (;;) {
          if (cancelled()) return;
          const live = await isLive();
          if (cancelled()) return;
          let raw: Record<string, unknown> | undefined;
          try {
            const res = await fetch(`/api/conversations/${convId}`);
            const data = (await res.json()) as { messages?: unknown[] };
            raw = (data.messages ?? []).find(
              (m) => (m as { id?: string }).id === messageId
            ) as Record<string, unknown> | undefined;
          } catch {
            raw = undefined;
          }
          if (raw) {
            const reasoningLength = (raw.reasoningLength as number) ?? 0;
            let reasoning: string | undefined;
            if (reasoningLength > 0 && reasoningLength !== reasoningShown) {
              try {
                const r = await fetch(
                  `/api/conversations/${convId}/reasoning/${messageId}`
                );
                reasoning = ((await r.json()) as { reasoning?: string }).reasoning;
                reasoningShown = reasoningLength;
              } catch {
                reasoning = undefined;
              }
            }
            const found = raw;
            // Checked after every await: Stop or a new run may own the
            // bubble by now, and a stale disk copy must not overwrite it.
            if (cancelled()) return;
            writeMessages(convId, (prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content: (found.content as string) ?? m.content,
                      reasoningContent: reasoning ?? m.reasoningContent,
                      reasoningLength,
                      toolEvents: Array.isArray(found.toolEvents)
                        ? (found.toolEvents as ToolEvent[])
                        : m.toolEvents,
                      timeline: Array.isArray(found.timeline)
                        ? (found.timeline as TimelineEntry[])
                        : m.timeline,
                      plan: found.plan ? (found.plan as PlanView) : m.plan,
                      thinkingEffort:
                        (found.thinkingEffort as string | undefined) ?? m.thinkingEffort,
                      isStreaming: live,
                      incomplete: live ? false : found.incomplete === true,
                      canResume: live ? false : found.canResume === true,
                    }
                  : m
              )
            );
          }
          if (!live) break;
          await new Promise((r) => setTimeout(r, RECHECK_MS));
        }
      } finally {
        // A cancelled loop leaves the chat's state alone: Stop already
        // reset it, and a new run in this chat owns `loading` now.
        if (!cancelled()) {
          // Gave up without a final disk copy (the server stayed out of
          // reach): the bubble must not be left spinning with no run.
          writeMessages(convId, (prev) =>
            prev.map((m) =>
              m.id === messageId && m.isStreaming
                ? {
                    ...m,
                    isStreaming: false,
                    incomplete: true,
                    canResume: Boolean(
                      m.content?.trim() ||
                        m.reasoningContent?.trim() ||
                        m.toolEvents?.length
                    ),
                  }
                : m
            )
          );
          patchSession(convId, {
            loading: false,
            stage: null,
            runMessageId: null,
          });
        }
        release();
      }
    },
    [patchSession, writeMessages, cancelRejoin]
  );

  const loadConversation = useCallback(
    async (id: string) => {
      // Switching chats deliberately does NOT abort the other chat's stream:
      // it keeps generating server-side and its frames keep landing in its
      // own ChatSession, so a task that is running never disappears — and
      // you can read or even chat in another conversation meanwhile. Only an
      // explicit Stop (or navigating away from the app) cancels a run. A
      // note's POST is in-flight, though, and it belongs to the conversation
      // being left — close the dock with it.
      btwAbortRef.current?.abort();
      setBtwEntry(null);
      // Each load gets a sequence number; a slower earlier response is ignored
      // once a newer one starts, so rapidly switching chats can't leave the
      // wrong transcript on screen.
      const seq = ++loadSeq.current;
      // A fast clicker used to pile up full-transcript downloads and parses
      // with no cancellation — each one froze the tab in turn. The newest
      // click kills the previous load; the sequence number still guards the
      // race the abort cannot (an already-arrived response).
      loadAbortRef.current?.abort();
      const loadController = new AbortController();
      loadAbortRef.current = loadController;
      setLoadingConv(id);
      workspaceIdRef.current = id;
      setCurrentConvId(id);

      // Show this conversation's session immediately — cached transcript
      // and, if it is still working, its live bubble, spinner and stage —
      // then refresh from disk in the background.
      activateSession(id);

      // An empty session (never opened this tab) starts from the cached
      // transcript so the paint is instant instead of waiting on disk.
      const cached = conversationCache.current.get(id);
      if (cached !== undefined) {
        const s = sessionsRef.current.get(id);
        if (s && s.messages.length === 0 && !s.loading) s.messages = cached;
        activateSession(id);
      }

      try {
        const res = await fetch(`/api/conversations/${id}`, {
          signal: loadController.signal,
        });
        if (!res.ok || seq !== loadSeq.current) return;

      const data = (await res.json()) as {
        messages?: unknown;
        historySummary?: unknown;
      };
      if (seq !== loadSeq.current) return;
      setSummaryByConv((prev) => ({
        ...prev,
        [id]: parseHistorySummary(data.historySummary),
      }));

      const list = Array.isArray(data.messages) ? data.messages : [];
      /*
       * Structural equality for the re-parse. Every load builds fresh
       * object identities, so `===` on tool/timeline/plan state is always
       * false and the "skip the swap" optimization below never fired on
       * agent chats — every click re-rendered the whole transcript. Event
       * history is append-only, so id sequences are enough; plans are
       * small enough to stringify.
       */
      const sameIds = (a?: { id: string }[], b?: { id: string }[]) =>
        a === b ||
        (a?.length === b?.length &&
          (a ?? []).every((e, i) => e.id === b?.[i]?.id));
      const sameTimeline = (
        a?: TimelineEntry[],
        b?: TimelineEntry[]
      ): boolean =>
        a === b ||
        (a?.length === b?.length &&
          (a ?? []).every((e, i) => {
            const o = b?.[i];
            if (o === undefined || e.kind !== o.kind) return false;
            if (e.kind === "think") {
              const t = o as { start: number; end: number };
              return e.start === t.start && e.end === t.end;
            }
            return e.kind === "tool"
              ? e.id === (o as { id: string }).id
              : e.text === (o as { text: string }).text;
          }));
      const parsed: Message[] = list.map((raw) => {
        const m = raw as Record<string, unknown>;
        return {
          id: m.id as string,
          role: m.role as "user" | "assistant",
          content: (m.content as string) ?? "",
          reasoningContent: m.reasoningContent as string | null | undefined,
          // Sent as a length, not text — the body is fetched when the panel
          // is opened. See api/conversations/[id]/reasoning.
          reasoningLength: m.reasoningLength as number | undefined,
          reasoningMs: m.reasoningMs as number | undefined,
          thinkingEffort: m.thinkingEffort as string | undefined,
          webSearchUsed: m.webSearchUsed as boolean | undefined,
          searchResults: parseSearchResults(m.searchResults),
          searchQueries: Array.isArray(m.searchQueries)
            ? (m.searchQueries as string[])
            : undefined,
          tokenCount: m.tokenCount as number | undefined,
          usage: (m.usage as UsageLike | null) ?? null,
          model: m.model as string | undefined,
          durationMs: m.durationMs as number | undefined,
          contextChars: m.contextChars as number | undefined,
          contextTokens: m.contextTokens as number | undefined,
          contextBreakdown: Array.isArray(m.contextBreakdown)
            ? (m.contextBreakdown as { label: string; chars: number }[])
            : undefined,
          ending: (m.ending as Message["ending"]) ?? undefined,
          createdAt: m.createdAt as string | undefined,
          incomplete: m.incomplete === true,
          // The server sends a flag, never the saved transcript itself: it
          // can run to megabytes and the browser has no use for it.
          canResume: m.canResume === true,
          // Mid-run steering note → compact chip, not a task bubble.
          isNote: m.note === true,
          attachments: Array.isArray(m.attachments)
            ? (m.attachments as Message["attachments"])
            : undefined,
          // Deliberately not restored: a question from a finished reply has
          // nothing listening for the answer any more.
          toolEvents: Array.isArray(m.toolEvents)
            ? (m.toolEvents as ToolEvent[])
            : undefined,
          timeline: Array.isArray(m.timeline)
            ? (m.timeline as TimelineEntry[])
            : undefined,
          // Needed so a typed "continue" after reload can see an unfinished
          // plan. Dropping it made missed-detection resumes look like a
          // finished Q&A and open a new thought box.
          plan: m.plan ? (m.plan as PlanView) : undefined,
        };
      });

        /*
         * Never overwrite a LIVE session with the disk copy.
         *
         * The saved transcript has no in-flight bubble at all, so a disk
         * refresh mid-run used to wipe the streaming reply off the screen —
         * exactly the "task fully disappears when I click another chat"
         * report. A run in this chat owns its own messages until it ends;
         * only then does the next load pull the finished transcript.
         */
        const live = sessionsRef.current.get(id);
        const hasLiveRun =
          live !== undefined &&
          (live.loading || live.messages.some((m) => m.isStreaming));

        if (!hasLiveRun) {
          conversationCache.current.set(id, parsed);
          // Only apply if the user has not switched away since the fetch
          // started; a faster load owns the screen then.
          if (seq === loadSeq.current && mirroredIdRef.current === id) {
            // Skip the swap when the disk copy is what is already on screen.
            // Parsing always builds fresh object identities, so without this
            // every click on the SAME chat re-rendered the whole transcript
            // (hundreds of memoised bubbles re-reconciled) — the 1-2s "heavy"
            // pause on switching back. Content identity is enough: the live
            // fields (open panels, scroll) are UI-only and unaffected.
            const shown = live?.messages ?? [];
            const same =
              shown.length === parsed.length &&
              parsed.every((m, i) => {
                const o = shown[i];
                return (
                  o.id === m.id &&
                  o.content === m.content &&
                  o.reasoningContent === m.reasoningContent &&
                  o.role === m.role &&
                  sameIds(o.toolEvents, m.toolEvents) &&
                  sameTimeline(o.timeline, m.timeline) &&
                  (o.plan === m.plan ||
                    JSON.stringify(o.plan ?? null) ===
                      JSON.stringify(m.plan ?? null)) &&
                  o.incomplete === m.incomplete &&
                  o.isNote === m.isNote
                );
              });
            if (!same) writeMessages(id, () => parsed, { cache: false });
          } else {
            setSessionsVersion((v) => v + 1);
          }
          // An unfinished last reply may still be running server-side.
          const last = parsed[parsed.length - 1];
          if (last?.role === "assistant" && last.incomplete) {
            void rejoinRun(id, last.id);
          } else if (last?.role === "user") {
            void rejoinRun(id, null);
          }
        }
      } catch {
        /* ignore — the cached/session copy stays on screen */
      } finally {
        // Only clear our own load: a newer click already owns the skeleton.
        if (seq === loadSeq.current) {
          setLoadingConv((prev) => (prev === id ? null : prev));
        }
      }
    },
    [activateSession, writeMessages, rejoinRun]
  );

  const startNewChat = useCallback(() => {
    // Starting a new chat does not cancel other chats' streams; they keep
    // running in their own sessions and saving to their own conversations.
    btwAbortRef.current?.abort();
    loadAbortRef.current?.abort();
    setLoadingConv(null);
    loadSeq.current += 1;
    const nextId = uuidv4();
    workspaceIdRef.current = nextId;
    setCurrentConvId(null);
    setDraftConvId(nextId);
    // A fresh, empty session for the new draft conversation.
    activateSession(nextId);
    setBtwEntry(null);
    setRecentlyChanged([]);
    setWorkspaceFiles([]);
  }, [activateSession]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const previous = conversationsRef.current.find((c) => c.id === id)?.title;

      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c))
      );

      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });

        if (!res.ok) {
          // The response was previously ignored, so a rejected rename still
          // appeared to work until the next refresh put the old name back.
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (previous !== undefined) {
            setConversations((prev) =>
              prev.map((c) => (c.id === id ? { ...c, title: previous } : c))
            );
          }
          setRenameError(data.error ?? "Couldn't rename that chat.");
        }
      } catch {
        if (previous !== undefined) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title: previous } : c))
          );
        }
        setRenameError("Couldn't reach the server.");
      }
    },
    []
  );

  const archiveConversation = useCallback(
    async (id: string, archived: boolean) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, archived } : c))
      );
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        });
      } catch {
        /* optimistic update already applied */
      }
    },
    []
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      let ok = false;
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
        });
        // The response was previously ignored, so a failed delete still
        // disappeared from the list and came back on the next refresh.
        ok = res.ok;
      } catch {
        ok = false;
      }

      if (!ok) {
        // Surfaced rather than swallowed: the old code removed the row
        // regardless, so a failed delete looked like it had worked until the
        // chat reappeared on the next refresh.
        setDeleteError("That chat couldn't be deleted. Please try again.");
        void refreshConversations();
        return;
      }

      // Drop the cached transcript too, or reopening a same-id chat would
      // show the deleted messages from memory.
      conversationCache.current.delete(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      // The ref too: a brand-new chat's first run used to leave
      // currentConvId null until `done`, and deleting it from the sidebar
      // then left the user inside the deleted chat (audit).
      if (currentConvId === id || workspaceIdRef.current === id) {
        startNewChat();
      }
    },
    [currentConvId, startNewChat, refreshConversations]
  );

  /**
   * Delete several chats in one request.
   *
   * Returns the ids that actually went, so the sidebar can keep any that
   * failed still ticked and let the user retry exactly those.
   *
   * Batched at 200 to match the server's per-request cap. Anything larger is
   * split rather than rejected: the limit exists so one request cannot ask
   * the server to walk an unbounded number of folders, not to stop the user
   * clearing out a lot of chats at once.
   */
  const deleteConversations = useCallback(
    async (ids: string[]): Promise<string[]> => {
      const removed: string[] = [];
      const failed: string[] = [];

      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        try {
          const res = await fetch("/api/conversations/bulk-delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: batch }),
          });
          if (!res.ok) {
            failed.push(...batch);
            continue;
          }
          const data = (await res.json()) as {
            deleted?: string[];
            failed?: string[];
          };
          removed.push(...(data.deleted ?? []));
          failed.push(...(data.failed ?? []));
        } catch {
          failed.push(...batch);
        }
      }

      if (removed.length > 0) {
        // Drop the cached transcripts too, or reopening a same-id chat would
        // show the deleted messages from memory.
        removed.forEach((id) => conversationCache.current.delete(id));
        const gone = new Set(removed);
        setConversations((prev) => prev.filter((c) => !gone.has(c.id)));
        if (
          (currentConvId && gone.has(currentConvId)) ||
          (workspaceIdRef.current && gone.has(workspaceIdRef.current))
        ) {
          startNewChat();
        }
      }

      if (failed.length > 0) {
        setDeleteError(
          failed.length === ids.length
            ? "Those chats couldn't be deleted. Please try again."
            : `${removed.length} deleted, ${failed.length} couldn't be. The rest are still selected.`
        );
        void refreshConversations();
      }

      return removed;
    },
    [currentConvId, startNewChat, refreshConversations]
  );

  const sendMessage = useCallback(
    async (
      content: string,
      options?: {
        regenerateFromId?: string;
        /** Continue this unfinished reply rather than sending a new one. */
        resumeMessageId?: string;
        /** Extra instruction typed alongside "resume". */
        resumeNote?: string;
        /** Answer with this model instead of the selected one, just this once. */
        modelOverride?: string;
        /** What the user actually typed, when it differs from `content`. */
        displayContent?: string;
        /** Thumbnails to show on the user's bubble. */
        attachments?: MessageAttachment[];
        /** Earlier replies being superseded, retained for comparison. */
        previousVersions?: Message["previousVersions"];
        /** Skip the in-flight guard so a timeout can resume itself. */
        force?: boolean;
        /**
         * Run in a specific conversation, even if the user has since
         * switched to another. Used by a background run's auto-resume.
         */
        conversationId?: string;
        /**
         * Edit-and-resend: the question's new text. Sent so the server can
         * rewrite the STORED question (regenerate keeps it as it was);
         * the model already gets the new text as `message`.
         */
        editedContent?: string;
      }
    ) => {
      // Read at send time, not from a render closure. New-chat/select-chat
      // writes this ref synchronously before React commits the new screen.
      // A backgrounded run's auto-resume names its own conversation.
      const requestConversationId =
        options?.conversationId ?? workspaceIdRef.current ?? workspaceId;

      // Guarded per conversation: two chats may generate at once, and a
      // resume in one must not be refused because the other is busy.
      const targetSession = getSession(requestConversationId);
      if (
        (!content.trim() && !(options?.attachments && options.attachments.length)) ||
        (targetSession.loading && !options?.force) ||
        !hasKeys
      ) {
        return;
      }

      // A fresh send (not the silent timeout continue) may auto-resume again.
      if (!options?.force) targetSession.cancelResume = false;
      // This run owns the chat now: a rejoin loop still polling the disk
      // copy would overwrite the live bubble and, when it ended, unlock the
      // composer mid-reply (audit).
      cancelRejoin(requestConversationId);

      // Keyed to the conversation THIS run belongs to (named explicitly, not
      // read from the "current chat" ref). Becomes the real server id when a
      // draft chat is saved mid-run (the meta event migrates it).
      let runConvId = requestConversationId;

      const trimmed = content.trim();
      const regenerateFromId = options?.regenerateFromId;
      const resumeMessageId = options?.resumeMessageId;
      const resumeNote = options?.resumeNote;
      // A one-off model choice (from Resume). Never written to settings: it
      // applies to this reply only, so the next message uses the model the
      // user actually selected.
      const activeModel = options?.modelOverride ?? model;
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        // Attachment payloads are for the model, not the transcript — showing
        // the raw <image> block made the user's own message unreadable.
        content: (options?.displayContent ?? trimmed).trim(),
        attachments: options?.attachments,
        thinkingEffort,
      };

      // The assistant bubble is created immediately and filled in as deltas
      // arrive, so the user sees text within a second instead of staring at a
      // spinner until the whole (possibly 60K-token) answer is finished.
      // Resuming keeps the reply's own id, so the server rewrites the
      // interrupted message in place and the text already on screen is
      // extended rather than replaced by a second bubble.
      const existing = resumeMessageId
        ? targetSession.messages.find((m) => m.id === resumeMessageId)
        : undefined;
      /*
       * The bubble's id — mutable, because it becomes the server's id at
       * `meta`.
       *
       * Reported (audit): a live reply kept the client id `stream-<ts>`
       * until `done`; `meta` only recorded the server id for Stop. After a
       * Stop, an error or a dropped stream, Resume / auto-resume / Retry /
       * Edit then sent `resumeMessageId: "stream-…"`, which the server
       * cannot find — so it answered from scratch, redoing the work and
       * duplicating messages. Every handler below matches on this binding,
       * so they all follow the rename; the React key is clientRenderKey,
       * which never changes, so the bubble does not remount.
       */
      let streamingId = resumeMessageId ?? `stream-${Date.now()}`;
      const assistantMsg: Message = {
        id: streamingId,
        // `id` becomes the server's persisted id when the stream finishes.
        // Keep React's key stable across that change or every local control in
        // the bubble resets at completion — including the open thinking box.
        clientRenderKey: existing?.clientRenderKey ?? streamingId,
        role: "assistant",
        // Carry the interrupted text forward so it does not blank out and
        // refill as the continuation streams in.
        content: existing?.content ?? "",
        // Keep the existing thought box. Blanking reasoning here is what
        // made Resume look like a brand-new thinking panel.
        reasoningContent: existing?.reasoningContent,
        reasoningLength: existing?.reasoningLength,
        thinkingEffort: existing?.thinkingEffort,
        plan: existing?.plan,
        // Earlier rounds' reasoning ranges point into the stored reasoning.
        // When that was never loaded, the continuation's reasoning starts
        // from an empty string here, and the old ranges would slice it
        // wrongly — so they are dropped for the live view (a reload brings
        // them back with the full text).
        timeline:
          typeof existing?.reasoningContent === "string"
            ? existing.timeline
            : existing?.timeline?.filter((e) => e.kind !== "think"),
        toolEvents: existing?.toolEvents,
        isStreaming: true,
        incomplete: false,
        previousVersions: options?.previousVersions,
      };

      writeMessages(runConvId ?? requestConversationId, (prev) => {
        // Resume swaps the interrupted reply for the streaming one, in place.
        if (resumeMessageId) {
          return prev.map((m) => (m.id === resumeMessageId ? assistantMsg : m));
        }
        // Regenerate replaces the previous reply rather than appending after
        // it, so the user's original question is not duplicated either.
        const base = regenerateFromId
          ? prev.slice(
              0,
              Math.max(0, prev.findIndex((m) => m.id === regenerateFromId))
            )
          : prev;
        return regenerateFromId
          ? [...base, assistantMsg]
          : [...base, userMsg, assistantMsg];
      });
      setIsLoading(requestConversationId, true);
      // Web search is now an agent tool, decided in-context: there is no
      // separate "checking if I need the web" phase before the reply.
      setStatusStage(requestConversationId, "thinking");
      setLiveRetry(runConvId ?? requestConversationId, null);

      /*
       * Conversation history is intentionally NOT sent by the browser.
       *
       * The server loads it from `requestConversationId`, which makes the id
       * the security boundary. A stale React closure can no longer pair Chat
       * B's id with Chat A's messages, tone, names, or generated action notes.
       */

      const controller = new AbortController();
      // Stop only ever touches the chat the user stopped; the entry is
      // re-keyed to the real id in migrateSession when a draft chat is saved.
      if (runConvId) abortRefs.current.set(runConvId, controller);

      // Batch deltas into one state update per paced frame (~30ms). Without
      // a floor a fast stream triggers dozens of re-renders a second, each
      // reconciling the transcript, re-laying-out for scroll follow and
      // repainting. It was 100ms while a flush re-laid-out the whole run's
      // reasoning, and text landed in visible lumps that read as lag; with
      // reasoning rendered per round (only its tail while followed) a flush
      // is cheap — measured zero long tasks even with the CPU throttled 4x.
      /*
       * Paced reveal. Providers deliver in bursts — twenty tokens at once,
       * then a pause — so even at 40ms the text jumped forward in lumps:
       * "faster, but not smooth printing". A paced frame releases only a
       * share of the backlog, sized so any burst drains in about
       * PACE_DRAIN_MS: a steady stream stays near real time, a burst is
       * spread over a few frames instead of landing at once. Boundaries
       * (a tool starting, the reply ending) still flush everything at once,
       * so ordering and the final text are exact.
       */
      /*
       * Steady reveal (lib/pacer). The first pass drained each burst in a
       * fixed 200ms, and a slow endpoint's bursts are further apart than
       * that — type, stop for ~0.4s, type again: "not laggy but freezy".
       * Now text is revealed at the rate it is arriving, behind a small
       * buffer sized to the gaps between bursts, so it keeps flowing
       * through them.
       *
       * One ordered queue for reasoning and prose. Two buffers meant the
       * switch from thinking to answering dumped the rest of the thought
       * at once; the queue flows straight across it.
       */
      const PACE_FRAME_MS = 24;
      const pacer = new StreamPacer();
      const queue: { kind: "c" | "r"; text: string }[] = [];
      let queuedChars = 0;
      let frame: number | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let lastFlushAt = 0;

      const enqueue = (kind: "c" | "r", text: string) => {
        if (!text) return;
        const last = queue[queue.length - 1];
        if (last && last.kind === kind) last.text += text;
        else queue.push({ kind, text });
        queuedChars += text.length;
        pacer.arrive(text.length, performance.now());
        scheduleFlush();
      };

      /** Take `n` chars off the front of the queue, in order, whole code points. */
      const dequeue = (n: number): { kind: "c" | "r"; text: string }[] => {
        const out: { kind: "c" | "r"; text: string }[] = [];
        while (n > 0 && queue.length) {
          const head = queue[0];
          let k = Math.min(n, head.text.length);
          const code = head.text.charCodeAt(k - 1);
          if (k < head.text.length && code >= 0xd800 && code <= 0xdbff) k += 1;
          out.push({ kind: head.kind, text: head.text.slice(0, k) });
          head.text = head.text.slice(k);
          if (!head.text) queue.shift();
          queuedChars -= k;
          n -= k;
        }
        if (!queue.length) queuedChars = 0;
        return out;
      };

      const flush = (paced = false) => {
        // Whichever scheduler won cancels the other. requestAnimationFrame can
        // pause in a throttled/background window; the timer is the guarantee
        // that real reasoning does not sit behind a permanent "Thinking…".
        if (frame !== null) cancelAnimationFrame(frame);
        if (flushTimer !== null) clearTimeout(flushTimer);
        frame = null;
        flushTimer = null;
        const now = performance.now();
        const dt = Math.min(120, Math.max(8, now - lastFlushAt));
        lastFlushAt = now;
        if (queuedChars <= 0) return;
        // A hidden tab has nobody to animate for: release it all.
        const pace =
          paced && typeof document !== "undefined" && !document.hidden;
        const n = pace ? pacer.take(queuedChars, now, dt) : queuedChars;
        reveal(n);
        // Whatever this frame held back goes out on the next one.
        if (queuedChars > 0) scheduleFlush();
      };

      /*
       * Before a boundary (a tool row, a plan, the end of the reply) the
       * buffered text is typed out quickly rather than dumped: up to
       * ~0.8s of text appearing in one frame read as a skip. The stream
       * reader waits for this, so nothing overtakes the text before it.
       */
      const DRAIN_MAX_MS = 220;
      const drain = async () => {
        if (queuedChars <= 0) return;
        if (frame !== null) cancelAnimationFrame(frame);
        if (flushTimer !== null) clearTimeout(flushTimer);
        frame = null;
        flushTimer = null;
        if (typeof document === "undefined" || document.hidden) {
          flush();
          return;
        }
        const start = performance.now();
        let prev = start;
        await new Promise<void>((resolve) => {
          const guard = setTimeout(() => resolve(), DRAIN_MAX_MS + 150);
          const step = () => {
            const now = performance.now();
            const left = DRAIN_MAX_MS - (now - start);
            const n =
              left <= 16
                ? queuedChars
                : Math.max(1, Math.ceil((queuedChars * (now - prev)) / left));
            prev = now;
            reveal(n);
            if (queuedChars <= 0) {
              clearTimeout(guard);
              resolve();
            } else {
              requestAnimationFrame(step);
            }
          };
          requestAnimationFrame(step);
        });
        // The guard fired (frames paused): whatever is left goes now.
        flush();
        lastFlushAt = performance.now();
      };

      /** Write the next `n` queued chars into the streaming bubble, in order. */
      const reveal = (n: number) => {
        const parts = dequeue(n);
        if (!parts.length) return;
        writeMessages(runConvId ?? requestConversationId, (prev) =>
          prev.map((m) => {
            if (m.id !== streamingId) return m;
            let timeline = m.timeline;
            let content = m.content;
            let thought = m.reasoningContent ?? "";
            let sawReasoning = false;
            for (const part of parts) {
              if (part.kind === "c") {
                // Appended to the trailing text entry rather than pushed, so
                // a paragraph split across frames stays one block instead of
                // fragmenting into dozens of rows.
                const list = [...(timeline ?? [])];
                const last = list[list.length - 1];
                if (last && last.kind === "text") {
                  list[list.length - 1] = { kind: "text", text: last.text + part.text };
                } else {
                  list.push({ kind: "text", text: part.text });
                }
                timeline = list;
                content += part.text;
              } else {
                // This round's reasoning goes in the timeline where it
                // happened — beside the tools it led to, not in one box at
                // the top of an hour-long reply.
                timeline = appendThinkRange(
                  [...(timeline ?? [])],
                  thought.length,
                  thought.length + part.text.length
                );
                thought += part.text;
                sawReasoning = true;
              }
            }
            return {
              ...m,
              content,
              reasoningContent: thought,
              // A later round may provide reasoning after an earlier one did
              // not. Real text supersedes the diagnostic immediately.
              reasoningNotice: sawReasoning ? undefined : m.reasoningNotice,
              timeline,
            };
          })
        );
      };
      function scheduleFlush() {
        if (frame !== null || flushTimer !== null) return;
        const paced = () => flush(true);
        const wait = PACE_FRAME_MS - (performance.now() - lastFlushAt);
        // A hidden tab gets no animation frames at all, so it flushes from
        // the timer alone — the text is there, whole, when the user returns.
        if (typeof document !== "undefined" && document.hidden) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
          }, Math.max(0, wait));
          return;
        }
        if (wait <= 0) {
          frame = requestAnimationFrame(paced);
        } else {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            frame = requestAnimationFrame(paced);
          }, wait);
        }
      }

      /** Set when a tool changed the workspace, so the list can refresh. */
      let sawToolWrite = false;
      const changedPaths = new Set<string>();
      // A bubble id whose dead connection THIS run should resume itself.
      // Local to the run: a run in another chat must not resume on it.
      let pendingAutoResume: string | null = null;
      // Set once `meta` named this run's server-side reply.
      let sawMeta = false;
      // Set by `done`: the run finished, there is nothing to rejoin.
      let sawDone = false;
      /*
       * The stream ended without `done`/`error` while the server run may
       * still be live: the reply id to rejoin (null = whichever run is live
       * in this chat). `undefined` means the run is simply over.
       */
      let rejoinAfter: string | null | undefined = undefined;

      const finish = (patch: Partial<Message>) => {
        flush();
        writeMessages(
          runConvId ?? requestConversationId,
          (prev) =>
            prev.map((m) =>
              m.id === streamingId
                ? { ...m, ...patch, isStreaming: false }
                : m
            )
        );
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            message: trimmed,
            // The model gets `message`; the transcript stores these instead.
            displayContent: options?.displayContent,
            attachments: options?.attachments,
            conversationId: requestConversationId,
            deepseekApiKey: deepseekKey,
            openrouterApiKey: openrouterKey,
            customModels,
            localBaseUrl,
            localApiKey,
            localApiModel,
            // A disabled provider is simply not sent, so the server
            // never sees a key it must not use.
            tavilyApiKey: tavilyEnabled ? tavilyKey : "",
            exaApiKey: exaEnabled ? exaKey : "",
            // Personal Access Token for GitHub push with no OAuth app.
            // Stored in localStorage by the connector; never logged.
            githubToken:
              typeof window !== "undefined"
                ? localStorage.getItem("nexusai-github-pat") ?? ""
                : "",
            model: activeModel,
            thinkingEffort,
            webSearchMode,
            enabledPluginIds: enabledPlugins,
            regenerateFromId,
            editedContent: regenerateFromId ? options?.editedContent : undefined,
            resumeMessageId,
            resumeNote,
            workspaceEnabled,
            lessonsEnabled,
            autoRunCommands,
            searchProfile,
            // The ceiling for this reply. Enforced on the server between
            // rounds — a client-side check could not stop a run in progress.
            budgetUsd,
            // Lets the agent look at images saved in the workspace, not just
            // ones attached to a message.
            visionApiKey: visionKey || undefined,
            visionModel,
            // Conversation and workspace identities must agree. The server
            // rejects a mismatch rather than reading another chat's files or lessons.
            workspaceId: requestConversationId,
          }),
        });

        // Validation failures still come back as ordinary JSON responses.
        if (!res.ok || !res.body) {
          const raw = await res.text();
          let serverError: string | null = null;
          try {
            const parsed = JSON.parse(raw) as { error?: unknown };
            if (typeof parsed.error === "string") serverError = parsed.error;
          } catch {
            /* non-JSON (e.g. an HTML error page) — handled below */
          }
          finish({
            content: `⚠️ ${
              serverError ??
              (res.status >= 500
                ? `The server hit an error (${res.status}). Check the server logs for details.`
                : `Request failed (${res.status} ${res.statusText || "Error"}).`)
            }`,
            isError: true,
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalMeta: Partial<Message> = {};
        let streamTitle = "";
        let sawError = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;

            let evt: StreamEvent;
            try {
              evt = JSON.parse(payload) as StreamEvent;
            } catch {
              continue;
            }

            // Frames route to THIS run's conversation session, always.
            //
            // The user may have switched to another chat while the run
            // continued server-side. Dropping these frames is exactly what
            // used to make a running task "fully disappear" the moment you
            // clicked another conversation: the bubble never got any more
            // text, and a disk refresh on return wiped it. The write helpers
            // below only touch the on-screen state when this conversation is
            // the visible one, so a background run is never lost and never
            // leaks into another chat.

            /*
             * Preserve stream order at visible boundaries.
             *
             * Reasoning/content deltas are batched, while plans and tool rows
             * are applied immediately. Without flushing here, a tool could
             * appear while the reasoning that led to it was still waiting for
             * a browser frame — exactly the intermittent double-"Thinking…"
             * state in Screenshot_169.
             */
            // Only events that add rows or end the reply are boundaries.
            // Status-only events (usage, sizes, a file being drafted,
            // retry notices) used to dump the whole paced backlog at once —
            // a visible jump every time one arrived mid-sentence.
            if (!PACE_THROUGH_EVENTS.has(evt.type)) await drain();

            // Whether this run's chat is the one on screen — computed AFTER
            // the drain. Reported (audit): it was read before `await drain()`
            // (up to ~370ms), so switching to chat B during that window let
            // `done` still set currentConvId / the workspace ref to chat A
            // while B was displayed.
            const active =
              mirroredIdRef.current === (runConvId ?? requestConversationId);

            switch (evt.type) {
              case "status":
                setStatusStage(runConvId ?? requestConversationId, evt.stage);
                // Do not clear retryNotice here. The route sends "thinking"
                // before it even calls the provider, so wiping the notice hid the hang.
                break;

              case "tool_drafting": {
                const cid = runConvId ?? requestConversationId;
                markRoundAnswered(cid);
                const prevDraft = getSession(cid).liveDrafting;
                patchSession(cid, {
                  liveDrafting: {
                    name: evt.name,
                    chars: evt.chars,
                    path: evt.path,
                    calls: evt.calls,
                    since:
                      prevDraft &&
                      prevDraft.name === evt.name &&
                      prevDraft.calls === evt.calls
                        ? prevDraft.since
                        : Date.now(),
                  },
                });
                break;
              }

              case "request_size":
                patchSession(runConvId ?? requestConversationId, {
                  liveDrafting: null,
                });
                setLiveRequestSize(runConvId ?? requestConversationId, {
                  round: evt.round,
                  inputChars: evt.inputChars,
                  breakdown: evt.breakdown,
                  firedAt: Date.now(),
                  answered: false,
                });
                break;

              case "retrying":
                if (evt.phase === "clear") {
                  setLiveRetry(runConvId ?? requestConversationId, null);
                  break;
                }
                setLiveRetry(runConvId ?? requestConversationId, {
                  phase: evt.phase === "attempt" ? "attempt" : "backoff",
                  attempt: evt.attempt,
                  attempts: evt.attempts,
                  delayMs: evt.delayMs,
                  reason: evt.reason,
                  detail: evt.detail,
                  host: evt.host,
                  providerId: evt.providerId,
                  inputChars: evt.inputChars,
                  breakdown: evt.breakdown,
                  receivedAt: Date.now(),
                });
                break;

              case "continuing":
                // Either the answer was too long for one response, or the
                // model stopped mid-task (free lanes do this on their own limits).
                // Said plainly, because otherwise a long pause mid-file
                // looks like the app has hung.
                setRetryNotice(runConvId ?? requestConversationId,
                  evt.reason === "thinking_budget"
                    ? "Used the thinking budget — answering now, without another think"
                    : evt.reason === "output_limit"
                    ? `Answer was longer than one response allows — continuing (${evt.n}/${evt.of})`
                    : evt.reason === "code_draft"
                    ? "It was writing the whole program in its head — stopped the think, writing the draft to files now"
                    : evt.reason === "unverified_claim"
                    ? "That reply claimed work that did not run — it is redoing it for real"
                    : `The model stopped mid-task — continuing from where it left off (${evt.n}/${evt.of})`
                );
                break;

              case "context_pruned":
                // Informational only; the reply is unaffected.
                break;

              case "context_compacted":
                // Also informational. Not surfaced as a notice: it happens
                // mid-task and reads as an error when it is the opposite.
                break;

              case "btw_note_accepted": {
                // The running task just read a mid-run note: it is now a real
                // user message in the transcript. Add the chip here so it
                // appears at the moment it was actually read, not later on a
                // reload — and mark the dock so the hand-off is confirmed.
                //
                // Attachments arrive as names only (the pixels are
                // megabytes the client already has); a reload brings the
                // full stored attachments, so thumbnails appear then.
                writeMessages(runConvId ?? requestConversationId, (prev) => [
                  ...prev,
                  {
                    id: evt.id,
                    role: "user",
                    content: evt.note,
                    isNote: true,
                    attachments: evt.attachments,
                    createdAt: new Date().toISOString(),
                  },
                ]);
                let acceptedId: string | null = null;
                setBtwEntry((prev) => {
                  if (
                    prev &&
                    prev.note === evt.note &&
                    prev.status !== "accepted"
                  ) {
                    acceptedId = prev.id;
                    return { ...prev, status: "accepted", round: evt.round };
                  }
                  return prev;
                });
                // The task read the note: the chip in the transcript is the
                // record now, and the dock fades after one glance at "read by
                // the task at step N".
                if (acceptedId) scheduleBtwDismiss(acceptedId);
                break;
              }

              case "plan":
                // Applied immediately rather than batched with text: the plan
                // changes a handful of times per reply, and seeing progress
                // land as it happens is the entire point of showing it.
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          plan: {
                            goal: evt.goal,
                            steps: evt.steps,
                            summary: evt.summary,
                          },
                        }
                      : m
                  )
                );
                break;

              case "budget_warning":
                // Warned rather than stopped. Being cut off with no notice is
                // worse than knowing it is going to be close.
                setRetryNotice(runConvId ?? requestConversationId,
                  `Spending limit approaching — $${evt.spentUsd.toFixed(4)} of ` +
                    `$${evt.limitUsd.toFixed(2)} used on this reply`
                );
                break;

              case "budget_stopped":
                // The reply itself explains this too, so the notice is short.
                // It clears on the next message like every other notice.
                setRetryNotice(runConvId ?? requestConversationId,
                  `Stopped at your $${evt.limitUsd.toFixed(2)} spending limit — ` +
                    `the work so far is saved, use Resume to continue`
                );
                break;

              case "meta":
                sawMeta = true;
                streamTitle = evt.title;
                // Needed by Stop: the server aborts by message id now, so a
                // closed tab no longer doubles as a stop signal.
                getSession(evt.conversationId ?? requestConversationId).runMessageId =
                  evt.messageId;
                finalMeta = {
                  ...finalMeta,
                  thinkingEffort: evt.resolvedEffort,
                  webSearchUsed: evt.webSearchUsed,
                  searchReason: evt.searchReason,
                  searchRounds: evt.searchRounds,
                  searchStopReason: evt.searchStopReason,
                  searchResults: evt.searchResults,
                  searchQueries: evt.searchQueries ?? undefined,
                  searchesPerformed: evt.searchesPerformed,
                  searchCacheHits: evt.searchCacheHits,
                  searchUsd: evt.searchUsd,
                };
                /*
                 * Apply the effort to the live bubble, not only at the end.
                 *
                 * `finalMeta` is merged when the stream finishes, so until
                 * then the streaming message had no thinkingEffort — and the
                 * thinking panel needs it to know reasoning is coming before
                 * the first token of it arrives. Without this the panel only
                 * appeared once text landed, which on a short reply is after
                 * the thinking is over.
                 *
                 * Only this one field: the search and cost numbers are not
                 * final yet and showing a half-filled meta row mid-reply
                 * would be worse than showing it at the end.
                 *
                 * The same write adopts the server's message id — now, not
                 * at `done`. From here on the bubble carries the id the server saves
                 * the reply under, so a Resume / Retry / Edit after a Stop,
                 * an error or a dropped stream names a message the server
                 * can find (see `let streamingId` above). The React key
                 * (clientRenderKey) stays the original client id.
                 */
                {
                  const fromId = streamingId;
                  const toId = evt.messageId || streamingId;
                  streamingId = toId;
                  writeMessages(runConvId ?? requestConversationId, (prev) =>
                    prev.map((m) =>
                      m.id === fromId
                        ? {
                            ...m,
                            id: toId,
                            clientRenderKey: m.clientRenderKey ?? fromId,
                            thinkingEffort: evt.resolvedEffort,
                          }
                        : m
                    )
                  );
                }
                if (evt.conversationId &&
                    evt.conversationId !== requestConversationId) {
                  // The server has saved the conversation under its real id;
                  // this run started on a draft id. Move the whole session,
                  // transcript cache and abort controller across so the
                  // backgrounded run keeps writing to the right chat.
                  migrateSession(requestConversationId, evt.conversationId);
                  runConvId = evt.conversationId as string;
                  // Only jump the view to the new id if the user is still
                  // looking at this run — not if they have since opened
                  // another chat.
                  if (mirroredIdRef.current === requestConversationId) {
                    workspaceIdRef.current = evt.conversationId;
                    setCurrentConvId(evt.conversationId);
                    activateSession(evt.conversationId);
                  }
                } else if (evt.conversationId && active) {
                  workspaceIdRef.current = evt.conversationId;
                  /*
                   * Enter the chat now, not at `done`.
                   *
                   * Reported (audit): during a NEW chat's first run
                   * currentConvId stayed null until the reply finished, so
                   * deleting that chat from the sidebar left you inside it
                   * and the workspace panel would not open. The id is the
                   * draft id the server adopted, so workspaceId does not
                   * change and migrateSession is not involved.
                   */
                  setCurrentConvId(evt.conversationId);
                }
                // List a brand-new chat now, not when its first reply ends:
                // a long first run left the sidebar saying "No conversations
                // yet" for its whole duration, with no running dot to find
                // it by after switching away. `done` below is a no-op then.
                if (evt.conversationId) {
                  const newId = evt.conversationId as string;
                  const newTitle = streamTitle || trimmed.slice(0, 48);
                  setConversations((prev) =>
                    prev.some((c) => c.id === newId)
                      ? prev
                      : [
                          {
                            id: newId,
                            title: newTitle,
                            archived: false,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                          },
                          ...prev,
                        ]
                  );
                }
                break;

              case "reasoning":
                setLiveRetry(runConvId ?? requestConversationId, null);
                markRoundAnswered(runConvId ?? requestConversationId);
                enqueue("r", evt.delta);
                break;

              case "reasoning_status": {
                const fields = evt.fieldsSeen.length
                  ? evt.fieldsSeen.join(", ")
                  : "no delta fields";
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId && !m.reasoningContent?.trim()
                      ? {
                          ...m,
                          reasoningNotice:
                            `Round ${evt.round}: ${evt.model} returned no ` +
                            `plain-text reasoning (${evt.effort}; saw ${fields}).`,
                        }
                      : m
                  )
                );
                break;
              }

              // Tool frames are applied immediately rather than batched:
              // there are only a handful per reply, and the delay would make
              // the "Writing app.py" line appear after the file already
              // existed.
              case "tool_start": {
                setLiveRetry(runConvId ?? requestConversationId, null);
                markRoundAnswered(runConvId ?? requestConversationId);
                patchSession(runConvId ?? requestConversationId, {
                  liveDrafting: null,
                });
                const started: ToolEvent = {
                  id: evt.id,
                  name: evt.name,
                  args: evt.args,
                };
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          toolEvents: [...(m.toolEvents ?? []), started],
                          // Records that this action came after whatever text
                          // has arrived so far, which is what the two-column
                          // view lines up on.
                          timeline: [
                            ...(m.timeline ?? []),
                            { kind: "tool", id: evt.id },
                          ],
                        }
                      : m
                  )
                );
                break;
              }

              case "approval_request": {
                const request: PendingCommand = {
                  id: evt.id,
                  command: evt.command,
                  args: evt.args,
                  display: evt.display,
                  reason: evt.reason,
                };
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId ? { ...m, pendingCommand: request } : m
                  )
                );
                break;
              }

              case "approval_resolved": {
                // Clear the prompt whoever resolved it — the user clicking,
                // a timeout, or Stop — so a dead prompt is never left behind.
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId && m.pendingCommand?.id === evt.id
                      ? { ...m, pendingCommand: null }
                      : m
                  )
                );
                break;
              }

              case "usage": {
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          usage: evt.usage,
                          tokenCount: evt.usage.total_tokens,
                          model: evt.model,
                          ...(evt.contextTokens
                            ? { contextTokens: evt.contextTokens }
                            : {}),
                        }
                      : m
                  )
                );
                break;
              }

              case "question": {
                const asked: PendingQuestion = {
                  id: evt.id,
                  question: evt.question,
                  options: evt.options,
                  context: evt.context,
                };
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId ? { ...m, pendingQuestion: asked } : m
                  )
                );
                break;
              }

              case "question_resolved": {
                // Cleared however it ended — answered, timed out, or stopped —
                // so a dead prompt is never left on screen.
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId && m.pendingQuestion?.id === evt.id
                      ? { ...m, pendingQuestion: null }
                      : m
                  )
                );
                break;
              }

              case "tool_result": {
                const isWrite =
                  evt.ok &&
                  evt.name !== "read_file" &&
                  evt.name !== "list_files";
                // A command can create files too (pip install, a build step),
                // so the file list has to refresh after one runs.
                if (evt.name === "run_command") sawToolWrite = true;
                sawToolWrite ||= isWrite;
                if (isWrite && evt.changedPath) {
                  changedPaths.add(evt.changedPath);
                }
                // Refresh as each tool finishes, not only once the whole
                // reply ends. The panel used to sit unchanged for the length
                // of a long agent run, so a file deleted on round three still
                // showed until the very end and the workspace looked frozen.
                // Only while this run's chat is on screen. Reported (audit):
                // a background run's writes highlighted "recently changed"
                // paths in, and refreshed the file list of, whichever chat
                // the user had switched to. The run's `finally` still
                // refreshes if the user comes back before it ends.
                if (isWrite && active) {
                  setRecentlyChanged([...changedPaths]);
                  // Coalesced: a batch of writes produces one refresh once
                  // they stop, not one per file.
                  scheduleWorkspaceRefresh();
                }
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          toolEvents: (m.toolEvents ?? []).map((t) =>
                            t.id === evt.id
                              ? {
                                  ...t,
                                  ok: evt.ok,
                                  summary: evt.summary,
                                  changedPath: evt.changedPath,
                                }
                              : t
                          ),
                        }
                      : m
                  )
                );
                break;
              }

              case "web_search": {
                // The agent searched itself (there is no longer a pre-agent
                // search). Accumulate onto the live reply so the citation
                // chips and "used the web" marker still appear, just like
                // they did for the old injected search.
                writeMessages(runConvId ?? requestConversationId, (prev) =>
                  prev.map((m) => {
                    if (m.id !== streamingId) return m;
                    const oldResults = m.searchResults ?? [];
                    const oldQueries = m.searchQueries ?? [];
                    const byUrl = new Map(oldResults.map((r) => [r.url, r]));
                    for (const r of evt.results) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
                    return {
                      ...m,
                      webSearchUsed: true,
                      searchResults: Array.from(byUrl.values()),
                      searchQueries: [...oldQueries, ...evt.queries.filter((q) => !oldQueries.includes(q))],
                      searchesPerformed:
                        (m.searchesPerformed ?? 0) + evt.searchesPerformed,
                    };
                  })
                );
                break;
              }

              case "content":
                setLiveRetry(runConvId ?? requestConversationId, null);
                markRoundAnswered(runConvId ?? requestConversationId);
                // Keep reasoning and prose in arrival order: a batch holds
                // one kind at a time, so the timeline can place each.
                enqueue("c", evt.delta);
                break;

              case "done": {
                sawDone = true;
                const usage = evt.usage as UsageLike | null;
                const diagnostic = evt.reasoningDiagnostic;
                const reasoningNotice =
                  diagnostic.expected && diagnostic.chars === 0
                    ? `No plain-text reasoning was present in the upstream ` +
                      `stream. Fields seen: ${
                        diagnostic.fieldsSeen.join(", ") || "none"
                      }. Model: ${evt.model}.`
                    : undefined;
                finish({
                  ...finalMeta,
                  reasoningNotice,
                  id: evt.id || streamingId,
                  tokenCount: usage?.total_tokens,
                  usage,
                  model: evt.model,
                  durationMs: evt.durationMs,
                  reasoningMs: evt.reasoningMs,
                  contextChars: evt.contextChars,
                  contextTokens: evt.contextTokens,
                  contextBreakdown: evt.contextBreakdown,
                  ending: evt.ending,
                  // A limit-stop must land as Resume on the SAME bubble.
                  // Ignoring these flags made every `done` look finished, so
                  // the next send opened a new thinking box from scratch.
                  incomplete: evt.incomplete === true,
                  canResume: evt.canResume === true || evt.incomplete === true,
                  errorNotice: evt.stopReason || undefined,
                });
                if (evt.conversationId) {
                  // Enter the newly saved conversation in the sidebar only
                  // when the user is still looking at this run.
                  if (active) {
                    workspaceIdRef.current = evt.conversationId;
                    setCurrentConvId(evt.conversationId);
                  }
                  setConversations((prev) =>
                    prev.some((c) => c.id === evt.conversationId)
                      ? prev
                      : [
                          {
                            id: evt.conversationId as string,
                            title: streamTitle || trimmed.slice(0, 48),
                            archived: false,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                          },
                          ...prev,
                        ]
                  );
                }
                break;
              }

              case "error": {
                sawError = true;
                /*
                 * Don't throw away a half-finished reply to show the error.
                 *
                 * Replacing the content meant a run that had already written
                 * files and produced text vanished the moment the balance ran
                 * out, leaving only "insufficient balance" and no way back to
                 * it. The server has saved that work; the bubble has to keep
                 * showing it, marked incomplete, so Continue is offered.
                 */
                const runSession = getSession(runConvId);
                const current = runSession.messages.find(
                  (m) => m.id === streamingId
                );
                const hadWork = Boolean(
                  current?.content?.trim() ||
                    current?.reasoningContent?.trim() ||
                    current?.toolEvents?.length
                );
                /*
                 * Reasoning counts as work.
                 *
                 * A reply that died before emitting prose still had a plan —
                 * on max thinking that is thousands of tokens already paid
                 * for, and the server saves it. Judging only on visible text
                 * meant the most common failure, running out of balance
                 * mid-thought, produced a bare error with no way back to it.
                 * That is why Resume was never seen.
                 */
                const used = autoResumeCounts.current.get(streamingId) ?? 0;
                if (
                  !runSession.cancelResume &&
                  shouldAutoResumeOnTimeout({
                    error: evt.error,
                    autoResume: evt.autoResume,
                    hadWork,
                    used,
                    local: resolveModelInfo(activeModel, customModels).provider === "local",
                  })
                ) {
                  // Keep the bubble streaming. Marking it incomplete here is
                  // what flashed the Resume button for a timeout the app is
                  // about to continue on its own.
                  autoResumeCounts.current.set(streamingId, used + 1);
                  // Pending auto-resume is local to THIS run, so a run in
                  // another chat cannot resume on this bubble's behalf.
                  pendingAutoResume = streamingId;
                  break;
                }
                finish(
                  hadWork
                    ? { incomplete: true, canResume: true, errorNotice: evt.error }
                    : {
                        content: `⚠️ ${evt.error}`,
                        isError: true,
                        // The interrupted banner (with its Try again button)
                        // only renders for incomplete replies. Without this
                        // an outage error was a dead end: the run died and
                        // the only recovery was retyping the message.
                        incomplete: true,
                      }
                );
                break;
              }
            }
          }
        }

        // Stream ended without a terminal frame (dropped connection).
        if (!sawError) {
          /*
           * Release the paced backlog first, unpaced.
           *
           * Reported (audit): text still queued in the pacer was either
           * dropped (the finally cancelled the pending frame without
           * flushing) or appended after the bubble had already been marked
           * finished. The whole reply lands before it is marked.
           */
          flush();
          // No `done`, but the server run may well still be going — runs
          // outlive their connection. Once `meta` named it, follow it.
          if (sawMeta && !sawDone) rejoinAfter = streamingId;
          writeMessages(runConvId ?? requestConversationId, (prev) =>
            prev.map((m) => {
              if (m.id !== streamingId || !m.isStreaming) return m;
              const hadWork = Boolean(
                m.content?.trim() ||
                  m.reasoningContent?.trim() ||
                  m.toolEvents?.length
              );
              return {
                ...m,
                ...finalMeta,
                isStreaming: false,
                incomplete: true,
                canResume: hadWork,
                // A reply about to be rejoined keeps its (maybe empty) text:
                // the live run fills it; a warning would sit in a running
                // bubble until the first disk poll.
                content:
                  m.content ||
                  (rejoinAfter !== undefined
                    ? ""
                    : "⚠️ The connection closed before a reply arrived."),
              };
            })
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Keep whatever streamed in, but mark it stopped. Without this the
          // partial text was later sent back as a completed reply, so the
          // model answered the abandoned question instead of the new one.
          // canResume must be set: incomplete-only used to show "Try again"
          // and rebuild the thinking box from scratch.
          const curSession = getSession(runConvId);
          const current = curSession.messages.find((m) => m.id === streamingId);
          const hadWork = Boolean(
            current?.content?.trim() ||
              current?.reasoningContent?.trim() ||
              current?.toolEvents?.length
          );
          finish({ incomplete: true, canResume: hadWork });
        } else {
          /*
           * A network failure mid-stream is not the end of the run.
           *
           * Reported (audit): this replaced the whole reply with "Couldn't
           * reach the server", left it un-resumable, and unlocked the
           * composer while the server run carried on — so the next send
           * started a parallel run. Now the text stays, the bubble is
           * marked interrupted exactly like the error-frame branch, and the
           * chat rejoins the live server run (see rejoinAfter in finally).
           * Only a failure before the server named its reply (no `meta`)
           * still reads as "couldn't reach the server".
           */
          const reason = `Couldn't reach the server: ${
            err instanceof Error ? err.message : "connection failed"
          }`;
          const current = getSession(runConvId).messages.find(
            (m) => m.id === streamingId
          );
          const hadWork = Boolean(
            current?.content?.trim() ||
              current?.reasoningContent?.trim() ||
              current?.toolEvents?.length
          );
          if (sawDone) {
            // The reply already finished; a read error after `done` must
            // not re-mark it interrupted.
          } else if (sawMeta || hadWork) {
            finish({
              incomplete: true,
              canResume: hadWork,
              errorNotice: reason,
            });
            if (sawMeta) rejoinAfter = streamingId;
          } else {
            finish({
              content: `⚠️ ${reason}. Check your connection and try again.`,
              isError: true,
              // Keeps the interrupted banner (Try again) on the bubble.
              incomplete: true,
            });
            // The request may have reached the server even though its first
            // frame never came back: follow whatever run is live.
            rejoinAfter = null;
          }
        }
      } finally {
        // Anything still queued goes out now; then no timer or frame may
        // fire into a finished bubble (flushTimer was never cleared here).
        flush();
        if (frame !== null) cancelAnimationFrame(frame);
        if (flushTimer !== null) clearTimeout(flushTimer);
        frame = null;
        flushTimer = null;
        // Drop this run's controller now that it has finished (under the id
        // it actually ran as, after any draft->real migration).
        if (runConvId) abortRefs.current.delete(runConvId);
        // Whether the user is still looking at THIS run's conversation. The
        // run finishes either way; the UI reset only applies if it is on top.
        const stillActive = mirroredIdRef.current === runConvId;
        const resumeId = pendingAutoResume;
        const endSession = getSession(runConvId);
        if (resumeId) {
          setStatusStage(runConvId, "working");
          setLiveRetry(runConvId, null);
          setRetryNotice(
            runConvId,
            "The connection dropped — continuing from where it left off"
          );
        } else if (rejoinAfter !== undefined && !endSession.cancelResume) {
          // The connection dropped but the server run may still be going.
          // Keep the composer locked (and the server id for Stop) while
          // rejoinRun checks; it follows the run if it is live and unlocks
          // the chat if it is not.
          patchSession(runConvId, {
            stage: "working",
            liveRetry: null,
            liveRequestSize: null,
            liveDrafting: null,
            runMessageId: rejoinAfter ?? endSession.runMessageId,
          });
          void rejoinRun(runConvId, rejoinAfter, { heldLoading: true });
        } else {
          // Run is over: clear the spinner for its own conversation only.
          patchSession(runConvId, {
            loading: false,
            stage: null,
            liveRetry: null,
            liveRequestSize: null,
            liveDrafting: null,
            runMessageId: null,
          });
        }
        // Re-sync the global chat list; this does not enter any transcript.
        void refreshConversations();
        if (stillActive && sawToolWrite) {
          setRecentlyChanged([...changedPaths]);
          void refreshWorkspaceFiles();
        }
        if (resumeId) {
          // Resume in THIS conversation, even if the user has switched to
          // another — the run continues in the background and its new
          // frames land in its own session.
          const list = endSession.messages;
          const index = list.findIndex((m) => m.id === resumeId);
          const prompt = index > 0 ? list[index - 1] : null;
          if (prompt?.role === "user") {
            const existing = list[index];
            const thinkOnly =
              Boolean(existing?.reasoningContent?.trim()) &&
              !existing?.content?.trim() &&
              !(existing?.toolEvents?.length);
            queueMicrotask(() => {
              if (getSession(runConvId).cancelResume) {
                patchSession(runConvId, {
                  loading: false,
                  stage: null,
                  liveRetry: null,
                  liveRequestSize: null,
                  liveDrafting: null,
                });
                return;
              }
              void sendMessageRef.current?.(prompt.content, {
                resumeMessageId: resumeId,
                force: true,
                conversationId: runConvId,
                resumeNote: thinkOnly
                  ? "You already thought. Do not think more. Call a tool or write the answer now."
                  : undefined,
              });
            });
          } else {
            patchSession(runConvId, { loading: false, stage: null });
          }
        }
      }
    },
    [
      hasKeys,
      workspaceId,
      deepseekKey,
      openrouterKey,
      customModels,
      localBaseUrl,
      localApiKey,
      localApiModel,
      tavilyKey,
      exaKey,
      tavilyEnabled,
      exaEnabled,
      model,
      thinkingEffort,
      webSearchMode,
      enabledPlugins,
      refreshConversations,
      scheduleWorkspaceRefresh,
      workspaceEnabled,
      autoRunCommands,
      lessonsEnabled,
      searchProfile,
      visionKey,
      visionModel,
      budgetUsd,
      refreshWorkspaceFiles,
      writeMessages,
      patchSession,
      setIsLoading,
      setStatusStage,
      setLiveRetry,
      setLiveRequestSize,
      markRoundAnswered,
      setRetryNotice,
      migrateSession,
      activateSession,
      cancelRejoin,
      rejoinRun,
    ]
  );

  // Mirror the latest values into refs after each commit so the stable
  // callbacks below can read them without taking them as dependencies.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Each conversation owns a workspace folder. Switching chats therefore
  // switches workspaces, so the file count has to be re-read.
  useEffect(() => {
    // Includes the reserved id of an unsaved new chat. Setting this to only
    // currentConvId made the ref null between chats and weakened isolation.
    workspaceIdRef.current = workspaceId;
    // Deferred so the state update doesn't cascade through this commit,
    // matching how the rest of this file loads data on mount.
    queueMicrotask(() => {
      if (workspaceEnabled) void refreshWorkspaceFiles();
      else setWorkspaceFiles([]);
    });
  }, [workspaceId, workspaceEnabled, refreshWorkspaceFiles]);

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  // Switching away from Qwen must drop the sidecar. Leaving llama-server
  // mapped is the "100% memory after I stopped using it" report.
  useEffect(() => {
    if (!settingsHydrated) return;
    if (activeModelInfo.provider === "local") return;
    void fetch("/api/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
  }, [activeModelInfo, settingsHydrated]);

  /**
   * Stop, meaning stop.
   *
   * Aborting the fetch alone is no longer enough: the server deliberately
   * keeps working when its connection drops, because a closed tab used to
   * kill a run that was still writing files. So Stop has to say so
   * explicitly, and only then close the stream locally.
   */
  /*
   * Whether the browser thinks it has a connection.
   *
   * Worth showing because the failure it causes is confusing: a reply stops
   * mid-sentence and the error mentions the API, which reads as the model
   * failing rather than the wifi dropping. It matters more now that a run
   * survives a lost connection — the work is still going on the server, and
   * saying so is the difference between waiting and starting over.
   */
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const stopGeneration = useCallback(() => {
    // Stop belongs to the conversation the user is looking at. Other chats'
    // runs are deliberately left alone — being able to keep one task running
    // while you answer another is the entire point.
    const convId = workspaceIdRef.current ?? currentConvId;
    if (!convId) return;
    const session = getSession(convId);
    // A stopped run must not silently resume itself.
    session.cancelResume = true;
    // Nor keep being followed: a rejoin loop left running after Stop wrote
    // the disk copy back over the stopped bubble every 2s (audit).
    cancelRejoin(convId);
    void fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: session.runMessageId || undefined,
        conversationId: convId,
      }),
      keepalive: true,
    }).catch(() => {});
    abortRefs.current.get(convId)?.abort();
    abortRefs.current.delete(convId);
    patchSession(convId, {
      loading: false,
      stage: null,
      liveRetry: null,
      liveRequestSize: null,
      liveDrafting: null,
      runMessageId: null,
    });
    writeMessages(
      convId,
      (prev) =>
        prev.map((m) =>
          m.isStreaming
            ? { ...m, isStreaming: false, incomplete: true, canResume: true }
            : m
        )
    );
  }, [currentConvId, patchSession, writeMessages, cancelRejoin]);

  /** Resend an edited user message, discarding everything after it. */
  const editMessage = useCallback((messageId: string, newContent: string) => {
    // Not while this chat is still answering. The edit rewrote the question
    // and dropped the reply locally, then sendMessage refused the resend
    // because the chat was busy — leaving a transcript that matched neither
    // the screen nor the server (audit). The Edit button is hidden while
    // loading too (MessageList `busy`); this is the backstop.
    if (getSession(workspaceIdRef.current).loading) return;
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    const question = list[index];

    // The reply directly after the question is the one being replaced.
    // Regenerating from the REPLY id keeps the question in the optimistic
    // list and in the stored transcript; regenerating from the question id
    // made sendMessage drop the question itself — the transcript rendered
    // an answer with no question above it, and on reload the stored
    // conversation had lost the question entirely. Editing an older
    // message also used to move the exchange to the bottom with the later
    // exchanges stranded above it, so the model re-answered material that
    // was already solved.
    const reply = list[index + 1];
    const carried =
      reply?.role === "assistant" && reply.content
        ? [
            ...(reply.previousVersions ?? []),
            {
              content: reply.content,
              model: reply.model,
              createdAt: reply.createdAt,
            },
          ]
        : undefined;

    // The question's new text must already be in the store before the
    // regenerate round starts: the server drops everything from the reply
    // id onward and replays the stored question, so the stored text is
    // what the model sees unless it is updated here.
    writeMessages(workspaceIdRef.current, (prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, content: newContent } : m
      )
    );

    /*
     * The question's files ride again. Reported (audit): Edit resent only
     * the text, so an image or video attached to the question silently
     * vanished from the model's view of the re-asked turn. `attachments` is
     * the same request field a normal send uses; the server rebuilds the
     * pixels (native) or the image descriptions (helper models) from it.
     */
    const attachments = question.attachments?.length
      ? question.attachments
      : undefined;

    // A reply that never got its server id (the stream failed before
    // `meta`) is unknown to the store: regenerating from it would truncate
    // nothing and leave the OLD question stored. Ask again as a fresh send
    // instead, which stores the edited question as a new message.
    if (reply?.role === "assistant" && !reply.id.startsWith("stream-")) {
      void sendMessageRef.current?.(newContent, {
        regenerateFromId: reply.id,
        previousVersions: carried,
        attachments,
        // Lets the server rewrite the stored question too (it replays the
        // request text to the model already, but truncateFrom keeps the
        // old text on disk). Ignored by a server that does not read it.
        editedContent: newContent,
      });
      return;
    }

    // No reply to replace (the question stands alone, or its reply was
    // provisional): move it to the end and answer it as a fresh send.
    writeMessages(workspaceIdRef.current, (prev) => {
      const i = prev.findIndex((m) => m.id === messageId);
      if (i === -1) return prev;
      const drop =
        prev[i + 1]?.role === "assistant" && prev[i + 1].id.startsWith("stream-")
          ? 2
          : 1;
      return [...prev.slice(0, i), ...prev.slice(i + drop)];
    });
    void sendMessageRef.current?.(newContent, { attachments });
  }, [writeMessages]);

  /** Remove a whole exchange — the question and the reply — from UI and disk. */
  const deleteMessage = useCallback((messageId: string) => {
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    let start = index;
    let end = index + 1;
    if (list[index].role === "user" && list[index + 1]?.role === "assistant") {
      end = index + 2;
    } else if (
      list[index].role === "assistant" &&
      index > 0 &&
      list[index - 1]?.role === "user"
    ) {
      start = index - 1;
    }
    const pair = list.slice(start, end);
    const isLastPair = end === list.length;

    const convId = workspaceIdRef.current;
    if (pair.some((m) => m.isStreaming)) {
      const session = convId ? getSession(convId) : null;
      if (session?.runMessageId) {
        void fetch("/api/chat/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: session.runMessageId,
            conversationId: convId,
          }),
          keepalive: true,
        }).catch(() => {});
      }
      if (convId) {
        abortRefs.current.get(convId)?.abort();
        abortRefs.current.delete(convId);
        patchSession(convId, {
          loading: false,
          stage: null,
          liveRetry: null,
          liveRequestSize: null,
          liveDrafting: null,
          runMessageId: null,
        });
      }
    }

    const next = [...list.slice(0, start), ...list.slice(end)];
    if (convId) writeMessages(convId, () => next);
    else {
      messagesRef.current = next;
    }

    const persistId = pair.find(
      (m) =>
        !m.id.startsWith("temp-") &&
        !m.id.startsWith("stream-")
    )?.id;
    if (!convId || (!persistId && !isLastPair)) return;

    const params = new URLSearchParams();
    params.set("message", persistId ?? pair[0].id);
    // A live reply carries its server id from `meta` on, but may not be on
    // disk yet — so the last pair always keeps the "last pair" fallback,
    // not only when no id is known.
    if (isLastPair) params.set("last", "1");
    void fetch(`/api/conversations/${convId}/messages?${params}`, {
      method: "DELETE",
    }).catch(() => {});
  }, [writeMessages, patchSession]);

  /** Re-run the user turn that produced `assistantId`. */
  // Read through refs so this callback keeps a stable identity. Depending on
  // `messages` would give MessageBubble a new prop on every message and defeat
  // its memoisation, which is what made typing slow in long conversations.
  const regenerate = useCallback((assistantId: string) => {
    // A busy chat refuses the resend, so do not drop anything first.
    if (getSession(workspaceIdRef.current).loading) return;
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === assistantId);
    if (index < 1) return;
    const prompt = list[index - 1];
    if (prompt.role !== "user") return;
    // Reported (audit): Retry resent only prompt.content, dropping the
    // question's images/video. Same `attachments` field as a normal send.
    const attachments = prompt.attachments?.length
      ? prompt.attachments
      : undefined;

    // A reply stopped before the server confirmed it still carries its
    // temporary streaming id, which the store knows nothing about. Retrying
    // such a message must not send regenerateFromId, or the server would try
    // to truncate from an id that was never written and silently do nothing.
    const isProvisional = assistantId.startsWith("stream-");
    if (isProvisional) {
      // Drop the question and its abandoned reply, then ask again — sending
      // without removing the prompt would leave a duplicate question.
      writeMessages(workspaceIdRef.current, (prev) => {
        const i = prev.findIndex((m) => m.id === assistantId);
        return i < 1 ? prev : prev.slice(0, i - 1);
      });
      void sendMessageRef.current?.(prompt.content, { attachments });
      return;
    }

    const old = list[index];
    void sendMessageRef.current?.(prompt.content, {
      regenerateFromId: assistantId,
      attachments,
      previousVersions: old.content
        ? [
            ...(old.previousVersions ?? []),
            { content: old.content, model: old.model, createdAt: old.createdAt },
          ]
        : undefined,
    });
  }, [writeMessages]);

  /**
   * Carry on an interrupted reply instead of starting it again.
   *
   * The difference from regenerate is the whole point: regenerate throws away
   * everything the model worked out and pays for all of it a second time.
   * Resume replays the saved transcript — the reasoning, the tool calls and
   * everything the tools returned — so only the rounds still outstanding are
   * charged, and any file already written stays written.
   */
  /**
   * The reply a typed "resume" would continue.
   *
   * Only the last message, and only if it is resumable. Anything looser
   * would reach back into the transcript and continue something the user has
   * moved on from — the shortcut has to mean one obvious thing or it is worse
   * than the button.
   */
  const lastResumable = (() => {
    const last = messages[messages.length - 1];
    if (!last || !replyCanContinue(last)) return null;
    const prev = messages[messages.length - 2];
    if (!prev || prev.role !== "user") return null;
    return last;
  })();

  /**
   * Fetch a message's reasoning the first time it is expanded.
   *
   * Idempotent and cheap to call: it returns immediately if the text is
   * already present, so the panel can ask on every open without checking.
   */
  /**
   * Fetch a stored message's chain of thought when its panel is opened.
   *
   * Every failure path here must end by writing SOMETHING into
   * `reasoningContent`. The panel renders "Loading…" whenever that field is
   * still undefined, so an early `return` leaves the text spinning forever —
   * which is exactly what happened: a chat with no id yet, a 404, or a
   * network blip all bailed out silently and the panel never resolved.
   *
   * It is also guarded against firing twice. Without that, opening and
   * closing the panel quickly issued a second request while the first was in
   * flight, and on a large chain of thought the two raced.
   */
  const reasoningInFlight = useRef(new Set<string>());
  /**
   * Deliberately depends on NOTHING, so its identity never changes.
   *
   * This is the actual cause of the "Loading… forever" report, and my first
   * fix missed it. The callback used to be `useCallback([currentConvId])`, so
   * it got a new identity whenever you switched chats — but MessageBubble is
   * memoised and its comparator does not include `onLoadReasoning`. An
   * already-mounted bubble therefore kept the OLD closure, holding the
   * PREVIOUS conversation's id, and asked
   * `/api/conversations/<previous-id>/reasoning/<message>`. That is a 404,
   * every time, for any chat you opened after the first one.
   *
   * Which is exactly the reported symptom: old chats, reliably, forever.
   *
   * Reading the id from a ref at call time means there is no stale closure to
   * capture. The memo comparator is fixed too, but this is the real repair —
   * a callback that is correct regardless of when it was captured.
   */
  const loadReasoning = useCallback(async (messageId: string) => {
    const existing = messagesRef.current.find((m) => m.id === messageId);
    // Already have it, or it is still streaming in — nothing to fetch.
    if (!existing || typeof existing.reasoningContent === "string") return;
    if (reasoningInFlight.current.has(messageId)) return;

    const convId = workspaceIdRef.current;

    // An unsaved chat has nothing on disk. Resolve to empty rather than
    // leaving the panel loading against a request that can never come.
    if (!convId) {
      writeMessages(
        null,
        (prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, reasoningContent: "" } : m
          )
      );
      return;
    }

    reasoningInFlight.current.add(messageId);
    let text = "";
    try {
      const res = await fetch(
        `/api/conversations/${convId}/reasoning/${messageId}`
      );
      if (res.ok) {
        const data = (await res.json()) as { reasoning?: string };
        text = data.reasoning ?? "";
      }
    } catch {
      /* fall through — an empty panel beats one that loads forever */
    } finally {
      reasoningInFlight.current.delete(messageId);
      // writeMessages keeps the live session, messagesRef and the transcript
      // cache in one step, so Resume (same tick, after this await) reads the
      // fetched text and switching away and back serves the same copy
      // instead of fetching the whole panel again.
      writeMessages(
        convId,
        (prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, reasoningContent: text } : m
          )
      );
    }
  }, [writeMessages]);

  /**
   * Continue an interrupted reply.
   *
   * `note` is anything the user typed alongside the resume word. It is passed
   * through to the server as an extra instruction rather than replacing the
   * original prompt: the point of resuming is that the saved work is reused,
   * and swapping the question out from under it would invalidate that.
   */
  /**
   * Continue an interrupted reply.
   *
   * Argument order matters here: the Resume BUTTON passes a model, the typed
   * "resume ..." passes a note. Keeping model second matches the button,
   * which is the common path, and the typed path names its argument.
   */
  const resumeReply = useCallback(
    (
      assistantId: string,
      modelOverride?: string,
      opts?: { note?: string }
    ) => {
      const list = messagesRef.current;
      const index = list.findIndex((m) => m.id === assistantId);
      if (index < 1) return;
      const prompt = list[index - 1];
      if (prompt.role !== "user") return;

      const existing = list[index];
      // Stored chats send only a length. Fetch the body first so Resume
      // reopens the same thought box instead of an empty new one.
      const needsReasoning =
        existing &&
        typeof existing.reasoningContent !== "string" &&
        (existing.reasoningLength ?? 0) > 0;

      const go = () => {
        void sendMessageRef.current?.(prompt.content, {
          resumeMessageId: assistantId,
          resumeNote: opts?.note?.trim() || undefined,
          // Which model finishes the job. The saved transcript is just
          // messages, so a run that stalled on Pro can be completed on Flash.
          modelOverride,
        });
      };

      if (needsReasoning) {
        void loadReasoning(existing.id).then(go);
        return;
      }
      go();
    },
    [loadReasoning]
  );

  /**
   * /compact: fold the whole conversation into its summary, so the next
   * request carries the summary instead of the turns.
   */
  const compactConversation = useCallback(
    async (instructions?: string): Promise<{ ok: boolean; text: string }> => {
      const convId = currentConvId;
      if (!convId) {
        return { ok: false, text: "Nothing to compact yet — send a message first." };
      }
      let res: Response;
      try {
        res = await fetch(`/api/conversations/${convId}/compact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instructions,
            model,
            customModels,
            deepseekApiKey: deepseekKey,
            openrouterApiKey: openrouterKey,
            localBaseUrl,
            localApiKey,
            localApiModel,
          }),
        });
      } catch {
        return { ok: false, text: "Couldn't reach the server — nothing was changed." };
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        summary?: unknown;
        beforeChars?: number;
        afterChars?: number;
        costUsd?: number | null;
      };
      if (!res.ok) {
        return { ok: false, text: data.error ?? "Compacting failed — nothing was changed." };
      }
      const summary = parseHistorySummary(data.summary);
      setSummaryByConv((prev) => ({ ...prev, [convId]: summary }));

      // The meter can't know the real size until the next request, so it
      // estimates: the last reply's window minus the history just folded.
      const msgs = sessionsRef.current.get(convId)?.messages ?? [];
      const last = [...msgs]
        .reverse()
        .find((m) => m.role === "assistant" && (m.contextTokens || m.contextChars));
      const saved = Math.max(0, (data.beforeChars ?? 0) - (data.afterChars ?? 0));
      if (last) {
        const was = last.contextTokens ?? Math.round((last.contextChars ?? 0) / 3.6);
        setEstimateByConv((prev) => ({
          ...prev,
          [convId]: {
            tokens: Math.max(0, Math.round(was - saved / 3.6)),
            afterMessageId: last.id,
          },
        }));
      }
      const k = (chars: number) =>
        chars >= 3600 ? `${Math.round(chars / 3600)}k` : String(Math.round(chars / 3.6));
      const cost =
        typeof data.costUsd === "number" && data.costUsd > 0
          ? ` · ${data.costUsd < 0.01 ? "<$0.01" : `$${data.costUsd.toFixed(2)}`}`
          : "";
      return {
        ok: true,
        text: `Compacted ${summary?.coveredTurns ?? msgs.length} messages — history went from ~${k(data.beforeChars ?? 0)} to ~${k(data.afterChars ?? 0)} tokens${cost}.`,
      };
    },
    [
      currentConvId,
      model,
      customModels,
      deepseekKey,
      openrouterKey,
      localBaseUrl,
      localApiKey,
      localApiModel,
    ]
  );

  /*
   * Rewind to a question — the chat, and the workspace files if asked.
   *
   * Questions sent in this tab carry temp- ids the store never saw, so the
   * request also names the reply's server id and the question's position
   * and text; the server finds the stored question from those. `dryRun`
   * asks what would happen, for the confirm step.
   */
  const requestRewind = useCallback(
    async (messageId: string, restoreFiles: boolean, dryRun: boolean) => {
      const convId = workspaceIdRef.current;
      if (!convId) {
        return { ok: false as const, error: "This chat hasn't been saved yet — send a message first." };
      }
      if (getSession(convId).loading) {
        return { ok: false as const, error: "A reply is running — stop it or wait for it, then rewind." };
      }
      const list = messagesRef.current;
      const index = list.findIndex((m) => m.id === messageId);
      const question = list[index];
      if (!question || question.role !== "user") {
        return { ok: false as const, error: "That message is no longer in this chat." };
      }
      const reply = list[index + 1];
      let res: Response;
      try {
        res = await fetch(`/api/conversations/${convId}/rewind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId,
            replyId:
              reply?.role === "assistant" && !reply.id.startsWith("stream-")
                ? reply.id
                : undefined,
            ordinal: list
              .slice(0, index)
              .filter((m) => m.role === "user" && !m.isNote).length,
            content: question.content,
            restoreFiles,
            dryRun,
          }),
        });
      } catch {
        return { ok: false as const, error: "Couldn't reach the server — nothing was changed." };
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          ok: false as const,
          error: typeof data.error === "string" ? data.error : "Rewinding failed.",
        };
      }
      return { ok: true as const, convId, data };
    },
    []
  );

  const previewRewind = useCallback(
    async (messageId: string): Promise<RewindPreview> => {
      const r = await requestRewind(messageId, false, true);
      if (!r.ok) return r;
      const files = r.data.files as Extract<RewindPreview, { ok: true }>["files"] | undefined;
      return {
        ok: true,
        removedMessages: Number(r.data.removedMessages) || 1,
        files: files ?? { available: false, kind: "none" },
      };
    },
    [requestRewind]
  );

  const rewindToMessage = useCallback(
    async (messageId: string, restoreFiles: boolean): Promise<RewindDone> => {
      const r = await requestRewind(messageId, restoreFiles, false);
      if (!r.ok) return r;
      const { convId, data } = r;

      // The cut shows at once; the server's copy (real ids, a dropped
      // summary) replaces it straight after.
      writeMessages(convId, (prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        return i === -1 ? prev : prev.slice(0, i);
      });
      if (mirroredIdRef.current === convId) void loadConversation(convId);
      if (restoreFiles) void refreshWorkspaceFiles();

      const removed = Number(data.removedMessages) || 1;
      const counts = data.filesRestored as { restored: number; removed: number } | null;
      const safety = typeof data.safetySnapshotId === "string" ? data.safetySnapshotId : null;
      const text =
        `Rewound — ${removed} message${removed === 1 ? "" : "s"} removed` +
        (counts
          ? `, files put back (${counts.restored} restored, ${counts.removed} removed).`
          : ", files left as they are.") +
        " Edit the question and send it again.";

      return {
        ok: true,
        question: typeof data.question === "string" ? data.question : "",
        text,
        undoFiles: safety
          ? async () => {
              try {
                const res = await fetch(`/api/workspace/${convId}/snapshots`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ snapshot: safety }),
                });
                if (!res.ok) throw new Error();
                if (workspaceIdRef.current === convId) void refreshWorkspaceFiles();
                return { ok: true, text: "The files are back as they were before the rewind." };
              } catch {
                return { ok: false, text: "Couldn't put the files back — use Restore points in the file panel." };
              }
            }
          : undefined,
      };
    },
    [requestRewind, writeMessages, loadConversation, refreshWorkspaceFiles]
  );

  /** Slash commands whose state lives on this page. */
  const runPageCommand = useCallback(
    async (name: string, arg: string): Promise<{ ok: boolean; text?: string } | void> => {
      const convId = currentConvId;
      const needChat = () => ({
        ok: false,
        text: "This chat hasn't been saved yet — send a message first.",
      });
      switch (name) {
        case "rename": {
          if (!convId) return needChat();
          await renameConversation(convId, arg.slice(0, 200));
          return { ok: true, text: `Renamed to "${arg.slice(0, 200)}".` };
        }
        case "archive": {
          if (!convId) return needChat();
          await archiveConversation(convId, true);
          startNewChat();
          return;
        }
        case "delete": {
          if (!convId) return needChat();
          const title = conversationsRef.current.find((c) => c.id === convId)?.title;
          if (!window.confirm(`Delete "${title ?? "this chat"}" and its workspace? This can't be undone.`)) {
            return { ok: true, text: "Kept the chat." };
          }
          await deleteConversation(convId);
          return;
        }
        case "export": {
          if (!convId) return needChat();
          const format = EXPORT_FORMATS.find((f) => f.id === (arg || "md").toLowerCase());
          if (!format) {
            return { ok: false, text: `Export as ${EXPORT_FORMATS.map((f) => f.id).join(", ")}.` };
          }
          const a = document.createElement("a");
          a.href = `/api/conversations/${convId}/export?format=${format.id}`;
          a.download = "";
          document.body.appendChild(a);
          a.click();
          a.remove();
          return { ok: true, text: `Downloading this chat as ${format.label}.` };
        }
        case "mcp":
          setShowMcp(true);
          return;
        case "search":
          setShowSearch(true);
          return;
        case "theme": {
          const t = THEMES.find(
            (x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase()
          );
          if (!t && arg !== CUSTOM_THEME_ID) {
            return { ok: false, text: `No theme called "${arg}".` };
          }
          setThemeId(t?.id ?? CUSTOM_THEME_ID);
          return { ok: true, text: `Theme: ${t?.name ?? "Custom"}` };
        }
        case "budget": {
          if (!arg) {
            return {
              ok: true,
              text:
                budgetUsd === null
                  ? "No spending limit. Set one with /budget 2 (dollars per reply)."
                  : `Limit: $${budgetUsd} per reply. /budget off removes it.`,
            };
          }
          const value = parseBudget(arg);
          if (Number.isNaN(value)) {
            return { ok: false, text: 'Give an amount in dollars, like "/budget 2", or "/budget off".' };
          }
          setBudgetUsd(value);
          return {
            ok: true,
            text: value === null ? "Spending limit removed." : `Each reply now stops at $${value}.`,
          };
        }
      }
    },
    [
      currentConvId,
      renameConversation,
      archiveConversation,
      deleteConversation,
      startNewChat,
      budgetUsd,
    ]
  );

  /** Choices the slash menu offers for command arguments. */
  const slashOptions = useMemo((): Record<string, SlashOption[]> => {
    const keys = {
      deepseekKey,
      openrouterKey,
      localBaseUrl,
    };
    const models: SlashOption[] = [
      ...MODELS.map((m) => ({ id: m.id, label: m.label, specs: m.specs })),
      ...customModels.map((c) => ({
        id: c.id,
        label: c.label,
        specs: resolveModelInfo(c.id, customModels).specs,
      })),
    ].map((m) => ({
      value: m.id,
      label: m.label,
      description:
        m.specs + (hasKeyForModel(m.id, keys, customModels) ? "" : " · no key"),
      current: m.id === model,
    }));
    return {
      model: models,
      effort: ["auto", "none", "low", "high", "max"].map((e) => ({
        value: e,
        label: e[0].toUpperCase() + e.slice(1),
        current: e === thinkingEffort,
      })),
      web: [
        { value: "auto", label: "On", description: "Searches when it needs to" },
        { value: "always", label: "Every message", description: "Leans towards looking things up" },
        { value: "off", label: "Off", description: "No web search" },
      ].map((o) => ({ ...o, current: o.value === webSearchMode })),
      theme: [
        ...THEMES.map((t) => ({ value: t.id, label: t.name, current: t.id === themeId })),
        { value: CUSTOM_THEME_ID, label: "Custom", current: themeId === CUSTOM_THEME_ID },
      ],
      export: EXPORT_FORMATS.map((f) => ({
        value: f.id,
        label: f.label,
        description: f.hint,
      })),
    };
  }, [
    customModels,
    model,
    thinkingEffort,
    webSearchMode,
    themeId,
    deepseekKey,
    openrouterKey,
    localBaseUrl,
  ]);

  return (
    <ArtifactProvider>
    <div className="flex h-dvh w-full overflow-hidden bg-bg-primary">
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        currentConvId={currentConvId}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelect={(id) => {
          closeSidebarIfOverlay();
          void loadConversation(id);
        }}
        onImported={() => void refreshConversations()}
        onNew={() => {
          closeSidebarIfOverlay();
          startNewChat();
        }}
        onDelete={deleteConversation}
        onDeleteMany={deleteConversations}
        onRename={renameConversation}
        onArchive={archiveConversation}
        onOpenSettings={() => setShowSettings(true)}
        onOpenMcp={() => setShowMcp(true)}
        runningIds={runningIds}
        deleteDelay={deleteDelay}
      />

      {/* Main Chat Area */}
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        conversationLoading={loadingConv !== null && messages.length === 0}
        statusStage={statusStage}
        canResumeLast={Boolean(lastResumable)}
        onResumeLast={(note) => {
          if (lastResumable) resumeReply(lastResumable.id, undefined, { note });
        }}
        connectionNotice={
          !online ? (
            <div className="px-4 pb-1.5 sm:px-6">
              <div className="mx-auto w-full max-w-3xl">
                <div className="flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-warning" />
                  <span className="text-[12px] leading-relaxed text-text-secondary">
                    <span className="font-medium text-warning">No connection.</span>{" "}
                    Anything already running keeps going on the server — it
                    will be here when you reconnect.
                  </span>
                </div>
              </div>
            </div>
          ) : null
        }
        btwEntry={btwEntry}
        onAskBtw={sendBtwNote}
        onDismissBtw={dismissBtw}
        retryNotice={retryNotice}
        retryBreakdown={retryBreakdown}
        retryDetail={retryDetail}
        requestSize={requestSize}
        drafting={drafting}
        onStop={stopGeneration}
        hasKeys={hasKeys}
        missingKeyLabel={
          activeModelInfo.provider === "openrouter"
            ? "OpenRouter"
            : activeModelInfo.provider === "local"
              ? "local server"
              : "DeepSeek"
        }
        model={model}
        customModels={customModels}
        thinkingEffort={thinkingEffort}
        webSearchMode={webSearchMode}
        visionKey={visionKey}
        visionModel={visionModel}
        enabledPlugins={enabledPlugins}
        sidebarOpen={sidebarOpen}
        onSend={sendMessage}
        onRegenerate={regenerate}
        onResume={resumeReply}
        onLoadReasoning={loadReasoning}
        onEdit={editMessage}
        onDeleteMessage={deleteMessage}
        onRewindPreview={previewRewind}
        onRewind={rewindToMessage}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onNewChat={startNewChat}
        onSetSearchMode={setWebSearchMode}
        onSetThinkingEffort={setThinkingEffort}
        onSetModel={setModel}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPlugins={() => setShowPlugins(true)}
        workspaceEnabled={workspaceEnabled}
        workspaceFiles={workspaceFiles}
        recentlyChanged={recentlyChanged}
        onOpenWorkspace={openWorkspace}
        onDecideCommand={decideCommand}
        onAnswerQuestion={answerQuestion}
        onPlanAction={planAction}
        workspaceId={workspaceId}
        onProcessesChanged={() => void refreshWorkspaceFiles()}
        sidePanelOpen={sidePanelOpen}
        onToggleSidePanel={() => setSidePanelOpen((v) => !v)}
        contextWindow={contextWindowFor(model, customModels)}
        modelLabel={activeModelInfo.shortLabel}
        historySummary={(() => {
          // Retry or an edit removes a /compact cursor, and the server drops
          // that summary with it — so must the meter.
          const summary = currentConvId ? summaryByConv[currentConvId] ?? null : null;
          return summary &&
            (!summary.manual || isLoading || messages.some((m) => m.id === summary.upToId))
            ? summary
            : null;
        })()}
        contextEstimate={currentConvId ? estimateByConv[currentConvId] ?? null : null}
        onCompact={compactConversation}
        onCommand={runPageCommand}
        slashOptions={slashOptions}
      />

      {/* Only while the workspace is on: an empty rail beside every ordinary
          conversation would be dead space. */}
      {workspaceEnabled && sidePanelOpen && (
        <WorkspaceSidePanel
          workspaceId={workspaceId}
          files={workspaceFiles}
          recentlyChanged={recentlyChanged}
          onOpenFile={openWorkspace}
          onClose={() => setSidePanelOpen(false)}
          onRestored={() => void refreshWorkspaceFiles()}
        />
      )}

      {/* Modals */}
      {showSettings && (
        <SettingsModal
          deepseekKey={deepseekKey}
          openrouterKey={openrouterKey}
          customModels={customModels}
          onCustomModelsChange={setCustomModels}
          themeId={themeId}
          onThemeChange={setThemeId}
          customTheme={customTheme}
          onCustomThemeChange={setCustomTheme}
          localBaseUrl={localBaseUrl}
          localApiKey={localApiKey}
          localApiModel={localApiModel}
          tavilyKey={tavilyKey}
          exaKey={exaKey}
          onExaKeyChange={setExaKey}
          tavilyEnabled={tavilyEnabled}
          onTavilyEnabledChange={setTavilyEnabled}
          exaEnabled={exaEnabled}
          onExaEnabledChange={setExaEnabled}
          visionKey={visionKey}
          visionModel={visionModel}
          onVisionKeyChange={setVisionKey}
          onVisionModelChange={setVisionModel}
          model={model}
          defaultEffort={thinkingEffort}
          onDeepseekKeyChange={setDeepseekKey}
          onLocalBaseUrlChange={setLocalBaseUrl}
          onLocalApiKeyChange={setLocalApiKey}
          onLocalApiModelChange={setLocalApiModel}
          onOpenrouterKeyChange={(key) => {
            setOpenrouterKey(key);
            // A user who only connected OpenRouter should land on the free
            // lane rather than a DeepSeek model they cannot call.
            if (key.trim() && !deepseekKey && activeModelInfo.provider === "deepseek") {
              setModel(FREE_OPENROUTER_MODEL_ID);
            }
          }}
          onTavilyKeyChange={setTavilyKey}
          onModelChange={setModel}
          onDefaultEffortChange={setThinkingEffort}
          deleteDelay={deleteDelay}
          onDeleteDelayChange={setDeleteDelay}
          autoRunCommands={autoRunCommands}
          lessonsEnabled={lessonsEnabled}
          onLessonsEnabledChange={setLessonsEnabled}
          onAutoRunCommandsChange={setAutoRunCommands}
          searchProfile={searchProfile}
          onSearchProfileChange={setSearchProfile}
          budgetUsd={budgetUsd}
          onBudgetUsdChange={setBudgetUsd}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showSearch && (
        <SearchModal
          onSelect={loadConversation}
          onClose={() => setShowSearch(false)}
        />
      )}

      {showMcp && <McpConsole onClose={() => setShowMcp(false)} />}

      {renameError && (
        <div
          role="alert"
          className="fixed bottom-5 left-1/2 z-[95] -translate-x-1/2 rounded-xl border border-danger/30 bg-bg-secondary px-4 py-2.5 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <span className="flex-none text-danger">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </span>
            <span className="text-[13px] text-text-primary">{renameError}</span>
            <button
              onClick={() => setRenameError(null)}
              className="rounded-lg px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {deleteError && (
        <div
          role="alert"
          className="fixed bottom-5 left-1/2 z-[95] -translate-x-1/2 rounded-xl border border-danger/30 bg-bg-secondary px-4 py-2.5 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-text-primary">{deleteError}</span>
            <button
              onClick={() => setDeleteError(null)}
              className="rounded-lg px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showWorkspace && currentConvId && (
        <WorkspacePanel
          workspaceId={workspaceId}
          highlightPath={workspaceHighlight}
          onClose={() => {
            setShowWorkspace(false);
            setWorkspaceHighlight(null);
            void refreshWorkspaceFiles();
          }}
        />
      )}

      {showPlugins && (
        <PluginsModal
          enabledPlugins={enabledPlugins}
          onTogglePlugin={(id) => {
            setEnabledPlugins((prev) =>
              prev.includes(id)
                ? prev.filter((p) => p !== id)
                : [...prev, id]
            );
          }}
          onClose={() => setShowPlugins(false)}
        />
      )}
    </div>
    </ArtifactProvider>
  );
}

/** The conversation file's `historySummary`, validated for the meter. */
function parseHistorySummary(
  raw: unknown
): (ContextSummaryInfo & { upToId: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || typeof r.upToId !== "string") return null;
  return {
    text: r.text,
    upToId: r.upToId,
    manual: r.manual === true,
    coveredTurns: typeof r.coveredTurns === "number" ? r.coveredTurns : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
  };
}
