"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QWEN_38_27B_ID } from "@/lib/models";
import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  formatBytes,
  type EngineDownloadEvent,
  type EngineStatus,
} from "@/lib/local-engine-shared";

interface LocalModelRuntimeProps {
  onLocalBaseUrlChange: (url: string) => void;
  onLocalApiModelChange: (model: string) => void;
  onUseModel: (modelId: string) => void;
}

function emptyStatus(): EngineStatus {
  return {
    ggufReady: false,
    ggufBytes: 0,
    ggufExpected: 0,
    mmprojReady: false,
    mmprojBytes: 0,
    mmprojExpected: 0,
    serverReady: false,
    running: false,
    baseUrl: DEFAULT_LOCAL_BASE_URL,
    apiModel: DEFAULT_LOCAL_API_MODEL,
    hint: "Checking this PC…",
  };
}

export function LocalModelRuntime({
  onLocalBaseUrlChange,
  onLocalApiModelChange,
  onUseModel,
}: LocalModelRuntimeProps) {
  const [status, setStatus] = useState<EngineStatus>(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"download" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pull, setPull] = useState<{
    label: string;
    percent: number | null;
    completed: number;
    total: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const applyReady = useCallback(() => {
    onLocalBaseUrlChange(DEFAULT_LOCAL_BASE_URL);
    onLocalApiModelChange(DEFAULT_LOCAL_API_MODEL);
    onUseModel(QWEN_38_27B_ID);
  }, [onLocalApiModelChange, onLocalBaseUrlChange, onUseModel]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/local", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as EngineStatus;
      setStatus(data);
    } catch {
      /* a missed probe must not look like the app froze */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (busy === "download") return;
    const t = setInterval(() => {
      void refresh();
    }, 4_000);
    return () => clearInterval(t);
  }, [busy, refresh]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const start = useCallback(async () => {
    setBusy("start");
    setError(null);
    applyReady();
    try {
      const res = await fetch("/api/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        status?: EngineStatus;
      };
      if (data.status) setStatus(data.status);
      if (!data.ok) setError(data.error ?? "Could not start the local model.");
    } catch {
      setError("Couldn't reach this app's local helper.");
    } finally {
      setBusy(null);
      void refresh();
    }
  }, [applyReady, refresh]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
    setPull(null);
  }, []);

  const download = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("download");
    setError(null);
    setPull({ label: "Starting", percent: null, completed: 0, total: 0 });
    applyReady();

    try {
      const res = await fetch("/api/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ action: "download" }),
      });

      const stream = (res.headers.get("content-type") ?? "").includes(
        "text/event-stream"
      );
      if (!res.ok || !res.body || !stream) {
        const raw = await res.text();
        let message = "Download could not start.";
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          /* keep default */
        }
        setError(message);
        setBusy(null);
        setPull(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let succeeded = false;

      for (;;) {
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
          let evt: EngineDownloadEvent;
          try {
            evt = JSON.parse(payload) as EngineDownloadEvent;
          } catch {
            continue;
          }
          if (evt.type === "error") {
            setError(evt.message);
          } else if (evt.type === "done") {
            succeeded = true;
            setPull({
              label: "Ready",
              percent: 100,
              completed: 0,
              total: 0,
            });
          } else if (evt.type === "status") {
            setPull((prev) => ({
              label: evt.message,
              percent: prev?.percent ?? null,
              completed: prev?.completed ?? 0,
              total: prev?.total ?? 0,
            }));
          } else {
            setPull({
              label: evt.label,
              percent: evt.percent,
              completed: evt.completed,
              total: evt.total,
            });
          }
        }
      }

      if (succeeded) applyReady();
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Download failed.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
      setPull(null);
      void refresh();
    }
  }, [applyReady, refresh]);

  const ready = status.running && status.ggufReady;
  const percent = pull?.percent ?? null;

  return (
    <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium leading-5 text-text-primary">
            On this PC
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
            Download the 27B into this app. A sidecar on your machine runs
            it — the chat window never loads the weights.
          </p>
        </div>
        <span
          className={`mt-0.5 h-2 w-2 flex-none rounded-full ${
            ready ? "bg-success" : busy ? "bg-[#cfa25a]" : "bg-text-muted"
          }`}
          aria-hidden="true"
        />
      </div>

      <p className="mt-2 text-[12px] leading-4 text-text-secondary">
        {loading ? "Checking this PC…" : status.hint}
      </p>

      {status.ggufBytes > 0 && !status.ggufReady && !pull && (
        <p className="mt-1 text-[11px] text-text-muted">
          {formatBytes(status.ggufBytes)} of {formatBytes(status.ggufExpected)}{" "}
          on disk — click Download to resume.
        </p>
      )}

      {pull && (
        <div className="mt-2.5">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-text-muted">
            <span className="truncate">{pull.label || "Downloading"}</span>
            <span className="flex-none">
              {percent !== null
                ? `${percent}%`
                : pull.total > 0
                  ? `${formatBytes(pull.completed)} / ${formatBytes(pull.total)}`
                  : "…"}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-secondary">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${percent ?? 8}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[12px] leading-4 text-danger">{error}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {ready ? (
          <button
            type="button"
            onClick={applyReady}
            className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent-light transition-colors duration-150 hover:bg-accent/15"
          >
            Use Qwen 3.8 27B
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void download()}
              disabled={busy === "start"}
              className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent-light transition-colors duration-150 hover:bg-accent/15 disabled:opacity-40"
            >
              {busy === "download" ? "Downloading…" : "Download Qwen 3.8 27B"}
            </button>
            {status.ggufReady && (
              <button
                type="button"
                onClick={() => void start()}
                disabled={busy !== null}
                className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-light hover:text-text-primary disabled:opacity-40"
              >
                {busy === "start" ? "Starting…" : "Start"}
              </button>
            )}
            {busy === "download" && (
              <button
                type="button"
                onClick={cancel}
                className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-text-muted transition-colors duration-150 hover:text-text-primary"
              >
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
