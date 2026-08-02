import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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

    // Call DeepSeek API
    const dsResponse = await fetch(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify(dsRequestBody),
      }
    );

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      console.error("DeepSeek error:", dsResponse.status, errText);
      return NextResponse.json(
        { error: `DeepSeek API error: ${dsResponse.status}` },
        { status: 502 }
      );
    }

    const dsData = await dsResponse.json();
    const choice = dsData.choices?.[0];
    const assistantContent = choice?.message?.content || "";
    const reasoningContent = choice?.message?.reasoning_content || null;
    const usage = dsData.usage;

    // Save to database
    let convId = conversationId;
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
    const userMsgId = uuidv4();
    await db.insert(messages).values({
      id: userMsgId,
      conversationId: convId,
      role: "user",
      content: message,
      thinkingEffort: resolvedEffort,
      webSearchUsed: !!doSearch,
    });

    // Save assistant message
    const assistantMsgId = uuidv4();
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

    return NextResponse.json({
      id: assistantMsgId,
      conversationId: convId,
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
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
