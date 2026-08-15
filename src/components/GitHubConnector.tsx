"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Repo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

interface Connection {
  repo: string;
  baseBranch: string;
  workingBranch: string;
}

export function GitHubConnector({
  workspaceId,
  onClose,
  onConnected,
}: {
  workspaceId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [configured, setConfigured] = useState(true);
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [statusRes, connectionRes] = await Promise.all([
        fetch("/api/github/status"),
        fetch(`/api/github/connection?workspaceId=${encodeURIComponent(workspaceId)}`),
      ]);
      const status = await statusRes.json();
      const connectedRepo = await connectionRes.json();
      setConfigured(status.configured !== false);
      setConnected(status.connected === true);
      setLogin(status.user?.login ?? "");
      setConnection(connectedRepo.connection ?? null);
      if (status.connected) {
        const repoRes = await fetch("/api/github/repos");
        const repoData = await repoRes.json();
        if (!repoRes.ok) throw new Error(repoData.error ?? "Could not list repositories");
        setRepos(repoData.repos ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load GitHub");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.data?.type === "apim-github-connected"
      ) {
        void load();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [load]);

  const connectAccount = () => {
    const popup = window.open(
      "/api/github/oauth/start?popup=1",
      "apim-github-oauth",
      "popup,width=720,height=760"
    );
    if (!popup) window.location.href = "/api/github/oauth/start";
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? repos.filter((repo) => repo.fullName.toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  const choose = async (repo: Repo) => {
    setSelected(repo);
    setBranch(repo.defaultBranch);
    setBranches([]);
    setError("");
    try {
      const res = await fetch(
        `/api/github/branches?repo=${encodeURIComponent(repo.fullName)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not list branches");
      setBranches(data.branches ?? []);
      if (!(data.branches ?? []).includes(repo.defaultBranch) && data.branches?.[0]) {
        setBranch(data.branches[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not list branches");
    }
  };

  const connectRepo = async () => {
    if (!selected || !branch || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/github/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          repo: selected.fullName,
          baseBranch: branch,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not connect repository");
      setConnection(data.connection);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect repository");
    } finally {
      setBusy(false);
    }
  };

  const disconnectAccount = async () => {
    await fetch("/api/github/status", { method: "DELETE" });
    setConnected(false);
    setRepos([]);
    setSelected(null);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} aria-label="Close GitHub connector" />
      <div className="relative flex h-[min(82vh,42rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl">
        <div className="flex h-[56px] flex-none items-center justify-between border-b border-border px-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">GitHub</h2>
            <p className="text-[11px] text-text-muted">Choose a repository and base branch</p>
          </div>
          <button onClick={onClose} className="sidebar-icon-btn h-8 w-8" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="py-16 text-center text-[13px] text-text-muted">Loading GitHub…</p>
          ) : !configured ? (
            <div className="rounded-xl border border-warning/30 bg-warning/8 p-4 text-[13px] leading-5 text-text-secondary">
              GitHub OAuth is not configured. Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code>, then restart apiM.
            </div>
          ) : !connected ? (
            <div className="flex flex-col items-center py-16 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-primary">
                <GitHubMark />
              </div>
              <h3 className="text-[15px] font-semibold text-text-primary">Connect your GitHub account</h3>
              <p className="mt-1 max-w-sm text-[12px] leading-5 text-text-muted">Repositories remain normal workspace files. Credentials stay in an encrypted HttpOnly cookie and are never exposed to the agent.</p>
              <button onClick={connectAccount} className="mt-5 rounded-lg bg-text-primary px-4 py-2 text-[13px] font-semibold text-bg-primary">Connect GitHub</button>
            </div>
          ) : connection ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-success/30 bg-success/8 p-4">
                <p className="text-[13px] font-semibold text-text-primary">{connection.repo}</p>
                <p className="mt-1 text-[12px] text-text-muted">Base: {connection.baseBranch}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-success">Working branch: {connection.workingBranch}</p>
              </div>
              <p className="text-[12px] leading-5 text-text-muted">The agent can inspect remote branches, edit this workspace, commit after approval, and push only the dedicated working branch with the GitHub push tool.</p>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[12px] text-text-muted">Connected as <span className="text-text-secondary">{login}</span></p>
                <button onClick={disconnectAccount} className="text-[11px] text-text-muted hover:text-danger">Disconnect account</button>
              </div>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a repository…" className="mb-3 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-light" />
              <div className="grid gap-1 sm:grid-cols-2">
                {visible.map((repo) => (
                  <button key={repo.fullName} onClick={() => void choose(repo)} className={`rounded-lg border p-3 text-left transition-colors ${selected?.fullName === repo.fullName ? "border-accent/50 bg-accent/8" : "border-border hover:border-border-light hover:bg-bg-hover"}`}>
                    <p className="truncate text-[13px] font-medium text-text-primary">{repo.fullName}</p>
                    <p className="mt-1 text-[11px] text-text-muted">{repo.private ? "Private" : "Public"} · {repo.defaultBranch}</p>
                  </button>
                ))}
              </div>
              {selected && (
                <div className="mt-4 rounded-xl border border-border bg-bg-primary/50 p-3">
                  <label className="text-[11px] font-medium text-text-secondary">Base branch</label>
                  <select value={branch} onChange={(e) => setBranch(e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary">
                    {(branches.length ? branches : [branch]).map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <p className="mt-2 text-[11px] leading-4 text-text-muted">apiM creates a new dedicated <code>apim/…</code> branch from this base. The base branch is never pushed directly.</p>
                  <button onClick={() => void connectRepo()} disabled={busy || !branch} className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50">{busy ? "Cloning repository…" : "Connect repository"}</button>
                </div>
              )}
            </>
          )}
          {error && <p className="mt-3 rounded-lg border border-danger/25 bg-danger/8 px-3 py-2 text-[12px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function GitHubMark() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .7a11.5 11.5 0 00-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 016 0C17.6 4.7 18.6 5 18.6 5c.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3c0 .4.2.7.8.6A11.5 11.5 0 0012 .7z" /></svg>;
}
