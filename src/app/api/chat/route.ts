import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  appendMessages,
  truncateFrom,
  upsertMessage,
  availableTitle,
} from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import { smartSearch, autoThinkingEffort, decideSearch } from "@/lib/smart-search";
import type { SmartSearchContext } from "@/lib/smart-search";
import { AVAILABLE_PLUGINS, buildSystemPrompt } from "@/lib/plugins";
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
      const assistantMsgId = uuidv4();
      let persisted = false;

      try {
        // Built-ins plus the user's own saved plugins.
        let customPlugins: Awaited<ReturnType<typeof listCustomPlugins>> = [];
        try {
          customPlugins = await listCustomPlugins();
        } catch (e) {
          console.error("Failed to load custom plugins:", e);
        }
        const systemPrompt = buildSystemPrompt(
          [...AVAILABLE_PLUGINS, ...customPlugins].map((p) => ({
            ...p,
            enabled: enabledPluginIds.includes(p.id),
          }))
        );

        // Regenerate: drop the previous reply (and anything after it) so the
        // new one replaces it rather than appending a duplicate.
        if (regenerateFromId) {
          try {
            await truncateFrom(convId, regenerateFromId);
          } catch (e) {
            console.error("Failed to truncate for regenerate:", e);
          }
        }

        // Save the user's message immediately. Previously nothing hit disk
        // until the whole reply finished, so closing the tab mid-answer lost
        // both the question and the partial answer.
        //
        // Skipped when regenerating: the question is already stored and
        // truncateFrom only removed the reply, so re-appending would duplicate
        // it.
        if (!regenerateFromId) try {
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
          ? `\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.\n\nYou can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Each command needs the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell. run_command waits for the program to finish, so use it only for things that exit — scripts, tests, installs. For anything that keeps running, such as a dev server or a watcher, use start_process instead: it returns straight away, and you can read its output with read_process and stop it with stop_process. Always stop what you started once you are done with it. If a decision would genuinely change what you build and you cannot settle it by reading a file, use ask_user rather than guessing — but sparingly, since every question interrupts the user. When you are done, briefly say what you changed and whether it ran.\n\nUse search_files to find where something lives rather than opening files one at a time, and read_files when you already know you need several — each separate call costs a whole round.${
              visionApiKey
                ? " You can also view_image to look at a screenshot or mockup saved in the workspace."
                : ""
            }` + workspaceFiles
          : "";

        // A structured transcript, not bare {role, content}. Tool calls and
        // reasoning must survive across turns or DeepSeek rejects the next
        // request with a 400.
        const transcript: TranscriptMessage[] = [
          {
            role: "system",
            content:
              systemPrompt +
              searchSummary +
              clarifyInstruction +
              workspaceInstruction,
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

        // ---------------- Agent loop ----------------
        // Without tools this runs exactly once. With them, each pass may end
        // in tool calls, which are executed and fed back as `role: "tool"`
        // messages before the next pass.
        // Write, run, read the error, fix, run again is four rounds for a
        // single bug. Real work is several of those plus the reading it takes
        // to find the right file, so 20 ran out mid-task.
        const MAX_TOOL_ROUNDS = 40;
        let round = 0;
        let toolRounds = 0;

        // Accumulated across every round — one displayed reply can span
        // several API turns once tools are involved.
        let assistantContent = "";
        let reasoningContent = "";
        // Mirrors what the client is shown, so a reopened chat still lists
        // the files this reply touched.
        const toolEvents: {
          id: string;
          name: string;
          args: string;
          ok?: boolean;
          summary?: string;
          changedPath?: string;
        }[] = [];

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
        )[] = [];

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

          const dsRequestBody: Record<string, unknown> = {
            model,
            messages: serializeForApi(transcript),
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
          let dsResponse: Response;
          try {
            dsResponse = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${deepseekApiKey}`,
              },
              body: JSON.stringify(dsRequestBody),
              signal: AbortSignal.timeout(280_000),
            });
          } catch (networkError) {
            const timedOut =
              networkError instanceof Error &&
              networkError.name === "TimeoutError";
            send({
              type: "error",
              error: timedOut
                ? "The DeepSeek API took too long to respond. Please try again."
                : "Couldn't reach the DeepSeek API. Check the network connection and try again.",
            });
            close();
            return;
          }

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

            send({
              type: "error",
              error:
                dsResponse.status === 401
                  ? "Your DeepSeek API key was rejected. Check it in Settings."
                  : dsResponse.status === 402
                    ? "Your DeepSeek account has insufficient balance."
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
              result = {
                ok: false,
                content: `Error: arguments were not valid JSON (${parsed.error})`,
                summary: "Invalid tool arguments",
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
            incomplete: false,
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
