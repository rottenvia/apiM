import { NextRequest, NextResponse } from "next/server";
import { deleteConversation } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * How many chats one request may delete.
 *
 * High enough that clearing out a month of chats is a single action, low
 * enough that a malformed body cannot ask the server to walk ten thousand
 * folders. Selecting more than this is possible in the UI; the client sends
 * them in batches.
 */
const MAX_PER_REQUEST = 200;

/**
 * Delete several chats in one request.
 *
 * The single-delete route already exists and works. This is not a shortcut
 * around it — it calls exactly the same `deleteConversation`, which is what
 * stops background processes, drops snapshots, and forgets any "always allow"
 * command permissions the workspace held. Reimplementing any of that here
 * would be how those steps quietly diverge.
 *
 * What this adds is one round trip instead of N, and one honest answer about
 * which ones actually went.
 */
export async function POST(req: NextRequest) {
  let body: { ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.ids)) {
    return NextResponse.json(
      { error: "ids must be an array" },
      { status: 400 }
    );
  }

  // De-duplicated: the same id twice would count as two deletions, and the
  // second would report a failure for something that is already gone.
  const ids = [...new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length > 0))];

  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids given" }, { status: 400 });
  }
  if (ids.length > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many at once — the limit is ${MAX_PER_REQUEST}` },
      { status: 400 }
    );
  }

  /*
   * One at a time, deliberately.
   *
   * deleteConversation stops processes and removes directories, and running
   * those concurrently against a shared data directory is how two of them
   * race on the same parent folder. This is a rare, user-initiated action
   * where a few hundred milliseconds does not matter and a partial failure
   * that is hard to explain does.
   *
   * A failure on one does not abandon the rest: deleting nine of ten and
   * saying so is better than stopping at the first problem and leaving the
   * user to work out how far it got.
   */
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    try {
      const ok = await deleteConversation(id);
      if (ok) deleted.push(id);
      else failed.push(id);
    } catch (error) {
      console.error(`Bulk delete failed for ${id}:`, error);
      failed.push(id);
    }
  }

  return NextResponse.json({ deleted, failed });
}
