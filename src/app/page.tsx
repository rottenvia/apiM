"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { Sidebar } from "@/components/Sidebar";
import { ChatArea } from "@/components/ChatArea";
import type { BtwEntry } from "@/components/BtwDock";
import { BalanceWarning, levelFor } from "@/components/BalanceWarning";
import { SettingsModal } from "@/components/SettingsModal";
import { PluginsModal } from "@/components/PluginsModal";
import { ArtifactProvider } from "@/components/ArtifactContext";
import { SearchModal } from "@/components/SearchModal";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { WorkspaceSidePanel } from "@/components/WorkspaceSidePanel";
import type { WorkspaceFileInfo } from "@/components/WorkspaceBar";
import type { ToolEvent } from "@/components/ToolActivity";
import type { PendingCommand } from "@/components/ApprovalPrompt";
import type { PendingQuestion } from "@/components/QuestionPrompt";
import type { TimelineEntry } from "@/components/MessageTimeline";
import { clampDeleteDelay, DEFAULT_DELETE_DELAY } from "@/components/DeleteChatDialog";
import { warmRoutes } from "@/lib/warmup";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string | null;
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
  /** Full token usage, for cost estimation. */
  usage?: Record<string, number> | null;
  /** Model that produced the reply, needed to price it. */
  model?: string;
  /** Wall-clock time the reply took. */
  durationMs?: number;
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
}

