import type { StoredConversation } from "@/lib/store";

export type ExportFormat = "json" | "md" | "txt" | "html";

export const EXPORT_FORMATS: {
  id: ExportFormat;
  label: string;
  hint: string;
  mime: string;
}[] = [
  { id: "md", label: "Markdown", hint: ".md", mime: "text/markdown" },
  { id: "json", label: "JSON", hint: ".json", mime: "application/json" },
  { id: "txt", label: "Plain text", hint: ".txt", mime: "text/plain" },
  { id: "html", label: "Web page", hint: ".html", mime: "text/html" },
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function renderExport(
  conv: StoredConversation,
  format: ExportFormat
): string {
  if (format === "json") {
    return JSON.stringify(conv, null, 2);
  }

  if (format === "txt") {
    const lines = [
      conv.title,
      "=".repeat(conv.title.length),
      `Exported ${formatDate(new Date().toISOString())}`,
      "",
    ];
    for (const m of conv.messages) {
      lines.push(`[${m.role.toUpperCase()}] ${formatDate(m.createdAt)}`);
      lines.push(m.content, "");
    }
    return lines.join("\n");
  }

  if (format === "md") {
    const lines = [
      `# ${conv.title}`,
      "",
      `*Exported ${formatDate(new Date().toISOString())} · ${conv.messages.length} messages*`,
      "",
    ];
    for (const m of conv.messages) {
      lines.push(`## ${m.role === "user" ? "You" : "Assistant"}`, "");
      if (m.reasoningContent) {
        lines.push("<details><summary>Thinking</summary>", "");
        lines.push("```", m.reasoningContent, "```", "");
        lines.push("</details>", "");
      }
      lines.push(m.content, "");
      if (m.searchResults?.length) {
        lines.push("**Sources**", "");
        m.searchResults.forEach((r, i) =>
          lines.push(`${i + 1}. [${r.title}](${r.url}) — ${r.domain}`)
        );
        lines.push("");
      }
      lines.push("---", "");
    }
    return lines.join("\n");
  }

  // Self-contained HTML page styled to match the app.
  const body = conv.messages
    .map((m) => {
      const who = m.role === "user" ? "You" : "Assistant";
      const sources = m.searchResults?.length
        ? `<div class="sources"><strong>Sources</strong><ol>${m.searchResults
            .map(
              (r) =>
                `<li><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a> <span>${escapeHtml(r.domain)}</span></li>`
            )
            .join("")}</ol></div>`
        : "";
      const thinking = m.reasoningContent
        ? `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(m.reasoningContent)}</pre></details>`
        : "";
      return `<article class="msg ${m.role}"><header>${who}<time>${escapeHtml(formatDate(m.createdAt))}</time></header>${thinking}<div class="body"><pre>${escapeHtml(m.content)}</pre></div>${sources}</article>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conv.title)}</title>
<style>
:root{--bg:#191715;--card:#141210;--line:#2c2924;--fg:#ede9e2;--dim:#a29d92;--muted:#6d685d;--accent:#c96442}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
.meta{color:var(--muted);font-size:.8rem;margin-bottom:2rem}
.msg{border:1px solid var(--line);border-radius:14px;padding:1rem 1.15rem;margin-bottom:1rem;background:var(--card)}
.msg.user{background:#201e1b}
.msg header{display:flex;justify-content:space-between;align-items:baseline;
font-weight:600;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:.6rem}
.msg.user header{color:var(--dim)}
.msg time{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:.72rem}
.body pre{white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit}
.thinking{margin-bottom:.75rem;border:1px solid #cfa25a33;border-radius:10px;padding:.5rem .75rem}
.thinking summary{cursor:pointer;color:#cfa25a;font-size:.8rem;font-weight:600}
.thinking pre{white-space:pre-wrap;color:var(--dim);font-size:.85rem;margin:.5rem 0 0}
.sources{margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--line);font-size:.85rem}
.sources strong{color:#6ba3a0;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.sources ol{margin:.4rem 0 0;padding-left:1.2rem;color:var(--dim)}
.sources a{color:#d97f5d}
.sources span{color:var(--muted);font-size:.78rem}
</style></head>
<body><main>
<h1>${escapeHtml(conv.title)}</h1>
<p class="meta">${conv.messages.length} messages · exported ${escapeHtml(formatDate(new Date().toISOString()))}</p>
${body}
</main></body></html>`;
}

export function exportFilename(
  conv: StoredConversation,
  format: ExportFormat
): string {
  const safe =
    conv.title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60)
      .toLowerCase() || "conversation";
  return `${safe}.${format}`;
}
