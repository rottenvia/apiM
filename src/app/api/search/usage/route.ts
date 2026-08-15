import { NextResponse } from "next/server";
import { usageSummary, resetUsage } from "@/lib/search-usage";
import { cacheStats, clearCache } from "@/lib/search-cache";

/**
 * This month's search spend, for the meter in Settings.
 *
 * Counted locally rather than read from the providers, so it is an estimate —
 * accurate while this app is the only consumer of the keys, which is the
 * intended setup.
 */
export async function GET() {
  const [usage, cache] = await Promise.all([usageSummary(), cacheStats()]);
  return NextResponse.json({ usage, cache });
}

/**
 * Reset the counters or empty the cache.
 *
 * Resetting usage is needed after topping up a plan, since the meter cannot
 * see a balance change it did not cause.
 */
export async function DELETE(req: Request) {
  const target = new URL(req.url).searchParams.get("target");

  if (target === "cache") {
    await clearCache();
  } else if (target === "usage") {
    await resetUsage();
  } else {
    await Promise.all([clearCache(), resetUsage()]);
  }

  const [usage, cache] = await Promise.all([usageSummary(), cacheStats()]);
  return NextResponse.json({ usage, cache });
}
