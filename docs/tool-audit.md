# The 26 tools, rated honestly

Written 2026-08-10, in answer to: *"rate our tools by percentages each — token
usage, the tool itself, how much of its potential is unleashed."*

Everything in the token column is measured (`JSON.stringify` of the schema, at
3.6 chars/token). The judgement columns are my assessment and I have tried to
be hard on them — a rating of 100% everywhere would be useless to you.

**One thing to get out of the way first:** the tool schemas cost **3,975 tokens
total**, sent once per conversation and cached at 1/120th price thereafter. On
a 40-round task they are **1% of the bill**. So "token usage" is the least
important column here, and no tool should ever be removed to save tokens. I am
including the numbers because you asked, not because they matter.

---

## The ratings

**Potential unleashed** = of what this tool could theoretically do, how much
does our version actually do.

| Tool | Tokens | Reliability | Potential unleashed | Verdict |
|---|---|---|---|---|
| `read_file` | 102 | 98% | 95% | Does one thing perfectly |
| `write_file` | 136 | 98% | 95% | Same |
| `edit_file` | 178 | 90% | 80% | Fails when the model's "exact" match isn't exact |
| `list_files` | 111 | 98% | 90% | Solid; superseded in practice by the auto tree |
| `search_files` | 213 | 92% | 60% | **Plain substring only — no regex, no case control** |
| `read_files` | 113 | 97% | 90% | Parallel, order preserved, cap 60 |
| `write_files` | 146 | 95% | 85% | Good for scaffolding |
| `edit_files` | 188 | 88% | 75% | Same brittleness as `edit_file`, multiplied |
| `replace_in_files` | 250 | 90% | 85% | Has a preview mode; genuinely good |
| `move_file` | 116 | 96% | 90% | Cheap and correct |
| `delete_file` | 77 | 97% | 90% | Fine |
| `undo_file` | 116 | 95% | 70% | One step back only |
| `list_snapshots` | 71 | 95% | 85% | Fine |
| `restore_snapshot` | 120 | 93% | 85% | Big hammer, correctly labelled |
| `run_command` | 281 | 75% | 55% | **See below — the weakest important tool** |
| `start_process` | 238 | 85% | 70% | Works; the agent forgets to stop things |
| `read_process` | 126 | 90% | 75% | No "wait until this appears" |
| `stop_process` | 99 | 95% | 90% | Fine |
| `list_processes` | 88 | 95% | 90% | Fine |
| `fetch_url` | 203 | 85% | 60% | **Static HTML only** |
| `inspect_page` | 174 | 70% | **35%** | **Measured failure below** |
| `web_search` | 183 | 88% | 80% | Good, with cost controls |
| `download_file` | 131 | 90% | 85% | Fine |
| `read_document` | 111 | 92% | 80% | Word/Excel/PPT/EPUB/ODT; **no PDF** |
| `view_image` | 168 | 85% | 70% | Needs a separate vision key |
| `ask_user` | 237 | 90% | 80% | Works; the model under-uses it |

---

## The three that actually hold the agent back

### 1. `inspect_page` — 35%, and this is the Faceit failure

Measured, not asserted. Given the HTML a modern site's server actually returns
before any JavaScript runs:

```
SPA shell — ids: ["root"]
SPA shell — classes: []
SPA shell — text: "FACEIT"
```

Against a server-rendered page it works exactly as intended:

```
Server-rendered — ids: ["score"]
Server-rendered — classes: ["match-header","match-header__score","team","team--home"]
Server-rendered — data:    ["data-testid"]
```

**This is the whole Faceit story.** The agent was asked to inject an overlay
into a match page. It inspected the page, received `<div id="root"></div>`,
and had nothing to build against — so it wrote a plausible generic overlay
that hooked into nothing, and the money went on writing something that could
not work. Not a reasoning failure. **You cannot write a selector for a DOM you
have never been shown**, and for any React/Vue/Angular site, our tool is shown
an empty shell.

Everything else in this document is secondary to this.

### 2. `run_command` — 75% reliable, 55% unleashed

Three real limits:

- **No shell, by design.** Correct: a shell would make the allow-list
  meaningless. But it means no pipes, no `&&`, no redirection, and the model
  reaches for them constantly.
- **Approval on every command.** Safe, but it makes the agent stop and wait,
  which is the opposite of the "does everything by itself" goal.
- **60-second timeout** (300s for installs). A real build exceeds this.

### 3. `search_files` — 92% reliable, 60% unleashed

Plain substring matching. No regex, no case-insensitivity flag, no
whole-word, no file-type filter. Every "find all functions matching X" becomes
several calls or a `read_files` that pulls far more than needed.

---

## Tools we do not have, in the order I would build them

| Missing tool | Value | Why |
|---|---|---|
| **A real browser** | **10/10** | Renders JavaScript, clicks, screenshots. Fixes the 35% above and unlocks self-testing. Everything else is small next to this. |
| `run_tests` | 7/10 | Detects the runner, parses output, returns only failures. Today the model runs a command and reads a wall of text. |
| `apply_patch` | 7/10 | Unified diffs instead of exact-string matching — the fix for `edit_file`'s 90%. |
| `grep` (regex) | 6/10 | Fixes `search_files` properly. |
| `read_pdf` | 5/10 | `read_document` covers everything except the format people actually send. Needs `pdfjs-dist`. |
| `http_request` | 5/10 | Test an API without shelling out to curl. |
| `wait_for` | 4/10 | "Wait until the server prints Ready" instead of guessing a sleep. |
| `sqlite_query` | 3/10 | Narrow but useful for data work. |
| `screenshot_diff` | 3/10 | Only meaningful once a real browser exists. |

---

## Why a real browser is the answer to "I want it to investigate by itself"

Your goal — *"I give it a task and it does everything by itself, I don't even
need to go into the console"* — decomposes into three things it cannot do now:

1. **See a rendered page.** Blocked: 35% above.
2. **See its own work.** It writes a web page and cannot look at it. It asks
   you whether the layout is right.
3. **Verify a fix.** It can run a command, but it cannot click a button and
   confirm the bug is gone.

A headless browser with `goto`, `click`, `type`, `screenshot` and
`evaluate` fixes all three with one tool, and `view_image` already exists to
read the screenshots back.

**Why it is not built yet:** this sandbox physically cannot run one — Chromium
needs `libnspr4`/`libnss3`, which are missing and cannot be installed here.
Playwright would install fine **on your Windows machine**, where the app
actually runs. So this is buildable by you, not testable by me, which is the
same position as the `cross-spawn` fix.

The honest risk: I would be writing browser automation I cannot execute once.
Given how the last untested-on-Windows change went, I would want to build it
behind a switch, with the browser policy from this session already enforcing
that it never touches your real browser.
