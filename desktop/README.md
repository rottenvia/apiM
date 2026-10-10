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
- Tools on demand and a catalog of skills, both described below: a request carries about a third of what it did, and plugins can be added, by you or by the assistant, to one chat or to all
- A problem report (Settings, Reports) that sorts what went wrong by likely cause: the app first (crashes, frozen frames), then this PC, the provider, and a model's slips only when the same one repeats
- A theme wall of its own: deep, tinted grounds with one vivid accent each, and the editor classics on darker grounds than the web's
- A terminal mode: `apim --ask "your question"` (add `--auto` to let it run commands, `--dir FOLDER` to pick the folder, `--note "text"` to hand the reply a "btw" after its first step, `--think` to print its thinking)

The browser tool drives a Chromium-family browser already on the PC (Edge, Chrome, Chromium, Brave or Thorium, or the one `APIM_BROWSER_PATH` names) with a throwaway profile. Nothing is bundled or downloaded.

## The computer, not only the chat's folder

The assistant runs on your own computer, and it is told so. It works at three depths: its workspace (the chat's folder, where everything it creates or changes goes), the computer around it, which it can look at, and the Linux sandbox when one is set up. Asked about a crash, a slow start or a setting, it is to investigate (read the logs and crash dumps, ask the event log, check versions and what is running) and to turn to you only for what only you can do. Before this it answered such a question with a list of steps for you, because "it could not see your machine".

- **What it is told about the computer** (`src/machine.rs`), read once when the app starts and sent with every request: the system and its build, the home folder and where programs keep their data, which of the usual programs are installed, the workspace's path, today's date, and how approvals are set. No chat starts by finding these out.
- **Looking at files.** `list_files`, `read_file` and `read_files` take a path written in full (`C:\...`, `~/...`, `%LOCALAPPDATA%\...`). Outside the workspace a folder is listed one level at a time, newest files first. Writing, editing, moving and deleting stay inside the workspace.
- **Asking the system.** `run_command` runs the system's own looking tools (`tasklist`, `systeminfo`, `wevtutil qe`, `reg query`, `sc query` and others; their changing forms are refused) and, on Windows, PowerShell. PowerShell's text is read first: while every command in it only looks (Get, Select, Where, Sort, Format, Measure, Test and their short names) it runs as any other command; text that could change the computer asks you in every mode, "Run automatically" included. That reading is a word list, there to catch a change made in passing; it does not hold a program the assistant writes and runs, which was always free to do what you can do.
- **Approval.** With "Ask me first" you allow each folder outside the workspace before it is looked into ("Look in this folder?", once or for the chat) and each command. With "Run automatically" looking does not ask.
- **Closed places.** Folders and files that keep sign-ins and keys (SSH and cloud keys, browser profiles, the system's credential stores, `.env` files, this app's own settings) are not read by a file tool or named in a PowerShell command, in any mode: what a tool reads goes to the model's provider.

## What a request carries

Every round of a reply sends the whole conversation again, so what stays in it is paid for every round. Three things kept a long chat far bigger than its work (measured on a real one: 1.7 million characters a round):

- **The same file read again.** A model that asks for one big file every round got its text every round, 400,000 characters each time. A call asked again whose answer is still in the conversation, byte for byte, now gets one line pointing at it (`compact::repeat_of`). The earlier copy stays where it is, so the start of the request does not move and the provider's cache of it holds. Once that copy has been collapsed as old, the file is read out again. Only the text that came back is compared, not how it was asked for: the same file asked for with another last line each time returned the same 400,000 characters and counted as a new call. Copies already in a conversation are folded the same way before every round, a note on the end of one ("you already read this") no longer making them differ.
- **Old pastes.** A log pasted five questions ago rode whole on every round of every later reply. An earlier message of yours over 16,000 characters now goes out as its first and last 8,000, with a line saying so. The newest earlier message and the one being answered are never cut. The chat itself keeps everything. Resume replays the transcript saved with the unfinished reply, so the same cut is made in that transcript when it is taken up.
- **Notes to a running task** (`btw …`, `/btw`). The note took the request's place in the reminder that ends every round, so a question asked in passing was read as the task and answered again each round. The reminder now keeps the request and only points at the notes; the note itself says to answer once and go on. A note shows in the chat at once, as a quiet line above the reply: the card that came and went above the message box is gone.

Two more were found by reading what that chat was billed: 28 million tokens for one reply, 36% of them outside the provider's cache, and over the whole chat nine tenths of the money went on input the cache did not cover.

- **Collapsing an old result every round.** The newest eight tool results stay whole and older ones become one line. Done one a round, a message in the middle of the request changed every round, and the provider's cache of everything after it, the eight newest results, was lost each time. Old results now collapse eight at a time (`prune::COLLAPSE_BATCH`), and all that is due on the first round of a resumed reply, whose cache is cold anyway. Measured on 24 file reads with GLM 5.3 Flash: 816,000 tokens outside the cache before, 280,000 after.
- **A file bigger than what is kept.** One read may return 400,000 characters, and only 150,000 characters of reads were kept as "still being worked from": a big file was collapsed after eight results and read again, about every ninth round. What is kept now always has room for one full read. The line that stands in for a repeated read (`[Unchanged: …]`) also counted as the newest read of the file, so the real copy was retired by it: it no longer does.

A read that did not fit says where to read on. A model that asks again from the first line gets the same first part again, however often it asks: five rounds in a row in that chat. The lines the first answer left out are now read for it and sent with the pointer, once, when they are all that is left of the file.

**Who writes the summary.** The chat's own model, the one picked in the model menu, in a call of its own with thinking off: it is sent the summary prompt and the turns, and nothing else (`summary.rs`). That goes for the summary kept up as a chat grows and for `/compact`. Three things were wrong with it:

- A model that answered by declining had its answer stored as the summary, and from then on that answer stood in for the whole conversation on every request. A reply that opens by declining is no longer stored: `/compact` says the model declined and changes nothing, the automatic summary is not asked for again in that chat until the app restarts (every message would pay for the same call), and a chat that already holds such a "summary" is read as having none.
- `/compact` read 60,000 characters a call, eight calls at most, whatever the model: the newest thirty-odd turns of a long chat, the rest counted as skipped. A call now reads a quarter of the model's window (875,000 characters for a million-token model). Eight calls stay the limit, so a compaction has a known highest price, and each call is one request of that size.
- The summary itself stays short on purpose (800 words for `/compact`, 300 for the automatic one): it rides on every later request.

And two that cost disk, not tokens. An unfinished reply keeps its transcript so Resume can carry on: it held every clip sent with it (a 40 MB video, written again with every save), and replies that could no longer be resumed kept theirs for good. A clip is now left out once it has been sent, and sending a message drops the transcripts of every earlier reply. A reply in progress is saved every five seconds, or twenty times as long as the last save took, whichever is longer: a chat of hundreds of megabytes was written out whole every five seconds.

A picture a tool shows the model (`view_image`, a screenshot) rides on the next request and no other. It used to be cut from that one too, with every picture that had "already ridden", so the model was never sent it.

A plan with every step done is cleared when the next message is sent: it stood over the new reply as if it were its plan, and was sent to the model with it.

## Checking the tools

`apim --tools calls.json --auto --dir FOLDER` runs a list of tool calls (`[{"name": "edit_file", "args": {...}}, ...]`) as the agent would make them and prints what each hands back: no model in between, so a tool is judged on what it does. `APIM_TOOL_CHARS` sets how much of each result is shown. All 59 were run this way on 2026-10-09; what that changed:

- `edit_file` reported "Edited" for an edit that left the file as it was, and took half a range (an end, no start) for one line. A model then looped: thirteen such edits in one chat. Both are refused now, with the lines as they stand; and every edit says what it replaced, so one that landed on the wrong lines is seen at once.
- `apply_patch` missed every hunk that was not at the end of its file when the patch ended in a newline, and refused a bare `@@` header.
- The loop breaker stopped the plain fix-and-rerun loop (edit, run the checker, edit, run it again) as "the same failing call three times". A command run again after the workspace changed is a new try.
- `run_tests` finds tests kept beside the code (`test_x.py`), runs pytest as a module, puts a test's name behind `-k`, and says how to get pytest when it is missing.
- Taken as meant: a process id without its `p`, a command line in one string, `update_plan` with `step`/`status`/`completed`, `query_data` with a bare condition (answered with the JSONPath that works) or a count with no query.
- "Run automatically" does not ask about a program built or downloaded into the chat's folder (it did). The one thing it still asks about is a PowerShell command that could change the computer.
- `update_plan` refused a step called done with no word on how it was checked, every time; a model that sent the same call three times had its finished run stopped by the loop breaker. It is asked once, and the second time the step is taken as done and wears "not said how it was checked". What was refused now comes first in the result, not after the whole plan. `finish` asks once in the same way.
- `delete_file` takes a folder inside the workspace, with everything in it.
- The check that marks a reply claiming work no tool did took "drop the dump here and I read it" for such a claim: an offer or a condition is no longer one. Its retry asks for a short correction, not the reply written out a second time.
- The request restated at the end of every round is marked as the app's reminder: a model took it for a new message and answered it each round.

Not run: `sandbox_run` and `sandbox_screenshot` (they need the WSL sandbox), `screenshot_window` on a real window, `web_search` (no key in the test folder), the GitHub tools against a real repository.

## Tools on demand

The agent has 59 tools, and their descriptions used to ride in every request: 57,000 characters, about 14,000 tokens, on every round. A plain "hi" cost 15,760 tokens to answer in 52. Now a request carries the twelve everyday tools (list, read, write, edit, search, run a command, the plan, ask, finish, web search), and the rest wait in eleven groups: files, code, processes, web, pictures, git, sandbox, data, memory, binary, helpers.

A group arrives in one of four ways, and then stays for the chat:

- The model asks for it with `load_tools`, whose description lists every group and its tools. This costs one short round.
- The message names it: a link brings the web group, "commit" brings git, "tkinter" brings the sandbox. Plain words in English; a request put another way costs the one round above.
- The chat's settings call for it: a connected GitHub repository brings git.
- The reply has become real work (three tool rounds): it gets memory and helpers, which the standing instructions lean on.

A tool called before its group was loaded still runs, and brings its group with it. Tools an MCP server lends are always sent. Measured with GLM 5.3 Flash: the same "hi" now costs 5,964 tokens, and a three-round task that loads a group by itself costs 20,279 where it cost about 47,000.

The groups are in `src/tools/groups.rs`. A test there fails when a tool synced from the web belongs to no group, so each new one is placed on purpose.

## Skills

A plugin is a standing instruction. Here it can also carry a longer guide, which is sent only when asked for, and a one-line reminder that rides with each new message for models that drift from a style after a few turns. More of them wait in a catalog.

- **In Plugins**, each card says where it applies: Off, This chat, or All chats. The list can be searched, and under the built-in ones is the catalog; putting a catalog skill on a chat adds it to your plugins.
- **By asking.** The assistant has a `skills` tool: "find a skill that keeps answers short and add it to this chat", "install Least Code for all chats", "switch Terse off". It searches, installs and follows the skill from its next words. Switching one on for every chat asks you first unless commands run automatically.
- **The catalog** ships with the app (`assets/skills.json`) and is added to from the copy of that file on the project's main branch, so a skill added there reaches every copy of the app. It holds apiM's own twelve skills, and pointers at official ones on GitHub (below). A downloaded entry is text on its way into the model's instructions: it is kept only when well formed and of modest size, nothing in it is run, and an installed skill is a copy that later changes to the catalog do not rewrite.

### Official skills, from GitHub

Claude's skills are folders with a `SKILL.md`: a name, when to use it, then the instructions in their author's words, and the files those point at. apiM takes them the same way (`src/skillhub.rs`), so what you get is the real thing and not a retelling:

- **Which.** The catalog points at Caveman (JuliusBrussee/caveman), Ponytail (DietrichGebert/ponytail), Graphify (Graphify-Labs/graphify) and Anthropic's own (anthropics/skills: PDF, Word, spreadsheets, slides, frontend design and more). Any other repository works by its address: type `owner/repo` or a github.com link into the search box of Plugins, or tell the assistant "install owner/repo".
- **How it is applied.** A short skill (up to 9,000 characters, as Caveman and Ponytail are) rides whole in every request while it is on, which is what Claude's start-up hook does with it, plus one reminder line per message. A long one (Graphify is 44,000) is named with its "use when" line, and the assistant reads it in full when a task calls for it, as Claude reads a skill. The files a skill carries are kept beside it in `data/skills/<id>/` and read one at a time (`skills`, action read, `file`).
- **The trust check.** Before anything is added you see where it comes from (stars, licence, last change, whether the catalog names that source) and what a search of its text found: instructions to drop other instructions, hidden characters, sending or reading secrets, downloading and running code in one step, turning a safety check off, an unreadable encoded block. "Check caveman's trust" asks for the same without adding. It cannot prove a skill harmless, and says so. A skill the check calls bad is never added unseen, even when commands run automatically.
- **What is not taken.** A plugin's hooks, commands and MCP servers: apiM runs nothing from a skill. A script it carries is text; it runs only if the assistant is told to run it, under the usual approval. Graphify needs its own program (`pip install graphifyy`).
- **GitHub's limit.** Unsigned, GitHub answers 60 requests an hour, three per repository; a repository looked at is remembered for ten minutes, and with a GitHub account connected the requests are signed (5,000 an hour). With the limit spent, a skill the catalog names still installs: its text is read and checked, its standing and carried files are not, and the check says so.

What saves tokens, in order: fewer tools sent (above), then writing less code (Least Code), then fewer words (Terse). A style plugin alone could only shorten the 52 tokens of that "hi".

## Selecting and copying

Text in a reply, your own messages, the notices between steps, the "Context compacted" line and the words of a step row can be selected with the mouse and copied; a click on a step row's words still opens the row. A selection has rounded corners and its letters keep their colour (`ui/selection.rs`: egui draws square boxes and inks the letters in a border's grey). One limit is egui's: a selection is dropped when its first or last line scrolls out of view, because rows that do not show are not laid out.

