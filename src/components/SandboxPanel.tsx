"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The Sandbox panel: set up (or remove) the private WSL2 Linux the agent uses
 * to run and test things invisibly on this PC.
 *
 * It shows what WSL has, whether the sandbox is installed, and — while a setup
 * or removal runs — the live log and a progress bar. The heavy lifting is all
 * server-side (lib/sandbox-setup); this just drives /api/sandbox and polls.
 */

interface WslDistro {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}
interface SandboxStatus {
  installed: boolean;
  distros: WslDistro[];
  defaultDistro: string | null;
  reason?: string;
  setUp: boolean;
  dir: string;
}
interface SandboxJob {
  kind: "setup" | "remove" | "enable-wsl";
  phase: string;
  progress: number | null;
  log: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  error?: string;
}
interface SandboxState {
  platform: string;
  status: SandboxStatus;
  job: SandboxJob | null;
}

export function SandboxPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SandboxState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sandbox");
      if (!res.ok) return null;
      return (await res.json()) as SandboxState;
    } catch {
      return null; // transient; the next poll retries
    }
  }, []);

  const poll = useCallback(async () => {
    const next = await refresh();
    if (next) setState(next);
  }, [refresh]);

  useEffect(() => {
    // Async IIFE so the setState lands in a callback, not the effect body.
    void (async () => {
      const next = await refresh();
      if (next) setState(next);
    })();
  }, [refresh]);

  // Poll while a job is running, so the log and bar move.
  const jobRunning = Boolean(state?.job && state.job.finishedAt === null);
  useEffect(() => {
    if (!jobRunning) return;
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [jobRunning, poll]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.job?.log]);

  const act = useCallback(
    async (action: "setup" | "remove" | "enable-wsl") => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch("/api/sandbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) setError(data.error ?? "Could not start.");
        await poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        setBusy(false);
      }
    },
    [poll]
  );

  const status = state?.status;
  const job = state?.job;
  const onWindows = state?.platform === "win32";
  const setUp = status?.setUp ?? false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sandbox"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-text-primary">Sandbox</h2>
            <p className="truncate text-xs text-text-muted">
              A private Linux on this PC where the agent can run and test things
              you never see
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

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
          {!state && <p className="text-text-muted">Checking…</p>}

          {state && !onWindows && (
            <div className="rounded-xl border border-border bg-bg-tertiary px-4 py-3 text-text-secondary">
              <p className="font-medium text-text-primary">Windows only</p>
              <p className="mt-1 text-[13px] text-text-muted">
                The WSL2 sandbox runs the app on Windows. This copy is running on{" "}
                <span className="font-mono">{state.platform}</span>, where the
                agent can already run things headlessly without it.
              </p>
            </div>
          )}

          {state && onWindows && (
            <>
              {/* Status line */}
              <div className="rounded-xl border border-border bg-bg-tertiary px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${
                      setUp
                        ? "bg-green-500"
                        : status?.installed
                          ? "bg-amber-500"
                          : "bg-red-500"
                    }`}
                  />
                  <span className="font-medium text-text-primary">
                    {setUp
                      ? "Sandbox ready"
                      : status?.installed
                        ? "WSL is on — sandbox not set up yet"
                        : "WSL is not turned on"}
                  </span>
                </div>
                {status?.reason && !setUp && (
                  <p className="mt-1.5 text-[13px] text-text-muted">{status.reason}</p>
                )}
                {setUp && (
                  <p className="mt-1.5 text-[13px] text-text-muted">
                    The agent can now use <span className="font-mono">sandbox_run</span>{" "}
                    and <span className="font-mono">sandbox_screenshot</span>. Each
                    command still asks you to approve it.
                  </p>
                )}
              </div>

              {/* What it is, once, for the first-time user */}
              {!setUp && !job && (
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-text-secondary">
                  <li>Runs entirely off-screen — no window, never steals focus, fine while gaming.</li>
                  <li>Only this chat&apos;s files are shared in; Windows is sealed off from it.</li>
                  <li>Sets up once (~350&nbsp;MB download). Remove it any time to reclaim the space.</li>
                </ul>
              )}

              {/* Live job */}
              {job && (
                <div className="rounded-xl border border-border bg-bg-primary px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">
                      {job.finishedAt === null
                        ? job.phase
                        : job.ok
                          ? "Finished"
                          : "Failed"}
                    </span>
                    {job.progress !== null && job.finishedAt === null && (
                      <span className="font-mono text-xs text-text-muted">
                        {Math.round(job.progress * 100)}%
                      </span>
                    )}
                  </div>
                  {job.progress !== null && job.finishedAt === null && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                      />
                    </div>
                  )}
                  {job.error && (
                    <p className="mt-2 text-[13px] text-red-400">{job.error}</p>
                  )}
                  {job.log && (
                    <pre
                      ref={logRef}
                      className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-bg-tertiary px-2.5 py-2 font-mono text-[11px] leading-4 text-text-secondary"
                    >
                      {job.log}
                    </pre>
                  )}
                </div>
              )}

              {error && <p className="text-[13px] text-red-400">{error}</p>}

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2">
                {!status?.installed && (
                  <button
                    type="button"
                    disabled={busy || jobRunning}
                    onClick={() => act("enable-wsl")}
                    className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-light disabled:opacity-50"
                  >
                    Turn on WSL
                  </button>
                )}
                {status?.installed && !setUp && (
                  <button
                    type="button"
                    disabled={busy || jobRunning}
                    onClick={() => act("setup")}
                    className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-light disabled:opacity-50"
                  >
                    {jobRunning ? "Setting up…" : "Set up sandbox"}
                  </button>
                )}
                {setUp && (
                  <button
                    type="button"
                    disabled={busy || jobRunning}
                    onClick={() => act("remove")}
                    className="rounded-lg border border-border px-3.5 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                  >
                    {jobRunning ? "Removing…" : "Remove sandbox"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={poll}
                  disabled={jobRunning}
                  className="rounded-lg px-3 py-2 text-[13px] text-text-muted transition-colors hover:text-text-primary disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
