import { NextRequest, NextResponse } from "next/server";
import {
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  createSnapshot,
} from "@/lib/snapshots";

export const dynamic = "force-dynamic";

/** Point-in-time copies of a workspace, and restoring them. */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return NextResponse.json({ snapshots: await listSnapshots(id) });
  } catch (error) {
    console.error("Listing snapshots failed:", error);
    return NextResponse.json({ snapshots: [] });
  }
}

/** POST with a snapshot id restores it; without one, takes a new snapshot. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { snapshot?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.snapshot) {
      const result = await restoreSnapshot(id, body.snapshot);
      return NextResponse.json({ ok: true, ...result });
    }

    const created = await createSnapshot(
      id,
      body.label?.trim() || "Manual save point"
    );
    if (!created) {
      return NextResponse.json(
        { error: "Nothing to save — the workspace is empty" },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true, snapshot: created });
  } catch (error) {
    console.error("Snapshot request failed:", error);
    return NextResponse.json(
      { error: "That save point could not be used" },
      { status: 400 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const snapshot = req.nextUrl.searchParams.get("snapshot");

  if (!snapshot) {
    return NextResponse.json({ error: "snapshot is required" }, { status: 400 });
  }

  return NextResponse.json({ deleted: await deleteSnapshot(id, snapshot) });
}
