"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * What has actually been going wrong.
 *
 * The user cannot report problems they never saw — a tool that failed on
 * round nine of a long run, a command refused for a reason that scrolled past.
 * This surfaces them, grouped and counted, so the frequent ones are obvious.
 *
 * Deliberately read-only apart from Clear and Export. It is a report, not a
 * console: anything actionable belongs in the fix, not in a button here.
 */

interface Group {
  kind: string;
  subject: string;
  count: number;
  lastAt: string;
  example: string;
}

const KIND_LABEL: Record<string, string> = {
  tool_failed: "Tool failed",
  command_refused: "Command refused",
  browser_blocked: "Browser blocked",
  api_error: "API error",
  limit_hit: "Hit a limit",
  run_stopped: "Stopped early",
  ui_error: "Interface error",
};

export function DiagnosticsPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /**
   * Read the log.
   *
   * Returns the data instead of writing it, so the initial fetch can be done
   * from an effect without React complaining about a synchronous state write
   * during the first commit — the effect awaits this and then commits once.
   */
  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch("/api/diagnostics", { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as { total: number; groups: Group[] };
    } catch {
      // An empty report is the honest fallback: the panel is a convenience,
      // and a failure to read it must not look like a failure of the app.
      return null;
    }
  }, []);

  const apply = useCallback(
    (data: { total: number; groups: Group[] } | null) => {
      if (data) {
        setTotal(data.total);
        setGroups(data.groups);
      }
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void fetchReport().then((data) => {
      if (!cancelled) apply(data);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchReport, apply]);

  const reload = useCallback(async () => {
    apply(await fetchReport());
  }, [fetchReport, apply]);

  /*
   * Downloaded via fetch + blob, not a plain <a href>.
   *
   * A download manager (IDM, on this user's machine) intercepts ordinary
   * navigations, tries to fetch the URL itself, and fails — which is exactly
   * what happened with the workspace download before it was changed to this.
   */
  const exportReport = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/diagnostics?format=md");
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "apim-diagnostics.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* nothing to do — the report is still readable on screen */
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/diagnostics", { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  return (
    <div>
      <label className="block text-sm font-semibold text-text-primary mb-2">
        Problem report
      </label>
      <p className="mb-3 text-[12px] leading-relaxed text-text-secondary">
        Failures are recorded as they happen — tools that errored, commands
        refused, runs that hit a limit. Grouped by how often each one occurs,
        so the thing worth fixing first is at the top. This never leaves your
        machine, and API keys are stripped before anything is written.
      </p>

      {loading ? (
        <p className="text-[12px] text-text-muted">Reading…</p>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-4 text-center">
          <p className="text-[13px] text-text-secondary">
            Nothing recorded yet.
          </p>
          <p className="mt-1 text-[11px] text-text-muted">
            Failures will show up here as they happen.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {groups.slice(0, 12).map((g, i) => (
            <div
              key={`${g.kind}-${g.subject}-${i}`}
              className={`flex items-start gap-2.5 px-3 py-2.5 ${
                i > 0 ? "border-t border-border" : ""
              }`}
            >
              <span
                className="mt-0.5 flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-bg-tertiary px-1.5 text-[11px] font-semibold text-text-secondary"
                title={`${g.count} occurrence${g.count === 1 ? "" : "s"}`}
              >
                {g.count}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-primary">
                  {KIND_LABEL[g.kind] ?? g.kind}
                  <span className="ml-1.5 font-mono text-[12px] text-text-secondary">
                    {g.subject}
                  </span>
                </p>
                <p className="mt-0.5 break-words text-[11px] leading-4 text-text-muted">
                  {g.example}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={exportReport}
          disabled={busy || total === 0}
          className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:text-text-primary disabled:opacity-40"
        >
          Export as Markdown
        </button>
        <button
          onClick={() => void reload()}
          disabled={busy}
          className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:text-text-primary disabled:opacity-40"
        >
          Refresh
        </button>
        <button
          onClick={clear}
          disabled={busy || total === 0}
          className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:text-danger disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      {total > 0 && (
        <p className="mt-2 text-[11px] text-text-muted">
          {total} event{total === 1 ? "" : "s"} recorded. Export and paste it
          into a chat to have the problems read back to you.
        </p>
      )}
    </div>
  );
}
