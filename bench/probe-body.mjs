/**
 * Probe: find where ~54M-char payloads actually live in the stored chats.
 *
 * Walks data/ for conversation JSON, ranks every message by the size of each
 * field that can ride the wire (content, attachments, resumeState, toolEvents,
 * reasoningContent), and drills into the biggest offenders part by part so the
 * exact carrier (video_url dataUrl vs frames vs tool args) is named.
 */
import { readdirSync, readFileSync } from "node:fs";

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

const M = 1e6;
const files = walk("data", []);
const hits = [];
for (const f of files) {
  let stat;
  try {
    stat = readFileSync(f, "utf8").length;
  } catch {
    continue;
  }
  if (stat > 2 * M) hits.push(f);
}
hits.sort();

for (const f of hits.slice(0, 40)) {
  let json;
  try {
    json = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.log(`${f}: UNPARSEABLE (${e.message.slice(0, 60)})`);
    continue;
  }
  const msgs = json?.messages;
  if (!Array.isArray(msgs)) continue;
  let any = false;
  for (const m of msgs) {
    const contentChars =
      typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    const attChars = JSON.stringify(m.attachments ?? []).length;
    const rsChars = JSON.stringify(m.resumeState ?? []).length;
    const teChars = JSON.stringify(m.toolEvents ?? []).length;
    const reasonChars = typeof m.reasoningContent === "string" ? m.reasoningContent.length : 0;
    const total = contentChars + attChars + rsChars + teChars + reasonChars;
    if (total < 2 * M) continue;
    if (!any) console.log(`\n=== ${f} (${msgs.length} messages) ===`);
    any = true;
    console.log(
      `  [${m.role}] id=${String(m.id ?? "").slice(0, 12)} total=${(total / M).toFixed(1)}M ` +
        `content=${(contentChars / M).toFixed(2)}M att=${(attChars / M).toFixed(2)}M ` +
        `resumeState=${(rsChars / M).toFixed(2)}M toolEvents=${(teChars / M).toFixed(2)}M reasoning=${(reasonChars / M).toFixed(2)}M`
    );
    for (const a of m.attachments ?? []) {
      const len = (a.dataUrl || "").length;
      if (len > M) console.log(`      attachment kind=${a.kind} dataUrl=${(len / M).toFixed(1)}M frames=${a.frames?.length ?? 0}`);
    }
    (m.resumeState?.messages ?? []).forEach((sm, i) => {
      const c = JSON.stringify(sm.content ?? "").length;
      if (c < M) return;
      const detail = Array.isArray(sm.content)
        ? sm.content
            .map((p) => {
              const u = p.image_url?.url ?? p.video_url?.url;
              return `${p.type}${typeof u === "string" ? `(${(u.length / M).toFixed(1)}M)` : ""}`;
            })
            .join(",")
        : "string";
      console.log(`      resumeState.messages[${i}] role=${sm.role} ${(c / M).toFixed(1)}M [${detail}]`);
    });
    (m.toolEvents ?? []).forEach((ev, i) => {
      const a = JSON.stringify(ev?.args ?? "").length;
      if (a > M) console.log(`      toolEvents[${i}] ${ev?.name} args=${(a / M).toFixed(1)}M`);
    });
  }
  if (!any) console.log(`\n=== ${f}: big file, no single big field ===`);
}
console.log("\nprobe done");