/** Lightweight record of an attachment, for display only. */
export interface MessageAttachment {
  name: string;
  kind: "text" | "image";
  /** Images only: data URL for the inline thumbnail. */
  dataUrl?: string;
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
      type: "retrying";
      attempt: number;
      attempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: "continuing"; reason: string; n: number; of: number }
  | { type: "context_pruned"; collapsed: number; tokensSaved: number }
  | { type: "context_compacted"; rounds: number; tokensSaved: number }
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
  | { type: "usage"; usage: Record<string, number>; model: string }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      changedPath?: string;
    }
  | { type: "content"; delta: string }
  | {
      type: "done";
      id: string;
      conversationId: string | null;
      persisted: boolean;
      usage: unknown;
      durationMs: number;
      model: string;
    }
  | { type: "error"; error: string };

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusStage, setStatusStage] = useState<StatusStage | null>(null);
  // A transient upstream failure being retried. Shown rather than hidden: a
  // silent 8-second pause reads as a freeze, and the user needs to know the
  // work is not lost.
  const [retryNotice, setRetryNotice] = useState<string | null>(null);


  const [showSettings, setShowSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  /*
   * What is actually left in the DeepSeek account.
   *
   * Cost per reply is estimated from token counts after the fact, which
   * cannot answer the question that matters: will the next task finish.
   * DeepSeek admits a request against the balance and deducts after it runs,
   * so a long agent task can begin with a few cents and end overdrawn. This
   * reads the real figure so the warning arrives before that, not after.
   */
  const [balance, setBalance] = useState<{
    total: number;
    available: boolean;
  } | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  /** Balance the user dismissed at, so it reappears only if things worsen. */
  const [balanceDismissedAt, setBalanceDismissedAt] = useState<number | null>(
    null
  );

  const refreshBalanceRef = useRef<(() => void) | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!deepseekKey) return;
    setCheckingBalance(true);
    try {
      const res = await fetch("/api/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deepseekApiKey: deepseekKey }),
      });
      const data = (await res.json()) as {
        total?: number;
        available?: boolean;
        error?: string;
      };
      // A failed check leaves the last known figure alone. Showing nothing is
      // better than replacing a real number with a guess.
      if (!data.error && typeof data.total === "number") {
        setBalance({ total: data.total, available: data.available === true });
      }
    } catch {
      /* offline, or the key is wrong — stay quiet */
    } finally {
      setCheckingBalance(false);
    }
  }, [deepseekKey]);

  useEffect(() => {
    refreshBalanceRef.current = refreshBalance;
  }, [refreshBalance]);

  // One check when a key is first available. After that it only re-reads when
  // a reply finishes, which is the only time the figure can have moved.
  useEffect(() => {
    if (deepseekKey) void refreshBalance();
  }, [deepseekKey, refreshBalance]);

  // A dismissal is tied to the amount it was dismissed at, so hiding the
  // warning at $0.40 does not also hide it at $0.05 — it comes back when
  // things get worse, not on a timer.
  const balanceLevel = balance
    ? levelFor(balance.total, balance.available)
    : "ok";
  const showBalanceWarning =
    balance !== null &&
    balanceLevel !== "ok" &&
    (balanceDismissedAt === null || balance.total < balanceDismissedAt - 0.001);
  const [tavilyKey, setTavilyKey] = useState("");
  const [visionKey, setVisionKey] = useState("");
  const [visionModel, setVisionModel] = useState("gpt-4o-mini");
  const [model, setModel] = useState("deepseek-v4-pro");
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

  const hasKeys = deepseekKey.length > 0;
  const initialLoadDone = useRef(false);
  /** Current workspace id, readable from callbacks without re-creating them. */
  const workspaceIdRef = useRef<string | null>(null);
  /** Latest conversation list, so rename can restore the old title on failure. */
  const conversationsRef = useRef<Conversation[]>([]);
  /** Lets the Stop button cancel an in-flight stream. */
  const abortRef = useRef<AbortController | null>(null);
  /** Server-side id of the reply in flight, for the stop endpoint. */
  const runMessageIdRef = useRef<string | null>(null);

  /*
   * The side channel.
   *
   * Held in its own state and never merged into `messages`, which is the
   * whole safety argument: the agent's next round reads `conversationHistory`
   * built from `messages`, so an aside that never lands there can never
   * redirect the running task.
   *
   * Its own AbortController too, deliberately not `abortRef` — Stop belongs
   * to the main task and dismissing an aside must not touch it.
   */
  const [btwEntry, setBtwEntry] = useState<BtwEntry | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);

  const dismissBtw = useCallback(() => {
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    setBtwEntry(null);
  }, []);

  const askBtw = useCallback(
    async (question: string) => {
      if (!question.trim() || !deepseekKey) return;

      // One at a time. A second aside replaces the first rather than stacking,
      // because a dock with a queue in it stops being an aside.
      btwAbortRef.current?.abort();
      const controller = new AbortController();
      btwAbortRef.current = controller;

      const id = `btw-${Date.now()}`;
      setBtwEntry({ id, question, answer: "", pending: true });

      // The last thing the user actually typed, for pronouns like "it".
      // Never the in-flight reply.
      const lastUser = [...messagesRef.current]
        .reverse()
        .find((m) => m.role === "user" && !m.isError);

      try {
        const res = await fetch("/api/btw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            question,
            deepseekApiKey: deepseekKey,
            workspaceId,
            lastUserMessage: lastUser?.content?.slice(0, 500),
          }),
        });

        const data = (await res.json()) as {
          answer?: string;
          error?: string;
          cancelled?: boolean;
        };

        if (controller.signal.aborted || data.cancelled) return;

        setBtwEntry((prev) =>
          prev && prev.id === id
            ? {
                ...prev,
                pending: false,
                answer: data.answer ?? "",
                error: data.error,
              }
            : prev
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        setBtwEntry((prev) =>
          prev && prev.id === id
            ? {
                ...prev,
                pending: false,
                error:
                  err instanceof Error
                    ? `Couldn't ask on the side: ${err.message}`
                    : "Couldn't ask on the side.",
              }
            : prev
        );
      }
    },
    [deepseekKey, workspaceId]
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
        }
      ) => void)
    | null
  >(null);

  // Load settings from localStorage after mount (deferred to a microtask so
  // state updates don't cascade synchronously through the first commit)
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("nexusai-settings");
        if (saved) {
          try {
            const s = JSON.parse(saved);
            if (s.deepseekKey) setDeepseekKey(s.deepseekKey);
            if (s.tavilyKey) setTavilyKey(s.tavilyKey);
            if (s.visionKey) setVisionKey(s.visionKey);
            if (s.visionModel) setVisionModel(s.visionModel);
            if (s.model) setModel(s.model);
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
          } catch {
            /* ignore */
          }
        }
        initialLoadDone.current = true;
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
          tavilyKey,
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
    tavilyKey,
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

  /** Sends the user's Run / Skip answer back to the waiting request. */
  const decideCommand = useCallback(
    async (id: string, approved: boolean, remember: boolean) => {
      // Clear immediately: the server confirms separately, and leaving the
      // buttons live invites a second click that would 404.
      setMessages((prev) =>
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
    []
  );

  /** Sends the user's answer back to the waiting request. */
  const answerQuestion = useCallback(async (id: string, answer: string) => {
    // Cleared immediately: the server confirms separately, and leaving the
    // input live invites a second submit that would 404.
    setMessages((prev) =>
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
  }, []);

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
    }
  }, []);

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

  const loadConversation = useCallback(async (id: string) => {
    // Each load gets a sequence number; a slower earlier response is ignored
    // once a newer one starts, so rapidly switching chats can't leave the
    // wrong transcript on screen.
    const seq = ++loadSeq.current;
    setCurrentConvId(id);

    // Show the cached copy immediately, then refresh from disk.
    const cached = conversationCache.current.get(id);
    setMessages(cached ?? []);

    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok || seq !== loadSeq.current) return;

      const data = (await res.json()) as { messages?: unknown };
      if (seq !== loadSeq.current) return;

      const list = Array.isArray(data.messages) ? data.messages : [];
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
          thinkingEffort: m.thinkingEffort as string | undefined,
          webSearchUsed: m.webSearchUsed as boolean | undefined,
          searchResults: parseSearchResults(m.searchResults),
          searchQueries: Array.isArray(m.searchQueries)
            ? (m.searchQueries as string[])
            : undefined,
          tokenCount: m.tokenCount as number | undefined,
          usage: (m.usage as Record<string, number> | null) ?? null,
          model: m.model as string | undefined,
          durationMs: m.durationMs as number | undefined,
          createdAt: m.createdAt as string | undefined,
          incomplete: m.incomplete === true,
          // The server sends a flag, never the saved transcript itself: it
          // can run to megabytes and the browser has no use for it.
          canResume: m.canResume === true,
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
        };
      });

      conversationCache.current.set(id, parsed);
      setMessages(parsed);
    } catch {
      /* ignore */
    }
  }, []);

  const startNewChat = useCallback(() => {
    setCurrentConvId(null);
    setDraftConvId(uuidv4());
    setMessages([]);
  }, []);

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
      if (currentConvId === id) {
        startNewChat();
      }
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
      }
    ) => {
      if (!content.trim() || isLoading || !hasKeys) return;

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
        ? messagesRef.current.find((m) => m.id === resumeMessageId)
        : undefined;
      const streamingId = resumeMessageId ?? `stream-${Date.now()}`;
      const assistantMsg: Message = {
        id: streamingId,
        role: "assistant",
        // Carry the interrupted text forward so it does not blank out and
        // refill as the continuation streams in.
        content: existing?.content ?? "",
        reasoningContent: existing?.reasoningContent ?? "",
        timeline: existing?.timeline,
        toolEvents: existing?.toolEvents,
        isStreaming: true,
        incomplete: false,
        previousVersions: options?.previousVersions,
      };

      setMessages((prev) => {
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
      setIsLoading(true);
      setStatusStage(webSearchMode === "off" ? "thinking" : "deciding");

      // For a regenerate, history must stop before the reply being replaced.
      // Same for a resume: the server replays the saved transcript, so the
      // reply being continued must not also arrive as history.
      const stopBefore = regenerateFromId ?? resumeMessageId;
      const sourceHistory = stopBefore
        ? messages.slice(
            0,
            Math.max(0, messages.findIndex((m) => m.id === stopBefore))
          )
        : messages;
      // Only the recent turns are sent. The server also caps this, but
      // trimming here keeps the request body small in very long chats — with
      // thousands of messages the payload alone would be megabytes.
      // Drop errors and any reply that was cut short with no content: sending
      // a blank assistant turn makes the model continue the abandoned answer
      // rather than respond to the new question.
      // Tool calls were previously stripped here, so on the next message the
      // model knew it had *said* "I created main.py" but not that it had done
      // it — and would offer to create the file again. A short note of what
      // each reply actually did is appended instead. Full tool calls can't be
      // replayed: DeepSeek requires reasoning_content alongside them, and
      // that isn't kept once a reply is finished.
      const historyForApi = sourceHistory
        .filter((m) => m.content.trim() && !m.isError)
        .slice(-20)
        .map((m) => {
          const done = (m.toolEvents ?? [])
            .filter((t) => t.ok && t.summary)
            .map((t) => t.summary as string);

          if (m.role !== "assistant" || done.length === 0) {
            return { role: m.role, content: m.content };
          }

          // Deduplicated: reading the same file three times while working is
          // normal and repeating it adds nothing.
          const unique = [...new Set(done)];
          return {
            role: m.role,
            content: `${m.content}\n\n[Actions taken: ${unique.join("; ")}]`,
          };
        });

      const controller = new AbortController();
      abortRef.current = controller;

      // Batch deltas into one state update per animation frame. Without this a
      // fast stream triggers hundreds of re-renders a second and the UI janks.
      let pendingContent = "";
      let pendingReasoning = "";
      let frame: number | null = null;

      const flush = () => {
        frame = null;
        if (!pendingContent && !pendingReasoning) return;
        const c = pendingContent;
        const r = pendingReasoning;
        pendingContent = "";
        pendingReasoning = "";
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== streamingId) return m;

            // Appended to the trailing text entry rather than pushed, so a
            // paragraph split across frames stays one block instead of
            // fragmenting into dozens of rows.
            let timeline = m.timeline;
            if (c) {
              const list = [...(timeline ?? [])];
              const last = list[list.length - 1];
              if (last && last.kind === "text") {
                list[list.length - 1] = { kind: "text", text: last.text + c };
              } else {
                list.push({ kind: "text", text: c });
              }
              timeline = list;
            }

            return {
              ...m,
              content: m.content + c,
              reasoningContent: (m.reasoningContent ?? "") + r,
              timeline,
            };
          })
        );
      };
      const scheduleFlush = () => {
        if (frame === null) frame = requestAnimationFrame(flush);
      };

      /** Set when a tool changed the workspace, so the list can refresh. */
      let sawToolWrite = false;
      const changedPaths = new Set<string>();

      const finish = (patch: Partial<Message>) => {
        if (frame !== null) cancelAnimationFrame(frame);
        flush();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingId ? { ...m, ...patch, isStreaming: false } : m
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
            conversationId: currentConvId ?? draftConvId,
            deepseekApiKey: deepseekKey,
            tavilyApiKey: tavilyKey,
            model: activeModel,
            thinkingEffort,
            webSearchMode,
            enabledPluginIds: enabledPlugins,
            conversationHistory: historyForApi,
            regenerateFromId,
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
            // A new chat has no id yet; the server falls back to the
            // conversation id it creates, which is what we adopt below.
            workspaceId,
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

            switch (evt.type) {
              case "status":
                setStatusStage(evt.stage);
                // Any progress means the retry resolved.
                setRetryNotice(null);
                break;

              case "retrying":
                setRetryNotice(
                  `${evt.reason} — retrying (${evt.attempt}/${evt.attempts - 1}) in ${Math.round(evt.delayMs / 100) / 10}s`
                );
                break;

              case "continuing":
                // The answer was too long for one response and is being
                // continued. Said plainly, because otherwise a long pause
                // mid-file looks like the app has hung.
                setRetryNotice(
                  `Answer was longer than one response allows — continuing (${evt.n}/${evt.of})`
                );
                break;

              case "context_pruned":
                // Informational only; the reply is unaffected.
                break;

              case "context_compacted":
                // Also informational. Not surfaced as a notice: it happens
                // mid-task and reads as an error when it is the opposite.
                break;

              case "budget_warning":
                // Warned rather than stopped. Being cut off with no notice is
                // worse than knowing it is going to be close.
                setRetryNotice(
                  `Spending limit approaching — $${evt.spentUsd.toFixed(4)} of ` +
                    `$${evt.limitUsd.toFixed(2)} used on this reply`
                );
                break;

              case "budget_stopped":
                // The reply itself explains this too, so the notice is short.
                // It clears on the next message like every other notice.
                setRetryNotice(
                  `Stopped at your $${evt.limitUsd.toFixed(2)} spending limit — ` +
                    `the work so far is saved, use Resume to continue`
                );
                break;

              case "meta":
                streamTitle = evt.title;
                // Needed by Stop: the server aborts by message id now, so a
                // closed tab no longer doubles as a stop signal.
                runMessageIdRef.current = evt.messageId;
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
                if (!currentConvId && evt.conversationId) {
                  // Ref first: `finally` reads it to refresh the file count,
                  // and a brand-new chat only learns its id here.
                  workspaceIdRef.current = evt.conversationId;
                  setCurrentConvId(evt.conversationId);
                }
                break;

              case "reasoning":
                pendingReasoning += evt.delta;
                scheduleFlush();
                break;

              // Tool frames are applied immediately rather than batched:
              // there are only a handful per reply, and the delay would make
              // the "Writing app.py" line appear after the file already
              // existed.
              case "tool_start": {
                const started: ToolEvent = {
                  id: evt.id,
                  name: evt.name,
                  args: evt.args,
                };
                setMessages((prev) =>
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
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId ? { ...m, pendingCommand: request } : m
                  )
                );
                break;
              }

              case "approval_resolved": {
                // Clear the prompt whoever resolved it — the user clicking,
                // a timeout, or Stop — so a dead prompt is never left behind.
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId && m.pendingCommand?.id === evt.id
                      ? { ...m, pendingCommand: null }
                      : m
                  )
                );
                break;
              }

              case "usage": {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId
                      ? {
                          ...m,
                          usage: evt.usage,
                          tokenCount: evt.usage.total_tokens,
                          model: evt.model,
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
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === streamingId ? { ...m, pendingQuestion: asked } : m
                  )
                );
                break;
              }

              case "question_resolved": {
                // Cleared however it ended — answered, timed out, or stopped —
                // so a dead prompt is never left on screen.
                setMessages((prev) =>
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
                if (isWrite) {
                  setRecentlyChanged([...changedPaths]);
                  // Coalesced: a batch of writes produces one refresh once
                  // they stop, not one per file.
                  scheduleWorkspaceRefresh();
                }
                setMessages((prev) =>
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

              case "content":
                pendingContent += evt.delta;
                scheduleFlush();
                break;

              case "done": {
                const usage = evt.usage as Record<string, number> | null;
                finish({
                  ...finalMeta,
                  id: evt.id || streamingId,
                  tokenCount: usage?.total_tokens,
                  usage,
                  model: evt.model,
                  durationMs: evt.durationMs,
                });
                if (evt.conversationId) {
                  setCurrentConvId(evt.conversationId);
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
                const current = messagesRef.current.find(
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
                finish(
                  hadWork
                    ? { incomplete: true, canResume: true, errorNotice: evt.error }
                    : { content: `⚠️ ${evt.error}`, isError: true }
                );
                break;
              }
            }
          }
        }

        // Stream ended without a terminal frame (dropped connection).
        if (!sawError) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingId && m.isStreaming
                ? {
                    ...m,
                    ...finalMeta,
                    isStreaming: false,
                    content:
                      m.content ||
                      "⚠️ The connection closed before a reply arrived.",
                  }
                : m
            )
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Keep whatever streamed in, but mark it stopped. Without this the
          // partial text was later sent back as a completed reply, so the
          // model answered the abandoned question instead of the new one.
          finish({ incomplete: true });
        } else {
          finish({
            content: `⚠️ Couldn't reach the server: ${
              err instanceof Error ? err.message : "connection failed"
            }. Check your connection and try again.`,
            isError: true,
          });
        }
      } finally {
        if (frame !== null) cancelAnimationFrame(frame);
        abortRef.current = null;
        setIsLoading(false);
        setStatusStage(null);
        setRetryNotice(null);
        // Re-sync with disk so ordering, titles and counts match what was
        // actually written.
        void refreshConversations();
        // The balance only moves when a reply finishes, so this is the one
        // moment worth re-reading it. Polling on a timer would spend requests
        // to learn nothing between messages.
        void refreshBalanceRef.current?.();
        if (sawToolWrite) {
          setRecentlyChanged([...changedPaths]);
          void refreshWorkspaceFiles();
        }
      }
    },
    [
      isLoading,
      hasKeys,
      currentConvId,
      draftConvId,
      workspaceId,
      deepseekKey,
      tavilyKey,
      model,
      thinkingEffort,
      webSearchMode,
      enabledPlugins,
      messages,
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
    workspaceIdRef.current = currentConvId;
    // Deferred so the state update doesn't cascade through this commit,
    // matching how the rest of this file loads data on mount.
    queueMicrotask(() => {
      if (workspaceEnabled) void refreshWorkspaceFiles();
      else setWorkspaceFiles([]);
    });
  }, [currentConvId, workspaceEnabled, refreshWorkspaceFiles]);

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

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
    const id = runMessageIdRef.current;
    if (id) {
      void fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: id }),
        keepalive: true,
      }).catch(() => {});
    }
    abortRef.current?.abort();
  }, []);

  /** Resend an edited user message, discarding everything after it. */
  const editMessage = useCallback((messageId: string, newContent: string) => {
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    const isLastTurn = index >= list.length - 2;

    if (isLastTurn) {
      // Editing the most recent turn: replace it in place, carrying the old
      // reply forward so the two can be compared.
      const replaced = list[index + 1];
      const carried =
        replaced?.role === "assistant" && replaced.content
          ? [
              ...(replaced.previousVersions ?? []),
              {
                content: replaced.content,
                model: replaced.model,
                createdAt: replaced.createdAt,
              },
            ]
          : undefined;

      void sendMessageRef.current?.(newContent, {
        regenerateFromId: messageId,
        previousVersions: carried,
      });
      return;
    }

    // Editing an older message: asking it again in place would answer a
    // question buried in the middle of the transcript, leaving the newest
    // exchange stranded. Move the whole exchange to the end instead.
    //
    // Both the question AND its reply must go — removing only the question
    // left the old answer floating with nothing above it.
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === messageId);
      if (i === -1) return prev;
      const removeCount = prev[i + 1]?.role === "assistant" ? 2 : 1;
      return [...prev.slice(0, i), ...prev.slice(i + removeCount)];
    });
    void sendMessageRef.current?.(newContent);
  }, []);

  /** Remove a user message and the reply it produced. */
  const deleteMessage = useCallback((messageId: string) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === messageId);
      if (index === -1) return prev;
      // Drop the following assistant turn too, so the transcript never shows
      // an answer with no question.
      const removeCount =
        prev[index + 1]?.role === "assistant" ? 2 : 1;
      return [...prev.slice(0, index), ...prev.slice(index + removeCount)];
    });
  }, []);

  /** Re-run the user turn that produced `assistantId`. */
  // Read through refs so this callback keeps a stable identity. Depending on
  // `messages` would give MessageBubble a new prop on every message and defeat
  // its memoisation, which is what made typing slow in long conversations.
  const regenerate = useCallback((assistantId: string) => {
    const list = messagesRef.current;
    const index = list.findIndex((m) => m.id === assistantId);
    if (index < 1) return;
    const prompt = list[index - 1];
    if (prompt.role !== "user") return;

    // A reply stopped before the server confirmed it still carries its
    // temporary streaming id, which the store knows nothing about. Retrying
    // such a message must not send regenerateFromId, or the server would try
    // to truncate from an id that was never written and silently do nothing.
    const isProvisional = assistantId.startsWith("stream-");
    if (isProvisional) {
      // Drop the question and its abandoned reply, then ask again — sending
      // without removing the prompt would leave a duplicate question.
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === assistantId);
        return i < 1 ? prev : prev.slice(0, i - 1);
      });
      void sendMessageRef.current?.(prompt.content);
      return;
    }

    const old = list[index];
    void sendMessageRef.current?.(prompt.content, {
      regenerateFromId: assistantId,
      previousVersions: old.content
        ? [
            ...(old.previousVersions ?? []),
            { content: old.content, model: old.model, createdAt: old.createdAt },
          ]
        : undefined,
    });
  }, []);

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
    if (!last || last.role !== "assistant") return null;
    if (!last.incomplete || last.isStreaming || !last.canResume) return null;
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
      setMessages((prev) =>
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
      setMessages((prev) => {
        const next = prev.map((m) =>
          m.id === messageId ? { ...m, reasoningContent: text } : m
        );
        // Keep the cache in step. Without this, switching away and back
        // served the pre-fetch copy from `conversationCache` and the panel
        // had to fetch all over again — which looked like the same bug.
        if (convId) conversationCache.current.set(convId, next);
        return next;
      });
    }
  }, []);

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

      void sendMessageRef.current?.(prompt.content, {
        resumeMessageId: assistantId,
        resumeNote: opts?.note?.trim() || undefined,
        // Which model finishes the job. The saved transcript is just
        // messages, so a run that stalled on Pro can be completed on Flash.
        modelOverride,
      });
    },
    []
  );

  return (
    <ArtifactProvider>
    <div className="flex h-dvh w-full overflow-hidden bg-bg-primary">
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        currentConvId={currentConvId}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelect={loadConversation}
        onOpenSearch={() => setShowSearch(true)}
        onImported={() => void refreshConversations()}
        onNew={startNewChat}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onArchive={archiveConversation}
        onOpenSettings={() => setShowSettings(true)}
        deleteDelay={deleteDelay}
      />

      {/* Main Chat Area */}
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        statusStage={statusStage}
        canResumeLast={Boolean(lastResumable)}
        onResumeLast={(note) => {
          if (lastResumable) resumeReply(lastResumable.id, undefined, { note });
        }}
        connectionNotice={
          !online ? (
            <div className="px-4 pb-1.5 sm:px-6">
              <div className="mx-auto w-full max-w-3xl">
                <div className="flex items-center gap-2.5 rounded-xl border border-[#cfa25a]/30 bg-[#cfa25a]/[0.07] px-3 py-2">
                  <span className="h-2 w-2 flex-none rounded-full bg-[#cfa25a]" />
                  <span className="text-[12px] leading-relaxed text-text-secondary">
                    <span className="font-medium text-[#cfa25a]">No connection.</span>{" "}
                    Anything already running keeps going on the server — it
                    will be here when you reconnect.
                  </span>
                </div>
              </div>
            </div>
          ) : null
        }
        balanceWarning={
          showBalanceWarning && balance ? (
            <BalanceWarning
              total={balance.total}
              available={balance.available}
              checking={checkingBalance}
              onRefresh={() => void refreshBalance()}
              onDismiss={() => setBalanceDismissedAt(balance.total)}
            />
          ) : null
        }
        btwEntry={btwEntry}
        onAskBtw={askBtw}
        onDismissBtw={dismissBtw}
        retryNotice={retryNotice}
        onStop={stopGeneration}
        hasKeys={hasKeys}
        model={model}
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
        workspaceId={workspaceId}
        onProcessesChanged={() => void refreshWorkspaceFiles()}
        sidePanelOpen={sidePanelOpen}
        onToggleSidePanel={() => setSidePanelOpen((v) => !v)}
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
          tavilyKey={tavilyKey}
          visionKey={visionKey}
          visionModel={visionModel}
          onVisionKeyChange={setVisionKey}
          onVisionModelChange={setVisionModel}
          model={model}
          defaultEffort={thinkingEffort}
          onDeepseekKeyChange={setDeepseekKey}
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
