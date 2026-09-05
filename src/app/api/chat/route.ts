import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  appendMessages,
  truncateFrom,
  upsertMessage,
  availableTitle,
  getConversation,
  drainBtwNotes,
} from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import { autoThinkingEffort } from "@/lib/smart-search";
import {
  ALL_PLUGINS,
  BASE_PROMPT,
  buildLegacyPrompt,
  buildPluginDirectives,
  pinPluginDirectivesOnFirstSystem,
} from "@/lib/plugins";
import { workspaceToolsFor, runTool } from "@/lib/tools";
import { agentRoundsFor, modelHasOpenToolLimits } from "@/lib/tool-limits";
import type { ToolResult } from "@/lib/tools";
import { buildWorkspaceContext } from "@/lib/workspace-context";
import { TreeTracker } from "@/lib/tree-delta";
import {
  createPlan,
  replacePlan,
  updatePlan,
  readPlanToolArgs,
  formatPlan,
  planSummary,
  planProgress,
  checkEvidence,
  PlanError,
  PLAN_MARKER,
  readPlan,
  writePlan,
  planIsComplete,
  planHasBlocked,
  reopenBlockedSteps,
  looksLikeRefusalBlocker,
  checkAnswerClaims,
} from "@/lib/plan";
import type { Plan } from "@/lib/plan";
import { BROWSER_POLICY_PROMPT, NO_BROWSER_PROMPT } from "@/lib/browser-policy";
import { browserAvailable } from "@/lib/browser-playwright";
import { recordAsync } from "@/lib/diagnostics";
import { listFiles, workspaceDirectory } from "@/lib/workspace";
import { createSnapshot } from "@/lib/snapshots";
import {
  runCommand,
  isReadOnlyCommand,
  validateCommand,
  describeCommand,
  formatRunResult,
} from "@/lib/runner";
import { requestApproval, isRemembered, askQuestion } from "@/lib/approvals";
import {
  ToolCallAccumulator,
  foldSystemMessagesToFront,
  batchItemCount,
  parseToolArguments,
  salvageToolArguments,
  salvagePartialFile,
  serializeForApi,
} from "@/lib/transcript";
import type { TranscriptMessage } from "@/lib/transcript";
import { pruneTranscript } from "@/lib/prune";
import { compactTranscript } from "@/lib/compact";
import {
  QWEN_COMPACT,
  QWEN_PRUNE,
  fitForLocalContext,
  localMessageBudget,
} from "@/lib/local-context";
import { SIDECAR_CTX, SIDECAR_MAX_OUTPUT } from "@/lib/local-engine-shared";
import { readLessons, applyLessons, formatLessonsForPrompt } from "@/lib/lessons";
import {
  readBinaryLedger,
  formatBinaryLedgerForPrompt,
  replaceBinaryLedger,
} from "@/lib/binary-ledger";
import {
  readFindings,
  formatFindingsForPrompt,
  replaceFindings,
} from "@/lib/findings";
import { runRefine } from "@/lib/refine";
import { beginRun, endRun } from "@/lib/runs";
import { listProcesses, isRunning } from "@/lib/processes";
import {
  rebuildResumeFromStored,
  rebuiltResumeInstruction,
} from "@/lib/rebuild-resume";
import type { RebuiltResume } from "@/lib/rebuild-resume";
import {
  fetchUntilHeaders,
  fetchWithRetry,
  isTimeoutFailure,
  OPENCODE_RETRY,
  readWithTimeout,
  SERVER_SIDE_STATUS,
  sleep,
} from "@/lib/retry";
import {
  MAX_AUTO_REVIVES,
  detectPrematureStop,
  prematureStopNotice,
  reviveInstruction,
} from "@/lib/revive";
import type { PrematureStopReason } from "@/lib/revive";
import { extractReasoningDelta } from "@/lib/reasoning-stream";
import { loadScopedConversationHistory } from "@/lib/chat-history";
import type { ScopedChatMessage } from "@/lib/chat-history";
import { buildUserContent, userHasContent } from "@/lib/multimodal";
import type { StoredAttachment } from "@/lib/multimodal";
import { getModel, maxOutputTokensFor, modelVision } from "@/lib/models";

/**
 * Marks a user turn that exists only to carry a tool's image.
 *
 * Needed so the loop can find its own earlier injections and collapse their
 * pixels without touching anything the user actually attached.
 */
const TOOL_IMAGE_TAG = "[tool image]";
import {
  GITHUB_TOKEN_COOKIE,
  githubConfig,
  openGitHubToken,
  pushGitHubWorkspace,
  readGitHubConnection,
} from "@/lib/github";
import {
  createBudget,
  chargeRound,
  checkBudget,
  budgetStopMessage,
  maxTokensFor,
} from "@/lib/budget";
import { cacheSplit, estimateCost, getDeepSeekPeriod } from "@/lib/pricing";
import { createContinuationDedup } from "@/lib/continuation-dedup";
import { listCustomPlugins } from "@/lib/plugin-store";
import {
  applyThinking,
  attemptTimeoutMs,
  completionHeaders,
  providerHttpError,
  providerTimedOut,
  providerUnreachable,
  resolveChatTarget,
  resolveHelperTarget,
} from "@/lib/providers";
import { OX_FIRST_TOKEN_MS, isOxProvider } from "@/lib/ox-host";
import {
  ensureEngineRunning,
  isManagedEngineUrl,
  readSidecarCtx,
} from "@/lib/local-engine";

export const maxDuration = 1800;

/*
 * The per-reply output ceiling now lives on the model (see
 * `maxOutputTokens` in models.ts), because it is a property of the model
 * and not of the front door that serves it. Keying it off the provider gave
 * GLM 5.3 Flash 64k of its documented 128k purely because it arrives via
 * OpenRouter — which is exactly the round that cuts a twenty-file
 * `edit_files` blob in half and loses the whole batch.
 *
 * A run is still bounded by the round cap and the (optional) spending limit,
 * never by this number: a forty-round task generates forty replies.
 */

/**
 * Derive a readable conversation title from the first user message.
 * Strips markdown noise, collapses whitespace and cuts on a word boundary so
 * the sidebar shows "Make an html game" rather than a truncated blob.
 */
/** Short chip for a failed make_plan — the full reason is in the tool body. */
function planFailSummary(detail: string): string {
  if (/outstanding/i.test(detail)) return "Could not set plan — leftover steps remain";
  if (/not a step/i.test(detail)) return "Could not set plan — a step was only a label";
  if (/not a goal/i.test(detail)) return "Could not set plan — goal was too vague";
  if (/at least one step/i.test(detail)) return "Could not set plan — no usable steps";
  if (/too many/i.test(detail)) return "Could not set plan — too many steps";
  if (/needs a goal/i.test(detail)) return "Could not set plan — missing goal";
  return "Could not set plan";
}

