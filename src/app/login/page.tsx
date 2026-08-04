"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      // Read as text first: an error page would be HTML, and calling .json()
      // on it throws a confusing parse error instead of showing the problem.
      const raw = await res.text();
      let data: { error?: string } = {};
      try {
        data = JSON.parse(raw) as { error?: string };
      } catch {
        /* non-JSON response */
      }

      if (!res.ok) {
        setError(data.error ?? `Sign-in failed (${res.status})`);
        setPassword("");
        inputRef.current?.focus();
        return;
      }

      // Only allow relative redirects, or a crafted link could bounce the
      // user to another site after a successful login.
      const next = params.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.replace(target);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-primary px-4">
      <div className="w-full max-w-[22rem]">
        <div className="mb-7 text-center">
          <h1 className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] text-text-primary">
            apiM
          </h1>
          <p className="mt-1.5 text-[13px] leading-5 text-text-secondary">
            Enter your password to continue
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            aria-label="Password"
            aria-invalid={Boolean(error)}
            className="h-11 w-full rounded-xl border border-border bg-bg-secondary px-3.5 text-[14px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-border-light"
          />

          {error && (
            <p role="alert" className="text-[12.5px] leading-4 text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !password}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-[11.5px] leading-4 text-text-muted">
          This app can create and edit files, and uses your API keys.
          That&apos;s why it&apos;s behind a password.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary or the build fails on this page.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
