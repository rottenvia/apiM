import { NextRequest, NextResponse } from "next/server";
import {
  readDiagnostics,
  clearDiagnostics,
  renderReport,
  summarise,
} from "@/lib/diagnostics";

/**
 * The diagnostics report.
 *
 * GET            — the grouped summary, for the Settings tab
 * GET ?format=md — the full Markdown report, for downloading or pasting
 * DELETE         — clear the log
 *
 * Local-only data. Nothing here is sent anywhere; the export exists so the
 * user can choose to paste it into a chat and have the problems read back.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const entries = await readDiagnostics();

    if (req.nextUrl.searchParams.get("format") === "md") {
      return new NextResponse(renderReport(entries), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="apim-diagnostics.md"`,
        },
      });
    }

    return NextResponse.json({
      total: entries.length,
      groups: summarise(entries).slice(0, 40),
      recent: entries.slice(-15).reverse(),
    });
  } catch (error) {
    console.error("Error reading diagnostics:", error);
    return NextResponse.json({ error: "Failed to read" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await clearDiagnostics();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error clearing diagnostics:", error);
    return NextResponse.json({ error: "Failed to clear" }, { status: 500 });
  }
}
