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

Runs every suite — currently 1,862 checks across 47 suites — without calling
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
reports PE32/PE32+, CPU architecture, hashes/imphash, sections and entropy,
mitigations, imports and imported function names, exports, version resources,
PDB paths, .NET assembly references, likely runtime-loaded DLL names, selected
ASCII/UTF-16 strings, signing-envelope presence, overlays and matching local
DLL dependencies. "Signing envelope present" does not claim the certificate is
trusted; trust verification is deliberately reported separately.

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
changing `.env.local`. Ghidra output is written in searchable ~350KB chunks
under `analysis/<binary>-<hash>/ghidra/`; ILSpy writes a C# project under the
matching `ilspy/` directory. Completed results are cached by SHA-256. Defaults
limit native analysis to four minutes, four CPU cores and 100MB of recovered
text; tune only when needed:

```env
APIM_BINARY_DECOMPILE_TIMEOUT_MS=240000
APIM_BINARY_MAX_CPU=4
APIM_BINARY_MAX_OUTPUT_MB=100
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