## Not here yet

- GitHub sign-in through the browser (the token field works)
- Screenshots of a hidden desktop for apps the agent starts
- Stills from a video clip for models that cannot watch it
- Pointing a chat at a folder of your own from the window (terminal mode has `--dir`; the window copies files in, as the web app does)
- A few small web touches: the offline banner, the resume-with-another-model menu

## Where things are saved

The desktop app and the web app share chats, workspaces, plugins, MCP servers and restore points. A skill added from the catalog is kept with your plugins; the web app shows it as one of yours and uses its instruction, not its guide or reminder. Which plugins are on for one chat, and which tool groups it has loaded, are kept in that chat's file.

| What | Where |
| --- | --- |
| Settings and keys | `%APPDATA%\apiM\settings.json` |
| Chats, workspaces and the rest | the repo's `data` folder when the program runs from inside the repo, otherwise `%APPDATA%\apiM` |

Set `APIM_DATA_DIR` to keep the data somewhere else.

## Staying in step with the web app

Tool descriptions, prompts, plugins and the model list come from the web app's source, so both versions tell the models the same thing. Kept apart, because the web has no such thing: the theme wall (`assets/themes.json`), the skill catalog (`assets/skills.json`), and which tools are sent when (the web sends them all). After changing the others in the web app, run this from the repo root:

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

`APIM_SHOT=out.png` makes the program draw one state off screen, save a picture of it and quit. `APIM_SHOT_STATE` names the state as a comma-separated list (`settings`, `tab4`, `wait-row`, `stalled`, `plugins`, `plugin-search` with `APIM_SHOT_QUERY`, `plugin-add`, `ask-skill`, `ask-look`, `btw`, `theme-midnight`, `no-sidebar`, `up-330` to turn the wheel back that many points, `select-300-200-600-260` to drag between two points and press Ctrl+C (what it copies is printed, and kept from the real clipboard), `maximized,f11` for full screen, and more in `ui/mod.rs`), `APIM_SHOT_CHAT` picks the chat by a part of its title, and `APIM_SHOT_SIZE=1400x900` sets the window.

`APIM_SHOT_STATE=send` with `APIM_SHOT_DRAFT="..."` really sends that message and takes the picture when the reply has ended. Point `APIM_DATA_DIR` at a spare folder first, so the chat it makes is not one of yours.
