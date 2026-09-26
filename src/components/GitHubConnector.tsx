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
  prUrl?: string;
  prNumber?: number;
  prBranch?: string;
}

interface PullRequest {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  title: string;
  mergeable: boolean | null;
  checks: { total: number; passed: number; failed: number; pending: number };
  reviewComments: number;
}

interface PrInfo {
  pr: PullRequest | null;
  stored: { number?: number; url: string } | null;
  suggestion: { title: string; body: string; commits: number } | null;
}

interface FileChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "C";
  additions: number;
  deletions: number;
}

interface Changes {
  /** Latest stored connection — the agent may have switched branches. */
  connection?: Connection | null;
  ahead: number;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  diff: string;
  uncommitted: number;
}

const patKey = "nexusai-github-pat";

function readStoredPat(): string {
  try {
    return (localStorage.getItem(patKey) ?? "").trim();
  } catch {
    return "";
  }
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
  // Personal Access Token: the no-OAuth way to connect, kept behind an
  // "advanced" disclosure. The primary path is the GitHub sign-in button.
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  // Changes review for a connected project.
  const [changes, setChanges] = useState<Changes | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  // Connecting: start a fresh apim/ branch or continue an existing one.
  const [branchMode, setBranchMode] = useState<"new" | "continue">("new");
  const [task, setTask] = useState("");
  const [continueBranch, setContinueBranch] = useState("");
  // Pull request for the working branch.
  const [prInfo, setPrInfo] = useState<PrInfo | null>(null);
  const [prFormOpen, setPrFormOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prDraft, setPrDraft] = useState(false);

  const authHeaders = useCallback(
    (): Record<string, string> => {
      const token = pat.trim() || readStoredPat();
      return token ? { "x-github-token": token } : {};
    },
    [pat]
  );

  const loadChanges = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/github/changes?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as Changes;
      setChanges(data);
    } catch {
      /* cosmetic — the panel stays usable without it */
    }
  }, [workspaceId]);

  // PR state hits the GitHub API, so it is loaded on open and after actions
  // rather than on the 5-second changes poll.
  const loadPr = useCallback(async () => {
    try {
      const token = readStoredPat();
      const res = await fetch(
        `/api/github/pr?workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers: token ? { "x-github-token": token } : {} }
      );
      if (!res.ok) return;
      setPrInfo((await res.json()) as PrInfo);
    } catch {
      /* cosmetic */
    }
  }, [workspaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const token = readStoredPat();
    if (token) setPat(token);
    try {
      const [statusRes, connectionRes] = await Promise.all([
        fetch("/api/github/status", {
          headers: token ? { "x-github-token": token } : {},
        }),
        fetch(
          `/api/github/connection?workspaceId=${encodeURIComponent(workspaceId)}`
        ),
      ]);
      const status = await statusRes.json();
      const connectedRepo = await connectionRes.json();
      setOauthAvailable(status.oauth === true);
      setConfigured(status.configured !== false || Boolean(token));
      setConnected(status.connected === true);
      setLogin(status.user?.login ?? "");
      setConnection(connectedRepo.connection ?? null);
      if (connectedRepo.connection) {
        void loadChanges();
        void loadPr();
      }
      if (status.connected) {
        const repoRes = await fetch("/api/github/repos", {
          headers: token ? { "x-github-token": token } : {},
        });
        const repoData = await repoRes.json();
        if (!repoRes.ok) throw new Error(repoData.error ?? "Could not list repositories");
        setRepos(repoData.repos ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load GitHub");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, loadChanges, loadPr]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  // Refresh the change summary whenever the modal is open and files change.
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => void loadChanges(), 5000);
    return () => clearInterval(timer);
  }, [connection, loadChanges]);

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

  // The Arena-style flow: a single button that hands you to GitHub, comes
  // back signed in, and lands you on the repository list.
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
    setContinueBranch("");
    setError("");
    try {
      const res = await fetch(
        `/api/github/branches?repo=${encodeURIComponent(repo.fullName)}`,
        { headers: authHeaders() }
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

  const savePatAndConnect = async () => {
    const token = pat.trim();
    setError("");
    if (!token) {
      setError("Paste a GitHub Personal Access token first.");
      return;
    }
    setBusy(true);
    try {
      const statusRes = await fetch("/api/github/status", {
        headers: { "x-github-token": token },
      });
      const status = await statusRes.json();
      if (!status.connected) {
        throw new Error("That token did not authenticate with GitHub. Check it has the repo scope.");
      }
      localStorage.setItem(patKey, token);
      setLogin(status.user?.login ?? "GitHub user");
      setConnected(true);
      const repoRes = await fetch("/api/github/repos", {
        headers: { "x-github-token": token },
      });
      const repoData = await repoRes.json();
      if (!repoRes.ok) throw new Error(repoData.error ?? "Could not list repositories");
      setRepos(repoData.repos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify the token");
    } finally {
      setBusy(false);
    }
  };

  const connectRepo = async () => {
    if (!selected || !branch || busy) return;
    if (branchMode === "continue" && !continueBranch) {
      setError("Pick the branch to continue.");
      return;
    }
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
          token: pat.trim() || readStoredPat() || undefined,
          ...(branchMode === "continue"
            ? { continueBranch }
            : { task: task.trim() || undefined }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not connect repository");
      setConnection(data.connection);
      await loadChanges();
      void loadPr();
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect repository");
    } finally {
      setBusy(false);
    }
  };

  const openPrForm = () => {
    setPrTitle(prInfo?.suggestion?.title ?? "");
    setPrBody(prInfo?.suggestion?.body ?? "");
    setPrFormOpen(true);
  };

  // The click is the approval: pushes the working branch if needed, then
  // opens the PR (or returns the one that already exists).
  const createPr = async () => {
    if (!prTitle.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/github/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          title: prTitle.trim(),
          body: prBody,
          draft: prDraft,
          token: pat.trim() || readStoredPat() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not open the pull request");
      setPrFormOpen(false);
      await Promise.all([loadPr(), loadChanges()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the pull request");
    } finally {
      setBusy(false);
    }
  };

  // Turn the project link OFF (files stay put; nothing more is pushed), or
  // back ON by reconnecting.
  const disconnectProject = async () => {
    setBusy(true);
    try {
      await fetch(
        `/api/github/connection?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" }
      );
      setConnection(null);
      setChanges(null);
      setPrInfo(null);
      setSelected(null);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  };

  const disconnectAccount = async () => {
    await fetch("/api/github/status", { method: "DELETE" });
    try {
      localStorage.removeItem(patKey);
    } catch {
      /* private mode etc. */
    }
    setPat("");
    setConnected(false);
    setRepos([]);
    setSelected(null);
  };

  // The agent can switch branches mid-run; the changes poll carries the
  // latest stored connection, so the header follows it.
  const view: Connection | null = connection ? changes?.connection ?? connection : null;
  const pr = prInfo?.pr ?? null;
  const prLink =
    pr?.url ??
    prInfo?.stored?.url ??
    (view?.prUrl && view.prBranch === view.workingBranch ? view.prUrl : "");
  const prNumber = pr?.number ?? prInfo?.stored?.number ?? view?.prNumber;
  const prState = pr ? (pr.draft && pr.state === "open" ? "draft" : pr.state) : "open";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} aria-label="Close GitHub connector" />
      <div className="relative flex h-[min(85vh,44rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl">
        <div className="flex h-[56px] flex-none items-center justify-between border-b border-border px-4">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">GitHub</h2>
            <p className="text-[11px] text-text-muted">
              {connection ? "Connected project" : "Connect a repository to this chat"}
            </p>
          </div>
          <button onClick={onClose} className="sidebar-icon-btn h-8 w-8" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="py-16 text-center text-[13px] text-text-muted">Loading GitHub…</p>
          ) : connection && view ? (
            /* ---------------- Connected: on/off toggle + changes review ---------------- */
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-tertiary/50 p-4">
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-text-primary">
                    <span className="truncate">{view.repo}</span>
                    <span className="flex-none text-text-muted">·</span>
                    <span className="truncate font-mono text-[13px] text-success">{view.workingBranch}</span>
                    {changes && changes.ahead > 0 && (
                      <span
                        className="flex-none rounded-full bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent-light"
                        title={`${changes.ahead} commit${changes.ahead === 1 ? "" : "s"} ahead of ${view.baseBranch}`}
                      >
                        ↑{changes.ahead}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-[12px] text-text-muted">
                    Base <span className="font-mono">{view.baseBranch}</span>
                  </p>
                  {prLink && (
                    <a
                      href={prLink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-light hover:underline"
                    >
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold capitalize ${
                          prState === "merged"
                            ? "bg-accent/15 text-accent-light"
                            : prState === "closed"
                            ? "bg-danger/10 text-danger"
                            : prState === "draft"
                            ? "bg-bg-hover text-text-muted"
                            : "bg-success/10 text-success"
                        }`}
                      >
                        {prState}
                      </span>
                      Pull request{prNumber ? ` #${prNumber}` : ""}
                    </a>
                  )}
                </div>
                <div className="flex flex-none flex-col items-end gap-2">
                  <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    On
                  </span>
                  <button
                    onClick={() => void disconnectProject()}
                    disabled={busy}
                    className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary hover:border-danger/40 hover:text-danger disabled:opacity-50"
                  >
                    Turn off
                  </button>
                </div>
              </div>

              {/* What exactly changes vs the base branch. */}
              <div className="overflow-hidden rounded-xl border border-border">
                <button
                  onClick={() => {
                    setChangesOpen((v) => !v);
                    if (!changesOpen) void loadChanges();
                  }}
                  className="flex w-full items-center justify-between gap-2 bg-bg-tertiary/40 px-4 py-3 text-left"
                >
                  <span className="text-[13px] font-semibold text-text-primary">
                    Changes vs {view.baseBranch}
                  </span>
                  {changes && changes.files.length > 0 ? (
                    <span className="flex items-center gap-2 text-[12px]">
                      <span className="text-green-400">+{changes.totalAdditions}</span>
                      <span className="text-red-400">−{changes.totalDeletions}</span>
                      <svg
                        width="12" height="12" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth={2.4}
                        className={`text-text-muted transition-transform ${changesOpen ? "rotate-90" : ""}`}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </span>
                  ) : (
                    <span className="text-[12px] text-text-muted">
                      {changes ? "no changes yet" : "…"}
                    </span>
                  )}
                </button>

                {changesOpen && (
                  <div className="border-t border-border">
                    {changes && changes.files.length > 0 ? (
                      <>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-text-muted">
                          <span>{changes.files.length} changed file{changes.files.length === 1 ? "" : "s"}</span>
                          <span>{changes.ahead} commit{changes.ahead === 1 ? "" : "s"} ahead</span>
                          {changes.uncommitted > 0 && (
                            <span className="text-warning">
                              {changes.uncommitted} uncommitted edit{changes.uncommitted === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                        <div className="max-h-56 overflow-y-auto">
                          {changes.files.map((f) => (
                            <div
                              key={f.path}
                              className="flex items-center gap-2 px-4 py-1.5 font-mono text-[12px] odd:bg-bg-tertiary/20"
                            >
                              <span
                                className={`flex h-4 w-4 flex-none items-center justify-center rounded text-[9px] font-bold ${
                                  f.status === "A"
                                    ? "bg-green-500/15 text-green-400"
                                    : f.status === "D"
                                    ? "bg-red-500/15 text-red-400"
                                    : "bg-accent/15 text-accent-light"
                                }`}
                              >
                                {f.status}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-text-secondary">
                                {f.path}
                              </span>
                              <span className="flex-none text-green-400">+{f.additions}</span>
                              <span className="flex-none text-red-400">−{f.deletions}</span>
                            </div>
                          ))}
                        </div>
                        {changes.diff && (
                          <div className="border-t border-border">
                            <button
                              onClick={() => setDiffOpen((v) => !v)}
                              className="w-full px-4 py-2 text-left text-[12px] font-medium text-accent-light hover:underline"
                            >
                              {diffOpen ? "Hide full diff" : "View full diff"}
                            </button>
                            {diffOpen && (
                              <pre className="max-h-72 overflow-auto bg-bg-primary/60 px-4 py-2 font-mono text-[11px] leading-[1.5] text-text-secondary">
                                {changes.diff}
                              </pre>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="px-4 py-6 text-center text-[12px] text-text-muted">
                        Nothing differs from {view.baseBranch} yet. Edits the agent
                        makes show up here, and pushes go only to{" "}
                        <span className="font-mono">{view.workingBranch}</span>.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Pull request: status once it exists, otherwise a create form. */}
              <div className="overflow-hidden rounded-xl border border-border">
                {pr ? (
                  <div className="flex items-center justify-between gap-3 bg-bg-tertiary/40 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-text-primary">
                        #{pr.number} {pr.title}
                      </p>
                      <p className="mt-0.5 text-[11px] text-text-muted">
                        {pr.checks.total === 0
                          ? "No checks reported"
                          : `Checks: ${pr.checks.passed} passed · ${pr.checks.failed} failed · ${pr.checks.pending} pending`}
                        {pr.mergeable === false ? " · not mergeable" : ""}
                        {pr.reviewComments > 0
                          ? ` · ${pr.reviewComments} review comment${pr.reviewComments === 1 ? "" : "s"}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-2">
                      <button
                        onClick={() => void loadPr()}
                        className="rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary hover:border-border-light hover:text-text-primary"
                      >
                        Refresh
                      </button>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-semibold text-white"
                      >
                        Open
                      </a>
                    </div>
                  </div>
                ) : !prFormOpen ? (
                  <div className="flex items-center justify-between gap-3 bg-bg-tertiary/40 px-4 py-3">
                    <span className="text-[12px] text-text-muted">
                      {changes && changes.ahead > 0
                        ? `${changes.ahead} commit${changes.ahead === 1 ? "" : "s"} ready for review`
                        : "Commit work to open a pull request"}
                    </span>
                    <button
                      onClick={openPrForm}
                      disabled={busy || !changes || changes.ahead === 0}
                      className="flex-none rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                    >
                      Create pull request
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 p-3">
                    <p className="text-[11px] text-text-muted">
                      <span className="font-mono">{view.workingBranch}</span> →{" "}
                      <span className="font-mono">{view.baseBranch}</span>. The branch is pushed first if needed.
                    </p>
                    <input
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="Pull request title"
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-light"
                    />
                    <textarea
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                      rows={6}
                      placeholder="What changed and how it was tested"
                      className="w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-[12px] text-text-primary outline-none focus:border-border-light"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
                        <input
                          type="checkbox"
                          checked={prDraft}
                          onChange={(e) => setPrDraft(e.target.checked)}
                        />
                        Draft
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setPrFormOpen(false)}
                          className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void createPr()}
                          disabled={busy || !prTitle.trim()}
                          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                        >
                          {busy ? "Opening…" : "Create pull request"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-[12px] leading-5 text-text-muted">
                The agent commits on the working branch, merges the latest{" "}
                <span className="font-mono">{view.baseBranch}</span> when behind, and —
                only after you approve — pushes it and opens a pull request. The base
                branch is never pushed or force-pushed. Turning off keeps all your files.
              </p>
            </div>
          ) : !connected ? (
            /* ---------------- Signed out: one primary button + PAT fallback ---------------- */
            <div className="space-y-4">
              <div className="flex flex-col items-center py-8 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-primary">
                  <GitHubMark />
                </div>
                <h3 className="text-[15px] font-semibold text-text-primary">Connect GitHub</h3>
                <p className="mt-1 max-w-sm text-[12px] leading-5 text-text-muted">
                  Click below, authorize apiM on GitHub, and pick a repository and
                  branch. The repo is cloned into this workspace and the agent pushes
                  only a dedicated <code>apim/…</code> branch.
                </p>
              </div>

              {oauthAvailable ? (
                <button
                  onClick={connectAccount}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-4 py-3 text-[15px] font-semibold text-bg-primary transition-opacity hover:opacity-90"
                >
                  <GitHubMark light />
                  Continue with GitHub
                </button>
              ) : (
                <div className="rounded-xl border border-warning/30 bg-warning/8 p-3 text-[12px] leading-5 text-text-secondary">
                  This apiM instance has no GitHub OAuth app registered. Use a Personal
                  Access Token below{configured ? ", or ask the host to set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET" : ""}.
                </div>
              )}

              {/* PAT path, tucked away as the advanced/self-host option. */}
              <div className="rounded-xl border border-border">
                <button
                  onClick={() => setShowPat((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-medium text-text-secondary hover:text-text-primary"
                >
                  <span>Use a Personal Access Token instead</span>
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth={2.4}
                    className={`text-text-muted transition-transform ${showPat ? "rotate-90" : ""}`}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {showPat && (
                  <div className="border-t border-border p-3">
                    <p className="text-[11px] leading-4 text-text-muted">
                      GitHub → Settings → Developer settings → Personal access tokens →
                      Fine-grained, with <b>Contents: read &amp; write</b> on the repos
                      you want.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="password"
                        value={pat}
                        onChange={(e) => setPat(e.target.value)}
                        placeholder="github_pat_… or ghp_…"
                        autoComplete="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 font-mono text-[12px] text-text-primary outline-none focus:border-border-light"
                      />
                      <button
                        onClick={() => void savePatAndConnect()}
                        disabled={busy}
                        className="flex-none rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
                      >
                        {busy ? "Verifying…" : "Verify"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ---------------- Signed in: choose repository + branch ---------------- */
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[12px] text-text-muted">
                  Connected as <span className="text-text-secondary">{login}</span>
                </p>
                <button onClick={disconnectAccount} className="text-[11px] text-text-muted hover:text-danger">
                  Sign out
                </button>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a repository…"
                className="mb-3 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-light"
              />
              <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
                {visible.map((repo) => (
                  <button
                    key={repo.fullName}
                    onClick={() => void choose(repo)}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      selected?.fullName === repo.fullName
                        ? "border-accent/50 bg-accent/8"
                        : "border-border hover:border-border-light hover:bg-bg-hover"
                    }`}
                  >
                    <p className="truncate text-[13px] font-medium text-text-primary">{repo.fullName}</p>
                    <p className="mt-1 text-[11px] text-text-muted">
                      {repo.private ? "Private" : "Public"} · {repo.defaultBranch}
                    </p>
                  </button>
                ))}
                {visible.length === 0 && (
                  <p className="col-span-2 py-6 text-center text-[12px] text-text-muted">
                    No repositories match.
                  </p>
                )}
              </div>
              {selected && (
                <div className="mt-4 rounded-xl border border-border bg-bg-primary/50 p-3">
                  <label className="text-[11px] font-medium text-text-secondary">Base branch</label>
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary"
                  >
                    {(branches.length ? branches : [branch]).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg border border-border bg-bg-tertiary p-0.5">
                    {(["new", "continue"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setBranchMode(mode)}
                        className={`rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors ${
                          branchMode === mode
                            ? "bg-bg-secondary text-text-primary shadow-sm"
                            : "text-text-muted hover:text-text-secondary"
                        }`}
                      >
                        {mode === "new" ? "New branch" : "Continue existing branch"}
                      </button>
                    ))}
                  </div>
                  {branchMode === "new" ? (
                    <>
                      <input
                        value={task}
                        onChange={(e) => setTask(e.target.value)}
                        placeholder="What is this work? (names the branch, optional)"
                        className="mt-2 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-light"
                      />
                      <p className="mt-2 text-[11px] leading-4 text-text-muted">
                        apiM branches off {branch || "the base"} into a dedicated{" "}
                        <code>apim/…</code> branch. The base branch is never pushed directly.
                      </p>
                    </>
                  ) : (
                    <>
                      <select
                        value={continueBranch}
                        onChange={(e) => setContinueBranch(e.target.value)}
                        className="mt-2 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary"
                      >
                        <option value="">Choose a branch to continue…</option>
                        {branches
                          .filter((name) => name !== branch)
                          .map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                      </select>
                      <p className="mt-2 text-[11px] leading-4 text-text-muted">
                        The branch is checked out tracking origin; commits and pull requests
                        continue on it, targeting {branch || "the base"}.
                      </p>
                    </>
                  )}
                  <button
                    onClick={() => void connectRepo()}
                    disabled={busy || !branch || (branchMode === "continue" && !continueBranch)}
                    className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? "Cloning repository…" : `Connect ${selected.fullName}`}
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="mt-3 rounded-lg border border-danger/25 bg-danger/8 px-3 py-2 text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function GitHubMark({ light = false }: { light?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={light ? "text-bg-primary" : ""}>
      <path d="M12 .7a11.5 11.5 0 00-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 016 0C17.6 4.7 18.6 5 18.6 5c.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3c0 .4.2.7.8.6A11.5 11.5 0 0012 .7z" />
    </svg>
  );
}
