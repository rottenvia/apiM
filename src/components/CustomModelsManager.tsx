"use client";

import { useState } from "react";
import {
  DEFAULT_MODEL_ID,
  customSpecs,
  sanitizeCustomModelDef,
} from "@/lib/models";
import type { CustomModelDef } from "@/lib/models";

/**
 * Your own OpenRouter models: any id from openrouter.ai, verified live.
 *
 * Adding is two steps: Verify checks the id exists and brings back its
 * context window, pricing and capabilities; Add stores it. The stored def
 * is what /api/chat prices and routes on, after its own re-sanitize.
 *
 * The def id embeds the wire slug (`custom:vendor/model`), so the same
 * model can never be added twice — re-adding refreshes it in place.
 */

interface VerifiedModel {
  id: string;
  name: string;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
}

export function CustomModelsManager({
  customs,
  onChange,
  openrouterKey,
  model,
  onModelChange,
}: {
  customs: CustomModelDef[];
  onChange: (next: CustomModelDef[]) => void;
  openrouterKey: string;
  model: string;
  onModelChange: (id: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verified, setVerified] = useState<VerifiedModel | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const verify = async (raw: string): Promise<VerifiedModel> => {
    const res = await fetch("/api/openrouter/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: raw, apiKey: openrouterKey || undefined }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      model?: VerifiedModel;
    };
    if (!res.ok || !data.ok || !data.model) {
      throw new Error(data.error ?? "Could not verify that model id.");
    }
    return data.model;
  };

  const runVerify = async () => {
    if (!slug.trim() || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    setVerified(null);
    try {
      const found = await verify(slug);
      setVerified(found);
      setLabel(found.name || found.id);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "Verify failed.");
    } finally {
      setVerifying(false);
    }
  };

  const add = () => {
    if (!verified) return;
    const def = sanitizeCustomModelDef({
      label: label.trim() || verified.name || verified.id,
      apiModel: verified.id,
      contextLength: verified.contextLength,
      inputPrice: verified.inputPrice,
      outputPrice: verified.outputPrice,
      // Images ride image_url parts on natives; anything else gets helper
      // descriptions. Video stays off: OpenRouter has no video_url
      // contract, so a clip would 400 — frames-mode stills still work.
      vision: verified.supportsVision ? "native" : "helper",
    });
    if (!def) {
      // Verify already passed, so this is a malformed wire id, not a
      // lookup failure — say so instead of sending the user in a loop.
      setVerifyError(
        `The verified id "${verified.id}" is not a usable model id. Copy it fresh from openrouter.ai.`
      );
      return;
    }
    // Same wire id, same def id — this replaces rather than duplicates.
    const next = customs.some((c) => c.id === def.id)
      ? customs.map((c) =>
          c.id === def.id ? { ...def, openLimits: c.openLimits } : c
        )
      : [...customs, def];
    onChange(next);
    onModelChange(def.id);
    setSlug("");
    setLabel("");
    setVerified(null);
    setVerifyError(null);
  };

  const remove = (id: string) => {
    onChange(customs.filter((c) => c.id !== id));
    if (model === id) onModelChange(DEFAULT_MODEL_ID);
  };

  const setOpenLimits = (id: string, open: boolean) => {
    onChange(
      customs.map((c) =>
        c.id === id
          ? sanitizeCustomModelDef({ ...c, openLimits: open }) ?? c
          : c
      )
    );
  };

  const refresh = async (def: CustomModelDef) => {
    if (refreshing) return;
    setRefreshing(def.id);
    try {
      const found = await verify(def.apiModel);
      onChange(
        customs.map((c) =>
          c.id === def.id
            ? sanitizeCustomModelDef({
                ...c,
                contextLength: found.contextLength,
                inputPrice: found.inputPrice,
                outputPrice: found.outputPrice,
                vision: found.supportsVision ? "native" : "helper",
              }) ?? c
            : c
        )
      );
    } catch {
      // A failed refresh keeps the stored def: stale pricing beats none,
      // and the chat route never blocks on it.
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-semibold text-text-primary">
        Your OpenRouter models
      </label>
      <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
        Any model id from{" "}
        <a
          href="https://openrouter.ai/models"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-light underline underline-offset-2"
        >
          openrouter.ai/models
        </a>{" "}
        — paste it, Verify, Add. It rides your OpenRouter key and appears in
        the model picker like a built-in.
      </p>

      {customs.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {customs.map((c) => {
            const unknownPrice =
              c.inputPrice === undefined && c.outputPrice === undefined;
            const selected = model === c.id;
            return (
              <li
                key={c.id}
                className={`rounded-xl border px-3 py-2.5 transition-colors ${
                  selected
                    ? "border-accent/30 bg-accent/[0.07]"
                    : "border-border bg-bg-tertiary"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onModelChange(c.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-[13px] font-medium text-text-primary">
                      {c.label}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-text-muted">
                      {c.apiModel}
                    </span>
                    <span className="block truncate text-[11px] text-text-secondary">
                      {unknownPrice
                        ? `${customSpecs(c)} · pricing unknown`
                        : customSpecs(c)}
                      {c.vision === "native" ? " · vision" : ""}
                    </span>
                  </button>
                  <span className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void refresh(c)}
                      disabled={refreshing !== null}
                      title="Re-check capabilities and pricing with OpenRouter"
                      className="rounded-lg px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40"
                    >
                      {refreshing === c.id ? "…" : "↻"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      title={`Remove ${c.label}`}
                      className="rounded-lg px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-danger"
                    >
                      ✕
                    </button>
                  </span>
                </div>
                {unknownPrice && (
                  <p className="mt-1 text-[11px] leading-4 text-warning">
                    OpenRouter reported no pricing — usage on this model
                    won&apos;t be costed. Re-verify if that looks wrong.
                  </p>
                )}
                <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={c.openLimits === true}
                    onChange={(e) => setOpenLimits(c.id, e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Uncapped tools — whole-file reads, no batch ceilings
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-xl border border-border bg-bg-tertiary/50 px-3 py-2.5">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setVerified(null);
              setVerifyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runVerify();
            }}
            placeholder="author/model-name or author/model:free"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-[12px] text-text-primary placeholder-text-muted placeholder:font-sans outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all"
          />
          <button
            type="button"
            onClick={() => void runVerify()}
            disabled={verifying || !slug.trim()}
            className="flex-none rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:opacity-40"
          >
            {verifying ? "…" : "Verify"}
          </button>
        </div>
        {verifyError && (
          <p className="mt-1.5 text-[11px] leading-4 text-danger">{verifyError}</p>
        )}
        {verified && (
          <div className="mt-2 rounded-lg border border-border bg-bg-secondary px-3 py-2">
            <p className="truncate text-[12px] font-medium text-text-primary">
              {verified.name}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-text-muted">
              {verified.id}
            </p>
            <p className="mt-0.5 text-[11px] text-text-secondary">
              {verified.inputPrice === 0 && verified.outputPrice === 0
                ? "Free"
                : verified.inputPrice === undefined &&
                    verified.outputPrice === undefined
                  ? "Pricing unknown — usage won't be costed"
                  : `$${verified.inputPrice ?? "?"} / $${verified.outputPrice ?? "?"} per 1M in/out`}
              {" · "}
              {[
                verified.supportsTools ? "tools" : "no tools",
                verified.supportsVision ? "vision" : null,
                verified.supportsThinking ? "thinking" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {!verified.supportsTools && (
              <p className="mt-1 text-[11px] leading-4 text-warning">
                This model reports no tool support — the agent can chat but
                its tools will be refused. Still addable; check the
                model&apos;s page if that surprises you.
              </p>
            )}
            <div className="mt-2 flex gap-1.5">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
                placeholder="Display name"
                aria-label="Display name"
                className="min-w-0 flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition-all"
              />
              <button
                type="button"
                onClick={add}
                className="btn-primary flex-none !px-3 !py-1.5 !text-[12px]"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
