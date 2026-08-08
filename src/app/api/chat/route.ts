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
import { smartSearch, autoThinkingEffort, decideSearch } from "@/lib/smart-search";
import type { SmartSearchContext } from "@/lib/smart-search";
import {
  ALL_PLUGINS,
  BASE_PROMPT,
  buildLegacyPrompt,
  buildPluginDirectives,
} from "@/lib/plugins";
import { WORKSPACE_TOOLS, runTool } from "@/lib/tools";
import { buildWorkspaceContext } from "@/lib/workspace-context";
import { createSnapshot } from "@/lib/snapshots";
import {
  runCommand,
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
import {
  rebuildResumeFromStored,
  rebuiltResumeInstruction,
} from "@/lib/rebuild-resume";
import type { RebuiltResume } from "@/lib/rebuild-resume";
import { fetchWithRetry } from "@/lib/retry";
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
      /** Wall-clock milliseconds from request start to final token. */
      durationMs: number;
      model: string;
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
    model = "deepseek-v4-pro",
    thinkingEffort = "auto",
    webSearchMode = "off",
    enabledPluginIds = [],
    conversationHistory = [],
    regenerateFromId,
    resumeMessageId,
    displayContent,
    attachments,
    workspaceEnabled = false,
    workspaceId,
    // Defaults to false, so a request that omits it asks rather than runs.
    // The dangerous setting has to be opted into explicitly, never inherited.
    autoRunCommands = false,
    visionApiKey,
    visionModel,
    searchProfile,
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
  const canSearch = Boolean(tavilyApiKey && webSearchMode !== "off");

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

        const recentContext = conversationHistory
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
              req.signal
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
              req.signal,
              searchProfile
            );
          } catch (searchError) {
            // A failed search shouldn't kill the answer — carry on without it.
            console.error("Search failed:", searchError);
          }

          if (searchContext && searchContext.results.length > 0) {
            searchSummary = `\n\n<web_search_results>\nI performed ${searchContext.searchesPerformed} targeted search(es) using queries: ${searchContext.queries
              .map((q) => `"${q}"`)
              .join(", ")}\n\nFound ${searchContext.sourcesUsed} relevant sources:\n\n${searchContext.summary}\n</web_search_results>\n\nIMPORTANT: Use the search results above to provide accurate, up-to-date information. Cite sources with their URLs. If the search results contain links to GitHub repos, documentation, or solutions, include those EXACT URLs. Never make up URLs.`;
          }
        }

        if (req.signal.aborted) {
          close();
          return;
        }

        send({
          type: "meta",
          conversationId: convId,
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

        const workspaceInstruction = workspaceEnabled
          ? `\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.\n\nYou can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Each command needs the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell. run_command waits for the program to finish, so use it only for things that exit — scripts, tests, installs. You can install packages: pip install and npm install both work and go into this workspace, not the user's system, so install what you need rather than rewriting code to avoid a dependency. For anything that keeps running, such as a dev server or a watcher, use start_process instead: it returns straight away, and you can read its output with read_process and stop it with stop_process. Always stop what you started once you are done with it. If a decision would genuinely change what you build and you cannot settle it by reading a file, use ask_user rather than guessing — but sparingly, since every question interrupts the user. When you are done, briefly say what you changed and whether it ran.\n\nUse search_files to find where something lives rather than opening files one at a time, and read_files when you already know you need several — each separate call costs a whole round.${
              visionApiKey
                ? " You can also view_image to look at a screenshot or mockup saved in the workspace."
                : ""
            }`
          : "";

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
            // The user's standing orders go last on purpose: the workspace
            // rules that precede them run to several thousand characters, and
            // whatever sits after that block is what the model weighs most
            // heavily.
            content:
              systemPrompt +
              searchSummary +
              clarifyInstruction +
              workspaceInstruction +
              pluginDirectives,
          },
        ];

        for (const msg of conversationHistory.slice(-20)) {
          if (!msg.content?.trim()) continue;
          transcript.push(
            msg.role === "assistant"
              ? { role: "assistant", content: msg.content }
              : { role: "user", content: msg.content }
          );
        }
        transcript.push({ role: "user", content: message });

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
          if (fileTreeIndex === -1) {
            transcript.push({ role: "system", content: body });
            fileTreeIndex = transcript.length - 1;
          } else {
            transcript[fileTreeIndex] = { role: "system", content: body };
          }
        };

        if (workspaceEnabled) setFileTree(workspaceFiles);

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
          let next = "";
          try {
            next = await buildWorkspaceContext(workspace);
          } catch {
            return; // Keep the last known tree rather than blanking it.
          }
          if (next === currentFileTree) return;

          // Drop the stale copy and re-append, so the freshest listing is
          // always the last thing before the model's next turn. Editing it in
          // place would leave it buried behind the tool results from this
          // round, where it reads as older than output that is actually
          // older than it.
          if (fileTreeIndex !== -1) {
            transcript.splice(fileTreeIndex, 1);
            fileTreeIndex = -1;
          }
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
          transcript.push(...resumed.messages);
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
            content: rebuilt
              ? rebuiltResumeInstruction(rebuilt)
              : "You were interrupted before finishing. Everything above is " +
                "your own work so far, including what the tools returned — " +
                "it is still valid, so do not repeat it. Continue from " +
                "exactly where you stopped. If a file was only partly " +
                "written, finish it with edit_file rather than rewriting it " +
                "from the start.",
          });

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

        // Accumulated across every round — one displayed reply can span
        // several API turns once tools are involved.
        //
        // Seeded from the interrupted reply when resuming, so the saved
        // message grows rather than being overwritten by only the new half.
        let assistantContent = resumedContent;
        let reasoningContent = resumedReasoning;
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
        const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let announcedWriting = false;
        const toolSummaries: { name: string; ok: boolean; summary: string }[] =
          [];

        while (true) {
          round += 1;
          const toolAcc = new ToolCallAccumulator();
          let roundContent = "";
          let roundReasoning = "";
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

          const dsRequestBody: Record<string, unknown> = {
            model,
            messages: serializeForApi(pruned.messages),
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: MAX_OUTPUT_TOKENS,
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
            // view_image is withheld without a key, so the model never calls
            // a tool that can only fail — it would waste a round and then
            // apologise instead of just working around it.
            dsRequestBody.tools = visionApiKey
              ? WORKSPACE_TOOLS
              : WORKSPACE_TOOLS.filter(
                  (t) => t.function.name !== "view_image"
                );
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
                  req.signal,
                  AbortSignal.timeout(280_000),
                ]),
              }),
            {
              signal: req.signal,
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
                // Everything needed to carry on instead of starting over.
                // Saved on each checkpoint, so even a killed process leaves a
                // resumable reply rather than a dead one.
                resumeState: {
                  toolRounds,
                  continuations,
                  messages: transcript,
                },
              });
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
            if (req.signal.aborted) {
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
                  reasoning_content?: string;
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
                send({
                  type: "usage",
                  usage: { ...totalUsage },
                  model,
                });
              }

              // Arrives on the final frame of the round, alongside an empty
              // delta — so it is read before the `!delta` guard below, which
              // would otherwise skip the one frame that carries it.
              const reason = chunk.choices?.[0]?.finish_reason;
              if (reason) roundFinishReason = reason;

              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                roundReasoning += delta.reasoning_content;
                send({ type: "reasoning", delta: delta.reasoning_content });
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

          if (calls.length === 0) break;

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
            send({ type: "status", stage: "writing" });
            continue;
          }

          toolRounds += 1;
          send({ type: "status", stage: "working" });

          for (const call of calls) {
            if (req.signal.aborted) break;

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

                const answer = await askQuestion(call.id, req.signal);

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
              };
              const check = validateCommand(args.command, args.args);

              if (!check.ok) {
                // Rejected before the user is asked — no point prompting for
                // something that could never run.
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

                const preApproved =
                  autoRunCommands ||
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
                    req.signal
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
                    { visionKey: visionApiKey, visionModel }
                  );
                } else {
                  const run = await runCommand(
                    workspace,
                    check.command,
                    check.args,
                    req.signal
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
            } else {
              result = await runTool(
                workspace,
                call.function.name,
                parsed.value,
                { visionKey: visionApiKey, visionModel }
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

            toolSummaries.push({
              name: call.function.name,
              ok: result.ok,
              summary: result.summary,
            });
          }

          // The next round must see the workspace as it is now, not as it was
          // before these tools ran.
          await refreshFileTree();

          if (req.signal.aborted) break;
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
            incomplete: hitOutputCeiling,
            // Kept only while there is something to resume. A finished reply
            // drops it: it is the largest field in the record and resuming a
            // complete answer means nothing.
            resumeState: hitOutputCeiling
              ? { toolRounds, continuations, messages: transcript }
              : null,
          });
          persisted = true;
        } catch (storeError) {
          console.error("Failed to persist conversation:", storeError);
        }

        send({
          type: "done",
          id: assistantMsgId,
          conversationId: convId,
          persisted,
          usage,
          durationMs: Date.now() - startedAt,
          model,
        });
        close();
      } catch (error) {
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
