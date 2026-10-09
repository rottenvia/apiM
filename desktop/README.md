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

The same things as the web app, with the same look:

- Chat with streaming, thinking, markdown, tables, highlighted code, colour emoji, and the split reply layout
- The same models as the web app, any OpenRouter model by its slug, and the local Qwen model downloaded and run from Settings
- An agent with all 59 of the web app's tools: files (with undo and patches), code lookup, search, commands, tests and builds, background processes, web search, page inspection and a real browser, documents (PDF, Word, Excel, PowerPoint), archives, data queries, binary analysis (Ghidra, ILSpy and capa when installed), the Linux sandbox, git and GitHub, snapshots, a plan and findings, and helper agents
- The web app's guards around the agent: retries, stalled-stream and loop detection, a spending limit per reply, context pruning and folding at 65% of the model's window
- **Manual** mode asks before a command runs. **Auto** mode runs developer tools without asking
- Rewind to any question (chat and files), Resume for a reply that stopped, Compare for regenerated replies
- Slash commands, find in chat (Ctrl+F), notes to a running task (`/btw`)
- The workspace panel with file tree, editor, diffs and restore points; the process list; import from a folder
- Attach files, folders, pictures and clips, or paste a picture or copied files with Ctrl+V; models that cannot see get a description of each picture
- GitHub: connect a repository with a token, push, open and follow pull requests
- MCP servers, the same 8 plugins plus your own, search budget
- A problem report (Settings, Reports) that sorts what went wrong by likely cause: the app first (crashes, frozen frames), then this PC, the provider, and a model's slips only when the same one repeats
- A theme wall of its own: deep, tinted grounds with one vivid accent each, and the editor classics on darker grounds than the web's
- A terminal mode: `apim --ask "your question"` (add `--auto` to let it run commands, `--dir FOLDER` to pick the folder)

The browser tool drives a Chromium-family browser already on the PC (Edge, Chrome, Chromium, Brave or Thorium, or the one `APIM_BROWSER_PATH` names) with a throwaway profile. Nothing is bundled or downloaded.

## Not here yet

- GitHub sign-in through the browser (the token field works)
- Screenshots of a hidden desktop for apps the agent starts
- Stills from a video clip for models that cannot watch it
- Pointing a chat at a folder of your own from the window (terminal mode has `--dir`; the window copies files in, as the web app does)
- A few small web touches: the offline banner, the resume-with-another-model menu

## Where things are saved

The desktop app and the web app share chats, workspaces, plugins, MCP servers and restore points.

| What | Where |
| --- | --- |
| Settings and keys | `%APPDATA%\apiM\settings.json` |
| Chats, workspaces and the rest | the repo's `data` folder when the program runs from inside the repo, otherwise `%APPDATA%\apiM` |

Set `APIM_DATA_DIR` to keep the data somewhere else.

## Staying in step with the web app

Tool descriptions, prompts, plugins and the model list come from the web app's source, so both versions tell the models the same thing. The theme wall is the one list kept apart (`assets/themes.json`). After changing the others in the web app, run this from the repo root:

```bash
npx tsx desktop/sync-from-web.mts
```

## Tests

```bash
cargo test
```

## When it feels slow

Set `APIM_PERF=4` before starting the program. It then prints, on stderr, every frame that took it longer than 4 ms to draw, every wait of over 40 ms between two frames while a reply is being written, and, when a reply ends, the longest any of its text waited to be shown.

Long chats stay quick because only what is on screen is laid out. A chat is read from disk and saved on other threads, so neither holds up the window.

A reply's text is shown at the pace it arrives, behind a small buffer (`src/ui/pacer.rs`, the web app's `pacer.ts`). Providers send text in bursts; shown as it lands, it types, stops and types again.

The buffer is only worth its delay while text comes quickly, so here it parts from the web: waiting text is never shown slower than eight words a second, and a reply that comes whole is typed out in under half a second. A busy provider sending a word a second then shows each word as it comes, where it used to crawl a second and a half behind and jump at the end. When nothing has come for two seconds in the middle of a reply, the row under it says it is waiting for the model.

Three things are written to the problem report so that slowness nobody was measuring can be found afterwards, and told apart: a frame that took over a quarter of a second, and text that waited over two seconds to be shown (both the app's doing), and a reply whose text came at under 15 characters a second (the provider's).

## Checking the look without touching the window

`APIM_SHOT=out.png` makes the program draw one state off screen, save a picture of it and quit. `APIM_SHOT_STATE` names the state as a comma-separated list (`settings`, `tab4`, `wait-row`, `stalled`, `theme-midnight`, `no-sidebar`, `up-330` to turn the wheel back that many points, `maximized,f11` for full screen, and more in `ui/mod.rs`), `APIM_SHOT_CHAT` picks the chat by a part of its title, and `APIM_SHOT_SIZE=1400x900` sets the window.

`APIM_SHOT_STATE=send` with `APIM_SHOT_DRAFT="..."` really sends that message and takes the picture when the reply has ended. Point `APIM_DATA_DIR` at a spare folder first, so the chat it makes is not one of yours.
