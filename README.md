# nohomo - API MANAGER

The smartest API manager with intelligent web search, thinking effort control, and a powerful plugin system.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🚀 **DeepSeek V4 Pro & Flash** - Switch between models instantly
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

Open http://localhost:3000 and add your DeepSeek API key via **Settings**.

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

Runs every suite — currently 1,882 checks across 47 suites — without calling
the paid API; `npm run test:real` does that and is opt-in.

```bash
npm test plan       # one suite
npm run typecheck   # types
npm run lint        # unused code, React mistakes
npm run score       # rates all 36 agent tools
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
7. Focused Ghidra/ILSpy output for functions referencing `CreateMove` or
   `IN_JUMP` by default.

"Signing envelope present" does not claim the certificate is trusted, and an
import is capability evidence rather than a malware verdict.

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
changing `.env.local`. By default the tool resolves symbols/strings named
`CreateMove` and `IN_JUMP`, follows their references and keeps those functions
in `focused-functions.c` / `focused-functions.cs`. If stripped/packed code has
no surviving focus reference, Ghidra automatically falls back to bounded full
decompilation instead of reporting an empty success. Set
`focused_only:false` in a tool call to retain full Ghidra output immediately in
searchable ~350KB chunks or the complete ILSpy C# project. Completed results
are cached by SHA-256 plus focus profile. Defaults limit native analysis to
four minutes, four CPU cores, 100MB of decompiler text and 512MB of exhaustive
static artifacts; tune only when needed:

```env
APIM_BINARY_DECOMPILE_TIMEOUT_MS=240000
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
- DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com)
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
