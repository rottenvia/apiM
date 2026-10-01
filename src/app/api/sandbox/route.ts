import { NextRequest, NextResponse } from "next/server";
import {
  getSandboxJob,
  sandboxStatus,
  startEnableWsl,
  startSandboxRemove,
  startSandboxSetup,
  startSandboxUpgrade,
} from "@/lib/sandbox-setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Sandbox panel's backend: what WSL has, whether the sandbox distro is
 * set up, and the live log of a setup/remove job. See lib/sandbox-setup.
 */
export async function GET() {
  return NextResponse.json({
    platform: process.platform,
    status: sandboxStatus(),
    job: getSandboxJob(),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const action = body.action;
  const started =
    action === "setup"
      ? startSandboxSetup()
      : action === "remove"
        ? startSandboxRemove()
        : action === "enable-wsl"
          ? startEnableWsl()
          : action === "upgrade"
            ? startSandboxUpgrade()
            : { ok: false as const, error: "action must be setup, remove, upgrade or enable-wsl" };
  if (!started.ok) {
    return NextResponse.json({ error: started.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, job: getSandboxJob() });
}
