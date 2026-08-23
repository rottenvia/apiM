"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QWEN_38_27B_ID } from "@/lib/models";
import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  SIDECAR_CTX,
  SPEC_PRESETS,
  defaultSpecState,
  formatBytes,
  type EngineDownloadEvent,
  type EngineStatus,
  type SidecarSpecState,
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
    nCtx: null,
    spec: defaultSpecState(),
  };
}

export function LocalModelRuntime({
  onLocalBaseUrlChange,
  onLocalApiModelChange,
  onUseModel,
}: LocalModelRuntimeProps) {
  const [status, setStatus] = useState<EngineStatus>(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "download" | "start" | "restart" | "opts" | "stop" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [customFlag, setCustomFlag] = useState("");
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

  const postAction = useCallback(
    async (
      action: string,
      extra?: Record<string, unknown>,
      kind: "start" | "restart" | "opts" | "stop" = "start"
    ) => {
      setBusy(kind);
      setError(null);
      if (kind !== "stop") applyReady();
      try {
        const res = await fetch("/api/local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          status?: EngineStatus;
        };
        if (data.status) setStatus(data.status);
        if (!data.ok) setError(data.error ?? "Could not update the local model.");
      } catch {
        setError("Couldn't reach this app's local helper.");
      } finally {
        setBusy(null);
        void refresh();
      }
    },
    [applyReady, refresh]
  );

  const start = useCallback(() => {
    void postAction("start", undefined, "start");
  }, [postAction]);

  const restart = useCallback(() => {
    void postAction("restart", undefined, "restart");
  }, [postAction]);

  const unload = useCallback(() => {
    void postAction("stop", undefined, "stop");
  }, [postAction]);

  const spec: SidecarSpecState = status.spec ?? defaultSpecState();

  const togglePreset = useCallback(
    (id: string) => {
      const on = spec.enabled.includes(id);
      const enabled = on
        ? spec.enabled.filter((x) => x !== id)
        : [...spec.enabled, id];
      void postAction("set-opts", { enabled, extra: spec.extra }, "opts");
    },
    [postAction, spec.enabled, spec.extra]
  );

  const addCustom = useCallback(() => {
    if (!customFlag.trim()) return;
    void postAction(
      "set-opts",
      { enabled: spec.enabled, extra: spec.extra, addFlag: customFlag },
      "opts"
    );
    setCustomFlag("");
  }, [customFlag, postAction, spec.enabled, spec.extra]);

  const removeExtraAt = useCallback(
    (index: number) => {
      const extra = spec.extra.filter((_, i) => i !== index);
      void postAction("set-opts", { enabled: spec.enabled, extra }, "opts");
    },
    [postAction, spec.enabled, spec.extra]
  );

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
  const windowTooSmall =
    typeof status.nCtx === "number" && status.nCtx < SIDECAR_CTX;

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
            ready && !windowTooSmall
              ? "bg-success"
              : busy || windowTooSmall
                ? "bg-[#cfa25a]"
                : "bg-text-muted"
          }`}
          aria-hidden="true"
        />
      </div>

      <p className="mt-2 text-[12px] leading-4 text-text-secondary">
        {loading ? "Checking this PC…" : status.hint}
      </p>

      {status.running && (
        <p
          className={`mt-1 text-[11px] ${
            windowTooSmall ? "text-danger" : "text-text-muted"
          }`}
        >
          Window:{" "}
          {typeof status.nCtx === "number"
            ? `${status.nCtx.toLocaleString()} tokens`
            : "unknown"}{" "}
          {windowTooSmall ? "— too small, Restart" : `(need ${SIDECAR_CTX.toLocaleString()})`}
        </p>
      )}

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
          <>
            <button
              type="button"
              onClick={applyReady}
              className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent-light transition-colors duration-150 hover:bg-accent/15"
            >
              Use Qwen 3.8 27B
            </button>
            <button
              type="button"
              onClick={() => void restart()}
              disabled={busy !== null}
              className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-light hover:text-text-primary disabled:opacity-40"
            >
              {busy === "restart" ? "Restarting…" : "Restart"}
            </button>
            <button
              type="button"
              onClick={() => void unload()}
              disabled={busy !== null}
              className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:border-danger/40 hover:text-danger disabled:opacity-40"
            >
              {busy === "stop" ? "Unloading…" : "Unload"}
            </button>
          </>
        ) : status.ggufReady ? (
          <>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy !== null}
              className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent-light transition-colors duration-150 hover:bg-accent/15 disabled:opacity-40"
            >
              {busy === "start" ? "Starting…" : "Start Qwen"}
            </button>
            <button
              type="button"
              onClick={() => void download()}
              disabled={busy === "start" || busy === "restart" || busy === "stop"}
              className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-light hover:text-text-primary disabled:opacity-40"
            >
              {busy === "download" ? "Downloading…" : "Re-download"}
            </button>
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
        ) : (
          <>
            <button
              type="button"
              onClick={() => void download()}
              disabled={busy === "start" || busy === "restart"}
              className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[12px] font-medium text-accent-light transition-colors duration-150 hover:bg-accent/15 disabled:opacity-40"
            >
              {busy === "download"
                ? "Downloading…"
                : status.ggufBytes > 0
                  ? "Resume download"
                  : "Download Qwen 3.8 27B"}
            </button>
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

      {status.ggufReady && (
        <div className="mt-3 border-t border-border pt-2.5">
          <p className="text-[12px] font-medium text-text-primary">
            Spec optimizations
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
            llama-server flags. Toggle these or add your own. Restart applies
            them.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {SPEC_PRESETS.map((preset) => {
              const on = spec.enabled.includes(preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => togglePreset(preset.id)}
                  disabled={busy !== null}
                  className="flex w-full items-start justify-between gap-2 rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-left disabled:opacity-40"
                >
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-text-primary">
                      {preset.label}
                    </span>
                    <span className="block text-[10px] leading-3 text-text-muted">
                      {preset.blurb}
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 flex-none text-[10px] font-medium ${
                      on ? "text-accent-light" : "text-text-muted"
                    }`}
                  >
                    {on ? "On" : "Off"}
                  </span>
                </button>
              );
            })}
          </div>
          {spec.extra.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {spec.extra.map((token, i) => (
                <li
                  key={`${token}-${i}`}
                  className="flex items-center justify-between gap-2 font-mono text-[11px] text-text-secondary"
                >
                  <span className="truncate">{token}</span>
                  <button
                    type="button"
                    onClick={() => removeExtraAt(i)}
                    className="text-[10px] text-text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              value={customFlag}
              onChange={(e) => setCustomFlag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="--spec-draft-p-min 0.85"
              className="min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-2 py-1.5 font-mono text-[11px] text-text-primary outline-none focus:border-accent/50"
            />
            <button
              type="button"
              onClick={addCustom}
              disabled={busy !== null || !customFlag.trim()}
              className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-text-secondary disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
