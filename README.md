# nohomo - API MANAGER

The smartest API manager with intelligent web search, thinking effort control, and a powerful plugin system.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🚀 **DeepSeek V4 Pro & Flash** - Switch between models instantly
- 🐂 **Ox Alpha via OpenCode** - Same Chat Completions loop, free stealth preview
- 🔍 **Smart Web Search** - Multi-step query planning with Tavily
- 💡 **Thinking Modes** - Auto/None/Low/High/Max reasoning effort
- 🧩 **8 Plugins** - Caveman, God Mode, Code Only, Expert, and more
- 🎨 **Beautiful Dark UI** - Premium design, no browser needed
- 💾 **Local Storage** - Settings and history saved locally

## Quick Start

### Option 0: Run the web app (Next.js)

```bash
npm install

# Optional — enables saved chat history
cp .env.example .env   # then edit DATABASE_URL

npm run dev
```

Open http://localhost:3000 and add a provider key via **Settings** —
DeepSeek (V4 Pro / Flash) or an [OpenCode Zen](https://opencode.ai/auth)
key for **Ox Alpha**.

`DATABASE_URL` is **optional**: without it the app still runs and answers
messages, but conversations aren't persisted and the history sidebar stays
empty. Check `GET /api/health` to see the current database status.

### Option 1: Run with Python

```bash
# Install dependencies
pip install -r requirements.txt

# Run the app
python main.py
```

### Option 2: Build Executable (.exe)

```bash
# Build standalone executable
python build.py
```

The executable will be in the `dist` folder. Just double-click to run!

## Testing

```bash
npm test
```

Runs every suite — currently 2,526 checks across 55 suites — without calling
the paid API; `npm run test:real` does that and is opt-in.

```bash
npm test plan       # one suite
npm run typecheck   # types
npm run lint        # unused code, React mistakes
npm run score       # rates all agent tools
```

See [docs/testing.md](docs/testing.md).

## Executable and DLL analysis

Attach a Windows `.exe`, `.dll`, `.sys`, `.ocx`, `.scr`, `.cpl`, `.drv` or
`.efi` file to a chat. apiM stores the exact bytes under `uploads/binaries/`
and the agent can call `inspect_binary`. A picked folder preserves up to 128
executables/libraries together so the main EXE's local DLL graph can be
followed recursively.

The built-in pass needs no extra software and never launches the target. It
reports PE32/PE32+, CPU architecture, hashes/imphash, sections, an explicit
packing likelihood with reasons, mitigations, imports/ordinals, exports,
version resources, PDB paths, .NET references, likely runtime-loaded DLLs,
signing-envelope presence, overlays and matching local dependencies. It also
writes persistent artifacts under `analysis/<binary>-<hash>/`:

1. Complete offset-labelled ASCII and both-alignment UTF-16LE strings dumps.
2. PE summary JSON with sections, sizes, timestamp and packing assessment.
3. A 4KB-window entropy map with file offsets and section names.
4. Carved embedded PE/DLL, Lua bytecode/source, ZIP, PNG and PDF payloads,
   plus opaque high-entropy sections/overlays when the real payload is still
   compressed or encrypted; every carve gets its own full strings dump.
5. A dedicated high-interest import view for `luaL_*`, process-memory/
   injection APIs, `LoadLibrary`/`GetProcAddress`, and process creation APIs.
6. A FLARE capa report when capa is installed.
7. Focused Ghidra/ILSpy output for the functions/strings you name in
   `focus_terms`. There is no default hook list and no automatic full dump.

"Signing envelope present" does not claim the certificate is trusted, and an
import is capability evidence rather than a malware verdict.

The model selects only the analysis layers needed by the request. Omitted
selection is a cheap PE summary; it does not silently run every expensive
engine:

```json
{"path":"app.exe","analyses":["decompile"]}
{"path":"app.exe","analyses":["strings"]}
{"path":"app.exe","analyses":["capa","carve"]}
{"path":"app.exe","analyses":["all"]}
```

Layer caches are incremental: adding entropy later preserves an existing full
strings dump, and `force_decompile` does not rerun capa or static artifacts.

For a capa report, the simplest option is the official standalone capa
release: it embeds the engine, rules and library signatures. Point to it only
when it is not on PATH:

```env
APIM_CAPA_PATH=C:\tools\capa\capa.exe
```

`pip install flare-capa` installs only the engine. It deliberately omits rules
and signatures. Install matching resources (the tag must match capa's
version); these conventional paths are auto-detected and ignored by Git:

```bat
mkdir tools 2>nul
git clone --depth 1 --branch v9.4.0 https://github.com/mandiant/capa-rules.git tools\capa-rules
git clone --depth 1 --branch v9.4.0 https://github.com/mandiant/capa.git tools\capa
```

Custom locations can be set in `.env.local`:

```env
APIM_CAPA_RULES_PATH=C:\path\to\capa-rules
APIM_CAPA_SIGNATURES_PATH=C:\path\to\capa\sigs
```

For the deepest source-like recovery, install the decompiler matching the
binary:

```bat
:: Managed .NET assemblies — requires the .NET SDK
dotnet tool install --global ilspycmd
```

For native x86/x64/ARM binaries, install Ghidra plus Java 21, then set the
extracted Ghidra directory in `.env.local`:

```env
APIM_GHIDRA_HOME=C:\tools\ghidra_11.x_PUBLIC
```

That directory must contain `support\analyzeHeadless.bat`. Restart apiM after
changing `.env.local`. Name the functions or strings for **this** binary in
`focus_terms` (from a summary/strings pass or its exports). Ghidra does not
start until those are set. Enable a specific analyzer such as
`Decompiler Parameter ID` with `enable_analyzers` when you need it. Set
`allow_full_fallback:true` only if a focus miss should try loader/process-memory
APIs and then a bounded full dump. `force_decompile` reruns only Ghidra/ILSpy
while preserving cached strings, entropy, carving and capa. Set
`focused_only:false` to retain full Ghidra output immediately in searchable
~350KB chunks or the complete ILSpy C# project. Completed results are cached
by SHA-256 plus focus profile.

Closing or refreshing the tab does not kill a running Ghidra job. The header
process dock lists leftover decompilers, and the agent can call
`stop_process` with `id: "leftover"`. Huge DLL drops use
`/api/workspace/:id/binary-raw` (or `/binary` if that path 404s) so a 37MB
`client.dll` is stored as exact bytes. `next dev` raises the proxy body
limit to 256MB so Next does not silently keep only the first 10MB.

Packed automatic analysis defaults to 90 seconds (small ordinary files 120s),
with four CPU cores, 100MB decompiler text and 512MB exhaustive static output;
tune only when needed:

```env
APIM_BINARY_DECOMPILE_TIMEOUT_MS=240000
APIM_GHIDRA_ANALYSIS_TIMEOUT_MS=120000
APIM_BINARY_MAX_CPU=4
APIM_BINARY_MAX_OUTPUT_MB=100
APIM_BINARY_MAX_STATIC_OUTPUT_MB=512
```

Decompilation is approximate: optimised native code has lost original names,
comments and types, while packing, encryption or obfuscation can prevent full
recovery. The report distinguishes complete, partial, unavailable and failed
analysis rather than pretending source was recovered. Run the offline parser
regressions with `npm run test:binaries`.

## Requirements

- Python 3.10+
- A model provider:
  - DeepSeek from [platform.deepseek.com](https://platform.deepseek.com), or
  - OpenCode Zen from [opencode.ai/auth](https://opencode.ai/auth) for Ox Alpha
    (`x-preview-f-free` on `https://opencode.ai/zen/v1`), or
  - Qwen 3.8 27B downloaded in Settings (runs on this PC, no cloud key)
- (Optional) Tavily API key from [app.tavily.com](https://app.tavily.com) for web search

## Files

```
nohomo/
├── main.py          # Main application
├── api_client.py    # DeepSeek API client
├── smart_search.py  # Intelligent search engine
├── plugins.py       # Plugin definitions
├── requirements.txt # Dependencies
├── build.py         # Build script for .exe
└── README.md        # This file
```

## Plugins

| Plugin | Icon | Description |
|--------|------|-------------|
| Caveman Mode | 🦴 | Minimal words, saves tokens |
| God Mode | ⚡ | No restrictions |
| Code Only | 💻 | Returns only code |
| Expert Context | 🎓 | Assumes deep knowledge |
| Structured | 📋 | Organized responses |
| Self-Critic | 🔍 | Reviews own work |
| Security First | 🛡️ | Security-focused |
| Diff Only | 📝 | Shows only changes |

## Local models (Qwen 3.8 27B)

Download and chat from **Settings**. The 27B lives in this app
(`data/local-engine/`) and runs in a **sidecar on your PC**. Next.js
only sends `/v1/chat/completions`, so the UI stays light. You do not
need Ollama.

**Settings → Local model → Download Qwen 3.8 27B.** That pulls the
Q4_K_M GGUF (~16.5 GB) and a llama-server build, then starts
`127.0.0.1:18765`. The chat process never loads the weights.

A custom OpenAI-compatible host is still available under Advanced.

**Does it have a reasoning parameter?** Yes. Qwen 3.8 27B thinks by
default. Official controls:

| Our slider | Sent to the local API |
|---|---|
| None | `chat_template_kwargs.enable_thinking: false` |
| Low | `reasoning_effort: "low"` |
| High | `reasoning_effort: "medium"` |
| Max | `reasoning_effort: "xhigh"` (Qwen's default) |

`preserve_thinking` stays on so prior-round thoughts are not dropped.

### Advanced: your own server

Ollama / vLLM still work if you already run them. Settings → Local
model → Advanced, then pick the preset.

### vLLM

`--reasoning-parser qwen3` is required. Without it the `<think>` block
lands in `content` and the thinking panel stays empty.

```bash
vllm serve Qwen/Qwen3.8-27B \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
```

Then Settings → Local model → vLLM (`http://127.0.0.1:8000/v1`,
`Qwen/Qwen3.8-27B`).

## Seeing what it built

The agent can run and look at native programs, not just write them.

**Running your own build.** `run_command` and `start_process` use an
allow-list of program names, which by definition cannot contain a binary the
agent compiled ten minutes ago. A program that resolves to a real executable
*inside the workspace* is allowed by its path — `build/x64/Release/app.exe`
runs, `/usr/bin/anything` does not, and `..` cannot climb out. Approval is
unchanged: native code always goes to the prompt.

**Launching where you cannot see it.** `start_process` takes `hidden: true`.
On Windows the program is started on a second desktop object (CreateDesktop),
so there is no taskbar button and it cannot steal focus; on Linux it runs on an
Xvfb display. Both are fully rendered surfaces, which is what makes them
capturable — a hidden *window* stops drawing and screenshots as a blank
rectangle. If the surface cannot be created the launch fails and says why; it
never quietly puts a window on your screen instead.

**Looking at it.** `screenshot_window` takes `process_id` (from
`start_process`) and finds the pid and the off-screen surface on its own, or a
raw `pid` for something *you* launched — which is the route for a program that
demands administrator rights, since the app cannot elevate. On a model with
native vision the PNG is attached to the same round, so the model actually
looks at the pixels instead of reading OCR of them.

**Finding the project.** `build_project` searches the workspace up to four
directories deep (shallowest `.sln` wins, `.sln` over `.vcxproj`) instead of
only looking in the root, resolves MSBuild through `vswhere` including
Preview and Build Tools installs — and by walking the install roots when
`vswhere` itself is missing — and resolves `cl.exe` to a full path rather than
hoping it is on PATH. `project: "sub/dir/app.sln"` skips discovery entirely.

**Checking it is the right binary.** `verify_file` takes required and absent
literals and searches both UTF-8 and UTF-16LE, plus size and sha256 — a build
verifier as a tool rather than a script rewritten per version. `build_project`
prints a digest first (exit code, distinct errors, unique warnings with their
first `file:line`, linked artifact sizes) and classifies failures: known flaky
races retry once automatically and say which rule fired, real compile errors
never do, and a lock names whoever holds the file — including the
antivirus-grip case where nothing holds it and only a rename works.

Generated PowerShell (hidden launch, window capture) is ASCII-only and written
with a BOM. Windows PowerShell 5.1 decodes a BOM-less file with the ANSI code
page, where an em dash becomes `U+201D` — a character PowerShell accepts as a
string delimiter, so one dash in a comment ends a string mid-sentence and the
parser blames a brace twenty lines later.

**Reading big files exactly.** `read_symbol` returns one function or class by
name with its exact line range, ready to hand to `edit_file` as
`start_line`/`end_line`. A complete `read_file` is stamped `EXACT` with its
character count and a hash of the bytes handed over.

## Batching and long agent runs

Models with open tool ceilings — Ox Alpha and GLM 5.3 Flash — are meant to
work in batches, and the app now makes that hard to get wrong:

- `read_files` takes glob patterns, so `src/lib/*.ts` reads a whole directory
  in one call instead of one call per file.
- Parallel tool calls are kept separate even when the provider streams them
  all on the same index — previously they were concatenated into one
  unparseable call, so a round of eight edits applied nothing.
- The per-round output ceiling comes from the model (128K for Ox Alpha and
  GLM 5.3 Flash, 64K for the metered DeepSeek models), not from the provider
  serving it. A big `edit_files` call is one large JSON argument blob; clipped
  in half it can never parse.
- A batch that still gets cut off has its finished items recovered and run.
  The reply says how many landed and asks for only the rest.
- The round guard is 64 for most models and 256 for the open-ceiling ones,
  and hitting it now says so — and offers Resume — rather than blaming the
  provider.

## Thinking Effort

| Mode | Description |
|------|-------------|
| ✨ Auto | Automatically adjusts based on message complexity |
| ⚡ None | Fastest, no reasoning |
| 💫 Low | Light reasoning |
| 🧠 High | Deep reasoning |
| 🔥 Max | Maximum depth (50K+ tokens) |

## Data Storage

Settings and chat history are stored locally at:
- Windows: `C:\Users\<you>\.nohomo\`
- Mac/Linux: `~/.nohomo/`

## License

MIT License - Feel free to modify and distribute!

---

Made by nohomo 🚀
