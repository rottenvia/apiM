# Agentic Workspace — Design Notes

Planning document for adding an Arena-style workspace (agent creates/edits files,
runs code, you download a zip) to this app. Nothing here is implemented yet.

All API claims below were verified against DeepSeek's docs on 2026-08-03.

---

## 1. How an agentic workspace actually works

There is no magic. The model cannot touch your disk. The entire mechanism is:

1. You send the model a list of **tool definitions** (JSON Schema) alongside the
   conversation — `write_file`, `read_file`, `list_files`, `run_command`.
2. Instead of prose, the model may reply with a **tool call**: `write_file({path, content})`.
3. **Your server executes it** and appends the result as a `role: "tool"` message.
4. You call the model again with that result appended.
5. Repeat until the model replies with no tool calls — that's the final answer.

That loop is the whole feature. Everything else — file tree, editor, zip export —
is UI on top of it.

```
user msg ──► DeepSeek ──► tool_calls? ──no──► final answer
                ▲                │
                │               yes
                │                ▼
                └──── tool result ◄─── your executor
```

### Verified facts

| Item | Status |
|---|---|
| DeepSeek supports `tools` / `tool_choice` | Yes — OpenAI-compatible schema |
| Tool calls work in **thinking mode** | Yes, since V3.2 |
| Model IDs `deepseek-v4-pro` / `deepseek-v4-flash` | Correct, current |
| Concurrency limit | Pro **500**, Flash **2500** |
| Strict schema mode | Beta, needs `base_url=…/beta` + `strict: true` |

### ⚠ The landmine in our current code

DeepSeek's docs are explicit:

> For requests carrying the `tools` parameter, the `reasoning_content` must be
> fully passed back to the API in all subsequent requests. If your code does not
> correctly pass back `reasoning_content`, the API will return a **400 error**.

Our `/api/chat` currently rebuilds history as **`{role, content}` only**
(`route.ts`, "Add conversation history"). It drops `reasoning_content`, and has
no concept of `tool_calls` or `role: "tool"` messages.

So tool calling will fail with a 400 on the second turn until history handling is
rewritten. This is the single biggest reason the chat route needs restructuring —
not the tool loop itself, which is straightforward.

Practical consequence: the agent loop must keep **two** representations —
the verbatim API transcript (with `reasoning_content`, `tool_calls`, `tool`
messages) and the prettified version we show the user. Today we conflate them.

---

## 2. Storage: where files live

You have an AWS VPS, so all options are open. Recommended split:

- **Source of truth: the VPS filesystem**, one directory per workspace:
  `/srv/workspaces/<workspace_id>/`
- **Metadata in Postgres**: workspace id, owner, created/updated, size, status.

Do *not* store file contents as rows in Postgres. You lose cheap `grep`, cheap
zip, and the ability to run a real build inside the directory.

Guardrails from day one:
- Resolve every path and assert it stays inside the workspace root
  (`path.resolve` + prefix check). Blocks `../../etc/passwd`.
- Reject symlinks that escape the root.
- Cap per-file size, total workspace size, and file count.
- Consider a per-workspace disk quota (XFS project quota or a loopback ext4
  image) so one runaway agent can't fill the disk.

---

## 3. Execution: the part that needs care

This is where "advanced" turns into "dangerous". `run_command` means **executing
AI-generated code on your VPS**. Treated casually, this is a straightforward path
to a compromised box that gets used for crypto mining or spam.

Three tiers, in increasing order of safety:

| Tier | What it is | Isolation | Effort |
|---|---|---|---|
| A | `child_process` on the host | ❌ none — full VPS access | trivial |
| B | Docker container per workspace | ✅ good | moderate |
| C | gVisor / Firecracker microVM | ✅✅ kernel-level | high |

**Tier A is not acceptable** for anything reachable from the internet. Skip it.

**Tier B (Docker) is the right target.** Practical config:

