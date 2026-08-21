import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  appendMessages,
  truncateFrom,
  upsertMessage,
  availableTitle,
  getConversation,
} from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import {
  smartSearch,
  autoThinkingEffort,
  decideSearch,
  SearchProviderError,
} from "@/lib/smart-search";
import type { SmartSearchContext } from "@/lib/smart-search";
import {
  ALL_PLUGINS,
  BASE_PROMPT,
  buildLegacyPrompt,
  buildPluginDirectives,
  PLUGIN_DIRECTIVES_MARKER,
} from "@/lib/plugins";
import { WORKSPACE_TOOLS, runTool } from "@/lib/tools";
import type { ToolResult } from "@/lib/tools";
import { buildWorkspaceContext } from "@/lib/workspace-context";
import { TreeTracker } from "@/lib/tree-delta";
import {
  createPlan,
  replacePlan,
  updatePlan,
  formatPlan,
  planSummary,
  planProgress,
  checkEvidence,
  PlanError,
  PLAN_MARKER,
  readPlan,
  writePlan,
  planIsComplete,
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
  parseToolArguments,
  serializeForApi,
} from "@/lib/transcript";
import type { TranscriptMessage } from "@/lib/transcript";
import { pruneTranscript } from "@/lib/prune";
import { compactTranscript, compactForResume } from "@/lib/compact";
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
import { fetchWithRetry } from "@/lib/retry";
import { extractReasoningDelta } from "@/lib/reasoning-stream";
import { loadScopedConversationHistory } from "@/lib/chat-history";
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
import { estimateCost, getDeepSeekPeriod } from "@/lib/pricing";
import { listCustomPlugins } from "@/lib/plugin-store";

export const maxDuration = 300;

/**
 * Overridable for local testing / proxies. Defaults to DeepSeek directly.
 */
const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

/**
 * Ceiling on generated tokens. The model supports up to 384K; 8192 was far too
 * low and silently truncated long answers (a full HTML game hits it mid-line).
 * This is only a cap — it costs nothing when responses are short.
 */
const MAX_OUTPUT_TOKENS = 65536;

/** Effort levels the API accepts once thinking is enabled. */
const VALID_EFFORTS = new Set(["low", "high", "max"]);

