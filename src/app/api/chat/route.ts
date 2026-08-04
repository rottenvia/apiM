import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { appendMessages, truncateFrom, upsertMessage } from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import { smartSearch, autoThinkingEffort, decideSearch } from "@/lib/smart-search";
import type { SmartSearchContext } from "@/lib/smart-search";
import { AVAILABLE_PLUGINS, buildSystemPrompt } from "@/lib/plugins";
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
}

/** One frame of our own SSE protocol (deliberately simpler than DeepSeek's). */
type StreamEvent =
  | { type: "status"; stage: "deciding" | "searching" | "thinking" | "writing" }
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
  | { type: "content"; delta: string }
  | {
      type: "done";
      id: string;
      conversationId: string | null;
      persisted: boolean;
      usage: unknown;
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

  const title = deriveTitle(message);

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
              content: message,
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
              deepseekApiKey
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
              tavilyApiKey as string
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

        const apiMessages: { role: string; content: string }[] = [
          {
            role: "system",
            content: systemPrompt + searchSummary + clarifyInstruction,
          },
        ];
        for (const msg of conversationHistory.slice(-20)) {
          apiMessages.push({ role: msg.role, content: msg.content });
        }
        apiMessages.push({ role: "user", content: message });

        const dsRequestBody: Record<string, unknown> = {
          model,
          messages: apiMessages,
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
        let assistantContent = "";
        let reasoningContent = "";
        let usage: unknown = null;
        let announcedWriting = false;

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
                delta?: { content?: string; reasoning_content?: string };
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
              send({ type: "reasoning", delta: delta.reasoning_content });
            }
            if (delta.content) {
              if (!announcedWriting) {
                announcedWriting = true;
                send({ type: "status", stage: "writing" });
              }
              assistantContent += delta.content;
              send({ type: "content", delta: delta.content });
              void checkpoint();
            }
          }
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
