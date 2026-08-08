"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface RunningProcess {
  id: string;
  display: string;
  running: boolean;
  startedAt: number;
  exitCode: number | null;
  stoppedByUser: boolean;
  logTail: string;
}

/**
 * Shows what the assistant left running, and lets the user stop it.
 *
 * Without this a dev server is invisible: it holds a port, keeps consuming
 * CPU, and the only way to find it is Task Manager. The model is supposed to
 * stop what it starts, but "supposed to" is not a guarantee.
 */
export function ProcessDock({
  workspaceId,
  onChanged,
}: {
  workspaceId: string | null;
  /** Called after a stop, so the caller can refresh anything it shows. */
  onChanged?: () => void;
}) {
  const [processes, setProcesses] = useState<RunningProcess[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setProcesses([]);
      return;
    }
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/processes`);
      if (!res.ok) return;
      const data = (await res.json()) as { processes?: RunningProcess[] };
      setProcesses(data.processes ?? []);
    } catch {
      /* cosmetic — keep the last known list */
    }
  }, [workspaceId]);

  // Polled rather than pushed: a process can exit on its own at any moment,
  // and there is no event for that. Only while something is alive, so an
  // idle chat makes no requests.
  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  const anyRunning = processes.some((p) => p.running);

  useEffect(() => {
    if (!anyRunning && !open) return;
    const timer = setInterval(() => void refresh(), open ? 1500 : 4000);
    return () => clearInterval(timer);
  }, [anyRunning, open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stop = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      try {
        await fetch(
          `/api/workspace/${workspaceId}/processes?process=${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
      } catch {
        /* the refresh below reflects whatever actually happened */
      }
      await refresh();
      onChanged?.();
    },
    [workspaceId, refresh, onChanged]
  );

  const running = processes.filter((p) => p.running);

  // Nothing running and nothing recent: stay out of the way entirely.
  if (processes.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="chip"
        data-active={running.length > 0}
        aria-expanded={open}
        title={
          running.length > 0
            ? `${running.length} running in the background`
            : "Recently finished processes"
        }
      >
        <span
          className={`h-1.5 w-1.5 flex-none rounded-full ${
            running.length > 0 ? "animate-pulse bg-green-400" : "bg-text-muted"
          }`}
          aria-hidden="true"
        />
        <span>{running.length > 0 ? `${running.length} running` : "Stopped"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(26rem,calc(100vw-1.5rem))]">
          <div className="popover-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-5 text-text-primary">
                  Background processes
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  Started by the assistant in this chat
                </p>
              </div>
              {running.length > 0 && (
                <button
                  onClick={() => void stop("all")}
                  className="flex-none rounded-lg border border-danger/40 px-2 py-1 text-[12px] text-danger transition-colors hover:bg-danger/10"
                >
                  Stop all
                </button>
              )}
            </div>

            <div className="max-h-[min(26rem,60vh)] overflow-y-auto p-1.5">
              {processes.map((proc) => (
                <div key={proc.id} className="rounded-lg px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 flex-none rounded-full ${
                        proc.running ? "bg-green-400" : "bg-text-muted"
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary"
                      title={proc.display}
                    >
                      {proc.display}
                    </span>

                    {proc.logTail.trim() && (
                      <button
                        onClick={() =>
                          setExpanded(expanded === proc.id ? null : proc.id)
                        }
                        className="flex-none rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text-primary"
                      >
                        {expanded === proc.id ? "Hide" : "Output"}
                      </button>
                    )}

                    {proc.running ? (
                      <button
                        onClick={() => void stop(proc.id)}
                        className="flex-none rounded-lg border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
                      >
                        Stop
                      </button>
                    ) : (
                      <span className="flex-none text-[11px] text-text-muted">
                        {proc.stoppedByUser
                          ? "stopped"
                          : `exit ${proc.exitCode ?? "?"}`}
                      </span>
                    )}
                  </div>

                  {expanded === proc.id && (
                    <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-border bg-bg-primary p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
                      {proc.logTail.trim() || "(no output)"}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
