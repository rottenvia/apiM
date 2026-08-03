import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { appendMessages } from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import { smartSearch, autoThinkingEffort } from "@/lib/smart-search";
import type { SearchResultItem } from "@/lib/smart-search";
import { AVAILABLE_PLUGINS, buildSystemPrompt } from "@/lib/plugins";

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
  webSearchEnabled?: boolean;
  enabledPluginIds?: string[];
  conversationHistory?: ChatMessage[];
}

/** One frame of our own SSE protocol (deliberately simpler than DeepSeek's). */
type StreamEvent =
  | { type: "status"; stage: "searching" | "thinking" | "writing" }
  | {
      type: "meta";
      conversationId: string | null;
      title: string;
      resolvedEffort: string;
      thinkingEnabled: boolean;
      webSearchUsed: boolean;
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
    webSearchEnabled = false,
    enabledPluginIds = [],
    conversationHistory = [],
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

  // Search runs only when the user explicitly enabled it AND a Tavily key
  // exists. No heuristic override — the toggle means exactly what it says.
  const doSearch = Boolean(webSearchEnabled && tavilyApiKey);

  const title = deriveTitle(message);

  const plugins = AVAILABLE_PLUGINS.map((p) => ({
    ...p,
    enabled: enabledPluginIds.includes(p.id),
  }));
  const systemPrompt = buildSystemPrompt(plugins);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      try {
        // ---------------- Web search ----------------
        let searchContext: {
          results: SearchResultItem[];
          queries: string[];
          summary: string;
          searchesPerformed: number;
          sourcesUsed: number;
        } | null = null;
        let searchSummary = "";

        if (doSearch) {
          send({ type: "status", stage: "searching" });

          const recentContext = conversationHistory
            .slice(-4)
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n");

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
          conversationId: conversationId ?? null,
          title,
          resolvedEffort,
          thinkingEnabled,
          webSearchUsed: doSearch,
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
        const apiMessages: { role: string; content: string }[] = [
          { role: "system", content: systemPrompt + searchSummary },
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

        while (true) {
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
            }
          }
        }

        // ---------------- Persist ----------------
        // Chats are stored as JSON under ./data/chats so they survive
        // restarts without needing a database. Failure here must not discard
        // a reply the user already watched arrive.
        let convId: string | null = conversationId ?? null;
        const assistantMsgId = uuidv4();
        let persisted = false;
        const now = new Date().toISOString();

        try {
          if (!convId) convId = uuidv4();

          const toStore: StoredMessage[] = [
            {
              id: uuidv4(),
              role: "user",
              content: message,
              thinkingEffort: resolvedEffort,
              webSearchUsed: doSearch,
              createdAt: now,
            },
            {
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
                (usage as { total_tokens?: number } | null)?.total_tokens ??
                null,
              createdAt: new Date().toISOString(),
            },
          ];

          await appendMessages(convId, title, toStore);
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