/**
 * Derive a readable conversation title from the first user message.
 * Strips markdown noise, collapses whitespace and cuts on a word boundary so
 * the sidebar shows "Make an html game" rather than a truncated blob.
 */
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
  attachments?: {
    name: string;
    kind: "text" | "image";
    dataUrl?: string;
  }[];
  conversationId?: string | null;
  deepseekApiKey?: string;
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
      attempt: number;
      attempts: number;
      delayMs: number;
      reason: string;
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
      reasoningDiagnostic: {
        expected: boolean;
        chars: number;
        fieldsUsed: string[];
        fieldsSeen: string[];
      };
    }
  | { type: "error"; error: string };

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

  if (!message || !deepseekApiKey) {
    return NextResponse.json(
      { error: "Message and DeepSeek API key are required" },
      { status: 400 }
    );
  }

  // Resolve "auto" to a concrete level based on the message.
  const resolvedEffort =
    thinkingEffort === "auto" ? autoThinkingEffort(message) : thinkingEffort;

  // "none" is our UI concept for "don't reason at all".
  const thinkingEnabled = resolvedEffort !== "none";

  // Searching is only possible with a Tavily key. Whether one actually happens
  // is decided inside the stream: "always" every turn, "auto" asks the model,
  // "off" never.
  const canSearch = Boolean(
    (tavilyApiKey || exaApiKey) && webSearchMode !== "off"
  );

  const derivedTitle = deriveTitle(displayContent?.trim() || message);

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
        } catch {
          // The consumer went away between our check and this enqueue, so the
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
       * Refuse a disagreement instead of letting Chat B point at Chat A's
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
        let scopedHistory: ChatMessage[] = [];
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
         * otherwise a reply that stopped at the round limit would resume with
         * a fresh budget and could loop indefinitely.
         */
        let resumed: {
          toolRounds: number;
          continuations: number;
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
                  // were made, so the round budget is not silently reset.
                  toolRounds: (prior.toolEvents ?? []).length,
                  continuations: 0,
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
              content: (displayContent ?? message).trim(),
              attachments: attachments?.length ? attachments : null,
              thinkingEffort: resolvedEffort,
              createdAt: new Date().toISOString(),
            },
          ]);
        } catch (e) {
          console.error("Failed to persist user message:", e);
        }

        // ---------------- Web search ----------------
        let searchContext: SmartSearchContext | null = null;
        let searchSummary = "";

        const recentContext = scopedHistory
          .slice(-4)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n");

        // Decide whether this turn needs the web. In "auto" the model itself
        // judges (one cheap Flash call, thinking off) instead of a keyword
        // guess, so ordinary coding questions skip the search entirely.
        let doSearch = false;
        let searchReason = "";
        let clarifyHint = "";
        if (canSearch) {
          if (webSearchMode === "always") {
            doSearch = true;
          } else {
            send({ type: "status", stage: "deciding" });
            const decision = await decideSearch(
              message,
              recentContext,
              deepseekApiKey,
              runSignal,
              // The plugin block governs this call too. Without it a plugin
              // that says "always look it up" or "never ask me questions"
              // had no effect on the one decision it most clearly applies to.
              pluginDirectives
            );
            doSearch = decision.needed;
            searchReason = decision.reason;
            // Underspecified questions get a clarifying question instead of a
            // search that would only return generic articles.
            if (decision.clarify) clarifyHint = decision.clarify;
          }
        }

        if (doSearch) {
          send({ type: "status", stage: "searching" });

          try {
            searchContext = await smartSearch(
              message,
              recentContext,
              deepseekApiKey,
              tavilyApiKey as string,
              runSignal,
              searchProfile,
              exaApiKey
            );
          } catch (searchError) {
            /*
             * Carry on, but SAY so.
             *
             * A failed search should not kill the answer — that part was
             * right. But it was logged to the server console and nowhere
             * else, so the model answered from memory believing it had
             * simply found nothing, and the user saw a confident answer with
             * no hint the web was never consulted.
             *
             * The note goes into the prompt, so the reply can be honest
             * about what it is based on.
             */
            console.error("Search failed:", searchError);
            const status =
              searchError instanceof SearchProviderError ? searchError.status : 0;
            const why =
              status === 401 || status === 403
                ? "the Tavily key was rejected"
                : status === 429 || status === 432
                  ? "the Tavily quota is spent"
                  : status
                    ? `the search service returned HTTP ${status}`
                    : "the search service could not be reached";
            searchSummary =
              `\n\n<web_search_failed>\nA web search was attempted and FAILED: ` +
              `${why}. No results were retrieved — this is not the same as ` +
              `finding nothing. Answer from your own knowledge, and tell the ` +
              `user plainly that you could not look it up.\n` +
              `</web_search_failed>`;
            recordAsync({
              kind: "api_error",
              subject: "web_search",
              detail: why,
              context: { status },
            });
          }

          if (searchContext && searchContext.results.length > 0) {
            searchSummary = `\n\n<web_search_results>\nI performed ${searchContext.searchesPerformed} targeted search(es) using queries: ${searchContext.queries
              .map((q) => `"${q}"`)
              .join(", ")}\n\nFound ${searchContext.sourcesUsed} relevant sources:\n\n${searchContext.summary}\n</web_search_results>\n\nIMPORTANT: Use the search results above to provide accurate, up-to-date information. Cite sources with their URLs. If the search results contain links to GitHub repos, documentation, or solutions, include those EXACT URLs. Never make up URLs.`;
          }
        }

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
          webSearchUsed: doSearch,
          searchReason,
          searchRounds: searchContext?.rounds ?? 0,
          searchStopReason: searchContext?.stopReason ?? "",
          searchResults:
            searchContext?.results.map((r) => ({
              title: r.title,
              url: r.url,
              domain: r.domain,
            })) ?? null,
          searchQueries: searchContext?.queries ?? null,
          searchesPerformed: searchContext?.searchesPerformed ?? 0,
          searchCacheHits: searchContext?.cacheHits ?? 0,
          searchUsd: searchContext?.estimatedUsd ?? 0,
        });

        // ---------------- Build the request ----------------
        const clarifyInstruction = clarifyHint
          ? `\n\nThis question depends on details only the user has. Before giving a general answer, ask them: "${clarifyHint}" Keep it to one short question, explain in a sentence why it changes the answer, and offer what general guidance you can meanwhile.`
          : "";

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
              (displayContent?.trim() || message).slice(0, 80)
            );
          } catch (e) {
            console.error("Snapshot failed:", e);
          }
        }

        // Checked once per reply, not per round: it is a module resolution
        // and the answer cannot change mid-conversation.
        const hasBrowser = workspaceEnabled ? await browserAvailable() : false;

        const workspaceInstruction = workspaceEnabled
          ? `\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.\n\nYou can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Each command needs the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell. run_command waits for the program to finish, so use it only for things that exit — scripts, tests, installs. You can install packages: pip install and npm install both work and go into this workspace, not the user's system, so install what you need rather than rewriting code to avoid a dependency. For anything that keeps running, such as a dev server or a watcher, use start_process instead: it returns straight away, and you can read its output with read_process and stop it with stop_process. Always stop what you started once you are done with it. Before anything that takes more than two or three actions, call make_plan: write down what finished looks like and the steps to get there, including how you will CHECK each one. On a long task your own reasoning from twenty rounds ago is gone, so without a written plan you will forget requirements from the first message and stop early because the work so far looks finished. When you work something out that a later turn would need - why an approach is dead, what a function actually does, which build or file is correct and why, an offset or value you verified, a command's exact error and what fixed it - call note_finding IMMEDIATELY, before continuing. Those findings are listed to you every turn and survive compaction, so you never have to re-read a file or re-run a command to remember it. Treat the findings list as your working memory: at the START of every turn, before doing anything, read the active findings and use them. When you find a finding is wrong or superseded, call note_finding with status='disproved' and the corrected claim so the list stays accurate and does not fill with stale notes. Do not record trivialities; one specific, evidence-backed line per finding. Keep it current with update_plan — a step is only done when you can say how you verified it.

Work to the end. Do not hand back a half-finished task with a summary that reads as if it is complete: if something cannot be done, say so plainly and say why. Check your own work before claiming it works — run the tests, call the endpoint, open the page. To compile or build anything, call build_project instead of typing msbuild/cmake/dotnet/cargo yourself: it finds the installed Visual Studio/MSBuild/compiler automatically (including vswhere), restores packages, builds Release x64 by default, and hands you the compiler errors so you can fix them and rebuild.

Ask before you build the wrong thing. If a choice would change what you produce and you cannot settle it by reading a file or looking it up, call ask_user — one question up front is far cheaper than twenty rounds of work in the wrong direction, and the user would rather be asked than handed something they have to throw away. Ask early, while the work is cheap to redo, not after you have committed to an approach. Offer concrete options with a sensible default so it is one click. Do not ask about things you can find out yourself, and do not ask the same thing twice. When you are done, briefly say what you changed and whether it ran.\n\nUse search_files to find where something lives rather than opening files one at a time, and read_files when you already know you need several — each separate call costs a whole round.\n\nYou can also look at the live web. When a task depends on what is actually on a page — its markup, its data, its exact wording — fetch it rather than reasoning from memory. Before writing anything that targets a site, such as a content script, a userscript or a scraper, call inspect_page on the real URL and use the ids and classes it returns. Never invent a selector you have not seen: a plausible-looking one that does not exist produces code that runs and does nothing, which is worse than admitting you need to look. Use fetch_url to read a page, fetch_url with raw for its HTML, and download_file to save something from a URL straight into the workspace. ${canSearch ? "When you hit something you do not know — an unfamiliar error, a library's current API — use web_search rather than guessing, because a wrong assumption compounds over every round after it. One web_search costs several model calls of its own, so make the query specific and read what comes back before searching again." : "There is no web_search in this workspace — no Tavily key is set in Settings. fetch_url still works if you already know the URL. When you genuinely do not know something and cannot look it up, say so instead of guessing, and name what you would have searched for."}\n\nIf an edit turns out to be wrong, undo_file puts that file back exactly as it was; reverting is safer than patching your own mistake. restore_snapshot rolls the whole workspace back to a restore point, which is a much larger step — list_snapshots first, and say what you are undoing before you do it. read_document opens PDF, Word, Excel, PowerPoint, EPUB and ODT files, which read_file cannot. inspect_binary statically reads Windows EXEs/DLLs without executing them. Select only the layers the request needs: analyses:["decompile"] to test Ghidra/ILSpy, ["strings"] for a strings dump, ["entropy"], ["carve"], ["dependencies"], or ["capa"] for those individual jobs, and ["all"] only when the user asks to check everything. Omitted analyses means a cheap summary, not everything. Decompiling is expensive and its artifacts persist on disk; the system message lists every executable already analyzed in this workspace with its hash and artifact paths - if the binary you need is already there, read those artifacts with read_file instead of running inspect_binary again, and never re-decompile the same hash unless the user asks you to. The moment you reach a conclusion about a binary - which one works, what is flawed, where the good build is, what a hook actually does - call note_binary so that verdict survives Stop and compaction instead of being paid for twice. write_files creates several files in one call, which is worth using whenever you are scaffolding.\n\nBatch the changes that belong together. move_file renames in one step instead of read-write-delete. edit_files applies several replacements at once, across one file or many. replace_in_files changes the same text everywhere it appears, which is what you want for renaming a function or an import path — doing that file by file costs a round each. When a string might occur somewhere you did not intend, run it with preview first and read the list before committing.${
              visionApiKey
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
              searchSummary +
              clarifyInstruction +
              workspaceInstruction +
              binaryLedgerBlock +
              findingsBlock +
              lessonsBlock,
          },
        ];

        for (const msg of scopedHistory) {
          if (!msg.content?.trim()) continue;
          transcript.push(
            msg.role === "assistant"
              ? { role: "assistant", content: msg.content }
              : { role: "user", content: msg.content }
          );
        }
        transcript.push({ role: "user", content: message });

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
          for (let i = transcript.length - 1; i >= 0; i--) {
            const entry = transcript[i];
            if (
              entry.role === "system" &&
              typeof entry.content === "string" &&
              entry.content.startsWith(PLUGIN_DIRECTIVES_MARKER)
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
        if (workspaceEnabled) {
          const saved = await readPlan(workspace);
          if (saved && !planIsComplete(saved)) {
            plan = saved;
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
        /** Only ever pushed to clarify once, however long the run gets. */
        let askedEarly = false;
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
           * Compact before replaying, not after.
           *
           * A resume drops a whole finished attempt into one request — on max
           * thinking, twenty rounds is ~180k tokens of reasoning alone, and
           * that then rides along on every remaining round. Folding the older
           * rounds first is what makes continuing cheaper than starting over
           * rather than merely different.
           *
           * Done unconditionally and without quantising: the prefix is
           * rewritten exactly once here and is stable afterwards, so there is
           * no cache being thrashed to pay for it.
           */
          const folded = compactForResume(resumed.messages);
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

        // ---------------- Agent loop ----------------
        // Without tools this runs exactly once. With them, each pass may end
        // in tool calls, which are executed and fed back as `role: "tool"`
        // messages before the next pass.
        // Write, run, read the error, fix, run again is four rounds for a
        // single bug. Real work is several of those plus the reading it takes
        // to find the right file, so 20 ran out mid-task.
        const MAX_TOOL_ROUNDS = 40;
        let round = 0;
        // Rounds already spent count against the limit. A resumed reply that
        // started over at zero could work indefinitely by being interrupted.
        let toolRounds = resumed?.toolRounds ?? 0;

        /**
         * Automatic "carry on" rounds after hitting the output limit.
         *
         * Capped so a model that ends every round at the ceiling cannot loop
         * forever, but high enough that a genuinely long file finishes: each
         * continuation adds another full output budget.
         */
        const MAX_CONTINUATIONS = 8;
        // Carried across a resume, so continuing cannot reset the guard and
        // spend another eight budgets on a model that never stops.
        let continuations = resumed?.continuations ?? 0;
        /** Set when the reply stopped because it ran out of room. */
        let hitOutputCeiling = false;
        /** Set when the spending limit ended the run rather than the model. */
        let stoppedByBudget = false;
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

        while (true) {
          round += 1;
          appendPluginDirectives();
          const toolAcc = new ToolCallAccumulator();
          let roundContent = "";
          let roundReasoning = "";
          const roundDeltaFields = new Set<string>();
          /** "stop" if the model finished, "length" if it ran out of room. */
          let roundFinishReason = "";

          // Collapse old tool results before sending. The stored transcript
          // keeps everything; only the copy going upstream is reduced, so a
          // long agent run does not re-pay for the full text of a file it
          // read thirty rounds ago.
          const pruned = pruneTranscript(transcript);
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
          const compacted = compactTranscript(pruned.messages);
          if (compacted.stats.rounds > 0) {
            send({
              type: "context_compacted",
              rounds: compacted.stats.rounds,
              tokensSaved: compacted.stats.tokensSaved,
            });
          }

          const dsRequestBody: Record<string, unknown> = {
            model,
            messages: serializeForApi(compacted.messages),
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
             */
            max_tokens: maxTokensFor(budget, model, MAX_OUTPUT_TOKENS),
            // NOTE: `thinking` is a REAL top-level parameter of DeepSeek's REST
            // API. It previously sat inside `extra_body`, which only exists as a
            // passthrough convention in the *Python OpenAI SDK*. Sending it over
            // plain fetch meant DeepSeek never saw it, silently defaulted to
            // thinking-enabled/high, and the "None" option did nothing.
            thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
          };

          if (thinkingEnabled) {
            dsRequestBody.reasoning_effort = VALID_EFFORTS.has(resolvedEffort)
              ? resolvedEffort
              : "high";
          }

          if (workspaceEnabled) {
            /*
             * Tools that cannot work are withheld rather than offered.
             *
             * A model given a tool it has no key for will call it, get an
             * error, apologise, and try something worse — a wasted round and
             * a worse answer. view_image needs a vision key; web_search needs
             * a Tavily one.
             */
            dsRequestBody.tools = WORKSPACE_TOOLS.filter((t) => {
              if (t.function.name === "view_image") return Boolean(visionApiKey);
              if (t.function.name === "web_search")
                return Boolean(tavilyApiKey || exaApiKey);
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

          // ---------------- Call DeepSeek ----------------
          // Retried rather than failed outright: a blip on round thirty of a
          // long task used to discard the whole run, including every token
          // already paid for. Only transient failures retry — a rejected key
          // or an empty balance fails the same way every time.
          const attempt = await fetchWithRetry(
            () =>
              fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${deepseekApiKey}`,
                },
                body: JSON.stringify(dsRequestBody),
                signal: AbortSignal.any([
                  runSignal,
                  AbortSignal.timeout(280_000),
                ]),
              }),
            {
              signal: runSignal,
              onRetry: ({ attempt: n, attempts, delayMs, reason }) => {
                send({ type: "retrying", attempt: n, attempts, delayMs, reason });
              },
            }
          );

          if (!attempt.response) {
            const err = attempt.error;
            if (err instanceof Error && err.name === "AbortError") {
              // The user pressed Stop; the abort handler already tidied up.
              close();
              return;
            }
            const timedOut = err instanceof Error && err.name === "TimeoutError";
            send({
              type: "error",
              error: timedOut
                ? `The DeepSeek API took too long to respond, after ${attempt.attempts} attempt(s).`
                : `Couldn't reach the DeepSeek API after ${attempt.attempts} attempt(s). Check the network connection and try again.`,
            });
            close();
            return;
          }

          const dsResponse = attempt.response;

          if (!dsResponse.ok || !dsResponse.body) {
            const errText = await dsResponse.text().catch(() => "");
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
            if (assistantContent || toolEvents.length || reasoningContent) {
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
                    messages: transcript,
                  },
                });
              } catch (e) {
                console.error("Could not save work before failing:", e);
              }
            }

            send({
              type: "error",
              error:
                dsResponse.status === 401
                  ? "Your DeepSeek API key was rejected. Check it in Settings."
                  : dsResponse.status === 402
                    ? "Your DeepSeek account has insufficient balance. Everything done so far is saved — add credit and press Continue on the reply above."
                    : dsResponse.status === 429
                      ? "Rate limited by DeepSeek. Please wait a moment and try again."
                      : `DeepSeek API error (${dsResponse.status})${detail ? `: ${detail}` : ""}`,
            });
            close();
            return;
          }

          // ---------------- Consume DeepSeek's SSE ----------------
          const reader = dsResponse.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

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
                webSearchUsed: doSearch,
                searchResults:
                  searchContext?.results.map((r) => ({
                    title: r.title,
                    url: r.url,
                    domain: r.domain,
                  })) ?? null,
                searchQueries: searchContext?.queries ?? null,
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
                    ? { toolRounds, continuations, messages: transcript }
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

            const { done, value } = await reader.read();
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
                const roundHit = u.prompt_cache_hit_tokens ?? 0;
                totalUsage.prompt_cache_hit_tokens += roundHit;
                totalUsage.prompt_cache_miss_tokens +=
                  u.prompt_cache_miss_tokens ??
                  Math.max(0, (u.prompt_tokens ?? 0) - roundHit);
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
              if (reason) roundFinishReason = reason;

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
                send({ type: "reasoning", delta: reasoningDelta.text });
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) toolAcc.add(tc);
              }
              if (delta.content) {
                if (!announcedWriting) {
                  announcedWriting = true;
                  send({ type: "status", stage: "writing" });
                }
                assistantContent += delta.content;
                roundContent += delta.content;
                appendTimelineText(delta.content);
                send({ type: "content", delta: delta.content });
                void checkpoint();
              }
            }
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
          const truncated = roundFinishReason === "length";

          if (truncated && calls.length === 0) {
            // Plain prose cut short. Ask for the rest instead of stopping —
            // the transcript already holds what arrived, so the continuation
            // costs only the remaining tokens rather than a full retry.
            if (continuations < MAX_CONTINUATIONS) {
              continuations += 1;
              transcript.push({
                role: "assistant",
                content: roundContent || null,
                reasoning_content: roundReasoning || null,
              });
              transcript.push({
                role: "user",
                content:
                  "You reached the output limit mid-answer. Continue from " +
                  "exactly where you stopped — do not repeat anything you " +
                  "already wrote, do not restate the plan, and do not " +
                  "apologise. Carry straight on from the last character.",
              });
              send({ type: "continuing", reason: "output_limit", of: MAX_CONTINUATIONS, n: continuations });
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

          if (toolRounds >= MAX_TOOL_ROUNDS) {
            // Guard against a model that keeps calling tools forever. Every
            // pending call needs a reply or the next request is a 400, so all
            // of them are answered rather than only the first.
            for (const call of calls) {
              transcript.push({
                role: "tool",
                tool_call_id: call.id,
                content:
                  `Tool limit reached for this message (${MAX_TOOL_ROUNDS} rounds). ` +
                  `Stop here and tell the user: what you finished, what is ` +
                  `left, and the exact next step so they can say "continue". ` +
                  `Do not pretend the task is complete.`,
              });
            }
            recordAsync({
              kind: "limit_hit",
              subject: "tool rounds",
              detail:
                `The agent used all ${MAX_TOOL_ROUNDS} rounds without ` +
                `finishing, so it was told to stop and summarise.`,
              context: { rounds: toolRounds },
            });
            send({ type: "status", stage: "writing" });
            continue;
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
                  visionKey: visionApiKey,
                  visionModel,
                  searchKey: tavilyApiKey,
                  exaKey: exaApiKey,
                  deepseekKey: deepseekApiKey,
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

            const parsed = parseToolArguments(call.function.arguments);

            let result: {
              ok: boolean;
              content: string;
              summary: string;
              changedPath?: string;
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

              result = {
                ok: false,
                content: looksTruncated
                  ? `Error: this ${call.function.name} call was cut off by the ` +
                    `output limit — its arguments are incomplete, so nothing ` +
                    `was written.\n\n` +
                    `The content was too large for one call. Do NOT resend it ` +
                    `whole. Instead:\n` +
                    `  1. write_file with the FIRST part only (aim for under ` +
                    `1500 lines).\n` +
                    `  2. Then append each following part with edit_file, ` +
                    `using the last few lines of what you just wrote as ` +
                    `old_text.\n` +
                    `Keep going until the file is complete. Say nothing else ` +
                    `until it is.`
                  : `Error: arguments were not valid JSON (${parsed.error})`,
                summary: looksTruncated
                  ? `Cut off mid-call — splitting into parts`
                  : "Invalid tool arguments",
              };
            } else if (call.function.name === "make_plan") {
              /*
               * Handled here, not in runTool, because a plan is per-RUN state.
               * The tool dispatcher is deliberately stateless — it takes a
               * workspace id and arguments — and threading a mutable plan
               * through it would make every tool call carry state it does not
               * use.
               */
              const pArgs = parsed.value as {
                goal?: unknown;
                steps?: unknown;
              };
              try {
                /*
                 * Re-planning keeps what was already proved.
                 *
                 * Without this, the cheapest way out of "four steps remain"
                 * was to call make_plan again with one trivial step and mark
                 * it done. replacePlan carries verified work forward, so a
                 * rewrite can reorganise what is left but cannot erase what
                 * happened.
                 */
                plan = replacePlan(
                  plan,
                  createPlan(
                    String(pArgs.goal ?? ""),
                    // The schema asks for strings, but some models send
                    // {title, description}. createPlan normalises that shape;
                    // String(object) is the literal "[object Object]" shown in
                    // every plan row in Screenshot_168.
                    Array.isArray(pArgs.steps) ? pArgs.steps : []
                  )
                );
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
                result = {
                  ok: true,
                  content:
                    `Plan set.\n\n${formatPlan(plan)}\n\nStart on step 1. ` +
                    `Update it with update_plan as you go.`,
                  summary: `Planned ${plan.steps.length} steps`,
                };
              } catch (error) {
                result = {
                  ok: false,
                  content: `Error: ${
                    error instanceof Error ? error.message : "bad plan"
                  }`,
                  summary: "Could not set plan",
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
                  result = {
                    ok: true,
                    content: formatPlan(plan),
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
                      visionKey: visionApiKey,
                      visionModel,
                      searchKey: tavilyApiKey,
                  exaKey: exaApiKey,
                      deepseekKey: deepseekApiKey,
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
                  visionKey: visionApiKey,
                  visionModel,
                  searchKey: tavilyApiKey,
                  exaKey: exaApiKey,
                  deepseekKey: deepseekApiKey,
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
         * A note is appended rather than the reply being blocked. Blocking
         * would throw away work that may be perfectly good apart from an
         * over-claiming last paragraph, and would cost another round to
         * regenerate. The point is that the claim stops being invisible.
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
          send({ type: "content", delta: note });
          appendTimelineText(note);
        }

        // ---------------- Final save ----------------
        // The assistant message has been checkpointed throughout the stream;
        // this last write clears the `incomplete` flag and records usage.
        try {
          await upsertMessage(convId, title, {
            id: assistantMsgId,
            role: "assistant",
            content: assistantContent,
            reasoningContent: reasoningContent || null,
            thinkingEffort: resolvedEffort,
            webSearchUsed: doSearch,
            searchResults:
              searchContext?.results.map((r) => ({
                title: r.title,
                url: r.url,
                domain: r.domain,
              })) ?? null,
            searchQueries: searchContext?.queries ?? null,
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
            incomplete: hitOutputCeiling || stoppedByBudget,
            // Kept only while there is something to resume. A finished reply
            // drops it: it is the largest field in the record and resuming a
            // complete answer means nothing.
            resumeState:
              hitOutputCeiling || stoppedByBudget
                ? { toolRounds, continuations, messages: transcript }
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
              deepseekApiKey,
              DEEPSEEK_BASE_URL,
              runSignal
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

        console.error("Chat API error:", error);
        send({
          type: "error",
          error:
            error instanceof Error
              ? `Internal server error: ${error.message}`
              : "Internal server error",
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