```
--network none          # no outbound traffic unless explicitly needed
--memory 512m
--cpus 0.5
--pids-limit 128
--read-only             # writable only via the mounted workspace volume
--cap-drop ALL
--security-opt no-new-privileges
--user 1000:1000        # never root
```

Plus a hard wall-clock timeout (kill at 30–60s) and a container-per-run or
per-session lifecycle. Note `--network none` breaks `npm install`; if you need
package installs, allow egress through a proxy allowlisting only registries.

**Auth is not optional.** Right now the app has no login — anyone who finds the
URL gets a shell on your VPS. Before execution ships publicly you need real auth
plus per-user workspace scoping. This is a hard blocker, not a nice-to-have.

---

## 4. Tool set

Start minimal. Every extra tool measurably degrades selection accuracy —
V4 is more agentic and calls badly-described functions more eagerly.

Phase 1 (no execution):
- `list_files(path?)`
- `read_file(path)`
- `write_file(path, content)` — creates parent dirs
- `edit_file(path, old_text, new_text)` — cheaper than rewriting a big file
- `delete_file(path)`

Phase 2:
- `run_command(command, cwd?)`

Schema discipline matters: concrete descriptions, `required` listed,
`additionalProperties: false`. Vague descriptions are the main cause of
wrong-tool calls.

---

## 5. Cost and latency

Agent loops re-send the whole transcript every turn. A 10-step task with a
growing 50K-token context is roughly 500K input tokens.

- V4 Pro: ~$0.22/task · V4 Flash: ~$0.07/task
- Cache hits drop input to **$0.003625/M** (Pro) — ~120× cheaper.

Two implications:
1. **Keep the prefix stable** (system prompt, tool defs, early history) so
   caching actually hits. Don't reorder tools between turns.
2. **Route by difficulty** — Flash for file edits, Pro for planning. Model choice
   per tool-loop iteration, not per conversation.

Also: `maxDuration = 120` in the current route is far too short for a 10-step
loop. Agent runs need streaming or a job queue, not a single blocking request.

---

## 6. Suggested phasing

**Phase 0 — unblock (required for anything else)**
Rewrite chat history to preserve `reasoning_content`, `tool_calls`, and
`role: "tool"`. Separate API transcript from display messages. Without this,
everything 400s.

**Phase 1 — virtual workspace, no execution**
Tool loop + the five file tools + workspace tables + file-tree UI + zip download.
Delivers ~80% of the value: the agent scaffolds a project, you download it.
No new security surface beyond path traversal.

**Phase 2 — auth**
Sessions, per-user workspaces. Prerequisite for Phase 3.

**Phase 3 — execution**
Docker sandbox, `run_command`, streamed terminal output.

**Phase 4 — polish**
Live diffs per tool call, per-step approval, checkpoint/rollback, git init.

Do them in this order. Phase 1 works on Vercel; Phase 3 requires the VPS.

---

## 7. Where we could beat Arena

Genuine opportunities given the existing UI:

- **Diff-first review** — show a red/green diff for every `write_file` inline in
  chat, with accept/reject per change.
- **Checkpoints** — snapshot the workspace before each agent run; one-click
  rollback. Cheap with git under the hood.
- **Plugins × tools** — the existing plugin system could inject tool-specific
  policy ("Security First" → agent must run a lint/audit step before finishing).
- **Thinking effort per step** — Flash for mechanical edits, Pro for planning,
  auto-escalate on failure. The effort selector already exists.
- **Live preview** — for web projects, expose the container port in an iframe.

---

## 8. Honest assessment

The tool loop is the *easy* part — a few hundred lines. The real work is:

1. History/transcript rewrite (Phase 0) — fiddly, and everything depends on it.
2. Sandbox hardening — the part with actual consequences if rushed.
3. File-tree/editor UI — the largest chunk of code by volume.

Phase 1 is a realistic weekend-to-week project and is genuinely useful alone.
Phase 3 is where the effort concentrates; don't start it until auth exists.

**Recommendation:** build Phase 0 + 1 first and use it. It answers "does this
actually feel good?" before committing to sandbox infrastructure.
