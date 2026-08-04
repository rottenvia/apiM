# How to test the workspace right now

The workspace lets the AI **create and edit real files on your computer** instead
of printing code for you to copy. The engine is finished. The buttons in the app
are not — so for now you test it from the terminal.

There are two ways. Start with the first.

Everything below works on **Windows, macOS and Linux**. On Windows use
PowerShell or the plain Command Prompt — nothing here needs Git Bash or WSL.

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
# macOS / Linux
cat data/workspaces/selftest/hello.py
```

```powershell
# Windows
type data\workspaces\selftest\hello.py
```

If something fails, run it again with more detail:

```bash
# macOS / Linux
VERBOSE=1 npm run test:workspace
```

```powershell
# Windows PowerShell
$env:VERBOSE=1; npm run test:workspace
```

```
:: Windows Command Prompt
set VERBOSE=1 && npm run test:workspace
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
# macOS / Linux
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "create notes.md with a heading",
    "deepseekApiKey": "sk-mock",
    "workspaceEnabled": true,
    "workspaceId": "myfiles"
  }'
```

On Windows, `curl` chokes on single quotes, so use PowerShell instead:

```powershell
# Windows PowerShell
$body = @{
  message         = "create notes.md with a heading"
  deepseekApiKey  = "sk-mock"
  workspaceEnabled = $true
  workspaceId     = "myfiles"
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:3000/api/chat -Method Post `
  -ContentType 'application/json' -Body $body
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
# macOS / Linux
ls data/workspaces/myfiles/
cat data/workspaces/myfiles/notes.md
```

```powershell
# Windows
dir data\workspaces\myfiles\
type data\workspaces\myfiles\notes.md
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

## Way 3 — with the real DeepSeek (costs under a cent)

Everything above uses a fake model. The fake always behaves perfectly, so it
proves the *plumbing* works — it does **not** prove the real DeepSeek picks
sensible tools. This is the one thing no local test can answer.

```bash
npm run test:real
```

It asks for your API key, starts the app itself, sends **one** real request,
and tells you what happened. No quotes, no escaping, no second terminal.

```
apiM workspace — REAL DeepSeek test

  Paste your DeepSeek API key and press Enter.
  It starts with sk- . No quotes needed — just paste it.

  key: ‹paste here›

  Asking DeepSeek:
  "create fizzbuzz.py that prints fizzbuzz for the numbers 1 to 20"

  → calling write_file {"path":"fizzbuzz.py","content":"for i in range(1,21):…
  ← write_file ok Created fizzbuzz.py
  → calling read_file {"path":"fizzbuzz.py"}
  ← read_file ok Read fizzbuzz.py

  Result

  YES  the real model used the file tools  (write_file -> read_file)
  YES  it successfully wrote a file
  YES  fizzbuzz.py is on your disk  (data/workspaces/real-test/fizzbuzz.py)
  time: 14.2s   rounds: 2
  tokens: 1204 in, 386 out   cost: about $0.00086

  What it wrote:

    for i in range(1, 21):
        if i % 15 == 0:
            print("FizzBuzz")
    …

  It works with the real model.
```

The key is saved to `data/.deepseek-key` so you're only asked once. That folder
is ignored by git, so **the key never leaves your machine and can never be
committed**. To use a different key, delete that file.

You can also set it as an environment variable instead, if you prefer:

```powershell
# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-your-key"; npm run test:real
```

### What the answer means

**`YES` on all three** — the real model uses the tools properly. The workspace
is genuinely ready.

**`NO` on "used the file tools"** — the model ignored them and printed code in
the chat instead. That's a real finding, not a crash: the tool descriptions
need work. Send me the output.

**A rejected key** — delete `data/.deepseek-key` and run again to re-enter it.

---

## Cleaning up

Everything the tests make lives in `data/workspaces/`, which git ignores. Delete
it whenever you like:

```bash
# macOS / Linux
rm -rf data/workspaces
```

```powershell
# Windows
rmdir /s /q data\workspaces
```

---

## If something goes wrong

**`'DEEPSEEK_BASE_URL' is not recognized`** — you're on an old copy. Pull again;
the scripts no longer use Unix-only shell syntax.

**`spawn npx ENOENT`** — same thing, old copy. The scripts now launch Next
directly instead of going through `npx`.

**`Cannot find module 'next'`** — run `npm install` first.

**Something else** — run with `VERBOSE=1` (see above) and send me the output.
The test prints the reason it couldn't start rather than hanging.

---

## What still doesn't exist

There is **no button in the app** for any of this yet — no workspace toggle, no
file list, no way to see what the AI changed. That's the next piece of work.
Until it's built, the terminal is the only way in.
