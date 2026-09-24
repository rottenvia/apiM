"use client";

import { useEffect, useState } from "react";

interface McpServerPublic {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  enabled: boolean;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

interface CallResult {
  ok: boolean;
  content: string;
  summary: string;
}

const inputClass =
  "w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all";

/**
 * Manual MCP console: pick a server, pick a tool, write the arguments,
 * call it, read what came back. The agent path needs nothing here — this
 * is for quick pokes (run a script, read the console) without spending
 * a model round on them.
 */
export function McpConsole({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [serverId, setServerId] = useState("");
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [toolName, setToolName] = useState("");
  const [args, setArgs] = useState("{\n  \n}");
  const [toolsError, setToolsError] = useState("");
  const [loadingTools, setLoadingTools] = useState(false);
  const [calling, setCalling] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/mcp/servers");
        if (!res.ok) return;
        const list = (await res.json()) as McpServerPublic[];
        setServers(list);
        if (list.length > 0) setServerId(list[0].id);
      } catch {
        // The empty state below explains itself.
      }
    })();
  }, []);

  useEffect(() => {
    // No server yet (or none configured): the initial empty state already
    // says that, so there is nothing to reset.
    if (!serverId) return;
    void (async () => {
      setLoadingTools(true);
      setToolsError("");
      setResult(null);
      try {
        const res = await fetch("/api/mcp/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId }),
        });
        const body = (await res.json()) as {
          ok: boolean;
          error?: string;
          tools?: McpToolInfo[];
        };
        if (!body.ok) {
          setTools([]);
          setToolName("");
          setToolsError(body.error ?? "Could not reach the server.");
          return;
        }
        const list = body.tools ?? [];
        setTools(list);
        setToolName(list.length > 0 ? list[0].name : "");
      } catch {
        setTools([]);
        setToolName("");
        setToolsError("Could not reach the server.");
      } finally {
        setLoadingTools(false);
      }
    })();
  }, [serverId]);

  const tool = tools.find((t) => t.name === toolName) ?? null;

  const call = async () => {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(args) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not an object");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      setResult({
        ok: false,
        content: "Arguments must be a JSON object.",
        summary: "Arguments must be a JSON object.",
      });
      return;
    }
    setCalling(true);
    setResult(null);
    try {
      const res = await fetch("/api/mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, tool: toolName, args: parsed }),
      });
      const body = (await res.json()) as CallResult & { error?: string };
      if (!res.ok && body.error) {
        setResult({ ok: false, content: body.error, summary: body.error });
      } else {
        setResult({
          ok: body.ok,
          content: body.content ?? "",
          summary: body.summary ?? "",
        });
      }
    } catch {
      setResult({
        ok: false,
        content: "The call failed before reaching the server.",
        summary: "The call failed before reaching the server.",
      });
    } finally {
      setCalling(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MCP console"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-text-primary">
              MCP console
            </h2>
            <p className="truncate text-xs text-text-muted">
              Call a server&apos;s tools by hand — no model round spent
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-none rounded-lg px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          {servers.length === 0 ? (
            <p className="text-sm text-text-muted">
              No MCP servers configured. Add one in Settings → MCP servers
              first.
            </p>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-text-primary">
                  Server
                </label>
                <select
                  value={serverId}
                  onChange={(e) => setServerId(e.target.value)}
                  className={`${inputClass} cursor-pointer`}
                >
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.url}
                    </option>
                  ))}
                </select>
              </div>

              {loadingTools ? (
                <p className="text-sm text-text-muted">Listing tools…</p>
              ) : toolsError ? (
                <p role="alert" className="text-[13px] text-danger">
                  {toolsError}
                </p>
              ) : (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-text-primary">
                      Tool
                    </label>
                    <select
                      value={toolName}
                      onChange={(e) => setToolName(e.target.value)}
                      className={`${inputClass} cursor-pointer`}
                    >
                      {tools.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {tool?.description && (
                      <p className="mt-1.5 text-xs text-text-secondary">
                        {tool.description}
                      </p>
                    )}
                  </div>

                  {tool?.inputSchema && (
                    <details className="rounded-xl border border-border bg-bg-tertiary px-4 py-2.5">
                      <summary className="cursor-pointer text-[13px] text-text-secondary">
                        Expected arguments
                      </summary>
                      <pre className="mt-2 overflow-x-auto font-mono text-[12px] text-text-secondary">
                        {JSON.stringify(tool.inputSchema, null, 2)}
                      </pre>
                    </details>
                  )}

                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-text-primary">
                      Arguments (JSON)
                    </label>
                    <textarea
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      rows={5}
                      spellCheck={false}
                      className={`${inputClass} font-mono`}
                    />
                  </div>

                  <button
                    type="button"
                    disabled={calling || !toolName}
                    onClick={() => void call()}
                    className="w-fit rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {calling ? "Calling…" : "Call tool"}
                  </button>

                  {result && (
                    <div
                      className={`rounded-xl border px-4 py-3 ${
                        result.ok
                          ? "border-border bg-bg-tertiary"
                          : "border-danger/30 bg-danger/[0.06]"
                      }`}
                    >
                      <p
                        className={`mb-1.5 text-[13px] font-medium ${
                          result.ok ? "text-text-primary" : "text-danger"
                        }`}
                      >
                        {result.ok ? "Result" : "Failed"}
                      </p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-text-secondary">
                        {result.content}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
