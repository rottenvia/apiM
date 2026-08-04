# How to test the workspace right now

The workspace lets the AI **create and edit real files on your computer** instead
of printing code for you to copy. The engine is finished. The buttons in the app
are not — so for now you test it from the terminal.

There are two ways. Start with the first.

---

## Way 1 — the one-command check (free, 10 seconds)

```bash
cd apiM
npm run test:workspace
```

This starts a **fake DeepSeek** on your machine, points the app at it, asks it to
create a file, and then checks the file really appeared. It never touches the
real DeepSeek, so **it costs nothing** — no tokens, no money, no API key needed.

You should see:

```
apiM workspace self-test

1. The AI creates a real file
  PASS  the model called a tool                write_file → read_file
  PASS  write_file ran and succeeded           Created hello.py
  PASS  read_file ran afterwards (multi-round loop works)
  PASS  the file exists on disk                data/workspaces/selftest/hello.py
  PASS  the file has the right contents        "print(\"hello from apiM\")"
  PASS  the model gave a final answer          Done — I created `hello.py` …

2. Split-up tool arguments are reassembled
  PASS  arguments arrived split and were stitched back together

3. The AI cannot escape the workspace folder
  PASS  all 6 escape attempts were blocked     6/6 blocked

4. Workspace off really means off
  PASS  no tools were run
  PASS  no files were created

All 10 checks passed.
```

Then look at the file it made with your own eyes:

```bash
cat data/workspaces/selftest/hello.py
```

If something fails, run it again with more detail:

```bash
VERBOSE=1 npm run test:workspace
```

### What each section is actually proving

**1 — the whole point.** The AI asked for a file to be written, the app wrote it,
the AI then read it back to check, and only then answered. That's an agent loop,
not a chatbot.

**2 — the subtle one.** Real APIs send the filename in pieces across the network:
`{"path":"hel` … `lo.py","content":…`. If the app acted too early it would create
a file called `hel`. This proves it waits and reassembles.

**3 — the safety one.** The *AI* chooses the filenames, so it could choose
`../../etc/passwd`. Six different escape tricks are thrown at it and all six are
refused. Files can only ever land inside `data/workspaces/`.

**4 — the trust one.** With the workspace switched off, the fake model tries to
write a file anyway (real models do this uninvited). Nothing runs, nothing is
created, and the tools aren't even offered to it.

---

## Way 2 — drive it by hand and watch files appear

This is the fun one. Two terminals.

**Terminal 1 — start the fake DeepSeek:**

```bash
cd apiM
npm run mock:deepseek
```

**Terminal 2 — start the app pointed at the fake:**

```bash
cd apiM
npm run dev:mock
```

**Terminal 3 (or the same one) — send a request:**

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "create notes.md with a heading",
    "deepseekApiKey": "sk-mock",
    "workspaceEnabled": true,
    "workspaceId": "myfiles"
  }'
```

You'll watch it happen live:

```
{"type":"status","stage":"thinking"}
{"type":"reasoning","delta":"I should create notes.md."}
{"type":"status","stage":"working"}
{"type":"tool_start","name":"write_file","args":"{\"path\":\"notes.md\",…}"}
{"type":"tool_result","name":"write_file","ok":true,"summary":"Created notes.md"}
{"type":"tool_start","name":"read_file",…}
{"type":"content","delta":"Done — I created `notes.md` …"}
```

And the file is really there:

```bash
ls data/workspaces/myfiles/
cat data/workspaces/myfiles/notes.md
```

Change `notes.md` in the message to `script.js`, `index.html`, `data.json` — the
fake model picks the filename out of your sentence, so you can create whatever
you like.

Try breaking it, too:

```bash
# workspace off — should refuse and create nothing
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"create evil.py","deepseekApiKey":"sk-mock","workspaceEnabled":false}'
```

---

## Way 3 — with the real DeepSeek (costs a few cents)

Everything above uses a fake model. The fake always behaves perfectly, so it
proves the *plumbing* works — it does **not** prove the real DeepSeek picks
sensible tools.

To test for real, just start the app normally (`npm run dev`, real key in
Settings) and send the same curl, but with your actual key:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "create a python script fizzbuzz.py that prints fizzbuzz to 20",
    "deepseekApiKey": "sk-YOUR-REAL-KEY",
    "workspaceEnabled": true,
    "workspaceId": "real-test"
  }'
```

Expect this to cost well under one cent. Watch whether it picks `write_file`
straight away or fumbles around first — that's the one thing no local test can
answer.

---

## Cleaning up

Everything the tests make lives in `data/workspaces/`, which git ignores. Delete
it whenever you like:

```bash
rm -rf data/workspaces
```

---

## What still doesn't exist

There is **no button in the app** for any of this yet — no workspace toggle, no
file list, no way to see what the AI changed. That's the next piece of work.
Until it's built, the terminal is the only way in.
