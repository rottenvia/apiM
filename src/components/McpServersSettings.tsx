"use client";

import { useCallback, useEffect, useState } from "react";

interface McpServerPublic {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  enabled: boolean;
}

interface TestState {
  status: "idle" | "testing" | "ok" | "error";
  message: string;
}

const inputClass =
  "w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all";

/**
 * MCP servers: where the AI's remote tools come from.
 *
 * Self-contained: it talks to /api/mcp directly and keeps no state in the
 * page. Tokens are write-only — the list endpoint never returns them, so
 * the form shows only whether one is set, and saving with an empty token
 * field keeps the stored one.
 */
export function McpServersSettings() {
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle", message: "" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/servers");
      if (res.ok) setServers((await res.json()) as McpServerPublic[]);
    } catch {
      // A failed refresh leaves the last known list in place.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  const openAdd = () => {
    setEditingId(null);
    setName("");
    setUrl("http://127.0.0.1:8225/mcp");
    setToken("");
    setFormError("");
    setTest({ status: "idle", message: "" });
    setFormOpen(true);
  };

  const openEdit = (server: McpServerPublic) => {
    setEditingId(server.id);
    setName(server.name);
    setUrl(server.url);
    setToken("");
    setFormError("");
    setTest({ status: "idle", message: "" });
    setFormOpen(true);
  };

  const runTest = async () => {
    setTest({ status: "testing", message: "Connecting…" });
    try {
      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editingId && !token
            ? { serverId: editingId }
            : { url, token: token ? token : undefined }
        ),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        server?: { name: string };
        tools?: { name: string }[];
      };
      if (body.ok) {
        const names = (body.tools ?? []).map((t) => t.name).join(", ");
        setTest({
          status: "ok",
          message: `Connected to ${body.server?.name ?? "server"} — ${body.tools?.length ?? 0} tool(s): ${names || "none listed"}`,
        });
      } else {
        setTest({ status: "error", message: body.error ?? "Connection failed." });
      }
    } catch {
      setTest({ status: "error", message: "Connection failed." });
    }
  };

  const save = async () => {
    setFormError("");
    setSaving(true);
    try {
      const payload = editingId
        ? { name, url, enabled: true, ...(token ? { token } : {}) }
        : { name, url, token };
      const res = await fetch(
        editingId ? `/api/mcp/servers/${editingId}` : "/api/mcp/servers",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setFormError(body.error ?? "Could not save.");
        return;
      }
      setFormOpen(false);
      await refresh();
    } catch {
      setFormError("Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
    await refresh();
  };

  const toggle = async (server: McpServerPublic) => {
    await fetch(`/api/mcp/servers/${server.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: server.name,
        url: server.url,
        enabled: !server.enabled,
      }),
    });
    await refresh();
  };

  if (!loaded) {
    return <p className="text-sm text-text-muted">Loading MCP servers…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">
        MCP servers lend the AI extra tools — a Roblox bridge, a database, a
        search box. Enabled servers&apos; tools appear in its tool list, and
        every call asks your permission first.
      </p>

      {servers.map((server) => (
        <div
          key={server.id}
          className="rounded-xl border border-border bg-bg-tertiary px-4 py-3"
        >
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={server.enabled}
              aria-label={`Enable ${server.name}`}
              onClick={() => void toggle(server)}
              className={`relative h-5 w-9 flex-none rounded-full transition-colors ${
                server.enabled ? "bg-accent" : "bg-border"
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                  server.enabled ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-primary">
                {server.name}
              </p>
              <p className="truncate font-mono text-[12px] text-text-muted">
                {server.url}
                {server.hasToken ? " · token set" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openEdit(server)}
              className="flex-none rounded-lg px-2.5 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => void remove(server.id)}
              className="flex-none rounded-lg px-2.5 py-1.5 text-[12px] text-danger/80 transition-colors hover:bg-danger/10 hover:text-danger"
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {servers.length === 0 && !formOpen && (
        <p className="text-sm text-text-muted">
          No MCP servers yet. Add one to give the AI remote tools.
        </p>
      )}

      {formOpen ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent/30 bg-accent/[0.04] p-4">
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-text-primary">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Potassium"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-text-primary">
              Endpoint URL
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:8225/mcp"
              className={`${inputClass} font-mono`}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-text-primary">
              Bearer token
              {editingId && (
                <span className="ml-1 text-xs font-normal text-text-muted">
                  (leave empty to keep the stored one)
                </span>
              )}
            </label>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={editingId ? "••••••" : "paste the server token"}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-text-secondary"
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {formError && (
            <p role="alert" className="text-[13px] text-danger">
              {formError}
            </p>
          )}
          {test.status !== "idle" && (
            <p
              role="status"
              className={`text-[13px] ${
                test.status === "ok"
                  ? "text-success"
                  : test.status === "error"
                    ? "text-danger"
                    : "text-text-muted"
              }`}
            >
              {test.message}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving || !name.trim() || !url.trim()}
              onClick={() => void save()}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-light disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Add server"}
            </button>
            <button
              type="button"
              disabled={test.status === "testing" || !url.trim()}
              onClick={() => void runTest()}
              className="rounded-xl border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {test.status === "testing" ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-xl px-3 py-2 text-sm text-text-muted transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openAdd}
          className="w-fit rounded-xl border border-dashed border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
        >
          + Add MCP server
        </button>
      )}
    </div>
  );
}
