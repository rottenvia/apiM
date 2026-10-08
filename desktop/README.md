# apiM desktop

The native version of apiM. Written in Rust and drawn with [egui](https://github.com/emilk/egui).

No Chromium, no Electron, no web view, no Node. One program.

## Run it

You need [Rust](https://rustup.rs).

```bash
cd desktop
cargo run --release
```

The program ends up at `desktop/target/release/apim.exe`. You can copy that one file anywhere.

Open **Settings** and paste an OpenRouter or DeepSeek key. Keys stay on your PC.

## What it does

- Chat with streaming, thinking, markdown, tables and highlighted code
- The same models as the web app, and you can add any OpenRouter model by its slug
- An agent with 36 tools: read, write and edit files (with undo), search, run commands and tests, keep background processes running, fetch pages, search the web, download files, keep a plan and findings, ask you questions, look at images, use git
- **Manual** mode asks before a command runs. **Auto** mode runs developer tools without asking
- Every chat has its own folder, or you can point a chat at any project on your PC
- The same 8 plugins, plus your own
- A spending limit per reply
- A terminal mode: `apim --ask "your question"` (add `--auto` to let it run commands, `--dir FOLDER` to pick the folder)

## Not here yet

The web app still does more. These are not ported:

- Browser tools (browse, inspect page) and screenshots of windows
- Sandbox (WSL) and the hidden desktop
- Binary analysis (Ghidra, capa)
- MCP servers
- Subagents
- GitHub sign-in and pull request tools
- Snapshots and rewind
- Reading PDF and Office files, archives, data queries
- Downloading and running the local Qwen model from inside the app (a local server you start yourself works)
- Image help for models that cannot see

## Where things are saved

| What | Where |
| --- | --- |
| Settings and keys | `%APPDATA%\apiM\settings.json` |
| Chats | `%APPDATA%\apiM\chats` |
| Chat folders | `%APPDATA%\apiM\workspaces` |

Set `APIM_DATA_DIR` to keep everything somewhere else.

## Staying in step with the web app

Tool descriptions, prompts, plugins and the model list come from the web app's source, so both versions tell the models the same thing. After changing them in the web app, run this from the repo root:

```bash
npx tsx desktop/sync-from-web.mts
```

## Tests

```bash
cargo test
```
