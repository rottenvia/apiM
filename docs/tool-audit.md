# The tools, rated honestly

Updated 2026-08-10, after the improvements below.

Token counts are measured. Judgement columns are my assessment, and I have
tried to be hard on them — all-100% would be useless to you.

**One correction from the first version of this document.** I claimed
`search_files` had "no regex, no case control, no glob". That was wrong; it
had all three. I had read the tool description instead of the implementation.
Everything below was probed by running it.

**Token cost is the least important column.** All schemas together are ~4,400
tokens, sent once per conversation and cached at 1/120th price after that — 1%
of a 40-round task. No tool should ever be removed to save tokens.

---

## Current ratings

| Tool | Reliability | Potential unleashed | Change this round |
|---|---|---|---|
| `read_file` | 98% | **98%** | +line ranges, numbered |
| `read_files` | 97% | 90% | — |
| `write_file` | 98% | 95% | — |
| `write_files` | 95% | 85% | — |
| `edit_file` | **97%** | **93%** | whitespace-tolerant matching |
| `edit_files` | **95%** | 85% | inherits the same fix |
| `apply_patch` | 95% | 90% | **new** |
| `replace_in_files` | 90% | 85% | — |
| `search_files` | 92% | **90%** | +context lines |
| `list_files` | 98% | 90% | — |
| `move_file` | 96% | 90% | — |
| `delete_file` | 97% | 90% | — |
| `undo_file` | 95% | 70% | one step back only |
| `list_snapshots` / `restore_snapshot` | 94% | 85% | — |
| `run_tests` | 90% | 85% | **new** |
| `run_command` | 75% | 55% | unchanged — see below |
| `start_process` | 85% | 70% | — |
| `read_process` | 90% | 75% | no wait-for-output |
| `stop_process` / `list_processes` | 95% | 90% | — |
| `browse` | **untested live** | **~85% by design** | **new** |
| `fetch_url` | 85% | 60% | static HTML only, by nature |
| `inspect_page` | 70% | 35% | superseded by `browse` |
| `web_search` | 88% | 80% | — |
| `download_file` | 90% | 85% | — |
| `read_document` | 92% | 80% | no PDF |
| `view_image` | 85% | 70% | needs a vision key |
| `ask_user` | 90% | 80% | — |

---

## What changed, and why each was worth doing

### `edit_file`: 80% → 93%

Every failure looked identical: *"old_text not found"*, on a file the model
had just read. The cause is that a model reproducing a snippet reliably gets
the characters right and unreliably gets the **indentation** right.

Now matched in three passes — exact, ignoring indentation, ignoring spacing
around punctuation — and the replacement is re-indented to match the file it
lands in, so a Python body cannot be flattened. Ambiguous matches and
genuinely absent text are still refused: tolerance means accepting a
differently-formatted description of **one** place, never choosing between
two.

### `read_file`: 95% → 98%

`start_line`/`end_line` were accepted and silently ignored — asking for lines
1–2 of an 8-line file returned all 8. They work now, and the output is
numbered, because a bare slice makes a model report "the bug is on line 12"
when it means line 411.

### `search_files`: 60% → 90%

Regex, case-sensitivity and globs already existed. What was missing was
context: a bare `return None` says nothing about which function it is in, so
the agent spent a whole round opening the file to find out. `context: 2` now
returns surrounding lines with the match marked.

### `apply_patch` (new)

`edit_file` degrades for several changes to one file, because each edit shifts
the lines below it. A patch carries its own context, so all the changes are
described against the file as last read. All hunks are located before any are
written — a patch applies completely or not at all. Stale `@@` numbers are
treated as a hint, since models reproduce them imprecisely.

### `run_tests` (new)

A 400-line pytest run is ~4k tokens, resent on every later round. The useful
part is under 20 lines. This detects the runner (npm script, pytest, vitest,
jest, cargo, go), runs it, and returns the verdict plus only the failures.

It **never claims a pass it did not parse** — unrecognised output is handed
back verbatim. Silently reporting success is the worst thing this tool could
do, so it is the one case tested hardest.

### `browse` (new) — the answer to the Faceit failure

Measured, from the earlier audit: given the HTML a modern site's server
returns, `inspect_page` sees

```
ids: ["root"]    classes: []
```

That is the whole Faceit story. The agent was asked to inject an overlay,
was shown an empty `<div id="root">`, and wrote a generic overlay that hooked
into nothing. **No model can write a selector for a DOM it has never seen.**

`browse` runs a real headless Chromium: `goto`, `click`, `type`, `wait_for`,
`scroll`, `screenshot`, `extract`, `evaluate`. It returns the selectors **as
they exist after JavaScript has run**, the visible text, any screenshots, and
— importantly for self-checking — the **browser console** and **failed
requests**.

That last part is what makes "investigate by itself" possible. A page that
renders but is broken says so in the console, and the agent has never had
access to that. Now it can write a page, open it, screenshot it, read the
errors, and fix them without asking you to look.

**Honest status.** Chromium cannot run in my sandbox — `libnss3`/`libnspr4`
are missing and unavailable, and Playwright's binary CDN is unreachable. Both
verified, not assumed. So the feature is split:

- **All the logic** (validation, ordering, failure handling, result shaping,
  screenshot containment, "selectors come from the rendered DOM") lives behind
  a `BrowserDriver` interface and is tested against a fake driver — 44 checks,
  all passing.
- **The Playwright adapter** is ~30 lines of one-to-one API calls. That is the
  part I could not execute.

Untested surface is therefore small and clearly located, rather than "several
hundred lines of browser code that has never run" — which is how the last
platform-specific fix shipped at 90% confidence.

It is **opt-in**: `npm run browser:install` (~150MB, once). Until then the
tool is not offered to the model at all, because offering a tool that cannot
run buys an error, an apology, and a worse fallback.

Safety is inherited from the browser policy built earlier: headless, its own
profile inside the workspace, never yours, never attached to a running
browser.

---

## What is still weak

### `run_command` — 75% / 55%, the weakest important tool

Three limits, all deliberate and all still costing something:

- **No shell.** Correct — a shell makes the allow-list meaningless — but it
  means no pipes, no `&&`, no redirection, and the model reaches for them.
- **Approval on every command.** Safe, but it is the main thing stopping the
  agent from working unattended, which is your stated goal.
- **60s timeout** (300s for installs). A real build exceeds this.

`run_tests` removes the most common reason to touch it. A future
`allow-list of safe command chains` would be the next step, and it needs care.

### Still missing

| Tool | Value | Why |
|---|---|---|
| `read_pdf` | 5/10 | `read_document` covers everything except the format people actually send |
| `http_request` | 5/10 | Test an API without shelling out to curl |
| `wait_for_output` | 4/10 | "Wait until the server prints Ready" instead of guessing a sleep |
| `git` helpers | 4/10 | `git` is allowed, but diff/commit/branch as structured tools would be cheaper than parsing porcelain |
| `sqlite_query` | 3/10 | Narrow, useful for data work |

Everything on that list is small compared to what `browse` unlocks, which is
why it went first.
