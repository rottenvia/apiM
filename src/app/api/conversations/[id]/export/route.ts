import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/store";
import {
  EXPORT_FORMATS,
  exportFilename,
  renderExport,
} from "@/lib/export";
import type { ExportFormat } from "@/lib/export";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const requested = req.nextUrl.searchParams.get("format") ?? "md";

    const spec = EXPORT_FORMATS.find((f) => f.id === requested);
    if (!spec) {
      return NextResponse.json({ error: "Unknown format" }, { status: 400 });
    }

    const conv = await getConversation(id);
    if (!conv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = renderExport(conv, spec.id as ExportFormat);
    const filename = exportFilename(conv, spec.id as ExportFormat);

    return new Response(body, {
      headers: {
        "Content-Type": `${spec.mime}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Export failed:", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
