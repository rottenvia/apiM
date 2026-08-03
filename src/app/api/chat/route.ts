import { NextRequest, NextResponse } from "next/server";
import { db, isDatabaseConfigured } from "@/db";
import { messages, conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  smartSearch,
  autoThinkingEffort,
  shouldAutoSearch,
} from "@/lib/smart-search";
import { AVAILABLE_PLUGINS, buildSystemPrompt } from "@/lib/plugins";

export const maxDuration = 120;

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

export async function POST(req: NextRequest) {
  try {
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
      enabledPluginIds = [] as string[],
      conversationHistory = [] as ChatMessage[],
    } = body;

    if (!message || !deepseekApiKey) {
      return NextResponse.json(
        { error: "Message and DeepSeek API key are required" },
        { status: 400 }
      );
    }

    // Resolve thinking effort
    const resolvedEffort =
      thinkingEffort === "auto" ? autoThinkingEffort(message) : thinkingEffort;

    // Set up plugins
    const plugins = AVAILABLE_PLUGINS.map((p) => ({
      ...p,
      enabled: enabledPluginIds.includes(p.id),
    }));
    const systemPrompt = buildSystemPrompt(plugins);

    // Determine if we should search
    const doSearch =
      webSearchEnabled && tavilyApiKey && (shouldAutoSearch(message) || webSearchEnabled);

    let searchContext = null;
    let searchSummary = "";

    if (doSearch && tavilyApiKey) {
      // Build conversation context for search planning
      const recentContext = conversationHistory
        .slice(-4)
        .map((m: ChatMessage) => `${m.role}: ${m.content}`)
        .join("\n");

      searchContext = await smartSearch(
        message,
        recentContext,
        deepseekApiKey,
        tavilyApiKey
      );

      if (searchContext.results.length > 0) {
        searchSummary = `\n\n<web_search_results>\nI performed ${searchContext.searchesPerformed} targeted search(es) using queries: ${searchContext.queries.map((q: string) => `"${q}"`).join(", ")}\n\nFound ${searchContext.sourcesUsed} relevant sources:\n\n${searchContext.summary}\n</web_search_results>\n\nIMPORTANT: Use the search results above to provide accurate, up-to-date information. Cite sources with their URLs. If the search results contain links to GitHub repos, documentation, or solutions, include those EXACT URLs. Never make up URLs.`;
      }
    }

    // Build messages array
    const apiMessages: { role: string; content: string }[] = [
      {
        role: "system",
        content: systemPrompt + searchSummary,
      },
    ];

    // Add conversation history
    for (const msg of conversationHistory.slice(-20)) {
      apiMessages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add current user message
    apiMessages.push({
      role: "user",
      content: message,
    });

    // Build DeepSeek request
    const dsRequestBody: Record<string, unknown> = {
      model,
      messages: apiMessages,
      stream: false,
      max_tokens: 8192,
    };

    if (resolvedEffort !== "none") {
      dsRequestBody.reasoning_effort = resolvedEffort;
      dsRequestBody.extra_body = { thinking: { type: "enabled" } };
    } else {
      dsRequestBody.extra_body = { thinking: { type: "disabled" } };
    }

    // Call DeepSeek API. Network faults here are upstream problems, so report
    // them as 502s with a readable reason instead of a generic 500.
    let dsResponse: Response;
    try {
      dsResponse = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify(dsRequestBody),
        signal: AbortSignal.timeout(110_000),
      });
    } catch (networkError) {
      console.error("DeepSeek request failed:", networkError);
      const timedOut =
        networkError instanceof Error && networkError.name === "TimeoutError";
      return NextResponse.json(
        {
          error: timedOut
            ? "The DeepSeek API took too long to respond. Please try again."
            : "Couldn't reach the DeepSeek API. Check the server's network connection and try again.",
        },
        { status: 504 }
      );
    }

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      console.error("DeepSeek error:", dsResponse.status, errText);

      // Surface DeepSeek's own message when it sends one, so users can tell an
      // invalid key from rate limiting instead of seeing a bare status code.
      let detail = "";
      try {
        const parsed = JSON.parse(errText);
        detail = parsed?.error?.message ?? parsed?.message ?? "";
      } catch {
        detail = errText.slice(0, 200);
      }

      const friendly =
        dsResponse.status === 401
          ? "Your DeepSeek API key was rejected. Check it in Settings."
          : dsResponse.status === 402
            ? "Your DeepSeek account has insufficient balance."
            : dsResponse.status === 429
              ? "Rate limited by DeepSeek. Please wait a moment and try again."
              : `DeepSeek API error (${dsResponse.status})${detail ? `: ${detail}` : ""}`;

      return NextResponse.json({ error: friendly }, { status: 502 });
    }

    const dsData = await dsResponse.json();
    const choice = dsData.choices?.[0];
    const assistantContent = choice?.message?.content || "";
    const reasoningContent = choice?.message?.reasoning_content || null;
    const usage = dsData.usage;

    // Persist to the database. History is a convenience, not a prerequisite
    // for answering — if the DB is unreachable or unconfigured we still return
    // the model's reply rather than turning a good answer into an error.
    let convId: string | null = conversationId ?? null;
    const assistantMsgId = uuidv4();
    let persisted = false;

    if (isDatabaseConfigured) {
      try {
        if (!convId) {
          convId = uuidv4();
          // Generate a title from the first message
          const title =
            message.length > 60 ? message.substring(0, 57) + "..." : message;
          await db.insert(conversations).values({
            id: convId,
            title,
          });
        } else {
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, convId));
        }

        // Save user message
        await db.insert(messages).values({
          id: uuidv4(),
          conversationId: convId,
          role: "user",
          content: message,
          thinkingEffort: resolvedEffort,
          webSearchUsed: !!doSearch,
        });

        // Save assistant message
        await db.insert(messages).values({
          id: assistantMsgId,
          conversationId: convId,
          role: "assistant",
          content: assistantContent,
          reasoningContent,
          thinkingEffort: resolvedEffort,
          webSearchUsed: !!doSearch,
          searchResults: searchContext
            ? JSON.stringify(searchContext.results.map((r) => ({ title: r.title, url: r.url, domain: r.domain })))
            : null,
          pluginsUsed: enabledPluginIds.length > 0 ? JSON.stringify(enabledPluginIds) : null,
          tokenCount: usage?.total_tokens || null,
        });

        persisted = true;
      } catch (dbError) {
        console.error("Failed to persist chat message:", dbError);
      }
    }

    return NextResponse.json({
      id: assistantMsgId,
      conversationId: convId,
      persisted,
      content: assistantContent,
      reasoningContent,
      resolvedEffort,
      webSearchUsed: !!doSearch,
      searchResults: searchContext?.results || null,
      searchQueries: searchContext?.queries || null,
      searchesPerformed: searchContext?.searchesPerformed || 0,
      usage,
      pluginsUsed: enabledPluginIds,
    });
  } catch (error) {
    // Last-resort guard: always emit JSON so the client never has to parse an
    // HTML error page.
    console.error("Chat API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Internal server error: ${error.message}`
            : "Internal server error",
      },
      { status: 500 }
    );
  }
}
