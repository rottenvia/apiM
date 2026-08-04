# Where apiM is, and what's next

Written 2026-08-04, after the workspace UI shipped.

---

## The honest answer: can it build an app yet?

**No. Not the way Arena does.** It can write real files, correctly, and that is
genuinely working. What it cannot do is the thing that makes Arena feel like
magic.

Here is the actual difference.

### What apiM does now

You ask for a file. The model calls `write_file`. The file appears on your
disk. You can open it, edit it, delete it. Verified against the real DeepSeek:
correct FizzBuzz, 6.1 seconds, $0.00061.

It can do this several times in one reply — up to 12 rounds of tool calls — so
"make me a small site with three pages" would produce three files. That is more
than a snippet generator.

### What it cannot do

**It cannot run anything.** There is no `run_command`. So the model:

- can't run `npm install`
- can't start a dev server
- can't run your code to see if it works
- can't read an error message and fix it
- can't run tests

This is the whole gap. Arena writes code, runs it, sees the crash, and fixes
it — a loop. apiM writes code and stops. If it writes a bug, it has no way to
find out.

**No preview.** Arena shows the running app in a panel. apiM shows you a text
editor.

**No project awareness.** Each chat gets its own empty folder. It doesn't know
about your existing project unless you paste files in.

**No image input.** DeepSeek's API is text-only, so "make it look like this
screenshot" doesn't work through DeepSeek. (There's a separate vision key for
reading screenshots into text, but that's a workaround, not the same thing.)

### So what is it good for today

Realistically:

- single files that are correct on the first try — scripts, configs, one-page
  HTML, small utilities
- editing files you already have, when you can describe the change
- generating several related files at once

Not yet:

- anything needing dependencies installed
- anything where "does it actually run?" is the real question
- large multi-file projects where the model needs to explore the codebase first

**Verdict:** somewhere between "prints code you copy" and "builds apps". Closer
to the first than the second. The next step is what closes the distance.

---

## Next steps, in order

### 1. Auth — before anything else

Right now anyone who can reach the app can read and write files in
`data/workspaces/`. On your own machine that's fine. The moment it goes on a
server it is not, and step 3 makes it far worse.

This is a hard blocker on hosting, not a nice-to-have.

### 2. Command execution in a sandbox

This is the one that changes what the product *is*. The model gets a
`run_command` tool, so it can:

```
write app.py  →  run it  →  read the error  →  fix it  →  run again
```

That loop is the difference between a code generator and an agent.

It cannot ship without a sandbox. Letting a language model run shell commands
on your machine is how you lose your files. The plan (already specced in
`workspace-plan.md`) is Docker with:

```
--network none --memory 512m --cpus 0.5 --pids-limit 128
--read-only --cap-drop ALL --security-opt no-new-privileges
--user 1000:1000  + 30-60s wall-clock timeout
```

Needs a real server — the Hetzner CX33 at about €6.50/month is the pick.

### 3. Live preview

Once things can run, show the result. A panel with the running app in it, the
way Arena does. Only meaningful after step 2.

### 4. Project awareness

Let a workspace point at a real folder on your machine, and give the model a
way to explore it before editing — so it can work on projects you already have
rather than only starting fresh.

---

## Smaller things worth doing

Not big enough to be phases, but each is real:

- **Diff view** — right now you see the final file, not what changed. When the
  model edits an existing file you should see the before and after.
- **Undo a file change** — no way to revert what the model wrote.
- **Per-chat cost in the sidebar** — you liked this idea earlier.
- **Model switching mid-chat** — start on Flash, escalate to Pro when it gets
  hard.
- **Migrate old Postgres chats** to the file store. Nothing was deleted, but
  they aren't visible.

---

## What we know actually works

Everything below was measured, not assumed:

| | |
|---|---|
| Real DeepSeek tool use | write_file → read_file, correct output, 6.1s, $0.00061 |
| Workspace safety | 7 path-escape attacks blocked, at both the tool and HTTP layers |
| Delete | 10 checks including the mid-reply race that used to resurrect chats |
| Long chats | 50,000 messages still render in ~70-84ms |
| Cross-platform | tests pass on Windows, macOS, Linux |

Run them yourself:

```bash
npm run test:workspace   # free, uses a fake DeepSeek
npm run test:delete      # free
npm run test:real        # real API, under a cent
```
