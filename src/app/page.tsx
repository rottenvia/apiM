"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatArea } from "@/components/ChatArea";
import { SettingsModal } from "@/components/SettingsModal";
import { PluginsModal } from "@/components/PluginsModal";

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
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

  // Load conversations. Guard against non-JSON responses (HTML error pages)
  // so a misconfigured backend degrades to "no history" instead of throwing.
  useEffect(() => {
    fetch("/api/conversations")
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : null))
      .then((data) => {
        if (Array.isArray(data)) setConversations(data as Conversation[]);
      })
      .catch(() => {});
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setCurrentConvId(id);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) {
        setMessages(
          data.map((m: Record<string, unknown>) => ({
            id: m.id as string,
            role: m.role as "user" | "assistant",
            content: m.content as string,
            reasoningContent: m.reasoning_content as string | null | undefined,
            thinkingEffort: m.thinking_effort as string | undefined,
            webSearchUsed: m.web_search_used as boolean | undefined,
            searchResults: m.search_results
              ? (typeof m.search_results === "string"
                  ? JSON.parse(m.search_results as string)
                  : m.search_results) as { title: string; url: string; domain: string }[] | null
              : null,
            tokenCount: m.token_count as number | undefined,
            createdAt: m.created_at as string | undefined,
          }))
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

  const startNewChat = useCallback(() => {
    setCurrentConvId(null);
    setMessages([]);
  }, []);

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

      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content: content.trim(),
        thinkingEffort,
        webSearchUsed: webSearchEnabled,
      };

      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: content.trim(),
            conversationId: currentConvId,
            deepseekApiKey: deepseekKey,
            tavilyApiKey: tavilyKey,
            model,
            thinkingEffort,
            webSearchEnabled,
            enabledPluginIds: enabledPlugins,
            conversationHistory: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
        });

        // The server can fail before it ever reaches our JSON handlers (e.g.
        // a crashed route returns Next.js' HTML error page, or a proxy returns
        // a gateway page). Parsing that as JSON is what produced the confusing
        // "Unexpected token '<', "<!DOCTYPE "... is not valid JSON" message,
        // so read the body as text first and decide based on the status.
        const raw = await res.text();

        let data: Record<string, unknown> = {};
        let parseFailed = false;
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parseFailed = true;
          }
        }

        if (!res.ok || parseFailed) {
          const serverError =
            typeof data.error === "string" ? data.error : null;

          const content = serverError
            ? `⚠️ ${serverError}`
            : res.status >= 500
              ? `⚠️ The server hit an error (${res.status}). This usually means the app's database or API configuration isn't set up correctly — check the server logs for details.`
              : res.status > 0 && !res.ok
                ? `⚠️ Request failed (${res.status} ${res.statusText || "Error"}).`
                : "⚠️ The server returned an unexpected (non-JSON) response.";

          const errorMsg: Message = {
            id: `err-${Date.now()}`,
            role: "assistant",
            content,
          };
          setMessages((prev) => [...prev, errorMsg]);
          return;
        }

        const payload = data as unknown as ChatResponse;

        const assistantMsg: Message = {
          id: payload.id ?? `msg-${Date.now()}`,
          role: "assistant",
          content: payload.content ?? "",
          reasoningContent: payload.reasoningContent,
          thinkingEffort: payload.resolvedEffort,
          webSearchUsed: payload.webSearchUsed,
          searchResults: payload.searchResults,
          searchQueries: payload.searchQueries,
          searchesPerformed: payload.searchesPerformed,
          pluginsUsed: payload.pluginsUsed,
          tokenCount: payload.usage?.total_tokens,
        };

        setMessages((prev) => [...prev, assistantMsg]);

        // Update conversation
        if (!currentConvId && payload.conversationId) {
          setCurrentConvId(payload.conversationId);
          setConversations((prev) => [
            {
              id: payload.conversationId as string,
              title:
                content.length > 60
                  ? content.substring(0, 57) + "..."
                  : content,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...prev,
          ]);
        }
      } catch (err) {
        // Reaching here means the request itself failed (offline, DNS, CORS,
        // aborted). Response-parsing problems are handled above, so this
        // message is now only ever shown for genuine connectivity issues.
        const errorMsg: Message = {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `⚠️ Couldn't reach the server: ${
            err instanceof Error ? err.message : "connection failed"
          }. Check your connection and try again.`,
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsLoading(false);
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
    ]
  );

  return (
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
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main Chat Area */}
      <ChatArea
        messages={messages}
        isLoading={isLoading}
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
  );
}
