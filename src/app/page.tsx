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

  // Load conversations
  useEffect(() => {
    fetch("/api/conversations")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setConversations(data);
      })
      .catch(() => {});
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setCurrentConvId(id);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
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

        const data = await res.json();

        if (!res.ok) {
          const errorMsg: Message = {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: `⚠️ Error: ${data.error || "Unknown error occurred"}`,
          };
          setMessages((prev) => [...prev, errorMsg]);
          return;
        }

        const assistantMsg: Message = {
          id: data.id,
          role: "assistant",
          content: data.content,
          reasoningContent: data.reasoningContent,
          thinkingEffort: data.resolvedEffort,
          webSearchUsed: data.webSearchUsed,
          searchResults: data.searchResults,
          searchQueries: data.searchQueries,
          searchesPerformed: data.searchesPerformed,
          pluginsUsed: data.pluginsUsed,
          tokenCount: data.usage?.total_tokens,
        };

        setMessages((prev) => [...prev, assistantMsg]);

        // Update conversation
        if (!currentConvId && data.conversationId) {
          setCurrentConvId(data.conversationId);
          setConversations((prev) => [
            {
              id: data.conversationId,
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
        const errorMsg: Message = {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `⚠️ Network error: ${err instanceof Error ? err.message : "Connection failed"}`,
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
