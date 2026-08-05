import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { appendMessages, truncateFrom, upsertMessage } from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import { smartSearch, autoThinkingEffort, decideSearch } from "@/lib/smart-search";
import type { SmartSearchContext } from "@/lib/smart-search";
import { AVAILABLE_PLUGINS, buildSystemPrompt } from "@/lib/plugins";
import { WORKSPACE_TOOLS, runTool } from "@/lib/tools";
import {
  runCommand,
  validateCommand,
  describeCommand,
  formatRunResult,
} from "@/lib/runner";
import { requestApproval, isRemembered } from "@/lib/approvals";
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

  const title = deriveTitle(displayContent?.trim() || message);

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
              req.signal
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
        });

        // ---------------- Build the request ----------------
        const clarifyInstruction = clarifyHint
          ? `\n\nThis question depends on details only the user has. Before giving a general answer, ask them: "${clarifyHint}" Keep it to one short question, explain in a sentence why it changes the answer, and offer what general guidance you can meanwhile.`
          : "";

        const workspace = workspaceId ?? convId;
        const workspaceInstruction = workspaceEnabled
          ? `\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.\n\nYou can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Each command needs the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell and commands are stopped after 30 seconds, so never start a server or anything interactive. When you are done, briefly say what you changed and whether it ran.`
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
        // Higher than the file-only limit: write, run, read the error, fix,
        // run again is four rounds for one bug, and real work has several.
        const MAX_TOOL_ROUNDS = 20;
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
        let usage: unknown = null;
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
            dsRequestBody.tools = WORKSPACE_TOOLS;
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

              if (chunk.usage) usage = chunk.usage;

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
            // Guard against a model that keeps calling tools forever.
            transcript.push({
              role: "tool",
              tool_call_id: calls[0].id,
              content:
                "Tool limit reached for this message. Summarise what you have done so far and stop.",
            });
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
            } else if (call.function.name === "run_command") {
              // Handled here rather than in runTool: it is the only tool that
              // has to pause and wait for the user.
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

                const preApproved = isRemembered(
                  workspace,
                  check.command,
                  check.args
                );

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
                parsed.value
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
            tokenCount:
              (usage as { total_tokens?: number } | null)?.total_tokens ?? null,
            usage: (usage as Record<string, number> | null) ?? null,
            model,
            durationMs: Date.now() - startedAt,
            toolEvents: toolEvents.length ? toolEvents : null,
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
