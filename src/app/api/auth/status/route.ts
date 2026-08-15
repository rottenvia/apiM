import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Whether this server has auth switched on.
 *
 * Public on purpose so the UI knows whether to offer a sign-out control. It
 * reveals only that a password exists, never any part of it.
 */
export async function GET() {
  const { enabled } = authConfig();
  return NextResponse.json({ authEnabled: enabled });
}
