"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatArea } from "@/components/ChatArea";
import { SettingsModal } from "@/components/SettingsModal";
import { PluginsModal } from "@/components/PluginsModal";
import { ArtifactProvider } from "@/components/ArtifactContext";

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
}

/** What the assistant is currently doing, for the live status indicator. */
export type StatusStage = "searching" | "thinking" | "writing";

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
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusStage, setStatusStage] = useState<StatusStage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Settings
  const [deepseekKey, setDeepseekKey] = useState("");
  const [tavilyKey, setTavilyKey] = useState("");
  const [model, setModel] = useState("deepseek-v4-pro");
  const [thinkingEffort, setThinkingEffort] = useState("auto");
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [enabledPlugins, setEnabledPlugins] = useState<string[]>([]);

  const hasKeys = deepseekKey.length > 0;
  const initialLoadDone = useRef(false);
  /** Lets the Stop button cancel an in-flight stream. */
  const abortRef = useRef<AbortController | null>(null);

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
            if (s.model) setModel(s.model);
            if (s.thinkingEffort) setThinkingEffort(s.thinkingEffort);
            if (s.enabledPlugins) setEnabledPlugins(s.enabledPlugins);
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
          model,
          thinkingEffort,
          enabledPlugins,
        })
      );
    }
  }, [deepseekKey, tavilyKey, model, thinkingEffort, enabledPlugins]);

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
    });
  }, [refreshConversations]);

  const loadConversation = useCallback(async (id: string) => {
    setCurrentConvId(id);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      // The store returns the whole conversation object, messages included.
      const data = (await res.json()) as { messages?: unknown };
      const list = Array.isArray(data.messages) ? data.messages : [];
      setMessages(
        list.map((raw) => {
          const m = raw as Record<string, unknown>;
          return {
            id: m.id as string,
            role: m.role as "user" | "assistant",
            content: (m.content as string) ?? "",
            reasoningContent: m.reasoningContent as string | null | undefined,
            thinkingEffort: m.thinkingEffort as string | undefined,
            webSearchUsed: m.webSearchUsed as boolean | undefined,
            searchResults: parseSearchResults(m.searchResults),
            searchQueries: Array.isArray(m.searchQueries)
              ? (m.searchQueries as string[])
              : undefined,
            tokenCount: m.tokenCount as number | undefined,
            createdAt: m.createdAt as string | undefined,
          };
        })
      );
    } catch {
      /* ignore */
    }
  }, []);

  const startNewChat = useCallback(() => {
    setCurrentConvId(null);
    setMessages([]);
  }, []);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c))
      );
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch {
        /* optimistic update already applied */
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
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (currentConvId === id) {
        startNewChat();
      }
    },
    [currentConvId, startNewChat]
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading || !hasKeys) return;

      const trimmed = content.trim();
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: trimmed,
        thinkingEffort,
        webSearchUsed: webSearchEnabled,
      };

      // The assistant bubble is created immediately and filled in as deltas
      // arrive, so the user sees text within a second instead of staring at a
      // spinner until the whole (possibly 60K-token) answer is finished.
      const streamingId = `stream-${Date.now()}`;
      const assistantMsg: Message = {
        id: streamingId,
        role: "assistant",
        content: "",
        reasoningContent: "",
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);
      setStatusStage(webSearchEnabled ? "searching" : "thinking");

      const historyForApi = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

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
          prev.map((m) =>
            m.id === streamingId
              ? {
                  ...m,
                  content: m.content + c,
                  reasoningContent: (m.reasoningContent ?? "") + r,
                }
              : m
          )
        );
      };
      const scheduleFlush = () => {
        if (frame === null) frame = requestAnimationFrame(flush);
      };

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
            conversationId: currentConvId,
            deepseekApiKey: deepseekKey,
            tavilyApiKey: tavilyKey,
            model,
            thinkingEffort,
            webSearchEnabled,
            enabledPluginIds: enabledPlugins,
            conversationHistory: historyForApi,
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
                break;

              case "meta":
                streamTitle = evt.title;
                finalMeta = {
                  ...finalMeta,
                  thinkingEffort: evt.resolvedEffort,
                  webSearchUsed: evt.webSearchUsed,
                  searchResults: evt.searchResults,
                  searchQueries: evt.searchQueries ?? undefined,
                  searchesPerformed: evt.searchesPerformed,
                };
                if (!currentConvId && evt.conversationId) {
                  setCurrentConvId(evt.conversationId);
                }
                break;

              case "reasoning":
                pendingReasoning += evt.delta;
                scheduleFlush();
                break;

              case "content":
                pendingContent += evt.delta;
                scheduleFlush();
                break;

              case "done": {
                const usage = evt.usage as { total_tokens?: number } | null;
                finish({
                  ...finalMeta,
                  id: evt.id || streamingId,
                  tokenCount: usage?.total_tokens,
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

              case "error":
                sawError = true;
                finish({ content: `⚠️ ${evt.error}`, isError: true });
                break;
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
          // User pressed stop — keep whatever streamed in so far.
          finish({});
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
        // Re-sync with disk so ordering, titles and counts match what was
        // actually written.
        void refreshConversations();
      }
    },
    [
      isLoading,
      hasKeys,
      currentConvId,
      deepseekKey,
      tavilyKey,
      model,
      thinkingEffort,
      webSearchEnabled,
      enabledPlugins,
      messages,
      refreshConversations,
    ]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
        onNew={startNewChat}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onArchive={archiveConversation}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main Chat Area */}
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        statusStage={statusStage}
        onStop={stopGeneration}
        hasKeys={hasKeys}
        model={model}
        thinkingEffort={thinkingEffort}
        webSearchEnabled={webSearchEnabled}
        enabledPlugins={enabledPlugins}
        sidebarOpen={sidebarOpen}
        onSend={sendMessage}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onNewChat={startNewChat}
        onToggleSearch={() => setWebSearchEnabled(!webSearchEnabled)}
        onSetThinkingEffort={setThinkingEffort}
        onSetModel={setModel}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPlugins={() => setShowPlugins(true)}
      />

      {/* Modals */}
      {showSettings && (
        <SettingsModal
          deepseekKey={deepseekKey}
          tavilyKey={tavilyKey}
          model={model}
          defaultEffort={thinkingEffort}
          onDeepseekKeyChange={setDeepseekKey}
          onTavilyKeyChange={setTavilyKey}
          onModelChange={setModel}
          onDefaultEffortChange={setThinkingEffort}
          onClose={() => setShowSettings(false)}
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