function deriveTitle(message: string): string {
  const cleaned = message
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*`>_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "New chat";
  if (cleaned.length <= 48) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  const cut = cleaned.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  const base = (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim();
  return base.charAt(0).toUpperCase() + base.slice(1) + "…";
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequestBody {
  message?: string;
  /**
   * What the user actually typed, when `message` also carries inlined file
   * contents or image descriptions. Only this is stored and shown in the
   * transcript; the model still receives the full `message`.
   */
  displayContent?: string;
  /** Attachment metadata for re-rendering chips after a reload. */
  attachments?: StoredAttachment[];
  conversationId?: string | null;
  deepseekApiKey?: string;
  /** OpenCode Zen key — required when Ox Alpha is on the Zen host. */
  opencodeApiKey?: string;
  /** OpenRouter key — required when Ox Alpha is on the OpenRouter host. */
  openrouterApiKey?: string;
  /** `zen` or `openrouter`. Defaults to Zen. */
  oxHost?: string;
  /** Local OpenAI-compatible host (in-app sidecar or a custom one). */
  localBaseUrl?: string;
  localApiKey?: string;
  localApiModel?: string;
  tavilyApiKey?: string;
  /** Optional fallback search provider, used when Tavily refuses. */
  exaApiKey?: string;
  model?: string;
  thinkingEffort?: string;
  /** "off" | "auto" | "always" — "auto" lets the model decide per message. */
  webSearchMode?: "off" | "auto" | "always";
  enabledPluginIds?: string[];
  conversationHistory?: ChatMessage[];
  /** When set, this message and everything after it is dropped first. */
  regenerateFromId?: string;
  /**
   * Continue an unfinished reply instead of starting it again.
   *
   * Carries the id of the assistant message to resume. The saved transcript
   * — reasoning, tool calls and everything the tools returned — is replayed,
   * so the model picks up with all its findings intact and only pays for the
   * rounds still to come.
   */
  resumeMessageId?: string;
  /**
   * Something typed alongside "resume" — "resume but skip the tests".
   *
   * Appended to the continue instruction rather than replacing the original
   * question: the whole value of resuming is that the saved transcript stays
   * valid, and swapping the prompt would contradict the work above it.
   */
  resumeNote?: string;
  /**
   * Let the agent record what it learns and read it back next time.
   * Off unless asked for: it writes a file into the workspace.
   */
  lessonsEnabled?: boolean;
  /** Enables the workspace tools for this turn. */
  workspaceEnabled?: boolean;
  /** Which workspace the tools operate on. Defaults to the conversation id. */
  workspaceId?: string;
  /** Skip the per-command approval prompt. Off unless explicitly enabled. */
  autoRunCommands?: boolean;
  /**
   * How aggressively to spend on search: "quality" | "balanced" | "cheap".
   * Omitted requests get the default profile.
   */
  searchProfile?: string;
  /** Vision provider key, so the agent can look at images in the workspace. */
  visionApiKey?: string;
  visionModel?: string;
  /**
   * Hard ceiling on what this reply may cost, in USD.
   *
   * Omitted or non-positive means no cap. Enforced between agent rounds, so
   * a run that hits it stops with its work saved and resumable rather than
   * being cut off mid-sentence.
   */
  budgetUsd?: number | null;
}

/** One frame of our own SSE protocol (deliberately simpler than DeepSeek's). */
type StreamEvent =
  | {
      type: "status";
      stage: "deciding" | "searching" | "thinking" | "writing" | "working";
    }
  | {
      type: "meta";
      conversationId: string | null;
      /** Id of the reply being generated, so Stop can name it. */
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
      /** Queries answered from cache, which cost nothing. */
      searchCacheHits: number;
      /** Estimated search spend for this turn, in USD. */
      searchUsd: number;
    }
  | { type: "reasoning"; delta: string }
  | {
      type: "reasoning_status";
      status: "missing_round";
      round: number;
      model: string;
      effort: string;
      /** Upstream delta keys only — never the private text itself. */
      fieldsSeen: string[];
    }
  | {
      /**
       * The model hit the output ceiling mid-answer and is being asked to
       * carry on, rather than the reply simply stopping short.
       */
      type: "continuing";
      reason: string;
      n: number;
      of: number;
    }
  | {
      /** A transient upstream failure is being retried rather than surfaced. */
      type: "retrying";
      phase?: "attempt" | "backoff" | "clear";
      attempt: number;
      attempts: number;
      delayMs: number;
      reason: string;
      host?: string;
      inputChars?: number;
    }
  | {
      /** Old tool output was collapsed to keep a long run affordable. */
      type: "context_pruned";
      collapsed: number;
      tokensSaved: number;
    }
  | {
      /**
       * Finished rounds were folded into a summary, which reclaims the
       * reasoning attached to them — the bulk of a long transcript.
       */
      type: "context_compacted";
      rounds: number;
      tokensSaved: number;
    }
  | {
      /** The agent recorded or corrected something it learned. */
      type: "lessons_updated";
      added: number;
      revised: number;
      total: number;
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
  | {
      type: "usage";
      usage: Record<string, number>;
      model: string;
      /** Peak/off-peak period the running cost was computed at. */
      period?: "peak" | "offpeak";
      /** Running cost of this reply, for the live budget readout. */
      spentUsd?: number;
      /** The cap in force, if any. */
      limitUsd?: number;
    }
  | {
      type: "plan";
      goal: string;
      steps: {
        id: number;
        text: string;
        state: string;
        verified?: string;
        blocker?: string;
      }[];
      summary: string;
    }
  | { type: "budget_warning"; spentUsd: number; limitUsd: number }
  | {
      type: "budget_stopped";
      spentUsd: number;
      limitUsd: number;
      reason: string;
    }
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
      /** Wall-clock milliseconds from request start to final token. */
      durationMs: number;
      model: string;
      /**
       * True when the reply stopped unfinished and Resume should keep the
       * same transcript (output ceiling, budget, or an inner-limit abort).
       * The live UI used to ignore this and treat every `done` as complete,
       * so a limit-stop looked finished and the next send started over.
       */
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
  | { type: "error"; error: string; autoResume?: boolean }
  | {
      type: "btw_note_accepted";
      /** The persisted message id of the note, so the UI chip and the saved
       *  transcript are the same message on a reload. */
      id: string;
      note: string;
      /** Which round read it — "folded in at step 4" beats "sometime soon". */
      round: number;
      /** Names/kinds of any attachments the note carried. */
      attachments?: { name: string; kind: string }[];
    };

/**
 * The least-shaped version of a Chat Completions body: no tools, no tool
 * choice, and no image/video parts (replaced by a text note).
 *
 * The Ox Alpha free model's tool path has been flapping on the OpenCode
 * gateway (anomalyco/opencode #44300, #44382 — "Endpoint is unavailable" /
 * network_error on ANY request that offers tools, while the identical
 * request without them streams fine). It is their adapter, not our key, but
 * while it is down a workspace turn — which always offers tools — fails
 * 100% and looks "50/50" as their side recovers and breaks again.
 *
 * This is the fallback body for ONE retry after such a rejection: the round
 * degrades to prose (the model can still emit tool calls learned from the
 * transcript and we execute those), instead of the whole run stopping.
 * Everything else — thinking fields, stream options, message text — stays
 * exactly as it was.
 */
function sanitizeOxRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  delete out.tools;
  delete out.tool_choice;

  const messages = out.messages;
  if (Array.isArray(messages)) {
    out.messages = messages.map((m) => {
      if (
        typeof m !== "object" ||
        m === null ||
        (m as Record<string, unknown>).role !== "user" ||
        !Array.isArray((m as Record<string, unknown>).content)
      ) {
        return m;
      }
      let droppedMedia = false;
      const content = ((m as Record<string, unknown>).content as Record<string, unknown>[]).map(
        (part) => {
          if (
            part &&
            typeof part === "object" &&
            (part.type === "image_url" || part.type === "video_url")
          ) {
            droppedMedia = true;
            return {
              type: "text",
              text: `[attached ${part.type === "video_url" ? "video" : "image"} omitted from this retry — the provider rejected the media payload; answer from the conversation text]`,
            };
          }
          return part;
        }
      );
      if (!droppedMedia) return m;
      return { ...(m as Record<string, unknown>), content };
    });
  }

  return out;
}

export async function POST(req: NextRequest) {
  // ---------------------------------------------------------------------
  // Validation happens before the stream opens, so these can still be real
  // HTTP error codes with JSON bodies.
  // ---------------------------------------------------------------------
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }

  const {
    message,
    conversationId,
    deepseekApiKey,
    opencodeApiKey,
    openrouterApiKey,
    oxHost,
    localBaseUrl,
    localApiKey,
    localApiModel,
    tavilyApiKey,
    exaApiKey,
    model = "deepseek-v4-pro",
    thinkingEffort = "auto",
    webSearchMode = "off",
    enabledPluginIds = [],
    regenerateFromId,
    resumeMessageId,
    resumeNote,
    displayContent,
    attachments,
    workspaceEnabled = false,
    lessonsEnabled = false,
    workspaceId,
    // Defaults to false, so a request that omits it asks rather than runs.
    // The dangerous setting has to be opted into explicitly, never inherited.
    autoRunCommands = false,
    visionApiKey,
    visionModel,
    searchProfile,
    // A ceiling on what this one reply may cost, in USD. Absent means no cap.
    budgetUsd,
  } = body;

  const userText = typeof message === "string" ? message : "";
  if (!userText.trim() && !attachments?.length) {
    return NextResponse.json({ error: "A message is required" }, { status: 400 });
  }

  const creds = {
    deepseekApiKey,
    opencodeApiKey,
    openrouterApiKey,
    oxHost,
    localBaseUrl,
    localApiKey,
    localApiModel,
  };
  const resolved = resolveChatTarget(model, creds);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const target = resolved.target;
  if (target.providerId === "local" && isManagedEngineUrl(target.baseUrl)) {
    const ready = await ensureEngineRunning();
    if (!ready.ok) {
      return NextResponse.json(
        { error: ready.error ?? "Qwen is not running on this PC." },
        { status: 503 }
      );
    }
    const ctx = await readSidecarCtx();
    if (ctx !== null && ctx < SIDECAR_CTX) {
      return NextResponse.json(
        {
          error:
            `Qwen is still on a ${ctx.toLocaleString()}-token window ` +
            `(need ${SIDECAR_CTX.toLocaleString()}). Open Settings → On this PC → Restart. ` +
            `An old llama-server is still holding the port.`,
        },
        { status: 503 }
      );
    }
  }
  // The helper follows the main model's provider: an Ox conversation judges
  // on Ox (free in preview, never balance-starved), a DeepSeek conversation
  // on Flash. Passing `model` is what keeps a dead DeepSeek key from
  // hijacking the web judge of a free Ox run.
  // Search planning is a tiny JSON side call. It may only ride a genuinely
  // cheaper/free helper target (DeepSeek Flash or Ox preview); resolving to
  // the main GLM/OpenRouter model made an agent search perform extra paid
  // GLM calls that were never part of the reply's usage total.
  const helperTarget = resolveHelperTarget(creds, model);
  const helperIsCheap =
    helperTarget !== null && helperTarget.model.id !== target.model.id;
  const helper = helperIsCheap ? helperTarget : null;
  const planner = helper
    ? {
        apiKey: helper.apiKey,
        baseUrl: helper.baseUrl,
        apiModel: helper.apiModel,
        thinkingStyle: helper.thinkingStyle,
      }
    : null;
  const helperApiKey = helper?.apiKey ?? "";

  // Resolve "auto" to a concrete level based on the message.
  // Local 27B on CPU cannot spend xhigh — it fills the output budget with
  // thinking and never answers. Auto therefore tops out at High (Qwen medium).
  // The Max slider still sends xhigh if the user picks it.
  let resolvedEffort =
    thinkingEffort === "auto" ? autoThinkingEffort(userText) : thinkingEffort;
  if (
    target.thinkingStyle === "qwen" &&
    thinkingEffort === "auto" &&
    resolvedEffort === "max"
  ) {
    resolvedEffort = "high";
  }

  // "none" is our UI concept for "don't reason at all".
  const thinkingEnabled = resolvedEffort !== "none";

  // Searching is only possible with a Tavily key. Whether one actually happens
  // is decided inside the stream: "always" every turn, "auto" asks the model,
  // "off" never.
  const canSearch = Boolean(
    (tavilyApiKey || exaApiKey) && webSearchMode !== "off"
  );

  const derivedTitle = deriveTitle(
    displayContent?.trim() ||
      userText ||
      attachments?.map((a) => a.name).filter(Boolean).join(", ") ||
      ""
  );

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
          // Proxies buffer small SSE frames. A retry/clear line that sits
          // in a 4KB buffer is exactly "the banner appeared 10s late" /
          // "it kept saying retrying after it started typing".
          if (event.type === "retrying") {
            controller.enqueue(encoder.encode(`: ${" ".repeat(1024)}\n\n`));
          }
        } catch {
          // The consumer went away between our check and this enqueue, so the
          // controller is already closed. Mark it so later frames are droppedenqueue, so the
          // controller is already closed. Mark it so later frames are dropped
          // quietly instead of throwing into the catch-all as a fake error.
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by an aborted client — nothing to do.
        }
      };

      // Ids are allocated up front so the same assistant message can be
      // rewritten in place as it streams.
      const startedAt = Date.now();
      const convId: string = conversationId ?? uuidv4();

      /*
       * A normal UI request uses the same id for conversation and workspace.
       * Refuse a disagreement instead of letting Chat B pointhat B point at Chat A's
       * LESSONS.md, plan, GitHub checkout or files. Direct API callers that
       * omit conversationId may still name a standalone workspace.
       */
      if (conversationId && workspaceId && workspaceId !== conversationId) {
        send({
          type: "error",
          error: "Conversation/workspace mismatch. Start a new request from the active chat.",
        });
        close();
        return;
      }

      // Two chats opened with the same first message would otherwise want the
      // same title, and the second would land in the first's folder. Only new
      // chats are adjusted; an existing one keeps whatever it is called.
      const title = conversationId
        ? derivedTitle
        : await availableTitle(derivedTitle);
      // Resuming rewrites the reply that was cut short, rather than adding a
      // second one beneath it.
      const assistantMsgId = resumeMessageId ?? uuidv4();
      let persisted = false;

      /*
       * The work watches this, not the request.
       *
       * `req.signal` aborts when the browser closes the tab, which used to
       * kill a run that was thirty rounds in and still writing files. Those
       * files are the point — they land in a workspace on the user's own
       * machine — so a closed tab now means "nobody is watching", not "stop".
       * Only the Stop button aborts, through /api/chat/stop.
       */
      const runSignal = beginRun(assistantMsgId, convId);
      const stopped = () => runSignal.aborted;
      let emergencySave: (() => Promise<void>) | null = null;

      // Named before search / the first model call so Stop has something
      // to abort. Waiting for the later search-filled meta is why Stop
      // did nothing and every model looked stuck.
      send({
        type: "meta",
        conversationId: convId,
        messageId: assistantMsgId,
        title,
        resolvedEffort,
        thinkingEnabled,
        webSearchUsed: false,
        searchReason: "",
        searchRounds: 0,
        searchStopReason: "",
        searchResults: null,
        searchQueries: null,
        searchesPerformed: 0,
        searchCacheHits: 0,
        searchUsd: 0,
      });

      /*
       * Set as soon as this reply produces anything — prose, reasoning or a
       * tool result. The catch at the bottom of this try is out of scope of
       * the round variables, so it reads this flag to decide whether a
       * mid-task drop should continue itself.
       */
      let sawWork = false;

      try {
        // Built-ins plus the user's own saved plugins.
        let customPlugins: Awaited<ReturnType<typeof listCustomPlugins>> = [];
        try {
          customPlugins = await listCustomPlugins();
        } catch (e) {
          console.error("Failed to load custom plugins:", e);
        }
        const pluginsWithState = [...ALL_PLUGINS, ...customPlugins].map(
          (p) => ({ ...p, enabled: enabledPluginIds.includes(p.id) })
        );

        // Current plugins get their own block, placed last — see
        // buildPluginDirectives for why position decided whether these were
        // obeyed at all.
        const pluginDirectives = buildPluginDirectives(pluginsWithState);

        // Classic plugins are appended to the persona instead, which is
        // exactly where they used to sit. Reproducing the old placement is
        // the point: it is what makes an old conversation read the way it
        // did when it was written.
        const systemPrompt = BASE_PROMPT + buildLegacyPrompt(pluginsWithState);

        // Regenerate: drop the previous reply (and anything after it) so the
        // new one replaces it rather than appending a duplicate.
        if (regenerateFromId) {
          try {
            await truncateFrom(convId, regenerateFromId);
          } catch (e) {
            console.error("Failed to truncate for regenerate:", e);
          }
        }

        /*
         * History is loaded by conversation id on the server.
         *
         * The browser used to send an arbitrary `conversationHistory` array.
         * During a fast New chat / Select chat transition, a stale callback
         * could address Chat B while still carrying Chat A's messages — a
         * direct cross-chat memory leak. Client history is now ignored; a new
         * id has no stored history, and an existing id can only read itself.
         */
        let scopedHistory: ScopedChatMessage[] = [];
        try {
          scopedHistory = await loadScopedConversationHistory(convId, {
            dropLastUser: Boolean(regenerateFromId || resumeMessageId),
          });
        } catch (e) {
          console.error("Could not load scoped conversation history:", e);
        }

        /*
         * Pick up an unfinished reply.
         *
         * The whole point is not paying twice. The saved transcript holds the
         * model's reasoning, every tool call it made and everything those
         * tools returned, so it resumes knowing what it already found rather
         * than rediscovering it. Rounds already spent are carried over too —
         * the ask-early nudge and plan checks need the real length of the
         * run, not a counter that resets every time someone presses Resume.
         */
        let resumed: {
          toolRounds: number;
          continuations: number;
          thinkNudges: number;
          messages: TranscriptMessage[];
        } | null = null;
        let resumedContent = "";
        let resumedReasoning = "";
        let resumedToolEvents: NonNullable<StoredMessage["toolEvents"]> = [];
        let resumedTimeline: NonNullable<StoredMessage["timeline"]> = [];
        /** Set when the transcript was reconstructed rather than replayed. */
        let rebuilt: RebuiltResume | null = null;

        if (resumeMessageId) {
          try {
            const conv = await getConversation(convId);
            const prior = conv?.messages.find((m) => m.id === resumeMessageId);
            const state = prior?.resumeState;
            if (state && Array.isArray(state.messages) && state.messages.length) {
              resumed = {
                toolRounds: state.toolRounds ?? 0,
                continuations: state.continuations ?? 0,
                thinkNudges: state.thinkNudges ?? 0,
                messages: state.messages as TranscriptMessage[],
              };
            } else if (prior) {
              /*
               * No saved transcript — a reply from before one was kept.
               *
               * Resuming these was refused at first, on the grounds that the
               * upstream transcript was gone. That was too pessimistic: what
               * is stored includes the model's reasoning, the prose it had
               * written, the order of events, and the COMPLETE arguments of
               * every tool call — for a write_file, the whole file. The only
               * real gap is what a read returned, and those files are still
               * on disk to be read again.
               *
               * So the transcript is reconstructed, with placeholders where a
               * result is genuinely missing, and the model is told which is
               * which. Far cheaper than redoing the task, and it keeps the
               * files already written.
               */
              rebuilt = rebuildResumeFromStored(prior);
              if (rebuilt) {
                resumed = {
                  // Unknown for an old reply. Counted from the calls that
                  // were made, so the run's length is not silently reset.
                  toolRounds: (prior.toolEvents ?? []).length,
                  continuations: 0,
                  thinkNudges: 0,
                  messages: rebuilt.messages,
                };
              }
            }

            if (resumed && prior) {
              // Keep the text already shown, so resuming extends the reply
              // rather than replacing it with only the new part.
              resumedContent = prior.content ?? "";
              resumedReasoning = prior.reasoningContent ?? "";
              // The actions and the narration that went with them, so the
              // finished reply reads as one continuous piece of work rather
              // than starting abruptly at the point it was interrupted.
              resumedToolEvents = prior.toolEvents ?? [];
              resumedTimeline = prior.timeline ?? [];
            }
          } catch (e) {
            console.error("Could not load resume state:", e);
          }
          // Nothing to resume from — fall back to answering normally rather
          // than failing, which at worst repeats work the user asked for.
        }

        // Save the user's message immediately. Previously nothing hit disk
        // until the whole reply finished, so closing the tab mid-answer lost
        // both the question and the partial answer.
        //
        // Skipped when regenerating: the question is already stored and
        // truncateFrom only removed the reply, so re-appending would duplicate
        // it. Skipped when resuming too: the question is already there, and
        // the reply being continued sits directly beneath it.
        if (!regenerateFromId && !resumeMessageId) try {
          await appendMessages(convId, title, [
            {
              id: uuidv4(),
              role: "user",
              // Store what the user typed. Saving the full payload meant the
              // <image> block reappeared in the transcript after a reload.
              content: (displayContent ?? userText).trim(),
              attachments: attachments?.length ? attachments : null,
              thinkingEffort: resolvedEffort,
              createdAt: new Date().toISOString(),
            },
          ]);
        } catch (e) {
          console.error("Failed to persist user message:", e);
        }

        // ---------------- Web search ----------------
        /*
         * No pre-agent judge, no pre-search.
         *
         * This used to spend a whole extra model call (a Flash "should I
         * search?" judge) before the agent did anything, then run the search
         * up front and inject the results into the first prompt. Two
         * problems: the judge was a wasted round-trip on every message
         * ("Checking if I need the web…" latency even for code questions),
         * and it searched before the agent had read anything, so the query
         * was a guess about what the task needed.
         *
         * The web_search tool is already one of the agent's tools. The Web
         * toggle now only decides whether that tool exists: on → the agent
         * calls web_search itself, once it knows what it is looking for; off
         * → the tool is withheld entirely. Results flow back through the
         * tool and are collected here for the citation chips and cost total.
         */
        const searchAccum = {
          results: [] as { title: string; url: string; domain: string }[],
          queries: [] as string[],
          searchesPerformed: 0,
          cacheHits: 0,
          estimatedUsd: 0,
          used: false,
        };

        // "Every message" mode is a nudge, not a different pipeline: it tells
        // the agent to default to looking something up rather than answering
        // from memory, but the agent still makes the call in-context.
        const searchAlwaysNudge =
          webSearchMode === "always" && canSearch
            ? "\n\nThe user has web search set to 'every message': before answering anything that could depend on current information — versions, APIs, pricing, news, recent changes — call web_search rather than relying on memory."
            : "";

        if (stopped()) {
          close();
          return;
        }

        send({
          type: "meta",
          conversationId: convId,
          messageId: assistantMsgId,
          title,
          resolvedEffort,
          thinkingEnabled,
          webSearchUsed: false,
          searchReason: "",
          searchRounds: 0,
          searchStopReason: "",
          searchResults: null,
          searchQueries: null,
          searchesPerformed: 0,
          searchCacheHits: 0,
          searchUsd: 0,
        });

        // ---------------- Build the request ----------------
        const workspace = workspaceId ?? convId;
        const githubConnection = workspaceEnabled
          ? await readGitHubConnection(workspace)
          : null;
        const githubOauth = githubConfig();
        const githubToken = githubOauth
          ? await openGitHubToken(
              req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
              githubOauth.tokenSecret
            )
          : null;
        // The model is otherwise blind to what already exists, and will
        // happily create a second copy of a file it never knew was there.
        const workspaceFiles = workspaceEnabled
          ? await buildWorkspaceContext(workspace)
          : "";

        // A restore point for the state before this reply. Per-file undo only
        // goes back one step, which does not help when a reply changed four
        // files. Failure here must not block the reply.
        if (workspaceEnabled) {
          try {
            await createSnapshot(
              workspace,
              (displayContent?.trim() || userText).slice(0, 80)
            );
          } catch (e) {
            console.error("Snapshot failed:", e);
          }
        }

        // Checked once per reply, not per round: it is a module resolution
        // and the answer cannot change mid-conversation.
        const hasBrowser = workspaceEnabled ? await browserAvailable() : false;

        const workspaceInstruction = workspaceEnabled
          ? `\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.${
              modelHasOpenToolLimits(model)
                ? " This model has no per-call tool ceilings: read_file returns the whole file, read_files / write_files / edit_files accept as many items as you send, search_files returns every match, and fetch_url returns the full page. Work in batches, not one item per call. Reading ten files is ONE read_files call — its paths accept globs, so \"src/lib/*.ts\" reads that whole directory at once — and changing ten files is ONE edit_files call. A round is a round whether it carries one job or thirty, and a reply that spends them one file at a time runs out of rounds with the task half done."
                : ""
            }\n\nYou can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Each command needs the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell. run_command waits for the program to finish, so use it only for things that exit — scripts, tests, installs. You can install packages: pip install and npm install both work and go into this workspace, not the user's system, so install what you need rather than rewriting code to avoid a dependency. For anything that keeps running, such as a dev server or a watcher, use start_process instead: it returns straight away, and you can read its output with read_process and stop it with stop_process. Always stop what you started once you are done with it. For anything that takes more than two or three actions, first read the files and explore enough to understand the task, then call make_plan: write down what finished looks like and the steps to get there, including how you will CHECK each one. The plan is not a first-move ritual — a plan made before you know what you are building is noise. It is also not a contract: when work teaches you something the plan did not know — a dead approach, a wrong assumption, a simpler path, a requirement you now understand better — call make_plan again immediately to replace it with the real path. On a long task your own reasoning from twenty rounds ago is gone, so without a written plan you will forget requirements from the first message and stop early because the work so far looks finished. When you work something out that a later turn would need - why an approach is dead, what a function actually does, which build or file is correct and why, an offset or value you verified, a command's exact error and what fixed it - call note_finding IMMEDIATELY, before continuing. Those findings are listed to you every turn and survive compaction, so you never have to re-read a file or re-run a command to remember it. Treat the findings list as your working memory: at the START of every turn, before doing anything, read the active findings and use them. When you find a finding is wrong or superseded, call note_finding with status='disproved' and the corrected claim so the list stays accurate and does not fill with stale notes. Do not record trivialities; one specific, evidence-backed line per finding. Keep it current with update_plan — a step is only done when you can say how you verified it.

Work to the end. Do not hand back a half-finished task with a summary that reads as if it is complete: if something cannot be done, say so plainly and say why. Check your own work before claiming it works — run the tests, call the endpoint, open the page. To compile or build anything, call build_project instead of typing msbuild/cmake/dotnet/cargo yourself: it finds the installed Visual Studio/MSBuild/compiler automatically (including vswhere), restores packages, builds Release x64 by default, and hands you the compiler errors so you can fix them and rebuild.

Ask before you build the wrong thing. If a choice would change what you produce and you cannot settle it by reading a file or looking it up, call ask_user — one question up front is far cheaper than twenty rounds of work in the wrong direction, and the user would rather be asked than handed something they have to throw away. Ask early, while the work is cheap to redo, not after you have committed to an approach. Offer concrete options with a sensible default so it is one click. Do not ask about things you can find out yourself, and do not ask the same thing twice. When you are done, briefly say what you changed and whether it ran.\n\nUse search_files to find where something lives rather than opening files one at a time, and read_files when you already know you need several — each separate call costs a whole round.\n\nYou can also look at the live web. When a task depends on what is actually on a page — its markup, its data, its exact wording — fetch it rather than reasoning from memory. Before writing anything that targets a site, such as a content script, a userscript or a scraper, call inspect_page on the real URL and use the ids and classes it returns. Never invent a selector you have not seen: a plausible-looking one that does not exist produces code that runs and does nothing, which is worse than admitting you need to look. Use fetch_url to read a page, fetch_url with raw for its HTML, and download_file to save something from a URL straight into the workspace. ${webSearchMode !== "off" && canSearch ? "When you hit something you do not know — an unfamiliar error, a library's current API — call web_search rather than guessing, because a wrong assumption compounds over every round after it. One web_search costs several model calls of its own, so make the query specific and read what comes back before searching again." : "There is no web_search tool available in this reply — the Web toggle is off or no Tavily/Exa key is set in Settings. fetch_url still works if you already know the URL. When you genuinely do not know something and cannot look it up, say so instead of guessing, and name what you would have searched for."}\n\nIf an edit turns out to be wrong, undo_file puts that file back exactly as it was; reverting is safer than patching your own mistake. restore_snapshot rolls the whole workspace back to a restore point, which is a much larger step — list_snapshots first, and say what you are undoing before you do it. read_document opens PDF, Word, Excel, PowerPoint, EPUB and ODT files, which read_file cannot. inspect_binary statically reads Windows EXEs/DLLs without executing them. Select only the layers the request needs: analyses:["decompile"] to test Ghidra/ILSpy, ["strings"] for a strings dump, ["entropy"], ["carve"], ["dependencies"], or ["capa"] for those individual jobs, and ["all"] only when the user asks to check everything. Omitted analyses means a cheap summary, not everything. After download_file of a large DLL, start with summary/strings and then decompile only the functions you name in focus_terms for THAT file — enable a specific analyzer such as Decompiler Parameter ID via enable_analyzers if you need it. Do not dump the whole binary and do not rely on a default hook list. Ghidra leftover after a closed or refreshed tab has no inspect UI: call list_processes and stop_process id=leftover to kill it. Decompiling is expensive and its artifacts persist on disk; the system message lists every executable already analyzed in this workspace with its hash and artifact paths - if the binary you need is already there, read those artifacts with read_file instead of running inspect_binary again, and never re-decompile the same hash unless the user asks you to. The moment you reach a conclusion about a binary - which one works, what is flawed, where the good build is, what a hook actually does - call note_binary so that verdict survives Stop and compaction instead of being paid for twice. write_files creates several files in one call, which is worth using whenever you are scaffolding.\n\nBatch the changes that belong together. move_file renames in one step instead of read-write-delete. edit_files applies several replacements at once, across one file or many. replace_in_files changes the same text everywhere it appears, which is what you want for renaming a function or an import path — doing that file by file costs a round each. When a string might occur somewhere you did not intend, run it with preview first and read the list before committing.${
              visionApiKey || modelHasOpenToolLimits(model)
                ? " You can also view_image to look at a screenshot or mockup saved in the workspace."
                : ""
            }${
              githubConnection
                ? `\n\nThis workspace is connected to GitHub repository ${githubConnection.repo}. ` +
                  `The selected base is ${githubConnection.baseBranch}; your writable branch is ` +
                  `${githubConnection.workingBranch}. Work only on that branch. You may inspect ` +
                  `other branches with read-only git show/log/branch commands. Use git status and ` +
                  `git diff before committing, commit through run_command after approval, and call ` +
                  `github_push only when the committed work is ready. Never merge or force-push.`
                : ""
            }${hasBrowser ? BROWSER_POLICY_PROMPT : NO_BROWSER_PROMPT}`
          : "";

        /*
         * What previous tasks in this workspace proved.
         *
         * Placed in the system message rather than at the end, unlike the
         * file tree: it changes at most once per task, so it does not
         * invalidate the prompt cache the way a per-round rewrite would, and
         * it belongs with the standing instructions.
         */
        let existingLessons: Awaited<ReturnType<typeof readLessons>> = [];
        if (workspaceEnabled && lessonsEnabled) {
          try {
            existingLessons = await readLessons(workspace);
          } catch (e) {
            console.error("Could not read lessons:", e);
          }
        }
        const lessonsBlock = formatLessonsForPrompt(existingLessons);

        // Durable record of executables already inspected/decompiled in this
        // workspace, plus any verdict the agent recorded. Survives Stop and
        // compaction so the next message cannot re-run Ghidra on a hash it
        // already spent minutes on. Unlike the lessons file this is
        // machine-maintained on every inspect_binary call, so it updates even
        // when the user pressed Stop (which deliberately skips lesson refine).
        let binaryLedgerBlock = "";
        if (workspaceEnabled) {
          try {
            binaryLedgerBlock = formatBinaryLedgerForPrompt(
              await readBinaryLedger(workspace)
            );
          } catch (e) {
            console.error("Could not read binary ledger:", e);
          }
        }

        // Established conclusions, separate from the binary record. This is
        // the durable memory that stops the model re-deriving an answer it
        // worked out three turns ago ("oh yeah, that is the way!"). Read once
        // per request and refreshed in place on resume, the same as the
        // binary ledger, so it survives Stop and compaction.
        let findingsBlock = "";
        if (workspaceEnabled) {
          try {
            findingsBlock = formatFindingsForPrompt(await readFindings(workspace));
          } catch (e) {
            console.error("Could not read findings:", e);
          }
        }


        /*
         * A structured transcript, not bare {role, content}. Tool calls and
         * reasoning must survive across turns or DeepSeek rejects the next
         * request with a 400.
         *
         * The file tree is deliberately NOT in here.
         *
         * DeepSeek caches by matching a prefix from the very start of the
         * messages array, and cached input costs $0.003625/M against
         * $0.435/M for a miss — 120x. The system message is the first thing
         * it compares, so a single character changed there invalidates the
         * cache for the entire request.
         *
         * The tree was in the system message and was rewritten after every
         * round that touched a file. That meant every write, every edit and
         * every delete forced a full-price re-read of the whole conversation:
         * a task that wrote files cost several times one that only read them,
         * for no reason other than where the text sat. It now goes in a
         * message appended at the end, where it can change freely while the
         * prefix in front of it stays byte-identical.
         */
        const transcript: TranscriptMessage[] = [
          {
            role: "system",
            // Stable base instructions only. Active plugin settings are a
            // separate system message re-appended at the end of every round,
            // where role plus recency give them real weight.
            content:
              systemPrompt +
              searchAlwaysNudge +
              workspaceInstruction +
              binaryLedgerBlock +
              findingsBlock +
              lessonsBlock,
          },
        ];

        /*
         * Ox / OpenCode often treats only the first system message as binding
         * and ignores a later "priority" one after a few rounds. Pin the
         * same standing orders onto that first message — start and end —
         * so Direct Mode cannot fade. DeepSeek still gets the tail-only
         * copy (cache prefix).
         */
        if (target.providerId === "opencode" || target.providerId === "openrouter") {
          pinPluginDirectivesOnFirstSystem(transcript, pluginDirectives);
        }

        const vision = getModel(model).vision;

        /*
         * Which history turns still replay their pixels in full.
         *
         * Every past user turn used to re-send its full base64 image/video on
         * EVERY request: up to twenty messages, 8MB images and 32MB clips —
         * one clip alone made a ~43MB body on every round, which is the
         * "invalid zstd request body" 1210 the Zen gateway returns, and on
         * the free pool the image tokens were re-billed every turn. What the
         * model saw is already reflected in its own earlier turns, so pixels
         * stay full only for the newest media-bearing turns (videos keep
         * strictly less of a window than images — they are the huge ones)
         * and become a one-line reference before that.
         */
        const mediaWindowFor: (
          msg: ScopedChatMessage
        ) => { images: boolean; videos: boolean } | null =
          vision === "native"
            ? (() => {
                const imgWindow = new Map<number, boolean>();
                const vidWindow = new Map<number, boolean>();
                let imgSeen = 0;
                let vidSeen = 0;
                for (let i = scopedHistory.length - 1; i >= 0; i--) {
                  const m = scopedHistory[i];
                  if (m.role !== "user") continue;
                  let hasImg = false;
                  let hasVid = false;
                  for (const a of m.attachments ?? []) {
                    if (a.kind === "image" && a.dataUrl) hasImg = true;
                    if (a.kind === "video" && a.dataUrl) hasVid = true;
                  }
                  if (hasImg) {
                    imgWindow.set(i, imgSeen < 2);
                    imgSeen += 1;
                  }
                  if (hasVid) {
                    vidWindow.set(i, vidSeen < 1);
                    vidSeen += 1;
                  }
                }
                return (m: ScopedChatMessage) => {
                  const i = scopedHistory.indexOf(m);
                  if (!imgWindow.has(i) && !vidWindow.has(i)) return null;
                  return {
                    images: imgWindow.get(i) ?? false,
                    videos: vidWindow.get(i) ?? false,
                  };
                };
              })()
            : () => null;

        for (const msg of scopedHistory) {
          if (msg.role === "assistant") {
            if (!msg.content?.trim()) continue;
            transcript.push({ role: "assistant", content: msg.content });
            continue;
          }
          const window = mediaWindowFor(msg);
          const built = buildUserContent(
            msg.content ?? "",
            msg.attachments,
            vision,
            window ? { mediaWindow: window } : undefined
          );
          if (!userHasContent(built)) continue;
          transcript.push({
            role: "user",
            content: built,
            // Re-label a saved steering note on replay, so a later run reads
            // it as "the user said this mid-task" rather than plain history.
            ...(msg.note === true ? { note: true } : {}),
          });
        }
        transcript.push({
          role: "user",
          content: buildUserContent(userText, attachments, vision),
        });

        /**
         * Re-append active plugins as the newest system instruction.
         *
         * Concatenating them into the first system message made them older
         * than the whole transcript, file tree and plan. Calling the block
         * "highest priority" could not compensate for that structural weight.
         * One dedicated system message is the highest supported API role, and
         * moving the stable block to the tail each round preserves prompt-cache
         * prefix hits while keeping it more recent than every dynamic input.
         */
        const appendPluginDirectives = () => {
          // Only the dedicated tail copy moves. The first system message may
          // START with the same marker (Ox pin) and must not be deleted.
          for (let i = transcript.length - 1; i >= 0; i--) {
            const entry = transcript[i];
            if (
              entry.role === "system" &&
              typeof entry.content === "string" &&
              entry.content === pluginDirectives
            ) {
              transcript.splice(i, 1);
            }
          }
          if (pluginDirectives) {
            transcript.push({ role: "system", content: pluginDirectives });
          }
        };

        /*
         * The file tree, as the last message before the model replies.
         *
         * Kept at the end for two reasons. The cache prefix in front of it
         * never changes, so rewriting the tree no longer invalidates the
         * whole request. And the model weighs what it read most recently
         * most heavily, so the current state of the workspace is the last
         * thing it sees before deciding what to do.
         *
         * Index is remembered rather than searched for: the loop appends
         * assistant and tool messages after this point, and finding it by
         * scanning would match the wrong message once the transcript grows.
         */
        let fileTreeIndex = -1;
        let currentFileTree = "";

        /*
         * Decides, each time the workspace changes, whether to append a short
         * delta or spend a cache miss on a fresh listing.
         */
        const treeTracker = new TreeTracker();

        /**
         * The agent's plan for this reply, if it made one.
         *
         * Lives for the duration of the run. It is appended to the request as
         * a trailing message so it can change every round without disturbing
         * the cached prefix, the same reason the file tree sits at the end.
         */
        /*
         * Loaded from disk, not started empty.
         *
         * This was `let plan = null` with a comment saying it to the request as
         * a trailing message so it can change every round without disturbing
         * the cached prefix, the same reason the file tree sits at the end.
         */
        /*
         * Loaded from disk, not started empty.
         *
         * This was `let plan = null` with a comment saying it lived for the
         * duration of the run — which is exactly the reported bug. Pressing
         * Stop threw the plan away, so the next message either re-planned
         * from nothing (losing every verified step) or carried on from
         * memory, which is the drift a plan exists to prevent.
         *
         * A finished plan is not carried into the next message: it belongs to
         * the task that ended, and handing it to an unrelated question would
         * be worse than having none.
         */
        let plan: Plan | null = null;
        /*
         * A leftover unfinished plan from a previous message must not lock
         * make_plan. Mid-run shrink-to-escape stays refused; the first
         * make_plan of a NEW user message (not Resume) may replace it.
         */
        let allowFirstPlanShrink = false;
        if (workspaceEnabled) {
          const saved = await readPlan(workspace);
          if (saved && !planIsComplete(saved)) {
            plan = saved;
            allowFirstPlanShrink = !resumeMessageId;
            /*
             * A blocked step left over from the previous reply must NOT
             * start this one stuck. "blocked" meant the last reply gave up;
             * carried forward it reads as a refusal the new reply never made
             * and, worse, the loop treats it as an answer to "are you done".
             * Reopen the steps and persist that, so the disk file cannot
             * resurrect the block on the message after either. A Resume
             * within the same task keeps the block visible only briefly —
             * reopening is still correct: the user pressed Resume because
             * they want it tried again.
             */
            if (planHasBlocked(plan)) {
              plan = reopenBlockedSteps(plan);
              await writePlan(workspace, plan);
            }
            send({
              type: "plan",
              goal: plan.goal,
              steps: plan.steps,
              summary: planSummary(plan),
            });
          } else if (saved) {
            // Finished last time: clear it so it cannot leak into this task.
            await writePlan(workspace, null);
          }
        }
        /** Only ever nudged once — see the check where the loop ends. */
        let nudgedIncomplete = false;
        /**
         * How many times a refusal-as-blocked has been reopened this run.
         *
         * A blocked step that is the model declining the work is reopened and
         * the work sent back, but a model that re-blocks on the third attempt
         * is either genuinely hitting something or determined to refuse — in
         * both cases looping forever burns tokens, so after this many the run
         * ends and the user can see the blocker text.
         */
        let refusalReopens = 0;
        const MAX_REFUSAL_REOPENS = 2;
        /** Only ever pushed to clarify once, however long the run gets. */
        let askedEarly = false;
        /**
         * The reply claimed tool work that never ran, and it was sent back to
         * actually do it (or confess). Once: a model that fabricates after
         * being caught gets the post-hoc note instead of another round.
         */
        let claimRetried = false;
        /** How many times the plan has been rewritten, to catch thrashing. */
        let replanCount = 0;
        /**
         * Every tool the model has actually used in this reply.
         *
         * Used to check that "I ran the tests" corresponds to something that
         * really ran. Names only — the arguments are irrelevant here and
         * keeping them would make this grow without bound on a long task.
         */
        const toolsUsedThisRun: string[] = [];

        const setFileTree = (text: string) => {
          currentFileTree = text;
          const body =
            `Current workspace contents (refreshed after every action — ` +
            `this replaces any earlier listing):${text}`;
          // `system`, not `user`. A trailing user message is, by every
          // convention, the thing being asked — putting a file listing there
          // makes the listing look like the request and buries the real
          // question above it. The self-test caught exactly this: asked to
          // create hello.py, the model produced app.py, because the last
          // thing addressed to it was a directory tree. As a system message
          // it reads as context, which is what it is.
          /*
           * Moved to the end, not overwritten where it sits.
           *
           * The listing was written back to a fixed index near the front of
           * the transcript. DeepSeek caches by PREFIX, so changing a message
           * at position 3 invalidates positions 3..n — which, twenty rounds
           * in, is every tool result of the whole run. The tree is the one
           * message that changes on almost every round, so it was
           * re-billing the entire conversation behind it each time.
           *
           * Measured over a 40-round task with a modest workspace:
           *
           *   tree at a fixed early index   126,088 missed tokens   $0.0552
           *   tree moved to the end          34,945 missed tokens   $0.0159
           *
           * 3.5x, and it grows with the length of the run — the longer the
           * task, the more sits behind the tree to be re-billed.
           *
           * The comment on the plan block below already had this exactly
           * right — "being last is also why it is free" — and the tree, which
           * changes far more often, was not getting the same treatment. The
           * re-baseline path (setFileTreeFull) removes and re-appends, so it
           * was already correct; only this hot path was not.
           */
          for (let i = transcript.length - 1; i >= 0; i--) {
            const m = transcript[i];
            if (
              m.role === "system" &&
              typeof m.content === "string" &&
              m.content.startsWith("Current workspace contents")
            ) {
              transcript.splice(i, 1);
            }
          }
          transcript.push({ role: "system", content: body });
          fileTreeIndex = transcript.length - 1;
        };

        if (workspaceEnabled) {
          setFileTree(workspaceFiles);
          // Seed the tracker with the same listing the model was just shown,
          // so the first delta describes changes from what it actually saw
          // rather than from an empty workspace.
          try {
            treeTracker.update(
              (await listFiles(workspace)).filter((f) => f.path !== "LESSONS.md")
            );
          } catch {
            /* the tracker simply baselines on its first successful refresh */
          }
        }

        /*
         * Replace everything above with the saved transcript when resuming.
         *
         * Built fresh first and then swapped, rather than branching earlier,
         * so the ordinary path stays exactly as it was. The tree is rebuilt
         * from the live workspace afterwards: the files on disk have moved on
         * since the reply stopped, and the stale listing inside the saved
         * transcript would describe a workspace that no longer exists.
         */


        /**
         * Keep the tree honest as the agent works.
         *
         * It was built once before the loop and never touched again, so after
         * the agent deleted a file on round three, rounds four onward still
         * listed it as present — which is why replies could name files that
         * no longer existed, or recreate one just deleted.
         *
         * Moving it to the end costs nothing to update: only this one message
         * changes, and everything the cache matches sits before it.
         */
        const refreshFileTree = async () => {
          if (!workspaceEnabled) return;

          let files: { path: string; size: number }[];
          try {
            files = (await listFiles(workspace)).filter(
              (f) => f.path !== "LESSONS.md"
            );
          } catch {
            return; // Keep the last known tree rather than blanking it.
          }

          const step = treeTracker.update(files);
          if (step.kind === "none") return;

          if (step.kind === "delta") {
            /*
             * Append, and touch nothing above.
             *
             * This is the whole optimisation. See lib/tree-delta.ts for the
             * measurements, but the short version: the previous code deleted
             * the listing from near the front of the array and re-appended
             * it, which changes the request from that point onward and costs
             * a full-price re-read of the entire conversation. Measured at
             * 229k wasted tokens on a 40-round task — a third of all input.
             *
             * A trailing append leaves every earlier byte identical, so it
             * all still hits the cache. The listing itself never moves again.
             */
            transcript.push({ role: "system", content: step.text });
            return;
          }

          // A re-baseline: enough has changed that a fresh listing is clearer
          // and smaller than the accumulated diffs. This costs one cache
          // miss, knowingly and rarely.
          let next = "";
          try {
            next = await buildWorkspaceContext(workspace);
          } catch {
            return;
          }
          if (next === currentFileTree) return;

          // Remove the old listing and every delta that described changes to
          // it — they are all superseded by the tree about to be appended,
          // and leaving them would have the model reading a diff against a
          // listing that no longer exists.
          for (let i = transcript.length - 1; i >= 0; i--) {
            const m = transcript[i];
            if (
              m.role === "system" &&
              typeof m.content === "string" &&
              (m.content.startsWith("Current workspace contents") ||
                m.content.startsWith("Workspace changes since"))
            ) {
              transcript.splice(i, 1);
            }
          }
          fileTreeIndex = -1;
          setFileTree(next);
        };

        /*
         * Replace everything above with the saved transcript when resuming.
         *
         * Built fresh first and then swapped, rather than branching earlier,
         * so the ordinary path stays exactly as it was. The tree is rebuilt
         * from the live workspace afterwards: the files on disk have moved on
         * since the reply stopped, and the stale listing inside the saved
         * transcript would describe a workspace that no longer exists.
         */
        if (resumed) {
          transcript.length = 0;

          /*
           * Replay the COMPLETE attempt: every tool call, every result, all
           * the reasoning.
           *
           * This used to fold the attempt unconditionally, collapsing all
           * but the last four rounds into one-line notes
           * ("- write_file(src/m0.js)")
           * and dropped the tool RESULTS for every folded round. A resumed
           * model then could not see what a command returned, whether a file
           * was fully written, or what a test printed — so it re-ran the same
           * commands and re-did the same work ("it has no memory on resume").
           *
           * The full transcript is the memory. Keeping it is also cheap: the
           * repo's own measurements (lib/compact.ts) show old reasoning lives
           * in the cached prefix at ~1/120th the rate, so folding it to save
           * money does not pay for itself short of 100+ rounds. We therefore
           * only fold as a safety valve, at the SAME high threshold the live
           * loop uses — a transcript approaching the context window is folded
           * to fit, keeping the recent rounds verbatim; anything smaller is
           * replayed byte for byte. The per-round prune that follows still
           * collapses very large old *file reads*, and findings/plan are
           * refreshed below.
           */
          const folded = compactTranscript(resumed.messages);
          transcript.push(...folded.messages);
          if (folded.stats.rounds > 0) {
            send({
              type: "context_compacted",
              rounds: folded.stats.rounds,
              tokensSaved: folded.stats.tokensSaved,
            });
          }

          fileTreeIndex = -1;
          currentFileTree = "";

          // Drop the tree the saved transcript carried, wherever it sits, so
          // the refresh below appends one current listing instead of leaving
          // two that disagree.
          for (let i = transcript.length - 1; i >= 0; i--) {
            const m = transcript[i];
            if (
              (m.role === "system" || m.role === "user") &&
              typeof m.content === "string" &&
              m.content.startsWith("Current workspace contents")
            ) {
              transcript.splice(i, 1);
            }
          }

          transcript.push({
            role: "user",
            // A rebuilt transcript needs a different brief: some results
            // above are placeholders, and telling the model everything is
            // intact is how it ends up describing a file it never saw.
            content:
              (rebuilt
                ? rebuiltResumeInstruction(rebuilt)
                : "You were interrupted before finishing. Everything above is " +
                  "your own work so far, including what the tools returned — " +
                  "it is still valid, so do not repeat it. Continue from " +
                  "exactly where you stopped. If a file was only partly " +
                  "written, finish it with edit_file rather than rewriting it " +
                  "from the start.") +
              // Anything typed next to "resume". Placed last so it is the
              // final thing the model reads before continuing, which is where
              // a course correction belongs.
              (resumeNote?.trim()
                ? `\n\nThe user added this instruction for the rest of the ` +
                  `work — follow it:\n${resumeNote.trim()}`
                : ""),
          });

          // Refresh the binary ledger. The saved first system message carries
          // a snapshot taken when the interrupted reply STARTED, before any
          // of its inspect_binary calls ran, so on resume it would tell the
          // model nothing was analyzed yet and it would re-decompile every
          // DLL. Replace that block in place with the current ledger from
          // disk, where every completed inspection has already been recorded.
          try {
            const fresh = formatBinaryLedgerForPrompt(
              await readBinaryLedger(workspace)
            );
            if (fresh) {
              for (let i = 0; i < transcript.length; i++) {
                const m = transcript[i];
                if (m.role === "system" && typeof m.content === "string") {
                  const updated = replaceBinaryLedger(m.content, fresh);
                  if (updated !== m.content) {
                    transcript[i] = { ...m, content: updated };
                    break;
                  }
                }
              }
            }
          } catch (e) {
            console.error("Could not refresh binary ledger on resume:", e);
          }

          // Refresh findings the same way: conclusions recorded during the
          // interrupted run are on disk but absent from the replayed first
          // system message, which froze the (empty) block at request start.
          try {
            const fresh = formatFindingsForPrompt(
              await readFindings(workspace)
            );
            if (fresh) {
              for (let i = 0; i < transcript.length; i++) {
                const m = transcript[i];
                if (m.role === "system" && typeof m.content === "string") {
                  const updated = replaceFindings(m.content, fresh);
                  if (updated !== m.content) {
                    transcript[i] = { ...m, content: updated };
                    break;
                  }
                }
              }
            }
          } catch (e) {
            console.error("Could not refresh findings on resume:", e);
          }

          await refreshFileTree();
        }

        if (target.providerId === "opencode" || target.providerId === "openrouter") {
          pinPluginDirectivesOnFirstSystem(transcript, pluginDirectives);
        }

        // ---------------- Agent loop ----------------
        // Without tools this runs exactly once. With them, each pass may end
        // in tool calls, which are executed and fed back as `role: "tool"`
        // messages before the next pass.
        // Write, run, read the error, fix, run again is four rounds for a
        // single bug. Real work is several of those plus the reading it takes
        // to find the right file, so the round guard below is deliberately
        // far above what an ordinary task needs: a reply ends when the model
        // stops calling tools, the user presses Stop, or a spending limit
        // (if one is set) fires.
        let round = 0;
        // Carried across Resume so the ask-early nudge and plan checks still
        // see how long this reply has already been working.
        let toolRounds = resumed?.toolRounds ?? 0;

        /**
         * Automatic "carry on" rounds after hitting the output limit.
         *
         * Capped so a model that ends every round at the ceiling cannot loop
         * forever, but high enough that a genuinely long file finishes: each
         * continuation adds another full output budget.
         */
        const MAX_CONTINUATIONS = 8;
        /**
         * Hard ceiling on the agent loop, per model.
         *
         * There is no other round budget. Combined with a Stop that used
         * to miss the body reader, a model that kept calling tools never
         * ended, so the guard has to exist and has to be finite.
         *
         * It is per model because 64 is not the same amount of work
         * everywhere. A model that batches its reads spends a handful of
         * rounds on a codebase; GLM 5.3 Flash reads one file per call and
         * can spend forty rounds before it has even looked at everything —
         * then the guard fires and the user gets a half-finished reply that
         * blames the provider. Open-ceiling models (1M window, free or
         * cheap) get a much higher guard; everyone else keeps 64.
         */
        const MAX_AGENT_ROUNDS = agentRoundsFor(model);
        /*
         * Output-limit continuation budgets start FRESH on every request —
         * including a Resume.
         *
         * They used to be carried from the saved state, so a reply that
         * stopped at the ceiling resumed with continuations already at the
         * cap: the very next long round tripped hitOutputCeiling again, and
         * the reply stopped at the same message over and over no matter how
         * many times it was resumed. An explicit Resume IS the authorisation
         * for another set of budgets; the user chose to keep paying. The
         * round cap (toolRounds, below) still carries, so a genuinely
         * runaway loop remains finite.
         */
        let continuations = 0;
        /**
         * Set when the next round is a "carry on from where you stopped"
         * prose continuation, so that round de-duplicates any text the model
         * incorrectly echoes back instead of continuing (GLM/Ox restart the
         * sentence). Consumed by the round that requested it.
         */
        let proseContinuationPending = false;
        /**
         * A think-only output-limit cut: one nudge to act, then stop. Fresh
         * budget on Resume for the same reason — but forceNoThinking below
         * still carries, so a model that burned the whole ceiling on
         * thinking is NOT told it may think again.
         */
        let thinkNudges = 0;
        /** After a think-only cut, the next call must not think again. */
        let forceNoThinking =
          (resumed?.thinkNudges ?? 0) > 0 ||
          /do not think more/i.test(resumeNote ?? "");
        /**
         * Times we auto-continued a mid-task stop that was not an output
         * ceiling. Separate from MAX_CONTINUATIONS, and not carried across
         * Resume: an explicit continue is the user asking us to try again.
         */
        let autoRevives = 0;
        /**
         * Times we re-issued an OpenCode call that came back HTTP 200 with
         * an empty SSE body. Zen does this during the same outages as 503;
         * built-in retries only fire on a bad status, so without this the
         * user sees "retrying" then a blank reply.
         */
        let emptyStreamRetries = 0;
        /** Set when the reply stopped because it ran out of room. */
        let hitOutputCeiling = false;
        /** Set when the spending limit ended the run rather than the model. */
        let stoppedByBudget = false;
        /**
         * Inner-limit / mid-task stop that auto-revive could not finish.
         * Must stay resumable: treating it as a complete `done` is why
         * Resume vanished and the next send opened a new thinking box.
         */
        let stoppedPrematurely: PrematureStopReason | null = null;
        const budget = createBudget(budgetUsd);
        /**
         * What the previous round cost, used to predict the next one. A limit
         * that only looks backwards overshoots by a whole round.
         */
        let lastRoundCost = 0;

        // Accumulated across every round — one displayed reply can span
        // several API turns once tools are involved.
        //
        // Seeded from the interrupted reply when resuming, so the saved
        // message grows rather than being overwritten by only the new half.
        let assistantContent = resumedContent;
        let reasoningContent = resumedReasoning;
        // Diagnostics contain field NAMES and counts only, never private text.
        // They tell us whether the provider omitted reasoning or used an
        // alternate compatible field that the parser normalized.
        const reasoningFieldsUsed = new Set<string>();
        const upstreamDeltaFields = new Set<string>();
        // Mirrors what the client is shown, so a reopened chat still lists
        // the files this reply touched.
        const toolEvents: {
          id: string;
          name: string;
          args: string;
          ok?: boolean;
          summary?: string;
          changedPath?: string;
        }[] = [...resumedToolEvents];

        /**
         * What happened, in order.
         *
         * The model narrates between tool calls, so the raw stream already
         * alternates text and actions. Concatenating the text loses which
         * sentence went with which action, which is the only interesting
         * part — so the order is recorded rather than flattened.
         */
        const timeline: (
          | { kind: "text"; text: string }
          | { kind: "tool"; id: string }
        )[] = [...resumedTimeline];

        const appendTimelineText = (text: string) => {
          const last = timeline[timeline.length - 1];
          if (last && last.kind === "text") last.text += text;
          else timeline.push({ kind: "text", text });
        };
        let usage: unknown = null;
        /**
         * Tokens across every round of the agent loop.
         *
         * `usage` is replaced each round, so on its own it reports the last
         * round rather than the task. Without this a long loop looks cheap
         * right up until the final total lands.
         */
        /*
         * The cache split has to be carried, not just the totals.
         *
         * DeepSeek reports prompt tokens as a hit/miss pair, and the two are
         * priced 120x apart. This accumulator kept only the three totals, so
         * every live figure sent to the UI was computed with the split
         * missing — and estimateCost falls back to treating the whole prompt
         * as a miss when it is. The number climbed to several times the real
         * cost during a run and then dropped when the reply finished and the
         * saved usage, which does carry the split, replaced it.
         *
         * Nothing was ever overcharged; the display was just pricing cached
         * tokens at the uncached rate.
         */
        const totalUsage = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 0,
        };
        /**
         * Last tool round whose full transcript was persisted.
         *
         * Resume state is a megabyte on a long run, so it is written once per
         * round rather than on every 2.5-second checkpoint.
         */
        let lastResumeRound = -1;
        let announcedWriting = false;
        const toolSummaries: { name: string; ok: boolean; summary: string }[] =
          [];

        emergencySave = async () => {
          if (!(assistantContent || toolEvents.length || reasoningContent)) {
            return;
          }
          await upsertMessage(convId, title, {
            id: assistantMsgId,
            role: "assistant",
            content: assistantContent,
            reasoningContent: reasoningContent || null,
            thinkingEffort: resolvedEffort,
            model,
            tokenCount: totalUsage.total_tokens || null,
            usage: totalUsage.total_tokens ? { ...totalUsage } : null,
            toolEvents: toolEvents.length ? toolEvents : null,
            timeline: timeline.length ? timeline : null,
            createdAt: new Date().toISOString(),
            incomplete: true,
            resumeState: {
              toolRounds,
              continuations,
              thinkNudges,
              messages: transcript,
            },
          });
        };

        while (true) {
          round += 1;
          appendPluginDirectives();
          // Ox ignores the tail copy after a few rounds. Re-pin every
          // round so a long agent loop cannot fade Direct Mode.
          if (target.providerId === "opencode" || target.providerId === "openrouter") {
            pinPluginDirectivesOnFirstSystem(transcript, pluginDirectives);
          }

          /*
           * The guards sit after the pin, not before it.
           *
           * Plugin directives are re-appended and re-pinned on every single
           * round — that is the whole priority mechanism — and anything
           * inserted above it is how "every round" quietly becomes "every
           * round except the ones that return early". Breaking out a few
           * statements later costs nothing: an abandoned round only appends
           * a directive block to a transcript that is saved unchanged.
           */
          if (stopped()) break;
          if (round > MAX_AGENT_ROUNDS) {
            // Named for what it is. It used to be filed as "provider_abort",
            // which told the user their provider had cut them off when in
            // fact this app's own guard had fired — and the revive nudge
            // then repeated that same wrong explanation back to the model.
            stoppedPrematurely = "round_cap";
            break;
          }

          /*
           * Drain steering notes the user posted while the previous round ran.
           *
           * A note becomes a real user message at this boundary — the last
           * thing the model reads before its next step — so it reads "hmm,
           * the user just told me this" in its thinking instead of the note
           * sitting in a side channel the task never sees. Nothing running is
           * interrupted: the previous round finished, and tools it started
           * keep running; the note simply joins the transcript here.
           *
           * Each note is also persisted as an ordinary user message, so it
           * keeps steering every later turn (and a resume, whose transcript
           * already contains it) instead of vanishing when this reply ends.
           */
          try {
            const midRunNotes = await drainBtwNotes(convId);
            for (const note of midRunNotes) {
              const noteId = uuidv4();
              // Same builder a normal message's attachments go through:
              // native-vision models get the pixels, blind models the
              // description blocks, and a dropped binary's "saved at <path>"
              // note rides in the wire text — so the task sees the attached
              // screenshot or DLL exactly as if it had been sent as a message.
              transcript.push({
                role: "user",
                content: buildUserContent(
                  note.wireText || note.text,
                  note.attachments,
                  vision
                ),
                note: true,
              });
              try {
                await appendMessages(convId, title, [
                  {
                    id: noteId,
                    role: "user",
                    // Store what the user typed, not the file blocks: the
                    // blocks are rebuilt from the attachments on replay, the
                    // same way an ordinary message stores its content.
                    content: note.text,
                    attachments: note.attachments?.length
                      ? note.attachments
                      : null,
                    note: true,
                    createdAt: new Date().toISOString(),
                  },
                ]);
              } catch (e) {
                // The in-flight transcript already has the note, so the model
                // still gets it this run; a disk error must not kill the task.
                console.error("Failed to persist btw note:", e);
              }
              send({
                type: "btw_note_accepted",
                id: noteId,
                note: note.text,
                round,
                // Names only — the pixels are megabytes and the client
                // already has them from the composer; the chip just needs to
                // show what went in.
                attachments: note.attachments?.length
                  ? note.attachments.map((a) => ({ name: a.name, kind: a.kind }))
                  : undefined,
              });
            }
          } catch (e) {
            console.error("Failed to drain btw notes:", e);
          }

          const toolAcc = new ToolCallAccumulator();
          let roundContent = "";
          let roundReasoning = "";
          const roundDeltaFields = new Set<string>();
          /** "stop" if the model finished, "length" if it ran out of room. */
          let roundFinishReason = "";

          /*
           * Continuation de-duplication.
           *
           * When a reply is cut mid-sentence we ask the model to "carry
           * straight on from the last character". GLM and Ox often ignore
           * that and restart the sentence instead — so the new stream's
           * beginning is a copy of text already streamed and saved, and the
           * two got concatenated into one garbled line ("The chain is closed —
           * **`m_hPawn = The chain closed, love — **`m_hPawn"). This round
           * buffers its opening prose until it diverges from the tail of what
           * we already have, then drops the repeated prefix. One fresh dedup
           * per round; see lib/continuation-dedup.ts.
           */
          const dedup = proseContinuationPending
            ? createContinuationDedup(assistantContent)
            : null;
          proseContinuationPending = false;

          // Collapse old tool results before sending. The stored transcript
          // keeps everything; only the copy going upstream is reduced, so a
          // long agent run does not re-pay for the full text of a file it
          // read thirty rounds ago.
          const pruned = pruneTranscript(
            transcript,
            target.thinkingStyle === "qwen" ? QWEN_PRUNE : undefined
          );
          if (pruned.stats.collapsed > 0) {
            send({
              type: "context_pruned",
              collapsed: pruned.stats.collapsed,
              tokensSaved: pruned.stats.tokensSaved,
            });
          }

          /*
           * Fold finished rounds down to a summary.
           *
           * Pruning handles tool results; this handles reasoning, which is
           * the far larger share. Measured on a real twenty-round run:
           * reasoning was 93% of the transcript and tool output 6%, because
           * reasoning was never pruned and is resent in full every round.
           *
           * A round can only lose its reasoning by losing its tool calls too
           * — the API requires the two together — so whole rounds are
           * replaced by a plain assistant message describing what they did.
           */
          const compacted = compactTranscript(
            pruned.messages,
            target.thinkingStyle === "qwen" ? QWEN_COMPACT : undefined
          );
          if (compacted.stats.rounds > 0) {
            send({
              type: "context_compacted",
              rounds: compacted.stats.rounds,
              tokensSaved: compacted.stats.tokensSaved,
            });
          }
          // Compact returns a new array. Re-pin the copy that actually
          // goes on the wire so Ox cannot lose MAXIMUM PRIORITY.
          if (target.providerId === "opencode" || target.providerId === "openrouter") {
            pinPluginDirectivesOnFirstSystem(
              compacted.messages,
              pluginDirectives
            );
          }

          // Qwen's jinja template only accepts a system message at index 0.
          // File-tree / plan / plugin tails stay in `transcript` (and so in
          // resume state) so DeepSeek/Ox keep their cache-friendly layout.
          // The sidecar window is 80K, not 1M — fit the wire copy so a
          // workspace turn cannot 400 with "exceeds the available context".
          const foldedForQwen =
            target.thinkingStyle === "qwen"
              ? foldSystemMessagesToFront(compacted.messages)
              : compacted.messages;
          const wireMessages =
            target.thinkingStyle === "qwen"
              ? fitForLocalContext(
                  foldedForQwen,
                  localMessageBudget(workspaceEnabled)
                ).messages
              : foldedForQwen;

          const dsRequestBody: Record<string, unknown> = {
            // On the wire this may differ from the app id (Ox Alpha is
            // `x-preview-f-free` on OpenCode Zen). Saved usage still uses
            // the app id so pricing looks it up correctly.
            model: target.apiModel,
            // DeepSeek REQUIRES the verbatim reasoning on tool-calling
            // turns; the OpenCode Zen gateway validates its schema strictly
            // and the Ox catalog marks the field as not required — sending
            // it is a 400 "[1210] Invalid API parameter" once any tool round
            // is in the transcript (and every resume replays those rounds).
            messages: serializeForApi(wireMessages, {
              includeReasoning: !isOxProvider(target.providerId),
            }),
            stream: true,
            stream_options: { include_usage: true },
            /*
             * Bounded by what the remaining budget can pay for.
             *
             * The spending limit is checked between rounds, which is the only
             * place a run can stop with its work saved — but on its own that
             * let a single round overshoot badly, measured at 4.8x a $0.10
             * cap. Capping max_tokens means the round physically cannot cost
             * more than is left.
             *
             * Local Qwen also cannot emit 65k into an 80k window that already
             * holds the prompt, so the sidecar output ceiling wins there.
             */
            max_tokens: maxTokensFor(
              budget,
              model,
              // Local Qwen cannot emit 65k into an 80k window that already
              // holds the prompt, so the sidecar ceiling wins there; every
              // hosted model uses its own documented output window.
              target.thinkingStyle === "qwen"
                ? SIDECAR_MAX_OUTPUT
                : maxOutputTokensFor(model)
            ),
          };

          applyThinking(
            dsRequestBody,
            target.thinkingStyle,
            thinkingEnabled && !forceNoThinking,
            forceNoThinking ? "none" : resolvedEffort
          );

          if (workspaceEnabled) {
            /*
             * Tools that cannot work are withheld rather than offered.
             *
             * A model given a tool it has no key for will call it, get an
             * error, apologise, and try something worse — a wasted round and
             * a worse answer. view_image needs a vision key except on Ox
             * Alpha, which can use free local OCR; web_search needs a
             * Tavily or Exa key.
             */
            dsRequestBody.tools = workspaceToolsFor(model).filter((t) => {
              if (t.function.name === "view_image") {
                return Boolean(visionApiKey) || modelHasOpenToolLimits(model);
              }
              if (t.function.name === "web_search")
                // Off = the tool does not exist for the agent. On = offered
                // whenever keys exist, and the agent decides when to call it.
                return (
                  webSearchMode !== "off" && Boolean(tavilyApiKey || exaApiKey)
                );
              // The browser is an optional install. Offering it when Chromium
              // is absent buys an error, an apology and a worse fallback.
              if (t.function.name === "browse") return hasBrowser;
              if (t.function.name === "github_push") {
                return Boolean(githubConnection && githubToken);
              }
              return true;
            });
            dsRequestBody.tool_choice = "auto";
          }

          send({ type: "status", stage: thinkingEnabled ? "thinking" : "writing" });

          const inputChars = JSON.stringify(dsRequestBody).length;
          const retryAttempts =
            target.providerId === "opencode" || target.providerId === "openrouter"
              ? OPENCODE_RETRY.attempts
              : undefined;

          // ---------------- Call DeepSeek ----------------
          // Retried rather than failed outright: a blip on round thirty of a
          // long task used to discard the whole run, including every token
          // already paid for. Only transient failures retry — a rejected key
          // or an empty balance fails the same way every time.
          const attempt = await fetchWithRetry(
            () =>
              fetchUntilHeaders(
                (signal) =>
                  fetch(`${target.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: completionHeaders(target),
                    body: JSON.stringify(dsRequestBody),
                    signal,
                  }),
                attemptTimeoutMs(target, inputChars),
                runSignal
              ),
            {
              ...((target.providerId === "opencode" || target.providerId === "openrouter") ? OPENCODE_RETRY : {}),
              signal: runSignal,
              onAttempt: ({ attempt: n, attempts }) => {
                send({
                  type: "retrying",
                  phase: "attempt",
                  attempt: n,
                  attempts,
                  delayMs: 0,
                  reason: "",
                  host: target.providerName,
                  inputChars,
                });
              },
              onRetry: ({ attempt: n, attempts, delayMs, reason }) => {
                send({
                  type: "retrying",
                  phase: "backoff",
                  attempt: n,
                  attempts,
                  delayMs,
                  reason,
                  host: target.providerName,
                  inputChars,
                });
              },
            }
          );

          if (!attempt.response) {
            const err = attempt.error;
            if (
              err instanceof Error &&
              err.name === "AbortError" &&
              !isTimeoutFailure(err)
            ) {
              // The user pressed Stop; the abort handler already tidied up.
              close();
              return;
            }
            const timedOut = isTimeoutFailure(err);
            const hadWork = Boolean(
              assistantContent || toolEvents.length || reasoningContent
            );
            if (hadWork) {
              try {
                await emergencySave?.();
              } catch (e) {
                console.error("Could not save work before timeout:", e);
              }
            }
            /*
             * No response at all — every attempt died on the network or on a
             * deadline. That is their server (or our clock), not the user's
             * key: with work saved, the reply continues itself. A Stop never
             * reaches here — the run-signal check above returns first.
             */
            send({
              type: "error",
              error: timedOut
                ? providerTimedOut(target.providerName, attempt.attempts)
                : providerUnreachable(target.providerName, attempt.attempts),
              autoResume: hadWork,
            });
            close();
            return;
          }

          let dsResponse = attempt.response;
          let earlyErrText = "";

          /*
           * Ox: one more chance with a body the gateway will actually take.
           *
           * A 400 "Invalid API parameter" is a REJECTION OF THE REQUEST
           * SHAPE, not of the content — retrying it identically fails
           * identically, which is why the retry policy treats 400 as fatal.
           * The shapes only Ox has rejected in the wild are the tool path
           * (their adapter for the free model flaps: anomalyco/opencode
           * #44300, #44382 — while it is down, every request that offers
           * tools fails while plain chat works) and oversized or foreign
           * media payloads (the "invalid zstd request body" variant of the
           * same 1210). So: if the rejection looks like a shape problem,
           * retry ONCE with the sanitized body — no tools, no media pixels.
           * The round degrades to prose at worst; the model can still emit
           * tool calls learned from the history and we execute those. Either
           * way the task survives instead of a hard stop mid-run.
           */
          if (!dsResponse.ok && (target.providerId === "opencode" || target.providerId === "openrouter")) {
            earlyErrText = await dsResponse.text().catch(() => "");
            const rejectedDetail = (() => {
              try {
                const parsed = JSON.parse(earlyErrText);
                return String(parsed?.error?.message ?? parsed?.message ?? "");
              } catch {
                return earlyErrText.slice(0, 300);
              }
            })();
            if (
              dsResponse.status === 400 ||
              (dsResponse.status >= 500 && /endpoint is unavailable/i.test(rejectedDetail))
            ) {
              const sanitized = sanitizeOxRequestBody(dsRequestBody);
              if (JSON.stringify(sanitized) !== JSON.stringify(dsRequestBody)) {
                const sanitizedChars = JSON.stringify(sanitized).length;
                send({
                  type: "retrying",
                  phase: "attempt",
                  attempt: attempt.attempts + 1,
                  attempts: (retryAttempts ?? attempt.attempts) + 1,
                  delayMs: 0,
                  reason: "host rejected the payload — retrying without tools and media",
                  host: target.providerName,
                  inputChars: sanitizedChars,
                });
                try {
                  const second = await fetchUntilHeaders(
                    (signal) =>
                      fetch(`${target.baseUrl}/chat/completions`, {
                        method: "POST",
                        headers: completionHeaders(target),
                        body: JSON.stringify(sanitized),
                        signal,
                      }),
                    attemptTimeoutMs(target, sanitizedChars),
                    runSignal
                  );
                  if (second.ok && second.body) {
                    recordAsync({
                      kind: "api_error",
                      subject: "ox_shape_rejection",
                      detail: `Recovered on sanitized retry after HTTP ${dsResponse.status}: ${rejectedDetail.slice(0, 160)}`,
                      context: { status: dsResponse.status },
                    });
                    dsResponse = second;
                  } else {
                    const t2 = await second.text().catch(() => "");
                    console.error(
                      "Ox sanitized retry failed:",
                      second.status,
                      t2.slice(0, 300)
                    );
                  }
                } catch (e) {
                  console.error("Ox sanitized retry threw:", e);
                }
              }
            }
          }

          if (!dsResponse.ok || !dsResponse.body) {
            const errText = earlyErrText || (await dsResponse.text().catch(() => ""));
            console.error("DeepSeek error:", dsResponse.status, errText);

            let detail = "";
            try {
              const parsed = JSON.parse(errText);
              detail = parsed?.error?.message ?? parsed?.message ?? "";
            } catch {
              detail = errText.slice(0, 200);
            }

            /*
             * Keep the work before giving up.
             *
             * This path is hit when the balance runs out, the key is
             * rejected, or DeepSeek rate-limits — and it used to return
             * without saving anything, so a run that had already spent
             * twenty rounds and written several files left a bare error
             * bubble with no way to continue it. Exactly the case that
             * prompted this: the money ran out mid-task and the task was
             * unrecoverable.
             *
             * Anything already produced is checkpointed with its resume
             * state first, so topping up and pressing Continue picks up
             * where it stopped instead of starting over.
             */
            const hadWork = Boolean(
              assistantContent || toolEvents.length || reasoningContent
            );
            if (hadWork) {
              try {
                await upsertMessage(convId, title, {
                  id: assistantMsgId,
                  role: "assistant",
                  content: assistantContent,
                  reasoningContent: reasoningContent || null,
                  thinkingEffort: resolvedEffort,
                  model,
                  tokenCount: totalUsage.total_tokens || null,
                  usage: totalUsage.total_tokens ? { ...totalUsage } : null,
                  toolEvents: toolEvents.length ? toolEvents : null,
                  timeline: timeline.length ? timeline : null,
                  createdAt: new Date().toISOString(),
                  incomplete: true,
                  resumeState: {
                    toolRounds,
                    continuations,
                    thinkNudges,
                    messages: transcript,
                  },
                });
              } catch (e) {
                console.error("Could not save work before failing:", e);
              }
            }

            /*
             * Server-side statuses (their 5xx / 408 / 409 / 425) mean the
             * host is down or overloaded — the same failure a dropped
             * stream is, so saved work continues itself. A 429 is the pool
             * saying "slow down" (the limit-resume agent owns it), and a
             * 401/402 is the key or balance — retrying those just delays
             * the error the user needs to see.
             */
            send({
              type: "error",
              error: providerHttpError(
                dsResponse.status,
                target.providerName,
                detail
              ),
              autoResume:
                hadWork && SERVER_SIDE_STATUS.has(dsResponse.status),
            });
            close();
            return;
          }

          // ---------------- Consume DeepSeek's SSE ----------------
          const reader = dsResponse.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const watchFirstToken = isOxProvider(target.providerId);
          const streamStarted = Date.now();
          let gotUpstreamSignal = false;
          let firstTokenTimedOut = false;
          /*
           * Idle watchdog AFTER the first byte.
           *
           * The first-token watchdog above only arms before anything arrives.
           * Once tokens are flowing, reader.read() would otherwise wait
           * forever: a host that accepts the connection, streams a little
           * (a long reasoning think is the common case) and then goes silent
           * — dropped pool connection, half-closed socket on their side —
           * leaves the reply frozen with no error and no Stop recovery, the
           * "it thought for twenty minutes and then hung" report. A normal
           * provider that is actually generating sends SSE keep-alive /
           * reasoning tokens inside this window; five minutes of total
           * silence is a dead connection, not a deep think. On fire we
           * checkpoint and surface a resumable timeout error instead.
           */
          const STREAM_IDLE_MS = 5 * 60_000;
          const markUpstream = () => {
            if (gotUpstreamSignal) return;
            gotUpstreamSignal = true;
            send({
              type: "retrying",
              phase: "clear",
              attempt: attempt.attempts,
              attempts: retryAttempts ?? attempt.attempts,
              delayMs: 0,
              reason: "",
              host: target.providerName,
            });
          };

          // Checkpoint the partial reply to disk at most once every few seconds.
          // Without this, closing the tab mid-answer lost everything generated
          // so far; with it, the text is recoverable and flagged `incomplete`.
          let lastCheckpoint = 0;
          let checkpointing = false;
          const CHECKPOINT_MS = 2500;

          const checkpoint = async (force = false) => {
            const nowMs = Date.now();
            if (!force && nowMs - lastCheckpoint < CHECKPOINT_MS) return;
            if (checkpointing) return;
            checkpointing = true;
            lastCheckpoint = nowMs;
            try {
              await upsertMessage(convId, title, {
                id: assistantMsgId,
                role: "assistant",
                content: assistantContent,
                reasoningContent: reasoningContent || null,
                thinkingEffort: resolvedEffort,
                webSearchUsed: searchAccum.used,
                searchResults: searchAccum.results.length
                  ? searchAccum.results
                  : null,
                searchQueries: searchAccum.queries.length
                  ? searchAccum.queries
                  : null,
                pluginsUsed: enabledPluginIds.length ? enabledPluginIds : null,
                tokenCount: null,
                toolEvents: toolEvents.length ? toolEvents : null,
                timeline: timeline.length ? timeline : null,
                createdAt: new Date().toISOString(),
                incomplete: true,
                /*
                 * Everything needed to carry on instead of starting over —
                 * but not on every checkpoint.
                 *
                 * Checkpoints fire every 2.5 seconds while text streams, and
                 * the transcript of a long agent run is around a megabyte of
                 * JSON. Serialising and writing that continuously, purely so
                 * a crash in the next few seconds would be resumable, costs
                 * far more than it protects: it slows the stream the user is
                 * watching and hammers the disk.
                 *
                 * Written once per tool round instead. A round is where the
                 * expensive, hard-to-redo work happens, so that is the
                 * granularity worth protecting; the prose since the last
                 * round is checkpointed as before and simply re-generated.
                 */
                resumeState:
                  toolRounds > lastResumeRound
                    ? { toolRounds, continuations, thinkNudges, messages: transcript }
                    : undefined,
              });
              // Recorded after a successful write, so a failed checkpoint
              // retries rather than skipping the round entirely.
              if (toolRounds > lastResumeRound) lastResumeRound = toolRounds;
            } catch (e) {
              console.error("Checkpoint failed:", e);
            } finally {
              checkpointing = false;
            }
          };

          let streamTimedOut = false;
          let idleTimedOut = false;
          try {
          while (true) {
            // The client vanished (tab closed, navigation, network drop). Stop
            // pulling tokens and keep the last checkpoint, which stays flagged
            // incomplete so the UI can offer to continue.
            if (stopped()) {
              await checkpoint(true);
              await reader.cancel().catch(() => {});
              close();
              return;
            }

            // Before the first signal: Ox gets its short overall budget
            // (OX_FIRST_TOKEN_MS). After: every individual read gets the idle
            // budget, so a stream that falls silent mid-reply — five minutes
            // with zero bytes — is a dead connection, not a deep think.
            const beforeFirst = watchFirstToken && !gotUpstreamSignal;
            const readMs = beforeFirst
              ? Math.max(1, OX_FIRST_TOKEN_MS - (Date.now() - streamStarted))
              : STREAM_IDLE_MS;
            const chunkRead = await readWithTimeout(
              reader,
              readMs,
              runSignal
            );
            if (chunkRead.timedOut) {
              if (!beforeFirst) {
                // Stream died mid-reply after producing output. Not the same
                // as "host never answered": work is in-flight, so checkpoint
                // and surface the resumable timeout below.
                idleTimedOut = true;
                streamTimedOut = true;
                await reader.cancel().catch(() => {});
                break;
              }
              firstTokenTimedOut = true;
              await reader.cancel().catch(() => {});
              break;
            }
            const { done, value } = chunkRead;
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE frames are newline-delimited; keep the trailing partial line.
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;

              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;

              let chunk: {
                choices?: {
                  delta?: {
                  content?: string;
                  reasoning_content?: unknown;
                  reasoning?: unknown;
                  thinking?: unknown;
                  reasoningContent?: unknown;
                  tool_calls?: {
                    index?: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }[];
                };
                /**
                 * Why the model stopped. "stop" means it finished its
                 * thought; "length" means it hit max_tokens mid-sentence and
                 * had more to say.
                 *
                 * This was never read. Nothing in the app could tell a
                 * finished reply from one chopped off in the middle, which is
                 * why a file the model was halfway through writing silently
                 * failed to appear: the tool call was cut off, its arguments
                 * were invalid JSON, and the failure looked like any other
                 * bad call rather than "ran out of room, ask for the rest".
                 */
                finish_reason?: string | null;
                }[];
                usage?: unknown;
              };
              try {
                chunk = JSON.parse(payload);
              } catch {
                continue; // ignore malformed frames rather than aborting
              }

              if (chunk.usage) {
                usage = chunk.usage;
                const u = chunk.usage as Record<string, number>;
                totalUsage.prompt_tokens += u.prompt_tokens ?? 0;
                totalUsage.completion_tokens += u.completion_tokens ?? 0;
                totalUsage.total_tokens += u.total_tokens ?? 0;
                // Kept per round and summed, since each round has its own
                // split — the first is mostly a miss, later ones mostly hits.
                // Normalize OpenRouter's prompt_tokens_details.cached_tokens
                // too; otherwise GLM cache reads are billed in the UI and
                // spending cap as full-price misses.
                const split = cacheSplit(u as Parameters<typeof cacheSplit>[0]);
                totalUsage.prompt_cache_hit_tokens += split.hit;
                totalUsage.prompt_cache_miss_tokens += split.miss;
                // Charge the running total for this round, at the real
                // cache-split rates, so the limit is enforced against what is
                // actually being billed rather than a token count.
                lastRoundCost = chargeRound(budget, u, model);

                const period = getDeepSeekPeriod().period;
                send({
                  type: "usage",
                  usage: { ...totalUsage },
                  model,
                  period,
                  // Recompute from the summed split so the live figure always
                  // uses the period active right now, proving cache-hit/miss,
                  // output and reasoning are all included in the number.
                  spentUsd: estimateCost(totalUsage, model, period) ?? budget.spentUsd,
                  limitUsd: budget.limitUsd ?? undefined,
                });
              }

              // Arrives on the final frame of the round, alongside an empty
              // delta — so it is read before the `!delta` guard below, which
              // would otherwise skip the one frame that carries it.
              const reason = chunk.choices?.[0]?.finish_reason;
              if (reason) {
                roundFinishReason = reason;
                markUpstream();
              }

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              for (const key of Object.keys(delta)) {
                upstreamDeltaFields.add(key);
                roundDeltaFields.add(key);
              }
              const reasoningDelta = extractReasoningDelta(
                delta as Record<string, unknown>
              );
              if (reasoningDelta) {
                reasoningFieldsUsed.add(reasoningDelta.field);
                /*
                 * Separate one round's thinking from the next.
                 *
                 * Reported as "blah blah blah.blah" — a missing space in the
                 * thinking panel. It is not a lost token and not a
                 * token-saving trick: the agent loop makes one API call per
                 * round, each returns its own reasoning, and the displayed
                 * panel is every round concatenated.
                 */
                if (!roundReasoning && reasoningContent) {
                  const gap = /\n\s*$/.test(reasoningContent) ? "" : "\n\n";
                  if (gap) {
                    reasoningContent += gap;
                    send({ type: "reasoning", delta: gap });
                  }
                }
                reasoningContent += reasoningDelta.text;
                roundReasoning += reasoningDelta.text;
                sawWork = true;
                markUpstream();
                send({ type: "reasoning", delta: reasoningDelta.text });
                void checkpoint();
              }
              if (delta.tool_calls) {
                markUpstream();
                for (const tc of delta.tool_calls) toolAcc.add(tc);
              }
              if (delta.content) {
                markUpstream();
                // A prose-continuation round may echo back text already
                // streamed; drop the repeated prefix before anything sees it.
                const emit = dedup ? dedup.push(delta.content) : delta.content;
                if (!emit) continue;
                if (!announcedWriting) {
                  announcedWriting = true;
                  send({ type: "status", stage: "writing" });
                }
                assistantContent += emit;
                roundContent += emit;
                sawWork = true;
                appendTimelineText(emit);
                send({ type: "content", delta: emit });
                void checkpoint();
              }
            }
          }
          } catch (streamErr) {
            if (runSignal.aborted) {
              await checkpoint(true);
              close();
              return;
            }
            if (isTimeoutFailure(streamErr)) {
              streamTimedOut = true;
              await checkpoint(true);
            } else {
              throw streamErr;
            }
          }

          if (streamTimedOut) {
            try {
              await emergencySave?.();
            } catch (e) {
              console.error("Could not save work before timeout:", e);
            }
            // A stalled stream is the host's clock problem, not ours: with
            // work checkpointed, the reply continues itself.
            send({
              type: "error",
              error: idleTimedOut
                ? `The model's connection went silent for over five minutes ` +
                  `mid-reply — their server dropped the stream. Work so far ` +
                  `is saved; Resume continues it.`
                : "The operation was aborted due to timeout",
              autoResume: Boolean(
                assistantContent || toolEvents.length || reasoningContent
              ),
            });
            close();
            return;
          }

          /*
           * OpenCode Zen sometimes returns HTTP 200 with an empty SSE body
           * during the same outages as 503. fetchWithRetry treats 200 as
           * success, so without this the user sees a blank reply after
           * "retrying". Only retry a stream that never even named a
           * finish_reason — a real empty `stop` is left alone.
           */
          if (
            (target.providerId === "opencode" || target.providerId === "openrouter") &&
            emptyStreamRetries < 2 &&
            !roundContent &&
            !roundReasoning &&
            toolAcc.result().length === 0 &&
            (!roundFinishReason || firstTokenTimedOut)
          ) {
            emptyStreamRetries += 1;
            send({
              type: "retrying",
              phase: "backoff",
              attempt: emptyStreamRetries,
              attempts: 2,
              delayMs: 1_200,
              reason: firstTokenTimedOut ? "no first token" : "empty reply",
              host: target.providerName,
              inputChars,
            });
            try {
              await sleep(1_200, runSignal);
            } catch (error) {
              if (error instanceof Error && error.name === "AbortError") {
                close();
                return;
              }
              throw error;
            }
            continue;
          }

          /*
           * Every stalled attempt failed: three 200s with nothing coming
           * through on the other side is an outage, not a short answer.
           *
           * Saving that as a completed blank reply was the "it was not
           * answering at all, and there is nothing to continue" case —
           * what the user needs is a real error. Any work from earlier
           * rounds of this reply is already checkpointed as incomplete, so
           * it stays resumable.
           */
          if (
            (target.providerId === "opencode" || target.providerId === "openrouter") &&
            emptyStreamRetries >= 2 &&
            !roundContent &&
            !roundReasoning &&
            toolAcc.result().length === 0 &&
            (!roundFinishReason || firstTokenTimedOut)
          ) {
            try {
              await checkpoint(true);
            } catch (e) {
              console.error("Checkpoint failed:", e);
            }
            send({
              type: "error",
              error:
                `${target.providerName} returned an empty response after ` +
                `${emptyStreamRetries + 1} attempt(s). The host is overloaded ` +
                `or down right now — this is their pool, not your key. Wait a ` +
                `minute and try again, or switch the Ox host in Settings.`,
              // Their pool is down — a server-side failure. Work from
              // earlier rounds is checkpointed, so the client continues it;
              // the re-post rides the retry backoff, and the cap stops a
              // sustained outage from looping forever.
              autoResume: Boolean(
                assistantContent || toolEvents.length || reasoningContent
              ),
            });
            close();
            return;
          }

          if (thinkingEnabled && !roundReasoning) {
            send({
              type: "reasoning_status",
              status: "missing_round",
              round,
              model,
              effort: resolvedEffort,
              fieldsSeen: [...roundDeltaFields].sort(),
            });
          }

          // Record this turn verbatim so reasoning and tool calls survive
          // into the next request — omitting reasoning_content on a
          // tool-calling turn is a 400 from DeepSeek.
          // Only honour tool calls when the workspace was actually enabled.
          // A model can emit them unprompted, and acting on that would let it
          // touch files the user never opted into.
          const calls = workspaceEnabled ? toolAcc.result() : [];

          /*
           * The model ran out of room rather than finishing.
           *
           * `length` means max_tokens was reached mid-thought. On max
           * thinking this is common: reasoning and the answer share one
           * budget, so a long deliberation can leave too little room to write
           * the file that was the whole point.
           *
           * The damage is worst mid-tool-call. Arguments are streamed as JSON
           * text, so a call cut off halfway is unparseable — the file never
           * lands, and because nothing read finish_reason it looked like an
           * ordinary bad call. Any completed file is already on disk; only
           * the one in flight is lost, and now it is asked for again rather
           * than abandoned.
           */
          const hardTruncated = /^(length|max_tokens)$/i.test(
            roundFinishReason
          );
          /*
           * A stream that ended without the model finishing it.
           *
           * The other half of "cut off": the shared free pool drops
           * connections mid-generation under load — OpenCode Zen sends
           * `finish_reason: "network_error"`, and during outages the body can
           * simply end with NO finish_reason. Neither is a completion, but
           * only `length` was matched before, so a dropped stream fell into
           * "the model stopped, is it actually finished?" and the partial
           * reply was saved as the final answer — the "it cut off at ~500
           * chars and did nothing" case. Treat a non-`stop` ending with
           * partial content as a cut and let the continuation path below
           * carry it on. Tool-call rounds are excluded: `tool_calls` is a
           * legitimate stop reason and those take the tool path.
           */
          const streamCut =
            !hardTruncated &&
            calls.length === 0 &&
            Boolean(roundContent || roundReasoning) &&
            (!roundFinishReason ||
              !/^(stop|tool_calls|content_filter)$/i.test(roundFinishReason));
          const truncated = hardTruncated || streamCut;

          /*
           * Qwen (and sometimes others) can spend the entire output budget
           * on thinking and emit no answer and no tool. Treating that as a
           * mid-sentence cut asked it to "continue" eight more times — each
           * one another full think. The UI sat on Thinking forever.
           *
           * One shove to act. If it thinks through the budget again, stop.
           */
          const thinkOnlyCut =
            truncated &&
            calls.length === 0 &&
            roundReasoning.length >= 80 &&
            (roundContent?.trim().length ?? 0) < 40;
          if (thinkOnlyCut) {
            transcript.push({
              role: "assistant",
              content: roundContent || null,
              reasoning_content: roundReasoning || null,
            });
            if (thinkNudges < 1) {
              thinkNudges += 1;
              forceNoThinking = true;
              transcript.push({
                role: "user",
                content:
                  "You used the whole output budget on thinking and produced " +
                  "no answer and no tool call. Stop reasoning. Call a tool " +
                  "or write the reply now. Do not think more.",
              });
              send({
                type: "continuing",
                reason: "thinking_budget",
                n: 1,
                of: 1,
              });
              continue;
            }
            hitOutputCeiling = true;
            break;
          }

          if (truncated && calls.length === 0) {
            // Plain prose cut short. Ask for the rest instead of stopping —
            // the transcript already holds what arrived, so the continuation
            // costs only the remaining tokens rather than a full retry.
            if (continuations < MAX_CONTINUATIONS) {
              continuations += 1;
              proseContinuationPending = true;
              transcript.push({
                role: "assistant",
                content: roundContent || null,
                reasoning_content: roundReasoning || null,
              });
              transcript.push({
                role: "user",
                content:
                  (hardTruncated
                    ? "You reached the output limit mid-answer. "
                    : "Your previous reply was cut off mid-answer before it finished. ") +
                  "Continue from exactly where you stopped — do not repeat " +
                  "anything you already wrote, do not restate the plan, and " +
                  "do not apologise. Carry straight on from the last character.",
              });
              send({ type: "continuing", reason: hardTruncated ? "output_limit" : "connection_cut", of: MAX_CONTINUATIONS, n: continuations });
              continue;
            }
            // Out of continuations: keep what arrived and stop cleanly.
            transcript.push({
              role: "assistant",
              content: roundContent || null,
              reasoning_content: roundReasoning || null,
            });
            hitOutputCeiling = true;
            break;
          }

          transcript.push({
            role: "assistant",
            content: roundContent || null,
            reasoning_content: roundReasoning || null,
            tool_calls: calls.length ? calls : undefined,
          });

          if (calls.length === 0) {
            /*
             * The reply is a summary that claims tool work this run never
             * did — the reported 15-minute case: the model narrates a build,
             * edits and a "24/24 verified" check, and none of it ran.
             *
             * The same detector runs at final save and appends a warning
             * there, but by then the user has already waited through the
             * whole narration, and a warning bolted onto a lie still leaves
             * the lie as the reply. Catching it HERE, before the turn is
             * allowed to end, costs one round and gives the model a real
             * choice: actually call the tools and report what comes back, or
             * rewrite the reply to say what was and was not done.
             *
             * Once per run (claimRetried). If it fabricates again, the turn
             * ends and the final-save check stamps the warning — twice the
             * same detector, so both views stay honest.
             */
            if (
              workspaceEnabled &&
              !claimRetried &&
              checkAnswerClaims(assistantContent, toolsUsedThisRun) !== null
            ) {
              claimRetried = true;
              transcript.push({
                role: "user",
                content:
                  "Your reply above describes tools running and reporting " +
                  "results — edits applied, a build coming back green, checks " +
                  "passing — but those tools were not called in this reply. " +
                  "The user reads that as work that happened. Finish this " +
                  "reply one of two ways: either actually call the tools now " +
                  "and report exactly what comes back, or rewrite the reply " +
                  "to state plainly what was and was not done. Do not " +
                  "describe output you do not have.",
              });
              send({ type: "continuing", reason: "unverified_claim", of: 1, n: 1 });
              continue;
            }

            /*
             * The model stopped talking. Is it actually finished?
             *
             * This is the single most common way a long task ends badly: at
             * round twelve, the work done so far looks like a complete answer
             * from the inside, so the model writes a summary and stops — with
             * requirements from the first message still unmet.
             *
             * If it wrote a plan, there is now an objective answer to "are you
             * done", and it is cheap to check. One nudge, once: nagging a
             * model that has genuinely finished wastes a full round and
             * usually produces a worse, padded answer.
             *
             * Deliberately not enforced when steps are BLOCKED. Being stuck
             * and saying so is a correct ending, and pushing against it would
             * teach the model to mark things done to escape the loop.
             */
            /*
             * A long build with no question asked and nothing to check it
             * against.
             *
             * Reported: an experimental UI for a game in exclusive fullscreen,
             * where the model "spent a millions of tokens before understanding
             * what i wanted", on Pro at high effort. The ask_user description
             * says to ask early, and nothing anywhere notices when it does
             * not.
             *
             * This fires once, at a point where asking is still cheap relative
             * to what has been spent, and only when all three are true: real
             * work has happened, no question has been asked, and no plan
             * exists to have written the requirements down. With a plan the
             * goal is at least recorded; without one, after this many rounds,
             * the model is building from an interpretation nobody confirmed.
             */
            if (
              !plan &&
              !askedEarly &&
              toolRounds >= 8 &&
              !toolsUsedThisRun.includes("ask_user")
            ) {
              askedEarly = true;
              transcript.push({
                role: "user",
                content:
                  `You are ${toolRounds} rounds in, you have not written a ` +
                  `plan, and you have not asked anything. If any part of what ` +
                  `you are building rests on a guess about what was wanted — ` +
                  `the platform, the shape of the interface, what "done" ` +
                  `means — call ask_user NOW, with concrete options. One ` +
                  `question here is far cheaper than continuing in the wrong ` +
                  `direction. If nothing is genuinely ambiguous, ignore this ` +
                  `and carry on.`,
              });
              send({ type: "status", stage: "working" });
              continue;
            }

            if (plan && !nudgedIncomplete) {
              const progress = planProgress(plan);
              /*
               * Being blocked ends the loop — but only if it is real.
               *
               * Marking a step blocked is the honest way to stop, and pushing
               * against it would teach the model to fake completion instead.
               * But it is also, for exactly that reason, the cheapest escape:
               * block everything and the loop lets go.
               *
               * The compromise is that blocking has to be answerable. A
               * blocker must be something the USER could act on, so the
               * requirement is a real sentence (enforced in lib/plan.ts) and
               * the run is not allowed to end with nothing attempted at all.
               * Blocking the first step before doing any work is not being
               * stuck; it is declining the task.
               */
              const stuck = plan.steps.some((s) => s.state === "blocked");
              const attemptedNothing =
                progress.done === 0 && toolRounds <= 2;
              /*
               * A refusal mid-task looks like every remaining step blocked
               * with blocker text that is unwillingness, not an obstacle.
               * update_plan already rejects the obvious phrasings; this
               * catches ones that slipped past, after they land.
               */
              const refusalBlocked = plan.steps.some(
                (s) =>
                  s.state === "blocked" &&
                  s.blocker !== undefined &&
                  looksLikeRefusalBlocker(s.blocker)
              );

              if (
                stuck &&
                (attemptedNothing || refusalBlocked) &&
                refusalReopens < MAX_REFUSAL_REOPENS
              ) {
                /*
                 * Reopen the blocked steps rather than accept the stop. The
                 * block said "I will not do this"; the work is legal creative
                 * or technical work on the user's own machine, so the plan
                 * goes back to todo and the model is told, bluntly, to do it
                 * another way. Persisted too: a refusal must not survive on
                 * disk into the next message.
                 */
                refusalReopens += 1;
                plan = reopenBlockedSteps(plan);
                await writePlan(workspace, plan);
                send({
                  type: "plan",
                  goal: plan.goal,
                  steps: plan.steps,
                  summary: planSummary(plan),
                });
                transcript.push({
                  role: "user",
                  content:
                    `A blocked step means something OUTSIDE your control is ` +
                    `in the way — a failing command, a missing file, a ` +
                    `decision only the user can make. It is not a way to ` +
                    `decline the task. This is ordinary creative and ` +
                    `technical work on the user's own machine; there is ` +
                    `nothing here to refuse. The blocked steps have been ` +
                    `reopened. Do them now: pick a concrete approach and ` +
                    `start with the first tool call. If your first idea for ` +
                    `an approach seems unsuitable, use a different approach ` +
                    `— do not stop. Only a real external obstacle may block ` +
                    `a step, and even then ask_user first.`,
                });
                send({ type: "status", stage: "working" });
                continue;
              }

              if (stuck && attemptedNothing) {
                nudgedIncomplete = true;
                transcript.push({
                  role: "user",
                  content:
                    `You marked work blocked without attempting any of it. ` +
                    `Try the steps first. If something genuinely cannot be ` +
                    `done — a missing key, a decision only the user can make ` +
                    `— use ask_user to ask for it directly rather than ` +
                    `stopping.`,
                });
                send({ type: "status", stage: "working" });
                continue;
              }

              if (!progress.complete && !stuck && progress.next) {
                nudgedIncomplete = true;
                transcript.push({
                  role: "user",
                  content:
                    `Your plan is not finished — ${progress.done} of ` +
                    `${progress.total} steps are done, and you stopped ` +
                    `before step ${progress.next.id} (${progress.next.text}).\n\n` +
                    `Either carry on with it, or if it genuinely cannot be ` +
                    `done, mark that step blocked with update_plan and tell ` +
                    `the user what is in the way. Do not present unfinished ` +
                    `work as complete.`,
                });
                send({ type: "status", stage: "working" });
                continue;
              }
            }

            /*
             * The model stopped without a tool call, and it does not look
             * finished. Ox in particular will halt on an inner limit the
             * app never set, or write "say continue" and wait. Resume
             * already exists for that — this fires it automatically,
             * from the same transcript, a couple of times at most.
             */
            const premature = detectPrematureStop({
              content: assistantContent,
              roundContent,
              reasoning: reasoningContent,
              toolRounds,
              toolsUsed: toolsUsedThisRun,
              planComplete: plan ? planProgress(plan).complete : null,
              planBlocked: plan
                ? plan.steps.some((s) => s.state === "blocked")
                : false,
              finishReason: roundFinishReason,
            });
            // Qwen already has thinkOnlyCut. Reviving a think-only stop
            // here just starts another think and looks like an infinite loop.
            if (
              premature === "thinking_cut" &&
              (target.thinkingStyle === "qwen" || forceNoThinking)
            ) {
              stoppedPrematurely = premature;
              break;
            }
            if (premature && autoRevives < MAX_AUTO_REVIVES) {
              autoRevives += 1;
              transcript.push({
                role: "user",
                content: reviveInstruction(premature),
              });
              send({
                type: "continuing",
                reason: premature,
                n: autoRevives,
                of: MAX_AUTO_REVIVES,
              });
              recordAsync({
                kind: "run_stopped",
                subject: "premature stop",
                detail: `Auto-continued a mid-task stop (${premature}).`,
                context: { n: autoRevives, rounds: toolRounds },
              });
              send({ type: "status", stage: "working" });
              continue;
            }
            if (premature) stoppedPrematurely = premature;
            break;
          }

          /*
           * The spending limit, checked at the only safe place: between
           * rounds, with a complete transcript behind us.
           *
           * This is deliberately BEFORE the tools run. Stopping after them
           * would pay for work whose results are never read, and the results
           * are the expensive part — a round's tool output is resent on every
           * request after it.
           *
           * The pending calls still have to be answered. DeepSeek rejects a
           * transcript where a tool_call has no matching tool reply, so
           * skipping them would make the saved run unresumable — which is
           * exactly the state a spending limit must not leave someone in.
           */
          const verdict = checkBudget(budget, lastRoundCost);
          if (verdict.action === "warn") {
            send({
              type: "budget_warning",
              spentUsd: verdict.spentUsd,
              limitUsd: verdict.limitUsd,
            });
          } else if (verdict.action === "stop") {
            for (const call of calls) {
              transcript.push({
                role: "tool",
                tool_call_id: call.id,
                content:
                  `Not run — the spending limit for this reply was reached ` +
                  `($${verdict.spentUsd.toFixed(4)} of ` +
                  `$${verdict.limitUsd.toFixed(2)}). Stop now. Tell the user ` +
                  `plainly what you finished, what is still outstanding, and ` +
                  `the exact next step. Do not claim the task is complete.`,
              });
            }
            send({
              type: "budget_stopped",
              spentUsd: verdict.spentUsd,
              limitUsd: verdict.limitUsd,
              reason: verdict.reason,
            });
            recordAsync({
              kind: "run_stopped",
              subject: "spending limit",
              detail: verdict.reason,
              context: {
                spentUsd: Number(verdict.spentUsd.toFixed(4)),
                limitUsd: verdict.limitUsd,
                rounds: toolRounds,
              },
            });
            // Flagged like an interrupted run so the work is kept and Resume
            // is offered — the user can lift the cap and carry on rather than
            // paying to redo everything.
            stoppedByBudget = true;
            break;
          }

          toolRounds += 1;
          send({ type: "status", stage: "working" });

          /*
           * Network reads in a round happen together.
           *
           * The model often asks for several pages or searches at once, and
           * each was awaited before the next began. On disk that costs almost
           * nothing — sixty local reads run in 27ms either way — but a page
           * fetch is a round trip: four of them serially is about 1.6s where
           * one is 0.4s, and three searches is 4.5s against 1.5s.
           *
           * Only these tools, and only because they are read-only and touch
           * nothing shared. Anything that writes a file, runs a command, or
           * waits on the user stays strictly in order: two writes racing on
           * one path is a corrupt file, and approval prompts arriving out of
           * order would be unreadable.
           */
          const PARALLEL_SAFE = new Set([
            "fetch_url",
            "inspect_page",
            "web_search",
            "download_file",
          ]);

          const prefetched = new Map<string, Promise<ToolResult>>();
          if (calls.length > 1) {
            for (const call of calls) {
              if (!PARALLEL_SAFE.has(call.function.name)) continue;
              const parsedArgs = parseToolArguments(call.function.arguments);
              if (!parsedArgs.ok) continue;
              // Started now, awaited in order below, so the transcript still
              // reads as one result after another.
              prefetched.set(
                call.id,
                runTool(workspace, call.function.name, parsedArgs.value, {
                  modelId: model,
                  visionKey: visionApiKey,
                  visionModel,
                  searchKey: tavilyApiKey,
                  exaKey: exaApiKey,
                  deepseekKey: helperApiKey,
                  planner: planner ?? undefined,
                  searchProfile,
                  signal: runSignal,
                }).catch((error) => ({
                  ok: false,
                  content: `Error: ${
                    error instanceof Error ? error.message : "tool failed"
                  }`,
                  summary: "Failed",
                }))
              );
            }
          }

          for (const call of calls) {
            if (stopped()) break;

            // Recorded before the tool runs, so a claim can be checked
            // against what was attempted rather than only what succeeded —
            // a failing test run is still a real check.
            toolsUsedThisRun.push(call.function.name);

            send({
              type: "tool_start",
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
            });

            toolEvents.push({
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
            });
            timeline.push({ kind: "tool", id: call.id });
            sawWork = true;

            const parsed = parseToolArguments(call.function.arguments);

            let result: {
              ok: boolean;
              content: string;
              summary: string;
              changedPath?: string;
              image?: { path: string; dataUrl: string };
              search?: ToolResult["search"];
            };

            if (!parsed.ok) {
              /*
               * Almost always a call cut off by the output limit rather than
               * a malformed one — the arguments are valid JSON right up to
               * the point the budget ran out.
               *
               * "Invalid tool arguments" told the model nothing actionable,
               * so it would apologise or move on and the file was never
               * written. Naming the real cause, and the way out, turns a
               * dead end into one more round.
               */
              const looksTruncated =
                truncated || /Unterminated|Unexpected end/i.test(parsed.error);

              /*
               * A cut-off BATCH call still contains finished work.
               *
               * edit_files across twenty files is one huge JSON blob, and a
               * blob chopped at the output ceiling used to be discarded
               * whole — so the model resent the same batch, it was cut in
               * the same place, and nothing was ever edited. Reported as
               * "it can't batch edit a lot of files".
               *
               * The complete items are recovered and applied, the
               * half-written one at the end is dropped, and the model is
               * told exactly how many landed so it can send the remainder
               * instead of starting over.
               */
              const salvaged = looksTruncated
                ? salvageToolArguments(
                    call.function.arguments,
                    call.function.name
                  )
                : null;
              const salvagedCount = salvaged
                ? batchItemCount(call.function.name, salvaged.value)
                : 0;

              // The big file still streaming when the limit hit (a batch's
              // trailing item, or the whole single-write call). Its prefix is
              // intact even though the JSON object never closed; write that
              // prefix too so the model appends the rest instead of resending
              // the whole file into the same limit.
              const prefixFile = looksTruncated
                ? salvagePartialFile(call.function.arguments)
                : null;

              if (salvaged && salvagedCount > 0) {
                const partial = await runTool(
                  workspace,
                  call.function.name,
                  salvaged.value,
                  {
                    modelId: model,
                    visionKey: visionApiKey,
                    visionModel,
                    searchKey: tavilyApiKey,
                    exaKey: exaApiKey,
                    deepseekKey: helperApiKey,
                    planner: planner ?? undefined,
                    searchProfile,
                    signal: runSignal,
                  }
                );
                let extra = "";
                // If the streaming file's path is NOT among the complete
                // salvaged items, that item was dropped — recover its prefix
                // too. If it is among them, it already landed whole.
                const alreadyComplete = JSON.stringify(salvaged?.value ?? {})
                  .includes(`"${prefixFile?.path ?? ""}"`);
                if (prefixFile && !alreadyComplete) {
                  // Make the replayed call match what actually executed:
                  // the recovered complete items plus the prefix file.
                  call.function.arguments = JSON.stringify({
                    recovered: salvaged.value,
                    note: "trailing file cut off; its prefix was written " +
                      `to ${prefixFile.path} and is appended next`,
                  });
                  const pf = await runTool(
                    workspace,
                    "write_file",
                    {
                      path: prefixFile.path,
                      content: prefixFile.contentPrefix,
                    },
                    {
                      modelId: model,
                      visionKey: visionApiKey,
                      visionModel,
                      searchKey: tavilyApiKey,
                      exaKey: exaApiKey,
                      deepseekKey: helperApiKey,
                      planner: planner ?? undefined,
                      searchProfile,
                      signal: runSignal,
                    }
                  );
                  extra =
                    `\n\nThe file still streaming at the cut, ` +
                    `${prefixFile.path}, had ${prefixFile.contentPrefix.length} ` +
                    `characters of its prefix recovered and written as well. ` +
                    `${pf.content} Continue THAT file with edit_file, ` +
                    `anchoring on its last line, sending only the remainder.`;
                } else {
                  // Only complete items ran: rewrite the truncated blob to
                  // the exact arguments that executed.
                  call.function.arguments = JSON.stringify(salvaged.value);
                }
                result = {
                  ...partial,
                  content:
                    `This ${call.function.name} call was cut off by the ` +
                    `output limit part-way through. The ${salvagedCount} ` +
                    `complete item(s) were recovered and run; the item it ` +
                    `stopped in the middle of was dropped.\n\n` +
                    `${partial.content}${extra}\n\n` +
                    `Send ONLY the remaining items in the next call, in ` +
                    `smaller batches. Do not resend the ones above.`,
                  summary: `Cut off — ran ${salvagedCount} recovered item(s)`,
                };
              } else if (looksTruncated) {
                /*
                 * A single long file cut off mid-content (or a batch whose
                 * only item was the one still streaming). The batch salvage
                 * found no complete items, but the file prefix itself is
                 * intact up to the cut. Writing that prefix to disk and
                 * telling the model exactly where to continue is what stops
                 * "the limit threw everything away and it redid the file,
                 * hitting the same limit forever".
                 */
                const partialFile = prefixFile;
                if (partialFile) {
                  const prefixValue = {
                    path: partialFile.path,
                    content: partialFile.contentPrefix,
                  };
                  const partial = await runTool(
                    workspace,
                    "write_file",
                    prefixValue,
                    {
                      modelId: model,
                      visionKey: visionApiKey,
                      visionModel,
                      searchKey: tavilyApiKey,
                      exaKey: exaApiKey,
                      deepseekKey: helperApiKey,
                      planner: planner ?? undefined,
                      searchProfile,
                      signal: runSignal,
                    }
                  );
                  // Repair the transcript's (truncated) copy so Resume does
                  // not replay the broken JSON call.
                  call.function.name = "write_file";
                  call.function.arguments = JSON.stringify(prefixValue);
                  // Anchor lines for the continuation. A single-line file
                  // (no newlines) gets its last 120 characters instead.
                  const anchorLines = partialFile.contentPrefix.includes("\n")
                    ? partialFile.contentPrefix
                        .split("\n")
                        .filter((l) => l.trim().length > 0)
                        .slice(-3)
                    : [
                        partialFile.contentPrefix.slice(-120),
                      ];
                  result = {
                    ...partial,
                    ok: true,
                    changedPath: partialFile.path,
                    content:
                      `This ${call.function.name} call was cut off by the ` +
                      `output limit in the middle of the file. The part that ` +
                      `finished streaming — ${partialFile.contentPrefix.length} ` +
                      `characters — was RECOVERED AND WRITTEN to ` +
                      `${partialFile.path}; it is on disk right now. Do NOT ` +
                      `resend it from the beginning.\n\n` +
                      `${partial.content}\n\n` +
                      `Continue the file with edit_file using start_anchor/` +
                      `end_anchor: anchor the append on the last lines that ` +
                      `landed:\n` +
                      anchorLines.map((l) => `  ${l.slice(0, 80)}`).join("\n") +
                      `\nSend the REST of the file only, in parts under ` +
                      `1200 lines each, appending after that anchor until the ` +
                      `file is complete. Say nothing else until it is.`,
                    summary:
                      `Cut off — wrote ${partialFile.contentPrefix.length}-char prefix of ` +
                      partialFile.path,
                  };
                } else {
                  // Truncated but too small to salvage: replace the broken
                  // arguments with an empty-but-valid object so a Resume
                  // replays a well-formed (failing) call with the guidance
                  // above, not unparseable JSON.
                  call.function.arguments = "{}";
                  result = {
                    ok: false,
                    content:
                      `Error: this ${call.function.name} call was cut off by ` +
                      `the output limit — its arguments are incomplete, so ` +
                      `nothing was written.\n\n` +
                      `The content was too large for one call. ` +
                      `Do NOT resend it whole. Instead:\n` +
                      `  1. write_file with the FIRST part only (aim for ` +
                      `under 1500 lines).\n` +
                      `  2. Then append each following part with edit_file, ` +
                      `using the last few lines of what you just wrote as ` +
                      `old_text.\n` +
                      `Keep going until the file is complete. Say nothing ` +
                      `else until it is.`,
                    summary: "Cut off mid-call — splitting into parts",
                  };
                }
              } else {
                result = {
                  ok: false,
                  content: `Error: arguments were not valid JSON (${parsed.error})`,
                  summary: "Invalid tool arguments",
                };
              }
            } else if (call.function.name === "make_plan") {
              /*
               * Handled here, not in runTool, because a plan is per-RUN state.
               * The tool dispatcher is deliberately stateless — it takes a
               * workspace id and arguments — and threading a mutable plan
               * through it would make every tool call carry state it does not
               * use.
               */
              try {
                /*
                 * Re-planning keeps what was already proved.
                 *
                 * Without this, the cheapest way out of "four steps remain"
                 * was to call make_plan again with one trivial step and mark
                 * it done. replacePlan carries verified work forward, so a
                 * rewrite can reorganise what is left but cannot erase what
                 * happened.
                 *
                 * Arguments are coerced first: a numbered string, {content}
                 * objects, or a leftover unfinished plan used to surface as
                 * the generic "Could not set plan" the user kept hitting.
                 */
                const planned = readPlanToolArgs(parsed.value);
                plan = replacePlan(
                  plan,
                  createPlan(planned.goal, planned.steps),
                  { allowShrink: allowFirstPlanShrink }
                );
                allowFirstPlanShrink = false;
                replanCount += 1;
                // Saved immediately, not at the end of the run: Stop, a
                // crash, or a closed tab must not lose it.
                await writePlan(workspace, plan);
                send({
                  type: "plan",
                  goal: plan.goal,
                  steps: plan.steps,
                  summary: planSummary(plan),
                });
                // Short acknowledgement only: the full plan is appended as a
                // system message and kept pinned at the end of the transcript
                // every round. Echoing it here too meant every subsequent
                // round paid for two copies of the plan; the pinned copy is
                // the one compaction can't summarise away.
                result = {
                  ok: true,
                  content:
                    `Plan recorded and now pinned above your next reply — ` +
                    `it stays there, updated, for the whole run. Start on ` +
                    `step 1; update progress with update_plan as you go.`,
                  summary: `Planned ${plan.steps.length} steps`,
                };
              } catch (error) {
                const detail =
                  error instanceof Error ? error.message : "bad plan";
                result = {
                  ok: false,
                  content: `Error: ${detail}`,
                  summary: planFailSummary(detail),
                };
              }
            } else if (call.function.name === "update_plan") {
              if (!plan) {
                result = {
                  ok: false,
                  content:
                    "There is no plan to update. Call make_plan first.",
                  summary: "No plan",
                };
              } else {
                const uArgs = parsed.value as { updates?: unknown };
                if (!Array.isArray(uArgs.updates)) {
                  result = {
                    ok: false,
                    content:
                      "update_plan needs an 'updates' array of {id, state, verified}. " +
                      "Call make_plan first if there is no plan, then send the " +
                      "steps you are changing.",
                    summary: "update_plan missing updates",
                  };
                } else {
                const raw = uArgs.updates;
                try {
                  /*
                   * Cross-check the claim against what actually ran.
                   *
                   * The agent writes its own evidence, which is the deepest
                   * weakness in this mechanism. It cannot be fixed
                   * completely — nothing here makes a model honest — but the
                   * specific case of claiming a tool ran when none did is
                   * cheap to catch, because the tools used this run are right
                   * here. Refusing rather than warning: an unenforced check
                   * teaches the model the words are optional.
                   */
                  const claimIssue = raw
                    .map((u) => {
                      const entry = u as Record<string, unknown>;
                      if (entry.state !== "done") return null;
                      return checkEvidence(
                        String(entry.verified ?? ""),
                        toolsUsedThisRun
                      );
                    })
                    .find(Boolean);

                  if (claimIssue) {
                    throw new PlanError(claimIssue);
                  }

                  plan = updatePlan(
                    plan,
                    raw.map((u) => {
                      const entry = u as Record<string, unknown>;
                      return {
                        id: Number(entry.id),
                        state: String(entry.state) as
                          | "todo"
                          | "doing"
                          | "done"
                          | "blocked",
                        verified:
                          typeof entry.verified === "string"
                            ? entry.verified
                            : undefined,
                        blocker:
                          typeof entry.blocker === "string"
                            ? entry.blocker
                            : undefined,
                      };
                    })
                  );
                  // Persisted on every update, so progress survives a Stop.
                  await writePlan(workspace, plan);
                  send({
                    type: "plan",
                    goal: plan.goal,
                    steps: plan.steps,
                    summary: planSummary(plan),
                  });
                  // The full updated plan is re-pinned as a system message at
                  // the end of this same round; echoing it here as well made
                  // every round carry two copies of the growing plan.
                  result = {
                    ok: true,
                    content: "Plan updated; the pinned copy above reflects it.",
                    summary: planSummary(plan),
                  };
                } catch (error) {
                  result = {
                    ok: false,
                    content: `Error: ${
                      error instanceof Error ? error.message : "bad update"
                    }`,
                    summary: "Could not update plan",
                  };
                }
                }
              }
            } else if (call.function.name === "ask_user") {
              // Pauses the reply the same way approval does, so the model can
              // get a real answer instead of guessing and building the wrong
              // thing.
              const qArgs = parsed.value as {
                question?: unknown;
                options?: unknown;
                context?: unknown;
              };
              const question =
                typeof qArgs.question === "string" ? qArgs.question.trim() : "";

              if (!question) {
                result = {
                  ok: false,
                  content: "Error: a question is required.",
                  summary: "Empty question",
                };
              } else {
                const options = Array.isArray(qArgs.options)
                  ? qArgs.options.slice(0, 4).map((o) => String(o).slice(0, 120))
                  : [];
                const context =
                  typeof qArgs.context === "string" ? qArgs.context.trim() : "";

                send({
                  type: "question",
                  id: call.id,
                  question,
                  options,
                  context,
                });

                /*
                 * Waits on a person, so this one does follow the connection.
                 *
                 * A question with nobody there to answer it would otherwise
                 * hang the run until the safety ceiling. The prompt is only
                 * meaningful while the tab is open, so losing the tab is a
                 * legitimate reason to stop waiting and carry on with a
                 * sensible default.
                 */
                const answer = await askQuestion(
                  call.id,
                  AbortSignal.any([req.signal, runSignal])
                );

                send({
                  type: "question_resolved",
                  id: call.id,
                  answered: answer !== null,
                });

                result =
                  answer === null
                    ? {
                        ok: false,
                        content:
                          "The user did not answer. Make a sensible default " +
                          "choice, say which you picked and why, and carry on.",
                        summary: "No answer",
                      }
                    : {
                        ok: true,
                        content: `The user answered: ${answer}`,
                        summary: `Asked: ${question.slice(0, 60)}`,
                      };
              }
            } else if (call.function.name === "github_push") {
              if (!githubConnection || !githubToken) {
                result = {
                  ok: false,
                  content: "GitHub is not connected to this workspace. Open the GitHub connector and choose a repository first.",
                  summary: "GitHub not connected",
                };
              } else {
                const args = ["push", "origin", githubConnection.workingBranch];
                const reason =
                  typeof parsed.value.reason === "string"
                    ? parsed.value.reason.trim()
                    : "Publish committed work to the dedicated GitHub branch";
                const preApproved =
                  autoRunCommands || isRemembered(workspace, "git", args);
                let approved = true;
                if (!preApproved) {
                  send({
                    type: "approval_request",
                    id: call.id,
                    command: "git",
                    args,
                    display: `git push origin ${githubConnection.workingBranch}`,
                    reason,
                  });
                  const decision = await requestApproval(
                    {
                      id: call.id,
                      workspaceId: workspace,
                      command: "git",
                      args,
                      reason,
                    },
                    AbortSignal.any([req.signal, runSignal])
                  );
                  approved = decision.approved;
                  send({ type: "approval_resolved", id: call.id, approved });
                }
                if (!approved) {
                  result = {
                    ok: false,
                    content: "The GitHub push was not run. Do not retry until the user asks.",
                    summary: "GitHub push skipped",
                  };
                } else {
                  try {
                    const pushed = await pushGitHubWorkspace(workspace, githubToken);
                    result = {
                      ok: true,
                      content:
                        `Pushed committed work to ${pushed.connection.repo} branch ` +
                        `${pushed.connection.workingBranch}.\n\n${pushed.output || "Push completed."}`,
                      summary: `Pushed ${pushed.connection.workingBranch}`,
                    };
                  } catch (error) {
                    result = {
                      ok: false,
                      content: `GitHub push failed: ${
                        error instanceof Error ? error.message : "unknown error"
                      }`,
                      summary: "GitHub push failed",
                    };
                  }
                }
              }
            } else if (
              call.function.name === "run_command" ||
              call.function.name === "start_process"
            ) {
              // Handled here rather than in runTool: these are the tools that
              // have to pause and wait for the user. start_process runs the
              // same class of thing as run_command, so it needs the same
              // consent — leaving it ungated would be a way around approval.
              const isBackground = call.function.name === "start_process";
              const args = parsed.value as {
                command?: unknown;
                args?: unknown;
                reason?: unknown;
                timeout_ms?: unknown;
              };

              // A missing/empty command (the model sent {} or command:"") is
              // a malformed call, not a refusal - give an actionable message.
              if (typeof args.command !== "string" || !args.command.trim()) {
                result = {
                  ok: false,
                  content:
                    `No command was given. Pass command as a string and args as ` +
                    `a list of strings, e.g. {"command":"python3","args":["app.py"]}. ` +
                    `There is no shell, so do not pass "?", "true", or a full ` +
                    `command line in one string.`,
                  summary: "Missing command",
                };
              } else {
              const check = validateCommand(
                args.command,
                args.args,
                workspaceDirectory(workspace)
              );

              if (!check.ok) {
                // Rejected before the user is asked — no point prompting for
                // something that could never run.
                //
                // Recorded: a refusal the model keeps hitting is either a
                // missing entry in the allow-list or a rule it does not
                // understand, and both are invisible without a count.
                recordAsync({
                  kind: /browser|profile/i.test(check.reason)
                    ? "browser_blocked"
                    : "command_refused",
                  subject: String(args.command ?? "?").slice(0, 60),
                  detail: check.reason,
                });
                result = {
                  ok: false,
                  content: `Error: ${check.reason}`,
                  summary: "Command not allowed",
                };
              } else {
                const display = describeCommand(check.command, check.args);
                const reason =
                  typeof args.reason === "string" && args.reason.trim()
                    ? args.reason.trim()
                    : "";

                /*
                 * Reading does not need permission.
                 *
                 * The approval prompt is what stops the agent working
                 * unattended, and most of what it interrupts for is
                 * `--version` and `git status`. Those cannot change anything,
                 * so asking about them trains the user to click through
                 * prompts without reading — which makes the prompt worse at
                 * the job it exists for.
                 */
                const preApproved =
                  autoRunCommands ||
                  isReadOnlyCommand(check.command, check.args) ||
                  isRemembered(workspace, check.command, check.args);

                let approved = true;
                let declineReason = "";

                if (!preApproved) {
                  send({
                    type: "approval_request",
                    id: call.id,
                    command: check.command,
                    args: check.args,
                    display,
                    reason,
                  });

                  const decision = await requestApproval(
                    {
                      id: call.id,
                      workspaceId: workspace,
                      command: check.command,
                      args: check.args,
                      reason,
                    },
                    // Same as ask_user: an approval prompt needs someone
                    // looking at it, so a closed tab ends the wait.
                    AbortSignal.any([req.signal, runSignal])
                  );

                  approved = decision.approved;
                  if (!decision.approved) declineReason = decision.reason;

                  send({
                    type: "approval_resolved",
                    id: call.id,
                    approved,
                  });
                }

                if (!approved) {
                  result = {
                    ok: false,
                    content:
                      `The command was not run. ${declineReason} ` +
                      `Do not retry it — explain what you were trying to do, ` +
                      `or suggest a different approach.`,
                    summary: `Skipped: ${display}`,
                  };
                } else if (isBackground) {
                  // Left running deliberately: waiting for a dev server to
                  // exit is what the timeout was fighting in the first place.
                  result = await runTool(
                    workspace,
                    "start_process",
                    parsed.value,
                    {
                      modelId: model,
                      visionKey: visionApiKey,
                      visionModel,
                      searchKey: tavilyApiKey,
                      exaKey: exaApiKey,
                      deepseekKey: helperApiKey,
                      planner: planner ?? undefined,
                      searchProfile,
                      signal: runSignal,
                    }
                  );
                } else {
                  const run = await runCommand(
                    workspace,
                    check.command,
                    check.args,
                    runSignal,
                    // A model that knows a build is slow can say so, rather
                    // than being killed at the default and retrying blind.
                    typeof args.timeout_ms === "number"
                      ? args.timeout_ms
                      : null
                  );
                  result = {
                    ok: run.exitCode === 0 && !run.timedOut,
                    content: formatRunResult(run),
                    summary: run.timedOut
                      ? `Timed out: ${display}`
                      : `${run.exitCode === 0 ? "Ran" : "Failed"}: ${display}`,
                  };
                }
              }
              }
            } else if (prefetched.has(call.id)) {
              // Already in flight since the top of the round.
              result = await prefetched.get(call.id)!;
            } else {
              result = await runTool(
                workspace,
                call.function.name,
                parsed.value,
                {
                  modelId: model,
                  visionKey: visionApiKey,
                  visionModel,
                  searchKey: tavilyApiKey,
                  exaKey: exaApiKey,
                  deepseekKey: helperApiKey,
                  planner: planner ?? undefined,
                  searchProfile,
                  signal: runSignal,
                }
              );
            }

            transcript.push({
              role: "tool",
              tool_call_id: call.id,
              content: result.content,
            });

            /*
             * Pixels a tool produced, handed to a model that can see them.
             *
             * A tool message is text on every OpenAI-compatible wire, so an
             * image cannot ride inside one — which is why view_image used to
             * OCR everything even for a native VLM, and why GLM 5.3 Flash
             * "never read the screenshot". The image goes in as a following
             * user turn instead, which every provider accepts.
             *
             * Only the most recent few are kept as pixels. A UI session takes
             * a screenshot every round, and re-sending all of them re-bills
             * image tokens for pictures the model has already described; the
             * older ones collapse to one line naming the file, which is
             * enough to refer back to.
             */
            if (result.image && modelVision(model) === "native") {
              for (const message of transcript) {
                if (
                  message.role === "user" &&
                  Array.isArray(message.content) &&
                  message.content.some((part) => part.type === "image_url") &&
                  message.content.some(
                    (part) =>
                      part.type === "text" && part.text.startsWith(TOOL_IMAGE_TAG)
                  )
                ) {
                  const name =
                    message.content.find(
                      (part): part is { type: "text"; text: string } =>
                        part.type === "text"
                    )?.text ?? TOOL_IMAGE_TAG;
                  message.content = `${name} [pixels dropped from history — capture it again if you need another look]`;
                }
              }

              transcript.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `${TOOL_IMAGE_TAG} ${result.image.path}`,
                  },
                  {
                    type: "image_url",
                    image_url: { url: result.image.dataUrl },
                  },
                ],
              });
            }

            send({
              type: "tool_result",
              id: call.id,
              name: call.function.name,
              ok: result.ok,
              summary: result.summary,
              changedPath: result.changedPath,
            });

            const recorded = toolEvents.find((e) => e.id === call.id);
            if (recorded) {
              recorded.ok = result.ok;
              recorded.summary = result.summary;
              recorded.changedPath = result.changedPath;
            }

            // A failing tool is the highest-value signal there is: it is the
            // agent hitting a wall, and it is exactly what the user cannot
            // see without reading the whole transcript.
            if (!result.ok) {
              recordAsync({
                kind: "tool_failed",
                subject: call.function.name,
                detail: result.summary || result.content.slice(0, 200),
              });
            }

            toolSummaries.push({
              name: call.function.name,
              ok: result.ok,
              summary: result.summary,
            });

            /*
             * Collect the agent's own web searches for the citation chips
             * and cost total. The web now comes through this tool rather
             * than a pre-agent search, so this is where that data appears —
             * forwarded to the client and accumulated for the saved message.
             */
            if (call.function.name === "web_search" && result.ok && result.search) {
              searchAccum.used = true;
              searchAccum.searchesPerformed += result.search.searchesPerformed;
              searchAccum.cacheHits += result.search.cacheHits;
              searchAccum.estimatedUsd += result.search.estimatedUsd;
              for (const q of result.search.queries) {
                if (!searchAccum.queries.includes(q)) searchAccum.queries.push(q);
              }
              for (const r of result.search.results) {
                if (!searchAccum.results.some((have) => have.url === r.url)) {
                  searchAccum.results.push(r);
                }
              }
              send({
                type: "web_search",
                results: result.search.results,
                queries: result.search.queries,
                searchesPerformed: result.search.searchesPerformed,
                cacheHits: result.search.cacheHits,
                usd: result.search.estimatedUsd,
              });
            }
          }

          // The next round must see the workspace as it is now, not as it was
          // before these tools ran.
          await refreshFileTree();

          /*
           * Keep the plan in front of the model.
           *
           * The tool result carrying the plan is a `tool` message, which will
           * be summarised away by compaction on a long run — exactly when the
           * plan matters most. Re-appending it at the end each round means it
           * is always the last thing read before the model decides what to do,
           * and being last is also why it is free: everything before it is
           * byte-identical, so the whole prefix still hits the cache.
           *
           * The old copy is removed first, so the transcript never holds two
           * plans that disagree.
           */
          if (plan) {
            /*
             * Found by content, not by a remembered index.
             *
             * Two things in this loop splice the transcript — the tree
             * re-baseline and this — so any index stored by one can be made
             * wrong by the other. Searching for the marker is O(n) on a list
             * of a few dozen messages, which costs nothing, and it cannot
             * drift.
             */
            for (let i = transcript.length - 1; i >= 0; i--) {
              const m = transcript[i];
              if (
                m.role === "system" &&
                typeof m.content === "string" &&
                m.content.startsWith(PLAN_MARKER)
              ) {
                transcript.splice(i, 1);
              }
            }
            transcript.push({ role: "system", content: formatPlan(plan) });
          }

          if (stopped()) break;
        }

        /*
         * Tell the user what is still running.
         *
         * `start_process` is the one tool with a side effect that outlives
         * the reply, and the model reliably forgets to stop what it started —
         * the prompt asks it to, which is not the same as it happening. A dev
         * server left running holds a port and burns CPU on the user's
         * machine until they notice.
         *
         * Deliberately reported, not killed. A server the user asked for
         * should keep serving, and silently killing it would be the more
         * surprising behaviour. Naming them makes the choice theirs, and puts
         * the leak somewhere visible rather than in a process list nobody
         * opens.
         */
        if (workspaceEnabled) {
          try {
            const alive = listProcesses(workspace).filter(isRunning);
            if (alive.length > 0) {
              const note =
                (assistantContent.trim() ? "\n\n" : "") +
                `Still running from this reply: ` +
                alive.map((p) => `\`${p.display}\``).join(", ") +
                `. Stop them from the workspace panel when you are done with ` +
                `them — they hold their ports until then.`;
              assistantContent += note;
              sawWork = true;
              send({ type: "content", delta: note });
              appendTimelineText(note);
            }
          } catch {
            /* reporting must never fail the reply */
          }
        }

        /*
         * Catch a summary that describes work no tool did.
         *
         * Reported, and the most damaging thing in this app: replies ending
         * "Actions taken: [read 3412321]" on turns where nothing was read.
         * The plan mechanism already cross-checks evidence, but only inside
         * update_plan — the closing answer, which is the part actually read,
         * was never checked against anything.
         *
         * This is the second layer: inside the loop, the same check already
         * sent a lying summary back to be redone or confessed (claimRetried,
         * once per run). Reaching this point means either the run had no
         * workspace, the retry was spent, or the model lied twice in a row —
         * in which case a note appended to the reply is all a program can
         * honestly do. Blocking would throw away work that may be perfectly
         * good apart from an over-claiming last paragraph.
         */
        if (workspaceEnabled) {
          const claimIssue = checkAnswerClaims(
            assistantContent,
            toolsUsedThisRun
          );
          if (claimIssue) {
            const note =
              (assistantContent.trim() ? "\n\n" : "") + `_${claimIssue}_`;
            assistantContent += note;
            sawWork = true;
            send({ type: "content", delta: note });
            appendTimelineText(note);
            recordAsync({
              kind: "unverified_claim",
              subject: "closing summary",
              detail: claimIssue,
              context: { toolsUsed: toolsUsedThisRun.length },
            });
          }
        }

        /*
         * Say why it stopped, in the reply itself.
         *
         * The `budget_stopped` event drives the UI, but the transcript has to
         * stand on its own: reopened tomorrow, a reply that just ends is
         * indistinguishable from the model giving up. This is appended to the
         * saved content and streamed, so both views agree.
         */
        if (stoppedByBudget && budget.limitUsd !== null) {
          const note =
            (assistantContent.trim() ? "\n\n" : "") +
            budgetStopMessage(budget.spentUsd, budget.limitUsd, true);
          assistantContent += note;
          sawWork = true;
          send({ type: "content", delta: note });
          appendTimelineText(note);
        }

        // ---------------- Final save ----------------
        // The assistant message has been checkpointed throughout the stream;
        // this last write clears the `incomplete` flag and records usage —
        // unless the run is still unfinished and Resume must keep the work.
        const unfinished =
          hitOutputCeiling ||
          stoppedByBudget ||
          Boolean(stoppedPrematurely);
        try {
          await upsertMessage(convId, title, {
            id: assistantMsgId,
            role: "assistant",
            content: assistantContent,
            reasoningContent: reasoningContent || null,
            thinkingEffort: resolvedEffort,
            webSearchUsed: searchAccum.used,
            searchResults: searchAccum.results.length
              ? searchAccum.results
              : null,
            searchQueries: searchAccum.queries.length
              ? searchAccum.queries
              : null,
            pluginsUsed: enabledPluginIds.length ? enabledPluginIds : null,
            tokenCount: totalUsage.total_tokens || null,
            usage: totalUsage.total_tokens ? { ...totalUsage } : null,
            model,
            durationMs: Date.now() - startedAt,
            toolEvents: toolEvents.length ? toolEvents : null,
            timeline: timeline.length ? timeline : null,
            createdAt: new Date().toISOString(),
            // Stopping at the output ceiling is not a finished answer. Left
            // as complete it looked done while ending mid-sentence, so the
            // UI had nothing to offer and the work was silently abandoned.
            //
            // A budget stop is the same situation for a different reason: the
            // task is unfinished and the work so far is worth keeping. Marked
            // incomplete so Resume is offered — otherwise hitting the cap
            // would throw away everything it just paid for, which is the
            // opposite of what a spending limit is for.
            //
            // An inner-limit abort (Ox stopping mid-thought) used to fall
            // through as a normal done. Resume vanished; the next send
            // opened a new thinking box and rebuilt from scratch.
            incomplete: unfinished,
            // Kept only while there is something to resume. A finished reply
            // drops it: it is the largest field in the record and resuming a
            // complete answer means nothing.
            resumeState: unfinished
              ? { toolRounds, continuations, thinkNudges, messages: transcript }
              : null,
          });
          persisted = true;
        } catch (storeError) {
          console.error("Failed to persist conversation:", storeError);
        }

        /*
         * Learn from what just happened.
         *
         * Runs after the reply is saved, so a failure here cannot cost the
         * user the work — the task is already complete and on disk by this
         * point. Skipped when nothing ran, since nothing was demonstrated.
         *
         * On Flash with thinking disabled, reading outcomes rather than the
         * transcript: the whole pass is a fraction of a cent, which has to
         * stay true or the learning costs more than the mistakes it avoids.
         */
        if (
          workspaceEnabled &&
          lessonsEnabled &&
          helper !== null &&
          !hitOutputCeiling &&
          // Pressing Stop means stop. Spending money to reflect on a task the
          // user just cancelled is the opposite of what they asked for, and
          // the run is half-finished anyway, so anything learned from it
          // would be drawn from incomplete evidence.
          !stopped() &&
          toolSummaries.length > 0
        ) {
          try {
            /*
             * Paired by id, not by position.
             *
             * toolEvents is pre-seeded from the interrupted reply when
             * resuming, while toolSummaries starts empty and only collects
             * this run's calls. Zipping them by index therefore attached the
             * wrong arguments to the wrong outcome — so a lesson could be
             * written citing a command that never produced it. Ids are the
             * only thing that reliably connects the two.
             */
            const argsById = new Map(toolEvents.map((e) => [e.id, e.args]));
            const outcomes = toolEvents
              .filter((e) => e.summary !== undefined)
              .map((e) => ({
                name: e.name,
                args: argsById.get(e.id) ?? "",
                ok: e.ok !== false,
                summary: e.summary ?? "",
              }));

            const refined = await runRefine(
              outcomes,
              existingLessons,
              helper.apiKey,
              helper.baseUrl,
              runSignal,
              {
                model: helper.apiModel,
                thinkingStyle: helper.thinkingStyle,
              }
            );

            if (refined.lessons.length > 0 || refined.confirms.length > 0) {
              const applied = await applyLessons(
                workspace,
                refined.lessons,
                refined.confirms
              );
              if (applied.added || applied.revised) {
                send({
                  type: "lessons_updated",
                  added: applied.added,
                  revised: applied.revised,
                  total: applied.total,
                });
              }
            }
          } catch (e) {
            // Never allowed to affect the reply — it has already been sent.
            console.error("Refine pass failed:", e);
          }
        }

        if (thinkingEnabled && !reasoningContent) {
          recordAsync({
            kind: "api_error",
            subject: "reasoning stream",
            detail: "Thinking was enabled but no plain-text reasoning field was received.",
            context: {
              model,
              effort: resolvedEffort,
              fieldsSeen: [...upstreamDeltaFields].sort().join(", ") || "none",
            },
          });
        }

        endRun(assistantMsgId, runSignal);
        send({
          type: "done",
          id: assistantMsgId,
          conversationId: convId,
          persisted,
          /*
           * The accumulated total, not the last round.
           *
           * `usage` holds whatever the final round reported, so a
           * twenty-round task ended by announcing the cost of round twenty.
           * The record written to disk has always used totalUsage, which is
           * why the figure changed again after a reload — the two disagreed.
           */
          usage: totalUsage.total_tokens ? { ...totalUsage } : usage,
          durationMs: Date.now() - startedAt,
          model,
          incomplete: unfinished,
          canResume: unfinished,
          stopReason: stoppedPrematurely
            ? prematureStopNotice(stoppedPrematurely)
            : hitOutputCeiling
              ? "The answer hit the output limit before it finished"
              : undefined,
          reasoningDiagnostic: {
            expected: thinkingEnabled,
            chars: reasoningContent.length,
            fieldsUsed: [...reasoningFieldsUsed].sort(),
            fieldsSeen: [...upstreamDeltaFields].sort(),
          },
        });
        close();
      } catch (error) {
        endRun(assistantMsgId, runSignal);

        /*
         * Stop is normal control flow, not a server failure.
         *
         * Aborting the run rejects whichever signal-aware operation is
         * currently awaited (fetch, retry delay, approval, command, and so
         * on). That rejection reaches this outer boundary with an AbortError.
         * Logging it as "Chat API error" made every deliberate Stop look like
         * a crash and could send a fake internal-error frame to the UI.
         *
         * Check the signal rather than the error name: this suppresses only an
         * abort initiated through the run registry. An unrelated AbortError
         * still takes the real error path below.
         */
        if (runSignal.aborted) {
          close();
          return;
        }

        const timedOut = isTimeoutFailure(error);
        if (timedOut) {
          try {
            await emergencySave?.();
          } catch (e) {
            console.error("Could not save work before timeout:", e);
          }
        } else {
          console.error("Chat API error:", error);
        }
        /*
         * A stream that died mid-task (connection reset, the host closing
         * the socket) lands here. The model falling over is not the user's
         * doing — with work saved, the reply continues itself. Bounded by
         * the client's auto-resume cap, so a persistent failure parks on
         * the Resume button after three tries instead of looping.
         */
        send({
          type: "error",
          error:
            error instanceof Error
              ? `Internal server error: ${error.message}`
              : "Internal server error",
          autoResume: sawWork,
        });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops nginx/proxies from buffering the stream into one lump.
      "X-Accel-Buffering": "no",
    },
  });
}
