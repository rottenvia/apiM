"use client";

import { useEffect } from "react";

/**
 * What the user sees when a render throws.
 *
 * Without this, any uncaught error in a component unmounts the whole tree and
 * leaves a blank white page — no message, no way back, and no indication that
 * the conversations are still safely on disk. A crash in one message bubble
 * would take the entire app with it.
 *
 * Next renders this in place of the broken tree, which keeps the process
 * alive and makes recovery a click rather than a refresh-and-hope.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Goes to the terminal running `npm run dev`, which is the only place a
    // self-hosted user can realistically look.
    console.error("apiM crashed:", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-primary px-6">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-[#cf6a5f]/30 bg-[#cf6a5f]/[0.07] p-5">
          <div className="flex items-start gap-3">
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#cf6a5f" strokeWidth={1.9} aria-hidden="true"
              className="mt-0.5 flex-none"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold text-text-primary">
                Something broke while drawing the page
              </h1>
              <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                Your chats and workspace files are on disk and untouched — this
                is a display fault, not lost work. Trying again usually clears
                it.
              </p>

              {/* The message itself, because a self-hosted user is also the
                  person who can fix it, and "an error occurred" helps nobody. */}
              <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-border bg-bg-secondary p-2.5 font-mono text-[11px] leading-relaxed text-text-muted">
                {error.message || "No message was provided."}
              </pre>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={reset}
                  className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-light"
                >
                  Try again
                </button>
                {/* A real navigation, not next/link.
                    
                    The React tree has just thrown, so a client-side route
                    change would re-mount the same broken state. A full reload
                    is the whole point of this button — eslint's rule assumes
                    a healthy app. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/"
                  className="rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:border-border-light hover:text-text-primary"
                >
                  Back to a fresh page
                </a>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-center text-[11px] text-text-muted">
          The full error is in the terminal running the app.
        </p>
      </div>
    </div>
  );
}
