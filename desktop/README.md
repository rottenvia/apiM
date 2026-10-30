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

Settings says at its foot when the program was built ("Built 2026-10-10 17:18"): the way to tell whether a window, a copy or a pinned shortcut is the newest build. A shortcut pinned to `target/release/apim.exe` opens whatever was built last; a copy made elsewhere stays as old as the day it was copied, and a window left open stays the build it was started from.

Open **Settings** and paste an OpenRouter, DeepSeek or Anthropic key. Keys stay on your PC.

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
- A message box for each chat: what is typed and attached in one chat stays with it, comes back when that chat is opened again, and survives a restart, pasted screenshots included
- Several chats answered at once: a reply goes on in its chat while another chat is open, or is sent to, and the chat list marks each one working (a pulsing dot) or waiting for your answer (a steady amber dot)
- GitHub: connect a repository through apiM's own GitHub App or a token, push, open and follow pull requests
- MCP servers, the same 8 plugins plus your own, search budget
- Tools on demand and a catalog of skills, both described below: a request carries about a third of what it did, and plugins can be added, by you or by the assistant, to one chat or to all
- A problem report (Settings, Reports) that sorts what went wrong by likely cause: the app first (crashes, frozen frames), then this PC, the provider, and a model's slips only when the same one repeats
- A theme wall of its own: deep, tinted grounds with one vivid accent each, and the editor classics on darker grounds than the web's
- Computer use, behind the **Use** chip beside Web: the agent sees your screen and uses your mouse and keyboard (open a game, click Play, test it), described below
- A terminal mode: `apim --ask "your question"` (add `--auto` to let it run commands, `--computer` to let it use the screen, `--dir FOLDER` to pick the folder, `--note "text"` to hand the reply a "btw" after its first step, `--think` to print its thinking, every line of it marked `~`)

The browser tool drives a Chromium-family browser already on the PC (Edge, Chrome, Chromium, Brave or Thorium, or the one `APIM_BROWSER_PATH` names) with a profile of its own, kept in the app's data folder, and shows it live in the Browser pane beside the chat (below). Nothing is bundled or downloaded.

## The computer, not only the chat's folder

The assistant runs on your own computer, and it is told so. It works at three depths: its workspace (the chat's folder, where everything it creates or changes goes), the computer around it, which it can look at, and the Linux sandbox when one is set up. Asked about a crash, a slow start or a setting, it is to investigate (read the logs and crash dumps, ask the event log, check versions and what is running) and to turn to you only for what only you can do. Before this it answered such a question with a list of steps for you, because "it could not see your machine".

- **What it is told about the computer** (`src/machine.rs`), read once when the app starts and sent with every request: the system and its build, the home folder and where programs keep their data, which of the usual programs are installed, the workspace's path, today's date, and how approvals are set. No chat starts by finding these out.
- **Looking at files.** `list_files`, `read_file` and `read_files` take a path written in full (`C:\...`, `~/...`, `%LOCALAPPDATA%\...`). Outside the workspace a folder is listed one level at a time, newest files first. Writing, editing, moving and deleting stay inside the workspace.
- **Asking the system.** `run_command` runs the system's own looking tools (`tasklist`, `systeminfo`, `wevtutil qe`, `reg query`, `sc query` and others; their changing forms are refused) and, on Windows, PowerShell. With "Ask me first" you are shown its text whole. With "Run automatically" it runs unasked like any other program, with two refusals that come back at once and wait for nobody: a command that takes the computer itself apart (disks, start-up, accounts, the system's protection, deleting from the registry), and a delete that names a place outside the chat's folder, because a restore point brings back that folder and nothing else. It used to ask about any text that could change the computer, in every mode: a reply left to run alone stood five minutes at each such question and then dropped the command. The reading is a word list, there to catch a wreck made in passing; it does not hold a program the assistant writes and runs, which was always free to do what you can do.
- **Approval.** With "Ask me first" you allow each folder outside the workspace before it is looked into ("Look in this folder?", once or for the chat) and each command. With "Run automatically" looking does not ask.
- **Closed places.** Folders and files that keep sign-ins and keys (SSH and cloud keys, browser profiles, the system's credential stores, `.env` files, this app's own settings) are not read by a file tool or named in a PowerShell command, in any mode: what a tool reads goes to the model's provider.

## The screen, the mouse and the keyboard

With the **Computer** chip on (beside Web, off by default) the agent may see the screen and use the mouse and keyboard whenever a task calls for it; off, it has no way to. It was made for the reply left alone with a game to test: it used to stop and wait for the user to open Roblox and press Play. The chip takes effect from the next message, and it shows an amber dot when the chosen model cannot see pictures, which is a model the tools are not offered to.

- **Two tools** (`src/tools/computer.rs`, the Windows side in `src/computer.rs`). `computer_look` returns a screenshot fitted into 1366x768 (a 2560x1440 screen shrinks 1.88x) and the open windows, front first, with their places in the screenshot's pixels. `zoom` shows part of it up to 3x larger, and `text` adds every line of text on the screen with the point that clicks it. `computer_act` runs a list of steps (click, double and right click, click with a key held, move, drag, scroll, type, key combinations, keys held down for games, wait, wait for a window or text, open a program or link with arguments, bring a window forward) and returns a fresh screenshot with the result.
- **One round for many steps.** The loop that screenshot-then-click tools run costs a model round per click. Here a call carries everything the model can foresee, and the picture of the result comes back with it: "wait for the window, click Press me, Tab, type, click the label" ran as one call in 5.5 s.
- **Clicks by text.** `{"click": "Play"}` is found on the screen by the app, not read off the picture by the model: Windows' own OCR reads the whole screen (0.3 s of work, 1.4 s with PowerShell's start) and UI Automation names the controls of the window in front. A control named exactly so comes first, then a line of text that is exactly it, then those words inside a longer line; "Play" inside "Playground" is never taken. Text inside apiM's own window, whose chat quotes what is being looked for, counts only when nothing else matches, and a text not there yet is read twice more over a second, for a window still drawing. Roblox Studio exposes about 95 controls to UI Automation and not its ribbon, so OCR is what finds most targets in games; it reads first, and a window that hangs UI Automation costs at most 2.5 s more, not the read.
- **What the user sees.** Each step's row shows the screenshot it took. Where the agent clicked is ringed in pink, numbered when a call clicked more than once; the ring is open in the middle, since a dot there hid the very word or checkbox the click was on, and with it whether the click took.
- **The user's hand wins.** Before each step, and through every wait, Windows' time of the last mouse or keyboard input is checked against the agent's own last input: if anything came after it, the call stops at once and the agent is told the user is at the computer. A game moving the pointer itself is not input: Roblox holds it at the middle of its viewport, not of its window, and the first check, which compared the pointer with where the last step left it, stopped the first play test in its wait. Two chats never drive the mouse at once.
- **Fewer pictures resent.** Every screenshot rides again with each later request, so once there are eight the five oldest are taken out together, keeping three: the cached start of the request changes once in five rounds, not every round. Screenshots are JPEG, about 120 KB at 1366x768, and the newest 300 of a chat are kept in its state folder.
- **Real pixels.** The window is DPI-aware through winit; terminal mode now asks for it too, or a scaled display would be read smaller and blurred.

Measured on a 2560x1440 screen with a throwaway WinForms window (a button, a text box, a label; it closes itself, then its process lingers 5 s as Roblox's does): the window was found 1.9 s after it was started, the button pressed and the text typed as the window's own log confirmed, and `wait_for_output` with `process` returned 0.11 s after the window closed, not 5 s later when the process ended.

In Roblox Studio, with a place open: F5 started the play test and the game's menu was on the screen after a 9 s wait, which the old pointer check had cut short; Shift+F5 stopped it and Studio was back in edit mode. Play, look, Stop, with a look before and after, took 21 s over six calls. Through a wait, a mouse move stopped the call 0.18 s later and a key press 0.2 s later; with neither, the same call ran to its end.

### A program's end, noticed when it happens

- **Waiting on a program the agent did not start.** `wait_for_output` takes `process`, a name or a pid, and ends the moment that program closes: its window, or its process, whichever goes first. Without `id` that is all it waits for. Before, a reply that started a game through its launcher could only follow PowerShell, which had long gone, and polled with scripts. With the computer on, the processes group comes loaded: the first live run, which would have had to load it, wrote a PowerShell monitor of its own instead and ran the whole test twice over it (191 s).
- **The last output, at once.** After a command ended, each of its output pipes was given 2 s in turn to close. A pipe held by something the command started and left running (a game, its crash handler) never closes, so every such command lost 4 s. Both pipes now get 0.5 s together, and what the program printed before it ended is in them already: a command whose child kept the pipe went from 4.8 s to 1.2 s, with all 3,000 of its lines.
- **A launcher is not a failure.** `start_process` called any program that ended in its first 4 s a failure, and a reply started the launcher again and again. Ending with code 0 is now reported as a launcher that returned, with the way to wait for what it started; any other code is still a failure.

## Which endpoint an OpenRouter model runs on

OpenRouter serves one model from many endpoints, at different prices and speeds (33 for GLM 5.3 Flash, input from $0.04 to $0.225 a million tokens). The app used to keep each catalog model on one endpoint written into the code. It now reads OpenRouter's list for the model (`/models/<id>/endpoints`, with your key: the speeds are only in the signed-in answer) and picks (`provider::choose_endpoint`):

- **The cheapest endpoint that is fast enough**: 40 tokens a second or more over the last half hour. "Cheapest" is what a request of this app costs there, not the input price alone: of the tokens it sends, about seven in ten are read from the cache, three are new, and one token is written per hundred sent.
- **Or one a little dearer and much faster**: up to a quarter more money for at least one and a half times the speed.
- Never one that is down, that failed more than 2% of the last day, that cannot call tools, or that has a smaller context window than the others.
- **Never one that loses parts of a tool call.** OpenRouter's list says an endpoint "supports tools"; it does not say whether a call arrives whole. So before picking, the app sends the eight cheapest fast endpoints one made-up call, three times each: a word, a list, and two optional texts, one of two lines (`provider::keeps_arguments`). An endpoint that returns it incomplete even once is left out, and the reply's first line names it. Results are kept in `endpoints.json` for three days, so most sessions ask nothing; the first reply after that waits a few seconds longer.

On 2026-10-12 thirteen of GLM 5.3 Flash's thirty endpoints failed that call. Four left optional arguments out, among them the one the app had picked that day and the one written into the code as the fallback (inference-net/fp4): there `edit_file` never received `old_text`, `start_line` or `start_anchor`, so every edit by text or by line range failed, `run_command` never received `stdin`, so every one-call script failed, and the loop breaker then ended the reply ("the same tool call failed three times"). In the benchmark (`bench/README.md`), 71 of 318 tool calls failed on it and 5 of 25 replies were ended that way; 17 tasks passed. With such endpoints left out: 19 of the same 25 passed, no reply was ended by the loop breaker, and 72 of 562 calls failed, nearly all of them a program the model ran exiting with an error. Six more endpoints sent GLM's own call markup inside a value when a list came before a text (`"args": "[\"-\"]<arg_key>command</arg_key><arg_value>python3"`). That one can be undone, and is, before the tool runs (`tools::parse_call`), for names that are arguments of the tool: a file about the markup keeps its text.

The next two cheapest fast-enough endpoints are kept as spares for when the first is down; nothing else is used, so every token stays on a known price. The pick is made once per model while the app runs: a pick that moved between replies would lose the provider's cache each time. It is said in a reply only when it is not the one picked last time (`endpoints.json` in the data folder remembers the pick and its prices). Cost figures and the spending limit use the picked endpoint's prices, in every session. Free models and other `:variant` ids are left to OpenRouter's own routing. The three numbers (`GOOD_TPS`, `FASTER`, `DEARER`) are at the top of the code that picks.

Two things the list does not say outright, both met on the first day:

- An endpoint may allow less output than the model's page says (128,000 tokens where the page says 131,072). Asked for more, OpenRouter drops the endpoint before trying it and answers "No endpoints found". A request asks for no more than every picked endpoint allows, and if the picked ones still cannot take a request, the pin is dropped for that reply and OpenRouter routes it.
- What an endpoint really costs depends on how well it caches, which is not listed. Measured on one 24-step task with GLM 5.3 Flash: Relace $0.028, Sail Research $0.042, StreamLake $0.044, each caching 70% to 85% of the input. The pick (Relace) was the cheapest of the three in fact as well as on paper.

- A cached price is only paid where the cache is read, and that differs by endpoint and by hour. Measured on 2026-10-13 with `bench/wire/cacheprobe.py` (a six-round conversation with a fresh start and tools, as an agent's rounds are): Relace, the cheapest on paper, read nothing in the first two or three rounds; in the live benchmark it read 0 of 47,924 tokens in a four-round reply and between 18% and 60% over a lane's night. StreamLake, Novita, Decart and Sail Research read every round from the second. So the app counts, per endpoint, what it sent and what came from the cache (`_reads` in `endpoints.json`), and once 150,000 tokens have gone to an endpoint, "cheapest" uses that endpoint's own share in place of the seven in ten. An endpoint not tried yet keeps the seven in ten, so it gets its turn; when the pick moves for this reason the notice says what the old one read. In the benchmark this moved one lane from Relace (18% read) to Sail Research (79%), at about the same cost: among the endpoints that are fast enough, none is much cheaper than Relace even with its misses.
- The cheapest endpoint in fact is under the speed floor. StreamLake costs about a third less for input and 72% less for output than Relace ($0.14 against $0.50 a million), and reads its cache from the second round; it writes 27 tokens a second and takes 6.7 s to the first one, where Relace writes 41 and takes 1.5 s. `APIM_ENDPOINT=streamlake/fp8` picks it by hand.

`APIM_ENDPOINT=streamlake/fp8` keeps every OpenRouter model to the endpoint with that tag, when it serves the model: for comparing endpoints, or for keeping to one you trust.

The picked endpoint is the first of three: when it is busy OpenRouter sends a round to a spare. That round starts with nothing cached there, and is billed at the spare's prices while the cost figure uses the first one's. OpenRouter names who answered in each reply's stream; a round answered by another endpoint than the round before is written to the problem log as "Endpoint changed", so a low cached share can be traced to it. (Added on 2026-10-13 with the key out of credit: the log line is proven against a stand-in server only.)

## Adding a model from a link

Paste a model's openrouter.ai link (or its id, `author/model-name`) into the chat and say to add it: the model in the chat calls `add_model`, the app checks the id with OpenRouter, and the model is in the model menu, with its context window, prices and abilities as OpenRouter lists them. The conversation stays on the model it was on. Settings → Models does the same by hand. The tool is only sent when a message names it or holds such a link, so it costs nothing otherwise.

What an added model gets is what every model gets, because none of it is written per model: the endpoint pick above (not for `:free` and other `:variant` ids), its real prices in the cost figures, and everything under "What a request carries". What it does not get: handling written for one model's habits (the two catalog models have some: DeepSeek is handed its thinking back, GLM's thinking cannot be switched off), Claude is the exception on caching: it reads from its cache only up to where a request marks it, and the loop marks a Claude request (the system prompt, the newest tool result, and the request as a whole).

## Claude on your own Anthropic key

With an Anthropic key in Settings → API keys, any Claude model runs on Anthropic's own API, billed to that key: Settings → Models lists the models the key can use (click one to check and add it), a Claude id (`claude-sonnet-5-5`) typed there or named in a chat is added the same way, and an id the key does not have comes back with the ones it does. Anthropic does not list prices through its API; the app knows them for the Claude models out by October 2026 (`src/anthropic.rs`), and a later one shows "pricing unknown" until the app knows it.

Claude's API speaks Messages, not Chat Completions: `src/anthropic.rs` translates each request on its way out and each reply or stream event on its way back, so the loop is the same loop. What changes on the way: system messages after the first turn ride in the user's turn as `<system-reminder>` text (Claude's own mid-conversation system message is not on every model); thinking is adaptive, its depth the effort setting, and "None" is low effort, as the newest models cannot switch it off; models older than 4.6 run without thinking; Claude's thoughts are not sent back, only the end of each as text, as on OpenRouter (each returned thought is checked against everything before it, and the loop rebuilds its newest turns every round); `temperature` and the like are never sent (API version 2026-10-21 refuses them). Requests carry three cache marks: the rules and the chat before the question for an hour, the newest tool result for five minutes, and the request's own mark for the rest.

## GitHub as apiM's own app

A Personal Access Token acts as you, on everything it reaches, until it is revoked. apiM can instead be a GitHub App of its own (`src/github_app.rs`): it then pushes and opens pull requests as `apim-…[bot]`, its commits show as the app, and it reaches only the repositories you install it on, with tokens that last an hour.

Setting it up is two clicks on GitHub. "Set up apiM's GitHub App" in the GitHub dialog opens GitHub's "new app" form in your browser, filled in from a manifest (name, the permissions below, no webhook). Pressing Create GitHub App sends the browser back to a one-time listener on 127.0.0.1, checked by a random state, and apiM trades GitHub's code for the app's id and private key. The browser then goes on to the app's install page, where you pick the repositories; the dialog reads them when its window is back in front. The app asks for write access to contents, pull requests, issues and workflows, and read access to checks, statuses and actions.

The key is kept in `github-app.json` beside `settings.json`, and neither file is read by a file tool or named in a PowerShell command. Each request signs a nine-minute sign-in with the key (RS256 through `ring`, already built for TLS), trades it for the repository's installation token and keeps that token for 55 minutes. The app comes first wherever a token is needed: listing repositories, cloning, pushing, the pull request and its checks. A repository it is not installed on falls back to the token when there is one, and otherwise says where to add it. "Disconnect" forgets the key on this computer; the app stays on GitHub until it is deleted on its page there. The rules for pushing are the same either way: only the `apim/…` working branch, never the base, never forced.

## What a request carries

Every round of a reply sends the whole conversation again, so what stays in it is paid for every round. Three things kept a long chat far bigger than its work (measured on a real one: 1.7 million characters a round):

- **The same file read again.** A model that asks for one big file every round got its text every round, 400,000 characters each time. A call asked again whose answer is still in the conversation, byte for byte, now gets one line pointing at it (`compact::repeat_of`). The earlier copy stays where it is, so the start of the request does not move and the provider's cache of it holds. Once that copy has been collapsed as old, the file is read out again. Only the text that came back is compared, not how it was asked for: the same file asked for with another last line each time returned the same 400,000 characters and counted as a new call. Copies already in a conversation are folded the same way before every round, a note on the end of one ("you already read this") no longer making them differ.
- **Old pastes.** A log pasted five questions ago rode whole on every round of every later reply. An earlier message of yours over 16,000 characters now goes out as its first and last 8,000, with a line saying so. The newest earlier message and the one being answered are never cut. The chat itself keeps everything. Resume replays the transcript saved with the unfinished reply, so the same cut is made in that transcript when it is taken up.
- **Notes to a running task** (`btw …`, `/btw`). The note took the request's place in the reminder that ends every round, so a question asked in passing was read as the task and answered again each round. The reminder now keeps the request and only points at the notes; the note itself says to answer once and go on. A note shows in the chat at once, as a quiet line above the reply: the card that came and went above the message box is gone.
- **Anything said while it works reaches it, and a long wait lets go of it.** Typed without "btw" in front, a message sent while a reply ran went nowhere at all: `submit` dropped it and left the words in the box. Everything typed while a reply runs is a note now, "btw" or not, and the box says so ("Working… say something and it reaches the task", the teal line and the send button while there is anything in it; with the box empty the button is Stop again, and `/stop` works either way). Notes are read at the top of the next round, so one passed while the reply sat inside `wait_for_output` — up to ten minutes watching a program — was not read until the program closed. That wait now gives up the moment anything is said (`Ctx::spoken_to`, polled with the rest every 150 ms), hands back "Stopped waiting … the user said something … nothing was lost, the process is still running", and says to answer and call it again. The program it watched is left running, and the tool's own description says this, so the model knows the round is not a failure. Measured: a 30-second sleep waited on with `timeout_ms` 600,000 came back 0.3 s after a note was pushed, with the process still alive.

Two more were found by reading what that chat was billed: 28 million tokens for one reply, 36% of them outside the provider's cache, and over the whole chat nine tenths of the money went on input the cache did not cover.

- **Collapsing an old result every round.** The newest eight tool results stay whole and older ones become one line. Done one a round, a message in the middle of the request changed every round, and the provider's cache of everything after it, the eight newest results, was lost each time. Old results now collapse eight at a time (`prune::COLLAPSE_BATCH`), and all that is due on the first round of a resumed reply, whose cache is cold anyway. Measured on 24 file reads with GLM 5.3 Flash: 816,000 tokens outside the cache before, 280,000 after.
- **A file bigger than what is kept.** One read may return 400,000 characters, and only 150,000 characters of reads were kept as "still being worked from": a big file was collapsed after eight results and read again, about every ninth round. What is kept now always has room for one full read. The line that stands in for a repeated read (`[Unchanged: …]`) also counted as the newest read of the file, so the real copy was retired by it: it no longer does.
- **Reads past the budget, one a round.** Which reads stay whole was decided from the whole conversation on every round. In a spell of reading (more than 150,000 characters of files) each new read pushed the oldest kept read out, so an old message changed on every round and nothing after it could be read from the cache. It is now decided from the conversation as it stood at the last result old enough to fold, so old messages change once per batch of eight. A test counts it: sixteen rounds of reading used to change an old message on most rounds, now on one.
- **What a round re-sends can be measured without a model** (`bench/wire`): a stand-in for OpenRouter plays a script of tool calls to the real program and keeps every request; a second script says how much of each request is the one before it, unchanged from the start. On a run shaped like the benchmark's (reading, commands, a plan, a file written) 88% is. The provider reported 46% to 53% read from its cache on the real runs, so the rest is lost on its side: see "Endpoint changed" below.

Four more were found by a test that plays sixty rounds of a build on DeepSeek and compares each request with the one before (`the_harness_keeps_what_the_provider_cached` in `agent.rs`): 84% of what went out could be read from the cache, and 13% was lost to the app changing earlier text.

- **A fresh listing in place of the first.** After 40 file changes the workspace listing is sent again in full. The old one and its deltas were taken out, so the second message of the conversation changed and everything after it went out at full price (156,000 characters in one round). The new listing now goes at the end, and the old ones stay until the transcript is folded, which sends it anew anyway.
- **A write losing its text when the file was read back.** Two rounds after a write, the read made the write a stub, and every message between was sent again. A write now loses its text at once only when the stub saves more than what lies between it and the call that made it stale (a file written again straight away); otherwise when its batch is old.
- **Pointers folded into pointers.** Identical results become a pointer at the newest copy. Two `[Unchanged: …]` lines, or two collapsed results, were identical too, and the older one changed, rounds back. Pointers are left alone now, and a small repeat far from its first copy waits for the fold.
- **Eight at a time where the cache is cheap.** On DeepSeek a cached token costs 2% of a fresh one, on Claude 10%: sending sixteen results again to save a few lines on later rounds does not pay. Where the cached price is a quarter of the input price or less, old results collapse 32 at a time (`prune::CACHED_COLLAPSE_BATCH`): over 150 simulated rounds, 18% cheaper on Claude and 37% on DeepSeek, for a transcript 10% longer. A model with no cached price keeps eight.

After them: 93% read from the cache, 4% lost (two batches), and the same sixty rounds cost 44% less at DeepSeek's prices, though 15% more text is sent.

Then the real app on real models, the 24-bug task (`bench/tasks/long-many-fixes`) on DeepSeek V4.1 Flash through OpenRouter and on Claude Haiku 5.5 through Anthropic's own API. `APIM_WIRE_LOG=<folder>` keeps every request body as it was sent, numbered, so two in a row can be compared; `bench/wire/cacheprobe.py` asks one endpoint (`PROBE_SESSION=1` names the conversation, which made no difference on Relace).

- **Tools added at the third round.** Every reply that ran three tool rounds was given two more tool groups, and the tools ride ahead of every message: the next round read nothing from its cache, on both providers. They are there from the first request now (`tools::groups::STANDING`).
- **The next question.** Claude keeps what it cached for five minutes, and a question asked later than that sent the whole chat again at 1.25 times the input price. The rules and the chat before the question now carry an hour's mark (written at twice the price, once): asked six minutes later, a 15,000-token chat was read from the cache whole, where it had been written again whole.
- **What changes between questions left the system prompt.** The date and what earlier work established (findings, the binary ledger, lessons) ride in a note just before the question. In the system prompt, a finding recorded in one reply changed the start of every request of the next, and the chat went out at full price again: a finding was recorded in 28% of the replies in this PC's chats. The date did the same at midnight.
- **The summary waits for more.** Older turns were folded into the chat's summary once 4,000 characters of them waited behind the newest eight, about every other message with long replies, and each refresh rewrote the start of the history. Where the cached price is a quarter of the input price or less it now waits for 40,000 characters, or twelve turns (the most the window sent word for word holds).

- **The workspace folder in the rules.** The system prompt named the chat's own folder, so every folder had a prompt of its own, and Claude, which reads its cache only as far as a mark, wrote all 13,800 tokens of rules and tools again for each new chat somewhere else. The folder rides in the note before the question now, with the date, which is already the line that changes. Measured on Haiku 5.5, a second chat in another folder: 0 tokens read from the cache before, 13,463 of 13,773 after.

Before and after on that task: DeepSeek 75.5% of the input read from the cache, then 89.8%; Claude 70 to 80%, then 82.9%. What is left is new text: each round reads all of the round before it, and these replies write long scripts.

A read that did not fit says where to read on. A model that asks again from the first line gets the same first part again, however often it asks: five rounds in a row in that chat. The lines the first answer left out are now read for it and sent with the pointer, once, when they are all that is left of the file.

**Who writes the summary.** The chat's own model, the one picked in the model menu, in a call of its own with thinking off: it is sent the summary prompt and the turns, and nothing else (`summary.rs`). That goes for the summary kept up as a chat grows and for `/compact`. Three things were wrong with it:

- A model that answered by declining had its answer stored as the summary, and from then on that answer stood in for the whole conversation on every request. A reply that opens by declining is no longer stored: `/compact` says the model declined and changes nothing, the automatic summary is not asked for again in that chat until the app restarts (every message would pay for the same call), and a chat that already holds such a "summary" is read as having none.
- `/compact` read 60,000 characters a call, eight calls at most, whatever the model: the newest thirty-odd turns of a long chat, the rest counted as skipped. A call now reads a quarter of the model's window (875,000 characters for a million-token model). Eight calls stay the limit, so a compaction has a known highest price, and each call is one request of that size.
- The summary itself stays short on purpose (800 words for `/compact`, 300 for the automatic one): it rides on every later request.

And two that cost disk, not tokens. An unfinished reply keeps its transcript so Resume can carry on: it held every clip sent with it (a 40 MB video, written again with every save), and replies that could no longer be resumed kept theirs for good. A clip is now left out once it has been sent, and sending a message drops the transcripts of every earlier reply. A reply in progress is saved every five seconds, or twenty times as long as the last save took, whichever is longer: a chat of hundreds of megabytes was written out whole every five seconds.

A picture a tool shows the model (`view_image`, a screenshot) rides on the next request and no other. It used to be cut from that one too, with every picture that had "already ridden", so the model was never sent it.

Three more, found by running the same long task before and after:

- **A short answer asked again.** A reply that ended in under forty characters after its steps ("Done.", the one word that was asked for) was read as "the model wrote nothing", asked again twice, a whole request each time, and then marked as stopped mid-task. A short answer is now an answer; only a round with no words at all is picked up.
- **"Are you guessing?" after the work.** A run of eight steps with no plan and no question is reminded to ask before building on a guess. The reminder waited until the model had stopped, which is when the work is done: it cost one more request on every long reply, and the model answered it under its answer ("nothing is ambiguous"). It now rides a request the run makes anyway.
- **Half price on screen.** In DeepSeek's off-peak hours the cost shown was halved for every model, OpenRouter's too, where nothing is discounted. It is halved for DeepSeek's own API only.

A reply the app was closed under (or that died with it) came back with its steps and no word that it had stopped: no Resume. A reply still holding the transcript it was being written from is now read as unfinished, and Resume carries on from its last saved step.

A plan with every step done is cleared when the next message is sent: it stood over the new reply as if it were its plan, and was sent to the model with it.

## The benchmark on Claude's own models

The 34 tasks were run on Claude Haiku 5.5 and 14 of them on Claude Opus 5.5, through Anthropic's own API, and every
round of every failed task was read. Five faults were the app's, not the models':

- **A refused request, and the round lost.** Where a provider has no field for it, the app carries the end of each
  step's thinking back as the turn's own words, under a label, or the model re-derives the task every round. Claude
  refuses such a request outright (`stop_reason` "refusal", category `reasoning_extraction`): no content, no tool
  call, the round gone. It struck 8 of the 14 Opus tasks, and 4 of them failed for it. Claude is given no thinking
  back now, in a field or in the words (`transcript::Thoughts::Gone`); its own signed thoughts are a separate
  question, and the comment in `anthropic.rs` says why none go. Opus 5.5 went from 10 of 14 to 13 of 14, in fewer
  rounds (76 to 67). The one that changed the other way, html-table-extract, failed the task's unseen-snapshot check
  on its own merits, at the same 41 of 54 Haiku scored on it.
- **An hour in the cache, costed as five minutes.** Claude says what it wrote for an hour, at twice the price, in
  `cache_creation` inside the first event of the stream. The reader kept only the plain numbers beside it, so every
  hour-long write was costed as a five-minute one.
- **A list sent as its own text, with the file's line breaks in it.** A model that wraps an argument in a string
  often leaves real line breaks inside, which JSON does not allow there, and the call was refused with "files must be
  a list of {path, content}" — twice in one task. Such text is read again with its line breaks escaped.
- **An edit with no path.** `edit_file` without `path` was answered "<the workspace> is a folder, not a file", four
  times in the 34 tasks. The edit now goes to the one file in the workspace its text fits, and says which; text that
  fits two files, or none, still asks for the path.
- **A variable mistaken for a place.** `$env:TZ = $z` in a loop, with `Remove-Item Env:TZ` after it, was refused as a
  delete outside the chat's folder. A delete from the process's own drives (`env:`, `variable:`, `function:`) touches
  no file, and `$env:` counts as a place only where a path goes on from it or it names one of the user's folders.
- **Tests beside the code, in JavaScript.** `run_tests` found no suite in a workspace holding `timing.test.js`, where
  Python's `test_x.py` beside the code has been found for a while. Node's own runner is used for a `.test.js` or
  `.spec.js` file with no Python beside it; its output was already read.

Two answers that cost a round were made to carry what to do next:

- **An anchor that was a pattern.** `end_anchor: "^}"` matched nothing, and the answer only said so. It now says an
  anchor is a line of the file's own text and prints the lines after the start anchor, so the next one is picked from
  the file rather than guessed again. Two models spent a round on this.
- **A command wrapped in a shell.** `cmd /c npm test` was refused with advice about running interpreters directly,
  which fits no launcher. The refusal now writes out the call it was carrying — `{"command": "npm", "args": ["test"]}`
  — unless the wrapper held a whole script with pipes or `&&`, which belongs in a PowerShell call.

Over the 34 tasks on Haiku 5.5, before and after: 32 passed either way (the two that did not are the models' own
work, a test suite that missed one of four hidden buggy variants and a generalisation to an unseen page), but the
run cost $0.93 then $0.76, took 261 rounds then 233, a median 108 seconds a task then 78, and failed 26 tool calls
then 22 — with every one of the app's own among them gone.

Terminal mode takes any model id now (`--model claude-opus-5-5`, `--model openai/gpt-6.1-terra`): one that is not in
the list is checked and added exactly as the model menu adds it, so the benchmark runs on a Claude key with
`ANTHROPIC_API_KEY` set and nothing to configure first.

## Claude, a second time: every model, and the refusal that ended a chat

Run on 2026-10-30 on Anthropic's own API: a ping on ten Claude models (Opus 5.5, 5 and 4.8, Sonnet 5.5, 5 and 4.6,
Haiku 5.5 and 4.5, Fable 5.1 and 5), the 14 tasks on Opus 5.5, Sonnet 5.5 and Fable 5.1, the 34 on Haiku 5.5, and
probes of the API itself. Found:

- **One carried thought, and the chat was over.** Where a think drafts a whole program, or the stream drops mid-think,
  the loop hands the thought back as the model's own words ("[My reasoning so far, verbatim …]"). On Claude that turn
  is refused (`stop_reason` "refusal", `reasoning_extraction`), and as it stays in the chat every later request is
  refused with it, a plain "hi" too: measured on Opus 5.5. Claude gets neither cutover now, and such a turn already in
  a chat is left out of what Claude is sent, so the chat goes on.
- **A refusal said nothing.** The category Claude gives (`stop_details`) was not read: the reply ended empty, the
  revive asked again with the same chat (refused again, paid again), and the problem log had no line for it. Each
  refusal is said now, with its kind, written down under Provider, and not asked again. Requests opt into Anthropic's
  fallback (`fallbacks: "default"`): a cyber or bio false alarm, likely on reverse-engineering work, is answered by the
  model Anthropic names for it, costed at that model's prices and said in the chat. All ten models take the field.
- **The rules written again for every new chat.** The rules' cache mark had moved to the end of the everyday tools, so
  a chat in a new folder read only the tools: 7,551 of 14,967 tokens from the cache, the rest written at the hour's
  double price. Both keep a mark now (the whole-request mark gives way when five would be set): 14,738 of 14,968.
  Over the tasks, the share read from the cache went from 75% to 83% on Opus 5.5, 74% to 82% on Sonnet 5.5 and
  80% to 89% on Haiku 5.5; Opus cost 10% less and Sonnet 14% less, all tasks passing before and after. Haiku passed
  33 of 34 both times and cost more ($0.70 to $0.81), in 238 rounds against 199: about the same a round.
- **Fable 5.1 against the task caps.** Six of its 14 tasks stopped at their spending caps, which were set for cheaper
  models. Run again with $2 a task, five of the six passed (13 of 14 in all, html-table-extract among them, which every
  other model fails); the one left, honest-blocked, lost a point on its own wording.
- **A paid round thrown away at the spending limit.** The limit was asked again before a round's tools ran, against
  what the next request might cost: Fable 5.1 wrote a whole test file in one round ($0.73), and the call was dropped
  from the chat unrun, so Resume would have paid for it again. Only a `delegate` call, which spends the limit itself,
  is held back now; the rest run, and the limit stops the next request.
- **`args` as one word.** `"args": "app/server.py"` was refused as "not a list" twice in one Sonnet 5.5 run. One word is
  one argument; words with spaces between them are still refused, where splitting would be a guess.

What was checked and is not a fault: changing `effort` or the thinking fields between requests keeps the cache on
Opus 5.5 and Haiku 5.5 (29,186 of 29,186 tokens read after each change); the cache within a reply reads all but the
newest round (90.6% over 21 rounds); per-message effort works on the 5.5 models, Fable 5.1 and Opus 5, and is a 400
on Sonnet 5 and Opus 4.8.

The problem log was checked against what it reported, and six kinds were false alarms: "Tool still running" fired at
90 s for a chosen sleep, a long build, a question to the user or an approval card, and "Slow tool" counted each such
call again (a call is overdue now only past its own time limit, never while it waits by design, and slow, stopped and
held-back text are kept out of the report); a wait that timed out and an approval nobody gave were filed as the PC's
fault; "reasoning stream" fired for Claude, whose adaptive thinking may skip a think; terminal mode printing to a
closed pipe was filed as a crash; and the time the user spent in a save or open dialog was filed as a frozen window.
An auto-continued stop is its own kind now ("Stopped mid-task, continued"), not "Run stopped early".

## A long reply that stopped

Found in one real reply: 160 rounds of work in a sandbox, 48 minutes, $0.27, stopped with two of six plan steps done and no visible way on.

- **Resume was out of sight.** "This reply stopped before it finished", with its Resume button, was drawn above the reply's steps: over two hundred of them. At the bottom, where the reader is, there was one grey line. The panel is now under the reply. (The web still draws it above.)
- **The ceiling on rounds follows the money.** A reply gets 64 rounds, and 32 more up to three times while it is getting somewhere (a plan step done, or three files changed, since the last check): 160 at most. That ceiling is there for the money, and 160 rounds of a cheap model cost a quarter of a dollar. Past it a reply that is still getting somewhere now runs on: up to the spending limit when one is set in Settings, else while what it has spent since its last finished plan step is under $1 (`stall::should_run_on`). The dollar was counted over the whole reply at first, and that paused one at $1.03, three rounds after it had finished its second step, under the words "used every tool round". A pause by this rule now says what it is: "Paused: $1.03 spent with no plan step finished, and no spending limit is set". A model whose price is not known stays at 160. One plan step that takes 120 rounds still pauses the reply and says so: that is the check for work that goes in circles.
- **"Treat it as invented" on real work.** The closing text is held against the tools that ran. Running a command only counted for `run_command`, so a reply that did everything in the sandbox was told its results were invented. `sandbox_run` counts, and a shell counts as having read and written files.
- **A search that said "No matches" for text that was there.** `search_files` left out files over 512 KB without a word, and did not read the `path` a model naturally passes. The result now names the files it left out; `path` keeps the search to one file or folder, and a file named there is searched whatever its size. A match inside a very long line (minified or packed code) comes back with the text around it, one entry per match: it used to show the line's first 400 characters, wherever the match was.
- **Sandbox steps said nothing.** A row read "Ran in sandbox …0-kb-3-line && python3 - <<'EOF' · Sandbox command finished". It now shows the reason the command was given with, and the last line the command printed.
- **Thinking typed as the answer.** GLM does not take its thinking back the way DeepSeek does, so the end of each thought rode back to it as the opening words of its own earlier turns. Shown a hundred turns that open with a thought, it began to think in its replies: 5,000 characters of "Wait… Hmm… Actually…" as answer text, 373 in the thought box. OpenRouter passes a `reasoning` field on to GLM (seen on Relace: a replayed thought is counted in the next prompt), so the end of each thought now rides there and the words stay words. Same size, same cost. Other families keep the old way until the same is seen for them; an endpoint that rejects the field falls back by itself.

## The two side panels

The chat list on the left and the files on the right were each a faithful copy of its own web component, and side by side they read as two apps: 14px names in rows of 42 against 12px names in rows of 30, a lettered tile before each file, five buttons 40 apart behind a lone folder, Download twice. They are one design now (`widgets::RAIL_*`):

- the same 12 from the edge and the same links at the foot (40 tall, 14px), under a rule that runs the panel's width;
- the files panel says "Files" where the left one has "New chat", with its buttons in one group at the right edge and the way out a little apart. Download is at the foot only, as a link like "Settings" on the other side. The history button stays lit while it is on;
- a file has a small page before its name, in the column where a folder has its picture, so the names of one folder stand in one line. File rows are 32 tall with 13px names.

For one day the chat rows were 32 tall too, level with the file rows. They are back at 42 with 14px names: the user liked the left side bigger.

The web still draws them its own way.

## Several chats at once, and a message box for each

One message box was shared by every chat (`App.draft`, `App.attachments`): text typed in one went along to whichever chat was opened next, and was gone after a restart. Now:

- **The box belongs to its chat.** Leaving a chat puts its text and chips away under its id (`ui/drafts.rs`) and opening it brings them back. The box's undo history is cleared on the way, or Ctrl+Z in the next chat brought the last one's words back. A notice above the box goes too: "Undo file changes" from a rewind would have undone them in the next chat's folder.
- **It outlives the app.** `drafts.json` in the data folder is written 0.6 s after the box last changed and when the app closes. A chip is kept as where it came from: a file or folder by its copy in the workspace (read from there again, never copied twice), a picture by its file with its description if it had one (never paid for twice). Chips are made live only when their chat is opened.
- **Pasted pictures are kept.** They went to `%TEMP%\apim-paste`, which Windows empties. They go to `pasted/` in the data folder now, and a start removes the ones no draft holds.
- **"New chat" goes back to the new chat you left.** `Conversation::new()` made a new id, so a fresh chat with text and files in it was lost behind the next one, its files in a workspace nothing pointed at. The blank chat's id is kept (`Drafts::blank`) and the app opens on it after a restart.

Replies run in as many chats as you send to. `App.run` was one reply and `parked` the one chat that could be written to off screen; now `App.runs` holds one per chat, each carrying its chat while another is on screen (`Run::parked`), and `pump` takes in every one each frame. Stop, approvals, questions and "btw" notes act on the chat on screen. Measured with `APIM_SHOT_INBOX` driving the window: two chats sent 4 s apart, switched between three times mid-reply, both finished with their files in their own workspaces.

What two replies at once had to have fixed first (found by reading everything an `agent::run` reaches for state shared across chats):

- A chat is not renamed while its reply runs. Its workspace and state folders are named after the title and move with it, from under a reply holding the old paths.
- The async runtime has 4 workers, not 2. Some steps still block the worker they run on (the sandbox's WSL probe takes up to 10 s), and with two of them every other chat's stream stopped.
- `screenshot_window` aims only at this chat's processes: process ids count up across all chats.
- One sandbox start and one local-model start at a time: two chats' first sandbox steps each started an Xvfb, and two local-model replies each killed the server the other had just started.
- `write_atomic` takes a temporary name of its own for each write, not one `.tmp` per file. A Ghidra project folder is per analysis, not per file.
- **A dump of mapped memory can be read.** A section carved out of a running process carries no header, so there is nothing to say where its bytes belong: Ghidra loaded it at 0 and nothing in it resolved. `image_base` (and `arch`, "x86-64" by default) now hands headless Ghidra its own `-loader BinaryLoader -loader-baseAddr … -processor …`, so the bytes are taken raw at the address they were mapped at — no PE header is built for them, since a synthesized header is one more thing to get wrong. Without an address a headerless file is not started at all: the result says which two arguments to pass, because a wrong address is worse than none when every reference resolves against it. Loading the bytes is not enough on its own: nothing in a headerless image points at code, so "Disassemble Entry Points" — the analyzer every other one follows from — had nowhere to begin and the program came back with zero functions however the analyzers were set. The pre-script now marks the first address of each executable block as an entry point (only for a raw load; a file with a header has its own entry, and seeding a section start would read data as code), and "Aggressive Instruction Finder" is turned on for the same reason. Measured on a 16 KB dump of 150 functions calling each other at `0x7ff782798000`: 150 of 150 decompiled, with the C to match. The ordinary header-bearing path is unchanged — `hello.exe` still reports 9 of 12, and the finder stays off for it. On a real carve rather than a built one — `hello.exe`'s own `.text` loaded raw at `0x401000` — 283 of 283 functions over 83% of the bytes; starting that window 20,007 bytes in, so its first byte is mid-instruction, still recovers 68 functions over 64%, which is the case that used to return nothing at all.
- **A `.env.local` beside the app is read.** The web app it grew out of keeps `APIM_GHIDRA_HOME` and the like in `.env.local`, and nothing here ever opened that file, so a machine with Ghidra installed and recorded still answered `spawn analyzeHeadless.bat ENOENT` — and the only fix was an environment variable set by hand in whatever shell started the app, which a double-clicked exe has no way to get. `main` now walks up from the working directory and from the exe for a `.env.local` and sets what it finds, skipping anything already in the environment, so a variable passed on the command line still wins. `export` prefixes and one pair of surrounding quotes are stripped, as the web app does.
- **A decompilation the time limit cut short is kept, not thrown away.** The summary was written after the decompile loop, so the one run that reaches the limit — a big binary, the only kind that does — was killed with every artifact on disk except the file saying how far it had got, and with no cache marker. The next inspection then deleted that output, started the same analysis, reached the same limit and deleted it again: half an hour of every core, each time, for work already done. The summary is now rewritten as each function starts and carries `Progress: in-progress` until the end, and a timed-out run that decompiled something is cached as `partial` and says so, with the limit to raise. Measured on 20,000 functions killed at 20 s: `Progress: in-progress`, `Functions decompiled: 8004`, reused in 0.2 s instead of 20 s; raising the limit misses the cache and finishes all 20,000.
- **The cache key covers what was asked for, not just the focus terms.** `analyzer_preset`, `disable_analyzers`, `enable_analyzers`, `allow_full_fallback`, `image_base`, `arch` and both time limits all change what Ghidra does, and none of them reached the key: a rerun that changed the analyzer set came back in 0.0 s from the old artifacts. That included the one rerun the tool's own description asks for — `enable_analyzers: ["Decompiler Parameter ID"]` to replace `param_1` with real names — which could not work at all. Caught by turning the instruction finder off on a file already analyzed and getting the finder's result back.
- **How much of the code was recovered is measured, not left to be worked out.** The summary gives the executable bytes, how many of them are inside any function, that as a percentage, and the first and last function address; under 50% it says so and names the two analyzers that move the number. A reader spent three rounds deriving this from `functions.tsv` by hand to find where a 4.2 MB image had been cut. `.rdata` loaded as if it were code now reports "100% of the executable bytes are in no function" instead of a cheerful "1 function decompiled".
- **The analysis says what Ghidra actually did.** The summary lists every memory block with its address range and permissions, and the pre-script writes the analyzer list twice. Both files are lines of `[on]`/`[off]` under near-identical names and the two disagree by design, so each now opens with the stage it comes from, and `analyzers-applied.txt` also prints what was asked for, marks an analyzer this Ghidra does not have, and says whether entry points were seeded. Three runs went into working out whether an override had landed, whether the block was executable and whether the language was right, each one guessed at from an empty result.
- **Every "set APIM_… in .env.local" line now says which file it means** (`env_local_source`), because the app looks in the working folder and beside the program and then upwards, and a reader with the wrong one of those open cannot tell.
- Measured and left alone: seeding every call target Ghidra left without a function created nothing in five runs, including one with the instruction finder off, because flow-following already makes a function at every direct call target it disassembles. What is still dark in a stripped dump sits behind indirect calls, which no call-target pass can see; the coverage warning above points at the two analyzers that can.
- **An MZ with no PE signature is said to be one.** `e_lfanew` pointing at anything but a PE, NE, LE or LX header fell through to "legacy DOS/Windows" with `imageBase 0x0`, no sections and no imports — a silent downgrade that reads like a clean inspection, and cost a reader two runs before the header they had built was found to have `e_lfanew` and the signature in disagreement. It now says what stands at that offset ("found \"H\x8b\x05\x00\", not \"PE\0\0\""), that the file is a raw or truncated image rather than a legacy program, that nothing below it was read from a header, and what to pass to read it anyway. A genuine NE, LE or LX still reports as before.
- **A reason for not decompiling was printed only if it used the right words.** The report showed the deep-decompilation block when the status was anything but "disabled" or the text held the phrase "was not started", so the first new reason that did not happen to use that phrase was dropped from the report and the run read as though nothing had stopped it — the same silent-skip shape as the MZ fallback. It now shows the block for every result with a decompiler behind it, and hides only the one case nobody asked for (`deep: false`, engine "none").
- **An entry point of 0** on an otherwise valid PE is called out: the image declares no entry, so a decompiler has no first function and guesses where code begins. Hand-built and rebuilt headers leave `AddressOfEntryPoint` unset, and nothing said so.
- **Reading a binary no longer takes the computer.** Ghidra runs one `decompile.exe` for each analysis thread, and `-max-cpu` is every core but one — five of them here, enough to make the user's own windows stutter for the ten to thirty minutes an analysis lasts. Everything the decompilers start is now started below normal priority (`CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS` in `decompiler::run_captured`), which the JVM's children inherit, so Windows hands a core back the moment anything else wants one. Nothing is given up: with the machine idle the analysis still has every core, so the thread count is left where it was rather than traded against the wait. Checked by asking a process started that way for its own `PriorityClass`: `BelowNormal`. Slow is the analysis itself — a full pass over a big binary runs for hours, which is why nothing starts without named `focus_terms`.
- **The heap setting reached nothing.** `APIM_GHIDRA_MAX_MEMORY` was handed to Ghidra as `MAX_MEMORY`, which no Ghidra launcher reads; 12.2's `analyzeHeadless.bat` reads `GHIDRA_HEADLESS_MAXMEM`, 2G when unset. So every run had 2G whatever was set, and a 15.3 MB carved `.text` ran out of heap in `X86Analyzer`, before a single function was decompiled. It now goes out under that name (and `MAXMEM` for older launchers), 4G unless set. Checked through the tool: `APIM_GHIDRA_MAX_MEMORY=64M` now stops a 256 KB run with `java.lang.OutOfMemoryError: Java heap space`, where 256M used to finish normally with 1.7 GB in use.
- **A failed run says why, first.** The model got the last 6000 characters of the log, mostly startup chatter and script paths, and an analyzer's `OutOfMemoryError` sits above its stack trace and the shutdown. The result now opens with the lines that name a cause (out of memory, a script that does not compile, an import with no loader, an abort), then the end; the whole log is kept as `ghidra.log` beside the output, since `-deleteProject` takes the project and Ghidra's own `application.log` is one file every run on the machine writes into. "Partial" now means some functions were decompiled: counting files called a run that died in auto-analysis partial, because the analyzer lists are written by every run. Ghidra exits 0 when the import itself fails, so a file it finds no loader for is told to pass `image_base`.
- **Analysis gets at most half of the whole-process limit.** Both were 30 minutes above 10 MB, or raised to the same value, and the process limit counts from launch: whenever analysis ran into its own, the kill came first and the post-script never decompiled anything.
- **The instruction finder is no longer forced on for a big raw image.** It was turned on for every raw load. On the 15.3 MB carve it is what broke the run: out of a 2G heap, and with 6G it filled the heap and met the 15-minute limit at 53% coverage, where without it the analysis took 85 s for 27%. On a 256 KB carve cut mid-function it found 880 functions against 878 without it. It stays on, unasked, for raw images up to 4 MB (the 16 KB dump above, a 2.7 MB `.text` in 279 s), and above that the result says it was left off and how to ask for it. The 15.3 MB carve now finishes with nothing set: 108 s, 27% of its bytes in functions.
- **`seed_addresses`** makes a function at each address given and decompiles it, whatever the focus terms. A carved image that starts mid-function has code nothing flows into: three real function starts of Taskmgr (from its exception table) stayed undecompiled in a 256 KB carve with or without the finder, and given as seeds all three were decompiled, in 13 s through the tool. The seeds go to `seeds.txt` in the output; the pre-script marks them as entry points and the post-script makes each a function if analysis did not, and says in `summary.txt` which were used and why any was not (not hex, outside every block, mid-instruction). They are in the cache key.
- Checked and found wrong in what a model concluded from one failed run: more cores do not take heap from the JVM (`-max-cpu` sets the analysis thread pool, not `-Xmx` or the collector's threads, which the launcher fixes at 2; peak analysis heap was 110 MB at 1 core and 130 MB at 5), and focusing the decompile step would not have saved it, since the run died in analysis, which always covers the whole image.

- **Each chat has its own sandbox display** (`sandbox::run::ensure` keeps one per chat, each on a display the others do not use). With one for all, two chats running GUI programs drew on the same screen and each one's screenshots showed the other's windows. A chat's display lives until the app closes, some 20 MB of Xvfb each.
- **`endpoints.json` is changed under one lock, read and written whole** (`provider::update_endpoints`). A chat probing endpoints for a few seconds wrote back the file as it had read it, losing the counts other chats added meanwhile, and a write caught half done read as an empty file that the next count started again from. Checked by six threads counting forty times each into one file: no count lost.

## A model for each chat

The model was one setting for the whole app: a chat's next question went to whatever was picked last in another chat. Now the model belongs to the chat (`Conversation::model`, a `model` key in its `chat.json`, which the web app keeps untouched). A pick made anywhere (the model menu, `/model`, Settings) is written to the chat on screen; opening a chat brings its model back, unless that model has left the list since. A chat from before goes by its last reply's model. A new chat starts on the model in use. A chat a reply ended in while another was on screen is summarised by its own model, not the one on screen.

Checked in the window with two chats from the real data copied to a spare folder: the game chat opened on GLM 5.3 Flash and the other on Claude Haiku 5.5; DeepSeek V4.1 Flash clicked in the game chat's menu was saved to that chat alone, and came back when it was opened again in a new process.

## Free models, free search, and research first

Measured on OpenRouter's free lanes (2026-10-27): Nemotron 3 Ultra, Nemotron 3.5 Lightning, Laguna S 2.1, Gemma 4 31B. Fresh small tasks finish; what went wrong was around them.

- **A full upstream pool was waited on for 217 s, then failed anyway.** Gemma's free pool (Google AI Studio, shared by every OpenRouter user) answered 429 to all five retries and all six waits. A free model's upstream 429 now gets two waits, then an error that says what it is and what to do. OpenRouter's own limits are read from its 429: the day's allowance (50 requests, 1,000 once $10 was bought) ends the reply at once with the time it comes back; the minute's (20) is waited out to the moment it resets. Requests to free models are spaced 3.1 s apart, so a run of quick rounds waits here rather than on a 429.
- **The first token was given 45 s.** A free pool queues the request and reads a long prompt slowly; cut and asked again, it started at the back of the queue. Free lanes get 150 s.
- **Shell lines were refused round after round.** Small models write `python --version && pytest --version`, `del sample.txt 2>nul || rm -f sample.txt`, `echo x > f.txt`, `del f.txt`; each was answered "There is no shell here" or "not an allowed command", and Laguna and Lightning spent six rounds of one task on it. A line with `&&`, `||`, a pipe, `;` or a redirect, and cmd's own commands (`del`, `dir`, `type`, `copy`, …), now run in PowerShell, with `&&`, `||` and `nul` put in the words Windows PowerShell 5.1 reads (`powershell_line`). The approval rules are PowerShell's, as before.
- **Web search needed a paid key.** Without Tavily or Exa the tool was withheld. Now `web_search` asks the free engines first: DuckDuckGo's HTML results page, then Brave's, with the model's own query, once. Tried and dropped: Bing without cookies answered with pages about something else; Mojeek and Startpage answer with a JavaScript challenge. Both engines refuse a burst (Brave six queries in five seconds, DuckDuckGo three in one) and then keep refusing for half an hour, which is why the free path sends one query per search (the planner made three to six), each engine 3 s apart, and leaves an engine alone for ten minutes after it refused. Tavily and Exa are the fallback when the free engines find nothing or refuse; the Quality search profile asks them alongside. Searches answered by the free engines are not counted in the search cost.
- **Models did not look things up.** The rules said to search "when you hit something you do not know", which a model that does not know what it does not know never hits. They now spell out the habit before the work starts ("Know before you build": what is unfamiliar or may have changed is searched and its source read; an unknown error is searched by its exact text; an existing tool is looked for before one is written; a named site or product is opened, not recalled), the first request of a reply ends on a one-line reminder of it, and `fetch_url` is an everyday tool rather than one in the web group. Nemotron 3 Ultra on "a script that prints the Bitcoin price from a free public API": before, it wrote the script from memory; now it searched first (8 results, CoinGecko's own keyless-API page among them), then wrote and ran it.
- **The prompt said there was no browser** next to a `browse` tool that drives the installed Edge or Chrome. The browser paragraph now follows the tool.

## Carrying a big task through

The same reply, read round by round (201 rounds, 82 minutes, $0.39, two of six plan steps done), lost most of its rounds in four ways. None of them is about the task; each is about how the work was prepared:

- **It acted on a guess.** It installed one language's runtime before looking at the file, then noticed the file was written for another, and still spent thirty rounds converting the file by hand before it fetched the right interpreter.
- **It built what exists.** A pretty-printer written three times, a tokenizer reworked for twenty-five rounds until a real parser did the job in three, and a search for published tools at round 119 instead of round 2.
- **It fixed one error a round.** Eight rounds went to eight stray brackets in one file, each found by running the whole thing again.
- **It waited blind.** A dozen runs ended at a time limit with nothing printed, one of them five minutes long, before it saw that a stopped program loses what it has not flushed.

What the app now gives a model for this:

- **Standing instructions for a big task** (`assets/prompts.json`, `workLoop`): look before you assume; find before you write; name the check that proves the goal and what is handed over if only part is reached; keep experiments short; step back on a timer.
- **At plan time** `make_plan` answers with one line more: look for what already exists for this exact problem and try that first.
- **At a checkpoint** (a plan step forty rounds old) two questions are added to the web's: are you building by hand something that exists, and how long does one experiment take (`plan::STEP_BACK`).
- **A run stopped at its time limit with nothing printed** says why nothing came and how to run it so the output survives: bounded, line-buffered, or into a file.
- **A run of ten seconds or more says how long it took.** The model has no clock.
- **The sandbox says what it holds** (python, node, gcc, git, gdb and the rest), so no round goes to finding out, and its description says to fetch a real tool before writing a stand-in.
- **The sandbox's node works on WSL 1.** Ubuntu's own does not start there ("Exec format error"); setup now checks it and puts node's official build in /opt/node when it does not (`wsl::NODE_REPAIR`).

Measured on a look-alike task (a 78,000-character line of minified JavaScript: restore it readable and prove it behaves the same), one run each, GLM 5.3 Flash at high effort: the build before these changes wrote its own formatter and repaired it three times, 17 requests and $0.022; the build with them installed a published formatter, 7 requests and $0.011. Both proved the result.

### The same chat, a third time

The next reply in that chat ran 224 rounds in 78 minutes for $1.03, finished two of its six plan steps, and stopped at the dollar. Read round by round, most of what it cost bought nothing:

- **One read was a quarter of the bill.** The model asked for the first five lines of a file to see what was in it. The file was one line of 217,000 characters, and all of it came back. As the newest read of that file it stayed in every request of the 218 rounds that followed: about a third of each. A line over 8,000 characters now shows its start, says how much is missing and how to reach it (`files::cut_long_lines`); a saved reply taken up again has such lines cut the same way.
- **Every small check took two rounds.** Some fifty one-off scripts were written as files and run in a second round, each round carrying the whole conversation; four times the run came before the write. `run_command` now takes the script on `stdin` (`python -`): one call, no file left behind. When the user is asked first, the card shows the script, and "always allow" remembers that script only.
- **The plan was asked for twenty-five times and had nothing to say.** Six rounds without `update_plan` and the app asks for one; the model answered `{"id":1,"state":"doing"}` each time. A plan that already shows the step being worked on is now asked about every twenty-four rounds, or when the prose claims a step is done.
- **`python` was not a command in the sandbox.** Ubuntu ships `python3` only. The model typed `python`, lost the round, and went back to the Windows side, where a Linux program cannot run. Setup now links the name, and the sandbox tool says which side runs what.
- **It took code apart with regular expressions.** A walker over one if-tree, counting `if` and `end`, was rewritten six times in sixty rounds, with that language's own parser two folders away in the same workspace. Asked at a checkpoint whether it was building something that exists, it answered for the whole project. The standing rules now name the small tools too (code is taken apart with a parser, never by counting brackets), and the checkpoint asks about the script in hand.

Measured on a look-alike task (a 300,000-character one-line JSON file and a minified script whose strings hold decoy function headers: count the failed records, list every function with its parameters, prove each number), one run each, GLM 5.3 Flash at high effort. The build before these changes probed with `python -c`, took the script apart with regular expressions and rewrote its report script three times: 16 requests, 293,000 prompt tokens, about $0.013. The build with them probed from stdin, installed a JavaScript parser and cross-checked it: 8 requests, 114,000 prompt tokens, about $0.007. Both reports were right.

Three things the screen said wrongly about that reply:

- The line under a reply read "~352k ctx" beside a ring at 15% of a million. It was the count of characters. It now shows tokens where the provider counted them ("~152k ctx").
- The thinking sent back to the model was counted in no part of the context breakdown: a third of the request.
- A reply stopped between two steps showed its last round's raw ending, "tool_calls". It reads "unfinished". One that closed properly with the finish tool showed the same word; it reads "stop".

And a message sent with a large file showed the note written for the model (the file's size, its first lines, which tool reads the rest) above the words that were typed. The bubble now shows the file's chip and the words.

### The same chat, a fourth time

The reply after that ran 148 rounds and died on "OpenRouter API error (400): Provider returned error". Read round by round:

- **Two answers of 600,000 characters ended it.** The model changed a few words in a generated file whose one line holds a 600,000-character program. `edit_file` shows the lines around a change so the model can check it, and it showed that line whole, twice. The next request was 1.8 MB and the provider turned it away without a reason. Lines beside an edit are now cut as a read cuts them (`files::describe`), and a saved reply taken up again has them cut too, so Resume works on that chat.
- **The error said nothing.** A refusal that is only OpenRouter's envelope now carries the provider's own words when it sent any, and a refused request over 400,000 characters says its size: "(the request was 1.8 MB)".
- **It answered the same question twenty-two times.** Every round ends with a note restating the request, so a long run cannot drift to an older task. The request was a question ("so what do we do to get …?"), it was the last thing each round read, and the reply kept answering it: "Answer (same as before): …", "User asked again: …", under a note that already said not to. The request now stands quoted inside the note, and the note ends on what to do (`goal_pin::render_goal_pin`; the web's wording is unchanged). Measured on a made-up transcript of thirteen rounds with the chat's two plugins on and the habit already begun, forty samples of each wording: the old one got the plan said again in 3 and some remark in 10; the new one got the next tool call and no words in all 40.
- **One slip cost forty rounds.** Its first one-call script went in as an argument after the dash (`args: ["-", "<script>"]`). Python opened its prompt on an empty stdin and "exit 0" came back with the banner; the model concluded "stdin got swallowed" and wrote every later check to a file, with a second round to run it. A script after the dash is now run as the script it is, and a dash with no script is refused with the right call.
- **A plan in words is no plan.** The reply opened with "Plan, 5 steps" as text and never called `make_plan`: the user saw no plan, and no step was ever counted. A numbered plan written into a reply that goes on working is now answered once with a note to put it in `make_plan` (`plan::wrote_plan_in_words`), and the note at round eight of a reply with no plan asks for one too.
- **`>out.txt` reached the program as a word.** There is no shell, so luau answered "Error opening ./>_NBUF_OUT.txt" and printed 30,000 characters of numbers. A redirect or a pipe among the arguments is now refused before anything runs, with the reason.

On screen, the row of that first script read "Ran python - · Ran: python - "". A script among a command's words is now named by its size: "python - <<stdin (10 lines)".

### Watching a reply as it is written

`bugs.md` of 11 October 2026 was written while a reply ran: a script polled the chat's file every five seconds and each thing that looked wrong went into the list at once. Seventeen entries in two hours, against six from reading the same chat's record the night before. What was fixed:

- **A minimized window took nothing in.** eframe 0.36 draws no pass for a window nobody sees and calls only `App::logic`. Everything the reply sent was taken in inside `ui`, so for as long as the window was down nothing was saved (nineteen minutes of rounds, once: closing the app then would have lost them), the end of a reply went unnoticed, and a command waiting for approval showed no card and flashed no taskbar. It timed out unseen after five minutes and the reply threw its approach away. The taking-in is in `logic` now. `APIM_SHOT_STATE=send,minimized` puts a self-portrait's window down for the length of its reply: the chat's file grows while it is down.
- **A command's whole output is kept.** A long output is shown with its middle cut. The middle used to be gone, and three times in one afternoon a reply ran a five-minute program again to get it, through PowerShell's `>` (which writes UTF-16, four more rounds each time to find that out). Once it wrote a script that opened the output file it took for granted the app had kept. Now `run_command` writes every byte to `.outputs/<time>-<program>.txt` in the chat's folder, names the file in the first line of its answer, and says not to run the program again. Read whole, a kept output shows its first 12,000 characters and how to get at the rest (a script that reads the file, a search, a line range): one of 124,000 characters read in one go was sent again with every later round, 326,905 tokens for a turn that took 46,742 when the reply ran a script over the file. More than 64 MB is a program that will not stop printing: the file holds the first 64.
- **And so is an output that was shown whole, when it will be folded later.** An answer of 1,500 characters or more is folded to one line once it is old (to keep requests small). In the benchmark a reply ran its "before" checks, changed the code, and then wanted that earlier output to compare: it had been folded, the code it came from was gone, and the line said "re-run the tool". The reply undid six of its own files to print it again, found the undo went back one step only, and rebuilt the old code from memory: 25 of its 43 rounds. Every output that can be folded now keeps its file, and the fold line starts with the file's name. The folder is hidden from the file list, the side panel and restore points (like `.history`), holds the newest 300 outputs, and `read_file` and `search_files` open it by name.
- **What the app tells every round rides inside the newest tool result.** The request, the plan and the nudges went after the results as system messages, and the model answered them: "Reminder handled.", "Plan noted.", "Step-budget check accepted." opened round after round. On a made-up run with that habit begun, 24 replies a way: as two system messages 6 answered a note and 19 wrote words; as one merged message 12 answered; with the plan alone 2; inside the tool result 1 answered and 5 wrote words. The saved transcript keeps the note as its own last message, as before.
- **The plan is pinned above the composer** (`plan_panel.rs`): one line with the step being worked on, the bar and the count, the steps on a click. It was a card in the newest reply, hundreds of rounds up the page of a long one.
- A program that starts and exits with an error is "Exited at once (code N)" in its step row and in the problem log, not "Failed to start". A long step's checkpoint is logged as `run_checkpoint`, not as a stop.

Seen and left: restore points copy every file up to 512 MB (1 GB for that one chat's scratch dumps); the workspace listing is one line a file however many there are (900 lines, 10,000 tokens a request); every round's thinking rides in every later request (the second largest part of one); the time shown as thinking includes the time the model spends writing a tool call.

### A compaction that looked hung, and changed nothing

A chat of 976 messages with a reply stopped at 579,000 tokens: Compact said "Compacting…" for seven minutes. It was working: eight parts of the chat, each read in one call that carried the summary so far, about 55 seconds a call, with nothing on screen to tell that from a hang. And when it ended, the next request carried exactly what it had before.

- **The parts are read at the same time.** Each part is summarised on its own, and one last call folds the parts, oldest first, into the summary. A made-up chat of three parts (2.3 million characters, three facts planted far apart): 23 seconds against 51, the three facts kept both ways. The wait is now the slowest part plus the folding, whatever the number of parts.
- **The button counts and stops.** "Stop · 3 of 9" while it works; a click drops the calls where they stand and leaves the chat as it was.
- **A compaction over a stopped reply covers the chat.** The summary names the last message it covers. That was the stopped reply, which is not one of the turns a request replays, so the name was never found there and the summary covered nothing: every older turn went out again beside it. Where a summary ends is now looked for among all the messages (`summary::shape`).
- **Resume opens with the chat as it is now.** A saved transcript begins with the turns that stood before its question when it was saved. When those have since been compacted (the same question, and at least a fifth smaller), the opening is taken afresh and the reply's own rounds are kept (`agent::refresh_opening`). Stop, compact, resume on a made-up chat: the request went from 96,088 tokens to 11,444, and the reply finished its forty files.
- **Dead saved transcripts are dropped when a chat is loaded.** Only the last reply can be resumed. That chat's file was 340 MB, 155 MB of it transcripts of earlier replies that had stopped, read into memory and written out again with every save.

Met in the live benchmark (`bench/live`, 2026-10-13), each read out of a reply's rounds:

- **An honest "I could not do this part" was pushed on.** A reply did two of three things, said plainly that the third could not be done (a host that does not exist), and closed with "give me the real URL and I'll update the file". The app read "I'll update" as an action left undone, said "The model stopped mid-task" and sent "call the tool in this response", twice: twice the tokens, and a push to act on what cannot be done. A promise in a sentence that waits on the user ("give me", "if you", "paste", "once you") is not taken for one (`run/revive.rs`).
- **`run_tests` said "pip install pytest".** Any Python project made it pick pytest, and without pytest its answer was to install it, into the user's own Python. It falls back to `python -m unittest` and counts that runner's output.
- **`edit_file` with the text to replace and a stray `end_line`** replaced that one line with all of the new text, and the block stood in the file twice. The text names the region when it is in the file once, and always when the only number is an end.
- **A read hid a byte order mark and called the text EXACT.** A reply parsed a CSV as it had read it and found no column named Email: it was the mark plus "Email". A read ends with one line when the file on disk starts with a UTF-8 mark or is UTF-16.
- **A PowerShell delete inside the chat's own folder was refused as "outside"**: any drive letter counted as outside. The folder's own full path is inside now; a folder that only starts like it, or `..` out of it, is still refused.
- **The file listing left out `build/`, `dist/` and `__pycache__/` without a word**, so a reply asked to clean a build had to ask the shell whether the project was clean already, and another could not see the `dist/` it had just made. The listing and `list_files` end with one line naming what they left out.
- **A tool name with the model's own markup after it** (`read_files</arg_key>paths</arg_key><arg_value>["a.py"]`, from a free coding model) was "Unknown tool" and the round was lost. The name is the part before the markup, the rest its arguments.
- **A whole command line in `command`** (`python -c "…"` and no `args`) was "not an allowed command", several times in a row on the same model, until the stall guard ended the reply. With no args given it is cut into words as a shell cuts it.
- **A sentence written "1) … 2) … 3) …"** was drawn as a list of one item, "1." in front and the rest run on inside it. A line that opens with `N)` and carries `N+1)` further on stays a sentence.

Met on four more model families (DeepSeek V4.1 Flash, GPT-6 Luna, Qwen 3.8 Flash, Claude Haiku 5.5; 2026-10-13), each read out of a reply's rounds. Every one of them passed all 21 turns of the first sixteen scenarios, so none of this showed in a score:

- **One read of several files was collapsed when the first of them was rewritten.** A reply read `lib/*.py` once and rewrote the files one by one; eight results later the read was a one-line stand-in, and the text of the files not reached yet was gone. Haiku 5.5 noticed ("a read that is collapsed in this transcript"), undid its work, read again and lost it again: 81 tool calls and 1.5 million tokens for one turn, 33 calls and 0.43 million once a read is kept until every file it showed is rewritten (`context/prune.rs`).
- **Claude models read nothing from their cache.** Their endpoints read only up to a mark the request sets, and only where an earlier request set one over the same text. The app set none, and it folds the work state into the newest tool result, which is gone from that result a round later. Replayed on Haiku 5.5: 0 of about 16,000 tokens a round as it stood; 99% with the first system message and the newest tool result marked and the work state a message of its own after it. Done for `anthropic/` models only. The round in which a chat's first plan adds its five tools still reads nothing.
- **The endpoint pick hopped.** Counting what each endpoint reads from its cache (see above) made the pick move whenever two counts crossed: 17 moves in one pass on GPT-6 Luna, each starting with a cold cache. The endpoint used last stays unless another costs 15% less.
- **A plan update that changed nothing said nothing.** GPT-6 Luna sent `{"id":1,"state":"doing","verified":"…"}` six times, each with a longer proof, and got the unchanged plan back each time, until the stall guard ended the reply. The answer now opens with what did not happen: `verified` counts only with `done`, or nothing changed and the work itself is next. The first two rounds of a reply that hold nothing but a plan update are told what such a round costs.
- **`"start_line": 0, "end_line": 0`** (a model that fills every optional field) was "Lines 0-0 are out of range". Line 0 is no line, and an end anchor sent alone is the text to replace.
- **Plan steps as objects** (`"steps": [{"step": "…"}]`) were refused; the sentence is taken out of the object.
- **The stand-in for old arguments, copied as a new call's arguments** (`{"_note": "arguments trimmed from history…"}`), was answered "No command was given". It is told what that text is.
- **Thinking written into the answer** (`…</think>answer`) stood in the chat as the answer. Between the model's own tags it goes to thinking, and a closing tag with nothing opening it takes the text before it back out of the answer.
- **Looks:** the header chip for background processes read "Stopped" next to the cost, as if the reply had been stopped ("Processes" now), and a chat's title kept the backticks of its first message.

Met in a large tree and in a long chat (`big-tree`: Python's own library with its interpreter, 2,268 files; `long-haul`: twelve messages on one project; GLM 5.3 Flash and DeepSeek V4.1 Flash, 2026-10-13). Both models passed every turn of both, so again none of this showed in a score:

- **The file list was 60,000 characters in every round.** A request names every file of the workspace, up to 2,000 of them: 17,000 tokens a round in this tree, 842,730 tokens for a one-line fix. Past 400 files the list now names the files right under the workspace and every folder with the number of files in it and below it (`context/workspace_context.rs`). The same fix on the same model then took 172,869 tokens; the three turns 1.09 million and $0.028 where they had taken 1.90 million and $0.044 (one run each).
- **`list_files` answered with 2,000 lines**, carried through the rest of the reply. A tree that large is answered folder by folder too, and a folder given as `path` shows its own files and the folders under it.
- **A program in the workspace, asked for by its bare name, ran the one on PATH.** Told "`python.exe` here runs it", a reply ran the machine's Python for four rounds and could not see the fault. PATH still wins, as in PowerShell, and like PowerShell the result says that a program of that name is in the workspace and how to run it (`.\python.exe`).
- **A commit of everything took the app's own folders with it.** `git_commit` with no paths adds all, and `.snapshots` (57 MB here), `.history`, `.outputs` and `.analysis` went in; the reply noticed, undid its commit and made it again by hand. A workspace that is a repository gets these folders named in `.git/info/exclude`, which is this clone's alone and is never committed.
- **A read from a line on, with no end named, gave the rest of the file**: lines 3060 to 5603 of a test file, 28,000 tokens in every round after it. Such a read shows 800 lines and says where to go on. (Checked by its test only, not yet in a live run.)
- **The closing answer said how it was checked twice**: the tool's wording asked for it in `result` and again in `verified`, and both are shown.
- **An install into the machine ran unasked** (2026-10-23). With commands running automatically, a reply told to write tests wrote them for pytest, found it missing and ran `pip install pytest` into the user's own Python: three packages that outlive the chat and that no restore point takes back. The prompt already said an install is for the user to approve; nothing asked. `pip install`, `python -m pip install`, `npm -g`, `yarn global`, `cargo install`, `go install` and `uv tool` outside the workspace now ask even then (`installs_on_machine`), and the prompt names unittest as the runner that needs nothing.

What held, and is now measured: the five rules of the first message, a code said in passing in the third and a decision of the fifth were all there at messages ten to twelve, on both models. The rules came through the summary of older turns word for word; the two asides were recorded with `note_finding` by the model itself and retired when used. With the model's window set to 60,000 tokens a reply folded its older rounds twice ("Context compacted · 12 steps summarised") and still finished right.

Not changed, and yours to decide: `git commit` typed as a command on the base branch gets past the rule the `git_commit` tool keeps (GLM committed to `main` three times that way).

Read out of a model's own report (2026-10-25). Asked after a long job what held it back, a reply named seven things. Held against the code, three were real, three half and one wrong:

- **It was told every command waits for the user, and that there is no shell.** `run_command`'s wording is the web's, where both are true. Here, with commands running automatically, nothing asks but an install into the machine, and PowerShell takes a whole script. The model priced every look as an approval it never got, looked less, and ran one program per round. The wording now leaves who is asked to the system prompt, which always said it, and on Windows calls PowerShell the shell: pipes, `;` and loops, the steps that go together in one call. "Ask me first" now says what it does not ask about. The same task before and after (DeepSeek V4.1 Flash, one run each): 6 requests and $0.0070, then 4 and $0.0045, with the tests, a line count and a process query in one round.
- **Work an earlier reply did was called invented.** The closing text is held against the tools that ran, and only this reply's counted: a summary of what the last reply wrote got "no file tool ran", and the model wrote corrections instead of finishing. The tools every earlier reply in the chat ran count now (`ChatState::tools_run`).
- **Every finding rode every question**: the 25 newest, up to 17,000 characters, most of them about other work. Past six, a question gets the ones it names by a word of their claim or files (a word a third of them share does not count), the newest besides when it names few, and a line saying how many more are in `.analysis/findings.json` (`format_findings_for_question`).
- **A wait on a background process stopped at 2 minutes**, so a 10-minute build took five waits. A wait and a command's own `timeout_ms` now go to 10 minutes.

Not as it said: a 420 MB folder is not too big for a restore point (the limits are 512 MB a file and 100,000 files, and a file is stored once however many points name it); the helper agent only reads, by design; and a command's 60 seconds was a default that `timeout_ms` raises.

## Checking the tools

`apim --tools calls.json --auto --dir FOLDER` runs a list of tool calls (`[{"name": "edit_file", "args": {...}}, ...]`) as the agent would make them and prints what each hands back: no model in between, so a tool is judged on what it does. `APIM_TOOL_CHARS` sets how much of each result is shown. All 59 were run this way on 2026-10-09; what that changed:

- `edit_file` reported "Edited" for an edit that left the file as it was, and took half a range (an end, no start) for one line. A model then looped: thirteen such edits in one chat. Both are refused now, with the lines as they stand; and every edit says what it replaced, so one that landed on the wrong lines is seen at once.
- `apply_patch` missed every hunk that was not at the end of its file when the patch ended in a newline, and refused a bare `@@` header.
- The loop breaker stopped the plain fix-and-rerun loop (edit, run the checker, edit, run it again) as "the same failing call three times". A command run again after the workspace changed is a new try.
- `run_tests` finds tests kept beside the code (`test_x.py`), runs pytest as a module, puts a test's name behind `-k`, and says how to get pytest when it is missing.
- Taken as meant: a process id without its `p`, a command line in one string, `update_plan` with `step`/`status`/`completed`, `query_data` with a bare condition (answered with the JSONPath that works) or a count with no query.
- "Run automatically" does not ask about a program built or downloaded into the chat's folder (it did), nor about PowerShell (it did, see "Asking the system").
- `update_plan` refused a step called done with no word on how it was checked, every time; a model that sent the same call three times had its finished run stopped by the loop breaker. It is asked once, and the second time the step is taken as done and wears "not said how it was checked". What was refused now comes first in the result, not after the whole plan. `finish` asks once in the same way.
- `delete_file` takes a folder inside the workspace, with everything in it.
- The check that marks a reply claiming work no tool did took "drop the dump here and I read it" for such a claim: an offer or a condition is no longer one. Its retry asks for a short correction, not the reply written out a second time.
- The request restated at the end of every round is marked as the app's reminder: a model took it for a new message and answered it each round.

Not run: `sandbox_run` and `sandbox_screenshot` (they need the WSL sandbox), `screenshot_window` on a real window, `web_search` (no key in the test folder), the GitHub tools against a real repository.

## Tools on demand

The agent has 59 tools, and their descriptions used to ride in every request: 57,000 characters, about 14,000 tokens, on every round. A plain "hi" cost 15,760 tokens to answer in 52. Now a request carries the thirteen everyday tools (list, read, write, edit, search, run a command, the plan, ask, finish, web search, read a page), and the rest wait in eleven groups: files, code, processes, web, pictures, git, sandbox, data, memory, binary, helpers.

A group arrives in one of four ways, and then stays for the chat:

- The model asks for it with `load_tools`, whose description lists every group and its tools. This costs one short round.
- The message names it: a link brings the web group, "commit" brings git, "tkinter" brings the sandbox. Plain words in English; a request put another way costs the one round above.
- The chat's settings call for it: a connected GitHub repository brings git.
- Every reply has memory and helpers from its first request, as the standing instructions lean on them. They used to come at the third tool round, and that changed the tool list in the middle of the reply: tools ride ahead of every message, so the next round read nothing from the provider's cache (on DeepSeek and on Claude alike).

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

Text in a reply, your own messages, the notices between steps, the "Context compacted" line and the words of a step row can be selected with the mouse and copied; a click on a step row's words still opens the row. A selection has rounded corners and its letters keep their colour (`ui/selection.rs`: egui draws square boxes and inks the letters in a border's grey).

A selection scrolls with you. egui turns no wheel while anything is dragged, so text could not be selected further down than the window reached, and a drag past the top or the bottom of the transcript left the view where it was. While text is being selected the transcript now takes the wheel itself, and a drag held past an edge scrolls that way, faster the further past (60 points a second at the edge, up to 3000; `selection::edge_scroll`). Scrolling was the easy half; the selection kept going away on the way, for three reasons, each found by a self-portrait that drags, scrolls and copies (`select-…,wheel-1500`, `hold-1500`, `away-3000`):

- **egui follows a selection only through text inside the clip**, and lets it go in any frame that does not reach both its ends, while a long chat lays out only what shows. Now the messages and rows between where the selection started and the window it was last dragged in are laid out while it lasts, those out of sight in a disabled child with no opacity, clipped to that stretch (`lazy::offstage`): egui sees both ends, nothing is painted and nothing there takes a click. Not past the window: egui takes a text laid out below the window, with the mouse below it, as dragged over, and the selection ran to the end of the chat.
- **A message coming into sight renamed every message under it.** egui names what has no name of its own by counting, a message out of sight took one number and a laid out one two, and a selection is held by those names. Each message's column now has its own id. Traced frame by frame, a selection held in the last reply went in the one frame the question above it came into view.
- **egui finds the text under the mouse where it was a frame ago.** A wheel that moved the view 700 points in one frame left the end being dragged where the selection's point was no longer kept. What is kept is now the whole window the selection was last dragged in, not the point.

Measured on a chat of eight replies of twelve paragraphs: dragged with the wheel turned 1500 points down, 20 paragraphs over two replies were copied, in order and none missing; held past the bottom for 1.5 s, 21 over three messages; past the top, 16; the wheel turned 1500 up, 21; turned 3000 points away after letting go, the copy still held all of it. A press on text that is already at the end, held below the edge, selects to the end and stops. Frames while scrolling with a selection held: 0.3 ms at the median against 0.2 ms with none.

## Your phone

The apiM iPhone app (`ios/`) drives this window from anywhere on the same network: it shows the chat on screen and the chats beside it, sends messages and photos into the message box here, answers the approval card and `ask_user`'s questions, and stops a reply. It mirrors rather than keeps its own state: a chat opened on the phone opens here, and a message from the phone goes through the same Send as one typed here, so a command runs, and words sent while a reply runs reach it as a note. Settings > Phone turns it on and shows the code to scan.

- **No server in between.** The phone connects straight to this computer on port 47100 (`APIM_REMOTE_PORT` moves it). The QR code holds the addresses (the one the default route leaves by and, with Tailscale, the Tailscale one, which reaches it from anywhere) and a 32-byte key. Every frame after the two hellos is ChaCha20-Poly1305 under keys HKDF-SHA256 derives from that key and both sides' random values, one key per direction, a counter as the nonce (`remote.rs`, on the `ring` already in the tree). A phone without the key is dropped before it sees anything; a frame replayed from an earlier connection or within one does not open. "Unpair all phones" makes a new key. A phone that connects is named above the message box ("iPhone connected. It can send messages and approve commands here."), so one that should not be there does not go unseen.
- **Only what changed travels.** The phone is sent the chat once, then each message whose JSON differs from what it was last sent, at most every 120 ms: a reply being written re-sends only itself. A whole real reply with a command and its approval (below) took 17 frames and 10 KB. A chat of 80 long replies (486 KB) is sent in 1.4 ms of work, and each frame while one of them grows costs 0.18 ms and 7 KB (`a_long_chat_patches_quickly`).
- **Minimized is fine.** The link is served from `logic`, which eframe runs while the window is down: a test window minimized through `ShowWindow` stayed minimized through a phone connecting, a new chat, a message and its reply.
- Measured end to end against this window, with a Python phone written from the description above rather than from this code (a third implementation, after Rust and Swift): a message from the phone ran on GLM 5.3 Flash, its `powershell echo hello-from-phone` waited for approval on the phone (3.0 s after sending), ran once allowed, and the answer came back 2.4 s later. A phone holding another key got nothing. The crypto's bytes are pinned by a test on each side (`sealing_matches_the_phone`, `WireTests`) and agree with Python's `cryptography`.

## Not here yet

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
| Unsent messages, pasted pictures | `drafts.json` and `pasted/` beside the chats |
| The phone link's key, and photos sent from the phone | `remote.json` and `phone/` beside the chats |

Set `APIM_DATA_DIR` to keep the data somewhere else.

## Staying in step with the web app

Tool descriptions, prompts, plugins and the model list come from the web app's source, so both versions tell the models the same thing. Kept apart, because the web has no such thing: the theme wall (`assets/themes.json`), the skill catalog (`assets/skills.json`), and which tools are sent when (the web sends them all). The commands' wording in `assets/tools.json` is this build's own too (who is asked, PowerShell, the 10-minute limits): the sync writes the web's back over it, and `the_desktop_wording_of_commands_survives_a_sync` then fails until it is put back. After changing the others in the web app, run this from the repo root:

```bash
npx tsx desktop/sync-from-web.mts
```

## Tests

```bash
cargo test
```

## When it feels slow

Set `APIM_PERF=4` before starting the program. It then prints, on stderr, every frame that took it longer than 4 ms to draw, every wait of over 40 ms between two frames while a reply is being written, and, when a reply ends, the longest any of its text waited to be shown. When the program leaves it prints one line more: how many frames it drew, how long the app took over one (median, 95th, 99th, longest), and the same for the time from one frame to the next, which is what the eye gets.

With a self-portrait this is a bench (`APIM_SHOT_STATE`): `scroll` turns the wheel on every frame, `stalled` makes the chat's last reply a running one, `open-step` unfolds each reply's last step with a long detail and brings it into view (its scroll bars drawn without a pointer over them), `wait-row` adds a reply that is being waited on, and `calm` leaves the frames to whatever asks for them, as when nobody touches the window. `APIM_VSYNC=off` draws as fast as it can, which shows what a frame really costs; `APIM_VSYNC=driver` goes back to OpenGL's own wait for the screen.

What that bench found on a PC with a 143 Hz screen, on a copy of a chat whose last reply had 500 steps:

- **A reply being written kept one processor core at 97%.** Laying a frame out took the app 0.4 ms and drawing it 0.8 ms more. The rest was the graphics driver, which spins while it waits for the screen, and the dots under a reply asked for a new frame every frame: 143 a second for as long as the reply ran, hours for a long one. Frames are now held to the screen's pace by asking Windows' compositor (`DwmFlush`), which sleeps: scrolling keeps its 143 frames a second (frame to frame 6.9 ms median, 7.1 ms at the 99th, the same as before) on a quarter of a core. When the compositor does not answer within a frame or so (a screen that is off), it is left alone for two seconds and a short sleep paces the frames. And the slow animations (the dots, the pulse of a running step, the light over a status) ask for thirty frames a second, eight while another window has the keyboard: a reply being waited on now costs about a twelfth of a core.
- **Sending froze the window.** The restore point taken before each question was made on the window's thread: 0.2 to 0.3 s with 1,700 files in the chat's folder, and a new 100 MB file is read, hashed and copied. It is made by the reply's own task now, before its first request; the question gets its restore point a moment later.
- **Deleting a chat froze it too**: 1.4 s for one whose folder held 660 MB. The chat leaves the list at once and its folders are cleared on another thread.

### A click that looked slow, and a start that showed nothing

Opening a chat took a millisecond to read and looked laggy all the same. Filmed frame by frame (2026-10-13), a click on a chat in the list did this: the old chat stood for 50 ms, the new one was drawn some 230 points short of its end, and a frame later it jumped to the end. Four causes, none of them the reading:

- **Every thread this program started held the window still.** The frame after any `std::thread::spawn` came 40 to 60 ms late on the PC this was measured on, whichever thread started it and however short its work (a thread that ended cost nothing). A chat was read on a thread of its own, the workspace was listed on another after every step of a reply and on every chat opened, a search of the chats took one a keystroke. They run on a few threads kept for the purpose now (`background` in `main.rs`, started before the window, one more whenever all are busy), tokio keeps the threads it starts for blocking work, and the thread that writes chats is started before the window too. The same click then showed the chat in the next frame, 7 ms later.
- **A chat being landed on was laid out a thousand million points down**, to be "clamped to its end". A float steps 64 points at a time that far out, so every message measured there came out some multiple of 64 tall (256 for one that is 541), and the chat landed short by the sum of it. The jump is made only once the end is measured, and only as far past the end as needed.
- **Only the last three messages were measured before landing.** A fourth in view was a guess and changed height as it was drawn. Every message that will be in view is measured first, and only those: with the older ones measured in the same go, a chat of long replies showed an empty window for two seconds.
- **Each pass of a frame waited for the screen.** A landing takes three passes, so it reached the screen two refreshes late.

A chat opens as the mouse button goes down on it, not when it comes up, comes in over a fifth of a second (it fades up from ten points below its place), and the highlight in the list is one box that travels from the chat that was open to the one that is. The same motion is on what else appears or moves: messages just sent, the rows of a list just put there, the raised half of Chats/Archive, the files rail (it slides as the chat list does), the toast, the button that jumps to the end, and every button gives a point under the pointer while it is held.

The start read every chat file whole before the window drew anything, to list them: 264 MB on one PC. The window is up first now, behind a loading screen with a bar of the bytes read and the time left, and the list is kept in `chat-index.json` beside the chats with the size and time of each file, so a start reads only the files that changed. A chat that takes more than a quarter of a second to open shows the same bar on its "Opening…" pill, which stays until the chat has landed and not only until its file is read. The time left is the bytes still to read over the pace of the files read so far (remembered between starts); the file in hand counts as far as that pace says it has come and is never called done before it is.

How it was seen: `APIM_SHOT_FILM=600` keeps every frame of that many milliseconds instead of one picture, named by the millisecond it was drawn at (`f-0040.jpg`), and `APIM_SHOT_STATE=click-140-415` clicks that point 400 ms in, as a hand does, 70 ms between down and up. `boot` films a real start, `splash` and `opening` stage the two bars part way, `fresh` a message just sent. With `APIM_PERF` a film says what each frame cost and how long after the one before it came.

### Odd input, every tool

`apim.exe --tools calls.json` with 89 calls nobody would make on purpose (a folder read as a file, a picture that is only named .png, a file in an older encoding, emoji at every place text is cut, 2 MB on stdin, a search for a word 60 times in one line) crashed nothing, and showed six answers that were wrong or no help:

- A search stopped at its 60 matches inside one file said "60 matches in 0 files".
- Reading a folder, or no path at all, said "Access is denied. (os error 5)". It says it is a folder, or that the path is missing.
- A file that is not there was named without its folder, and nothing more. It is named as asked for, with where files of that name are: a reply asked three times for one two folders away.
- A file in an older encoding (Latin-1, Windows-1251) was shown under "EXACT" with its other letters as "�", and an edit wrote those back: the file was destroyed. It is shown with a line saying so; `edit_file` and `replace_in_files` leave it alone and say why.
- A file that only ends in .png went to the model as a picture; a provider turns the whole request away for one it cannot open. A picture is now known by its first bytes.
- `edit_file` told of text that matches in several places did not say how to change them all (`replace_in_files`).

Fourteen ordinary tasks run the same night (tests, a bug fix, a CSV summary, a web page, C in the sandbox, a local server, a plan, names in Cyrillic) all ended right.

A second build folder keeps all of this off the program that is open: `CARGO_TARGET_DIR=target-bench cargo build --release` (add `CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` to build in one minute instead of three), run with `APIM_DATA_DIR` pointing at a spare folder that holds a copy of the chat.

Long chats stay quick because only what is on screen is laid out. A chat is read from disk and saved on other threads, so neither holds up the window.

A reply's text is shown at the pace it arrives, behind a small buffer (`src/ui/pacer.rs`, the web app's `pacer.ts`). Providers send text in bursts; shown as it lands, it types, stops and types again.

The buffer is only worth its delay while text comes quickly, so here it parts from the web: waiting text is never shown slower than eight words a second, and a reply that comes whole is typed out in under half a second. A busy provider sending a word a second then shows each word as it comes, where it used to crawl a second and a half behind and jump at the end. When nothing has come for two seconds in the middle of a reply, the row under it says it is waiting for the model.

Three things are written to the problem report so that slowness nobody was measuring can be found afterwards, and told apart: a frame that took over a quarter of a second, and text that waited over two seconds to be shown (both the app's doing), and a reply whose text came at under 15 characters a second (the provider's).

### A thought that shut as a step appeared

Filmed with `APIM_SHOT_STATE=send` and `APIM_SHOT_FILM=45000` (the film now runs alongside the reply, from the moment the message goes), the first step of a reply did everything in one frame, 7.88 s into a 30-second film: the open thought (some 300 points of text) vanished, the step row appeared, the route notice moved from under the thought to over it, and the chat's totals strip came in at the top and pushed the whole chat down by about 60 points. A second review of a 45-second film found the same jolt on every step after that, and one more: as a thought shut the chat followed its end down by up to 170 points, then jumped back up 37 when the next row came.

- **One layout from the first thought.** A reply that thinks is drawn as a timeline from its first thought on. It started as a box on top and turned into a timeline when a step came, which is what moved everything at once. A reply without steps now shows its thought as the same one-line row.
- **A thought takes the place of "Thinking…"**: its label is there in the frame the line goes, at the same height, and its box fades in around it. Unfolding from nothing, it left a beat with neither.
- **A thought folds** over a quarter of a second (`widgets::unfold`: the body is cut off at a share of its height and takes only that much room, its words fading faster than the room so none stand half seen; a row coming in fades at the pace of its room instead, or it stayed unseen for its first frames), and its box fades from the thinking colour. It shuts when the model starts writing a tool call or its own words, and the step, notice or words wait for the fold (`FOLD_WAIT`, 200 ms, so they come in under its last stretch rather than after a beat of nothing). The typing pacer gives out one kind of text a frame (the end of a thought and the first words after it came in together, under the open box), and while the words are held neither its quarter-second for typing out what a row waits behind runs, nor its clock: a reply's last line came in whole, and the first line after a fold in one frame.
- **One curve** for every fold and entrance, the web's standard `cubic-bezier(0.4, 0, 0.2, 1)` (`widgets::ease`). Filmed, a cubic in-out read as a fade that then snapped shut (its first fifth hardly moves), a sine in-out the same more mildly, and a cubic out as a pop that then drifted.
- **New rows unfold into their room**: a step (finished or not, a quick one arrives done), a notice (the route line pushed "Thinking…" down two lines in a frame), the buttons under a reply that ends, a step's detail when clicked. The counts in the row over a reply fade in where they land.
- **The totals strip has its room from the moment a reply runs** and its words fade in with the first count; unfolding then, it pushed a new chat down by 60 points mid-reply.
- **Gaps stay put.** Every gap in the chat was 4 points while a reply waited for its first words and 24 after, so the chat drew together on each send and the reply dropped 20 points at its first word.
- **Status lines** on an empty row go up once their words have stood 300 ms, counted from when they could first be said ("Writing a.txt…" came up under a folding thought for a tenth of a second before its step took its place); in place of a line that is up, new words go up at once. They fade in when their words change, not when a request goes out or its first byte comes ("Thinking…" dimmed and came back twice in its first second). A request counts as answered once something of the answer shows, so "Waiting for the model…" does not leave before anything takes its place.
- **The sweep over a waiting line lights the words, not the letters** (`chat::shimmer`). Its band stepped by letter index over a proportional font, so it crawled across a wide "W" and jumped across a narrow "i", and a letter could be a third of the way from dim to lit above the one beside it: "Waiting for output" read as "W aiting", one bright letter stuck to a dim word. The band is in points now, laid out from the words themselves and 0.6 of their width (40 to 140 points), so no letter is more than a quarter of the range from its neighbour and a wide letter is no slower to cross than a narrow one; and it is drawn 30 times a second while the window has focus, not the 20 the rest of the glances take, since a sweep at that rate steps — half the cost of drawing at the window's own rate over the minutes a long reply runs. A letter per section is kerned against nothing, which stands a pair like "To" a point wide — small enough to leave, and `ponytail:` marked where it would be fixed. Two tests hold it: the lit words stand where the plain words stand, and over a whole 1.5 s sweep no two letters beside each other jump by more than a quarter of the dim-to-lit range while the band still travels across the line.
- **Room a fold gives up stays as blank space** under the live reply (`App::floor`) instead of the chat sliding down into it; new rows fill it, and what is left glides away when the reply ends. Only the reply's own room is kept: kept for the whole transcript, a long chat's older messages, measured smaller than their guessed heights while the reply ran, left a screen of blank under it, and a message just sent vanished above the view (filmed on a copy of a 96-message chat: blank from 0.96 s on; now the message and its reply's first line stay in view). Each send starts with none. The room is kept for 600 ms (`FLOOR_HOLD`), long enough for the step after a fold to come in, and then glides away: kept until the reply grew into it, the wait on the model after each step showed the reply's last line a folded thought's height above the box (filmed against a fake model that waits 2.5 s a round: 118 points of blank under "Waiting for the model…" for the whole wait; now 37, the status line just above the box, from 0.6 s after the fold, gliding there in about a third of a second). A thought gives its room back as it shuts, whether shut by hand or by the reply as its step or its words come: for the length of a fold after a click in the transcript, or after the reply shuts a thought (`Run::folded`), nothing is held. The reply's own fold, held, left 207 points of blank under its end for 0.7 s at every step (filmed against the fake model); now the chat slides down with the thought as it shuts, the gap above the box stays within 35 to 45 points, and the step and its result then come in under it. One opened and shut again by hand under a live reply's end, held, left 206 points of blank there for 0.6 s and settled a second after the click (filmed with an inbox `click` on the thought, open then shut, in a 6 s wait on the model); now the chat is back where it was when the fold ends, 0.3 s after the click, and the status line never leaves the box.
- **A scrolled thought fades out under its label** rather than cutting a line in half there.
- **The end is glided onto.** egui's own sticking stepped the chat up by each line a reply wrapped onto (15 to 40 points in a frame), showing the line cut off under the edge first. The chat now follows its end itself, as a spring that closes the distance in about a fifth of a second (`widgets::Follow`), and stops following when a wheel or the scroll bar takes it up. Closing a share of the distance each frame instead kicked the pace up in a frame with every line. A live thought's own text follows its end the same way inside its box, where it hopped a line at a time.
- **What grows while open takes its room gradually**: a thought's box grew by a line (20 or 40 points) in a frame as it streamed, and a step's row by its result line. `unfold` gives growth its room over about a tenth of a second, cut at the edge meanwhile.
- A thought's clock goes on from the line before it ("Thinking… · 4s" turned into "Thinking · 0s").
- A failed step's line, cut at 160 characters, ends in "…" (it read "…pass the whole scr").

Measured after, on four more films of the same task, each checked frame by frame and two by a second pair of eyes: a fold runs its quarter-second with height and words falling together (81% height at 65% opacity, 61% at 43%, 37% at 36%); a thought's box grows about 8 points a frame; the chat glides 1 to 5 points a frame onto its end; no status line comes up for less than a quarter of a second; the last words of a reply type out over 0.3 s; the window drew a frame every 6.9 ms (95th percentile 7.0 ms) while filming. What these left are closed in the next part.

### What that left, and what filming it again turned up

- **A step shows while its call is being written.** The step came only once the model had finished writing its call, a tenth of a second or more after the thought had folded, with a status line ("Writing demo/a.txt…") that hardly stood between. Now the call shows as the step it will be from the moment the thought has folded and the text before it is on screen (`Run::drafted`): "Writing demo/a.txt" with the path once it is whole (as it streamed, it grew a letter at a time), and the size once it passes a thousand characters. The step that starts has the same id, so it goes on in the same row: filmed, two rows came in while their calls streamed and turned to "Created" in place. The line under the reply says "Working on your files…" from then; it said "Thinking…" under a step being written.
- **The ctx count comes in again when it changes unit**: "~40k chars" jumped to "~9k ctx" a hundred points on as the counts before it came in.
- **The "Files" chip changes its words over a fifth of a second.** "Files" turned into "3" in a frame, the chip 22 points narrower and the cost label beside it jumping. Its width now glides, the old words fade out before the new ones come in (faded across each other they read "3iles"), the dot behind comes in with the new words, and the dot's room is taken at once (grown with its fade, the chip shrank and grew again by 5 points). The cost label fades in.
- **A receipt the reply already said is not said again.** The finish step's result and how it was checked become the reply's closing text. Filmed, a model wrote its summary and then handed finish the same summary in other words, and both showed. Each part is now left out when three in four of its words that carry meaning are in what the reply wrote since its last real work (`agent::said_already`; on that reply the repeat scored 0.79 and the "Verified" line, which was new, 0.69). A plan written before the work does not count.
- **Words after a new row wait for its room.** The closing words started under the "Finished" step in the frame it began unfolding, and their first line rode down 25 points with it; they now wait as they do after a fold, counted from when the row first showed. `APIM_PERF` also times the work done before each frame is drawn (taking in replies, saving one that ended): it never passed 4 ms, so the odd 55 to 70 ms wait between frames in the films is not the app's.
- **A reply of steps no longer drops at its end.** A reply asked to think whose model sent no thinking showed an empty "Thinking" box from its first words, and a reply whose only words were its closing receipt got the box as it ended, pushing every step down 30 points in a frame. The box now comes in with the first step, unfolding as a step does.
- **Two flaky tests.** `winproc` asked a process still loading for its modules twenty times in well under a millisecond; it now waits 10 ms between tries. The local engine's test started its stand-in server on a three-second clock, which on a busy machine came before the launch, so the launch found the port taken; it now starts when the program is launched. Its folder also lost to `APIM_DATA_DIR`, which goes before the `APIM_DATA_ROOT` it set, so a test run with a spare data folder read the model file of the run before; the tests that point the data folder at their own now share one lock (`store::TEST_DATA_DIR`) and set the variable that wins. Two test runs at once no longer share the GitHub tests' folders.

Measured after, on eleven films of the same task, checked frame by frame and one by a second pair of eyes: each step comes in as its call starts streaming rather than when the call is whole (0.3 to 1.8 s later in these runs); the chip's left edge moves 22 points over 0.2 s in one direction; nothing over a reply moves when it ends; the chat glides 80 points onto the end of a finished reply in 0.45 s, rising to 290 points a second and settling; the window drew a frame every 6.9 ms (95th percentile 7.0 ms). The full suite passed five times, three of them while a second copy ran beside it.

The film itself had to change: half a minute of 2400x1720 frames held in memory ran out of it (16.5 MB a frame, 9.6 GB of PNGs). Frames are written by another thread as they come, at the window's size in points as JPEG, one every 14 ms at most, and dropped (and counted) rather than slowing the window when the writer falls behind. `APIM_SHOT_INBOX` also takes `type <text>`, `attach <path>`, `open <part of a title>`, `new` and `send`, which is how the drafts and the parallel chats above were filmed.

## The Browser pane

The agent's browser is on screen now, in a card beside the chat (`ui/browser_pane.rs`, `browser/live.rs`), as Claude's desktop app shows its own. Before, each `browse` call started a headless browser, did its steps and threw it away: nobody saw the page, and the next call started from nothing.

- **A page for each chat, kept open.** One headless browser holds a page (a CDP target of its own) for each chat's workspace; `browse` and that chat's pane share it. Only the page of the chat on screen, with its pane open, streams its frames as JPEG (`Page.startScreencast`), decoded off the UI thread. A page opened in one chat used to show up in every other one: a YouTube video asked for in one chat played on in the next. The pane opens itself when the agent starts browsing and says "apiM is browsing · <title>" while it does; the next call starts where the last one left off. A page follows its chat when a rename moves the workspace folder (`live::moved`; checked by renaming a chat with a video open: same page, still streaming), and closes when the chat is deleted. Closed and unused for ten minutes, the browser is shut, and a Windows job object ends it with apiM, so a crash leaves no browser behind.
- **The user can take over.** Back, forward, reload or stop, an address box (a URL, `example.com`, `localhost:8000`, or words to search DuckDuckGo), open in your own browser, and close. Clicks, the wheel, mouse moves, typing and the editing keys go to the page.
- **The page is laid out at the pane's size**, as a browser window that size would lay it out. At the fixed 1280×800 of the first version, a 660-point pane drew the page at 0.52×: body text about 8 points, and half the pane empty under it. The layout is capped at 1280 wide, past which the frame is scaled up, so the agent's screenshots stay that size at most. A resize never lands while the agent is mid-step, so the points it read off a screenshot stay where they were.
- **It follows a drag.** The page used to be laid out again only once the pane's edge had been still for 250 ms, so while it was dragged the page sat at its old width and jumped when the mouse let go. It is now sent the new size at most every 70 ms during the drag, and once more 700 ms after the last one. Dragged by hand on a test copy: with the button still held, the pane was wider and example.com had already re-wrapped to it.
- **The files rail makes way.** While the pane is open, the workspace rail closes, and it comes back when the pane closes: a preview, a page the agent opens, or a video. The rail's header button, shown meanwhile, closes the pane to bring the rail back.
- **It slides** in and out as the sidebar and the files rail do (0.3 s, its content held at full width and cut at the edge). It used to fade in at full width, which moved the chat 600 points sideways in one frame. Its bar is the chat header's 56 points, so the two rows of buttons line up.
- **What the page may open** (`browser::policy::check`): data:, blob: and about:; http and https on the public web and on this machine (`localhost`, to look at a site being built); a `file:` only from inside the chat's workspace, judged on the canonical path, so `..` or a junction cannot step out. The LAN and the cloud metadata address are refused before a request leaves, as before.
- **Live reload** (`live::written`): when a step writes a file the page on show is made of (the page itself, or a style, script, picture or data file in its folder or under it) and the agent is not driving, the page loads again. Filmed with Haiku 5.5 changing a word on a page open in the pane: the old word at 5.1 s, the new one at 6.6 s with the page's own progress bar back at its start, and nobody touching Reload.
- **Preview** on an .html file (the file panel's chip, or the right-click menu) opens it in the pane.
- **Sound and playback follow the user** (`live::sync`, `live::MEDIA_JS`). Each frame the window says which chat is on screen, whether its pane is open, whether the window is minimised, and which chats have an agent at work. The page in front of the user plays with sound. A page in another chat whose agent is working (watching a video to learn from it) plays on, muted. Any other page in another chat is paused and muted. A script installed in every document before the page's own catches a video as it starts, and the app plays again or unmutes only what it paused or muted. Checked on a test copy with a page that logs its own events. Switching to a new chat logged `pause (muted=true)`, and coming back logged `volumechange (muted=false)` and `play`. With the agent running a 25-second command in that chat, leaving logged only `volumechange (muted=true)` (no pause), and coming back unmuted it. A player that is in no document (`new Audio().play()`) is caught by its `play`, and a WebAudio context is suspended while its page is muted. A minimised window's page is not streamed.
- **A frame, every time.** One run in three or so, a page opened and loaded but the pane stayed on "Opening…" for good. The stream had been started on the blank page before the first address loaded; the page then moved to another renderer, and a page that does not change paints nothing more. Two places also started the stream at once. Now a page starts its stream once however often it is asked, and a page that has loaded with no frame 700 ms later has its stream started over. Twelve runs in a row then each showed the page; the restart was needed in four of them. The self-portrait that sometimes came back empty right after a build was probably this.
- **The agent's pointer.** A `click` or `type` step shows where it acts: an arrow glides to the element (0.3 s), a ring spreads where it clicks, and a pill says what it does ("Clicking “Learn more”", "Typing “cats”"). The step waits 320 ms for it, only while someone is watching that page, and the pointer fades 2.5 s after the agent's last step. Filmed with Haiku 5.5 clicking example.com's link: the pointer on "Learn more" at 2.7 s, the IANA page at 3.0 s. That run also found that every `click` and `type` failed with a SyntaxError: an edit had put a real line break inside a quoted string of the script that finds the element. Every injected script in `browser/` now parses under node. A password field's text is never in the pill ("Typing a password"), as the page itself shows only dots.
- **Stretch**, the button beside the address (its tooltip says "Stretch"): the page leaves the pane and covers the window below the title bar, black around it, and the player fills the page. YouTube's own player is kept, so its controls stay; elsewhere it is the largest video showing. The rest of the page is hidden by a style rather than by asking for fullscreen. YouTube's player, asked from a script or by its `f` key while an advert loaded, stayed in the page. The page is laid out at the window's size there, up to 1920 wide, for a sharper picture. A back button shows at the top right for 2.2 s after the mouse moves, and Esc leaves too. The stretch belongs to its chat: leaving the chat puts that page back in its pane. Checked on a YouTube video and a local clip: both fill the window.
- **Sign-ins are kept.** The browser has a profile of its own in the app's data folder (`browser/`), used from one run to the next, so a site the user signs into in the pane stays signed in. If that profile is busy (another apiM has it), a throwaway one is used instead. The browser is asked to close and given two seconds to be gone before it is killed, since it writes its cookies on the way out. A page counting its visits in `localStorage` read 1, 2 and 3 over three runs of the app. The agent drives the same profile, so it can use a session the user signed into there. The prompt tells it to ask the user to sign in in the pane, and never to type a password itself.
- **Not Google, though.** Google's sign-in turns this browser away ("This browser or app may not be secure"): it refuses browsers that are headless or driven by a program, and the pane is both. It is not dressed up as an ordinary Chrome to get past that, since the disguise would also hide from every other site that a program drives it. Instead, on `accounts.google.com` the pane shows a card at the bottom that says why, with "Open in your browser" opening the same page in the system browser. The card is at most 620 points wide, so it stays one block under a stretched page; shot in the pane, a narrow window and stretched, in a dark and a light theme.
- **Straight to the address.** The prompt tells the model to open a search as a URL (`youtube.com/results?search_query=…`) rather than type into the site's search box. Typing and clicking through a site is the slow way, and it is what the pointer then shows.

### "Opening" for good

A `browse` once stayed on "Opening" until the app was closed. A motion page, to be screenshot a few seconds in, left a CDP command waiting for an answer that never came, and nothing had a clock. Every CDP command now gives up after 45 s (`cdp::CALL_TIMEOUT`), and every step of a session has its own bound on top. A step that runs out marks the page wedged, the next call starts a new one, and the result says which step hung. The step row says "Browsing", not "Opening". The last screenshot of a session goes back to a model that can see as a picture with the result; it used to be told to open it with another call.

## The effort slider

The effort menu is a slider (`composer::effort_panel`) with the depths the chat's model really has (`models::effort_levels`). A stop that changed nothing on the wire would only mislead.

| Model | Stops |
| --- | --- |
| Claude 4.6 and later | Low, Medium, High, X-High, Max. No None: they cannot stop thinking, and Low is their shortest |
| DeepSeek V4 Pro | None, High, Max (its Low is its High) |
| DeepSeek, local models | None, Low, High, Max |
| GLM 5.3 Flash's pinned endpoint | Low, Medium, High, Max (it refuses reasoning off) |
| Other OpenRouter models | None, Low, Medium, High, Max |
| Claude before 4.6 | no slider |

Auto is a switch above it, and turning Auto off keeps the stop it was on. A setting a model does not have is sent as its nearest one, the deeper on a tie, and a thinking depth is never sent as None (`models::fit_effort`). The chip says what is really sent. All five Claude depths were sent to Haiku 5.5 and accepted.

It is squared off as Claude's own effort menu draws it, in the theme's own colours (`composer::slider`). The title names the depth ("Effort High"), and "Faster" and "Smarter" stand over the two ends. The track is 14 points thick with 5-point corners, with a dot at each stop. It is lit in the accent up to the knob. The knob is a 14 by 20 rounded block in the theme's lightest colour, a little taller than the track, over a shadow (two widening rounded rects, as egui cannot blur). The popover is 320 points wide. A first version had a round accent knob with sparks and a name under each stop; the user asked for Claude's squarer look. The next, with a 26-point track and a 22 by 34 knob, was too big beside Claude's and Codex's, so it was halved. Under Auto the accent turns grey rather than see-through, since a faded knob showed the track through it. It was shot dark, dark under Auto, and on the light Paper theme, and a drag from Medium to X-High was filmed: the knob follows the pointer and glides to the nearest stop on release.

## Claude's thinking, as it comes

Claude's summarized thinking does not stream. It comes in bursts with silences between: on one Haiku 5.5 reply, 108 characters at 2.3 s, 142 at 2.7 s, 172 at 5.1 s. The typing pace read each silence as the end and shot the burst out, so the box stood still and then filled at once. The pacer (`ui/pacer.rs`) now notices the pattern (a pause of half a second or more). For a thought, it spreads what it holds over the time until the next burst is expected, never slower than 5% a frame, and the end of a thought drains in 0.6 s. A Claude reply expects bursts from its first token. In the test that replays the pattern, the longest still stretch fell from over 1 s to 0.7 s. Each thought also ended with "\n\n", which left a blank line at the foot of the box; it is trimmed.

Filmed after, on Haiku 5.5 at High: the one still stretch left was the second the API itself sent nothing ("Total time" held for 1 s). The box filled to its last line and folded to "Thought · 83 tok" as the answer came.

## Files: pictures, right-click, Save as

- A picture opens as itself on a checkerboard, at most 1:1, with its size. It used to open as a page of replacement characters. Any other file with a NUL byte in its first 8 KB is binary and says so (`workspace_panel::look_of`).
- **Save** writes the file (Ctrl+S too) when it has changes, and is **Save as…** otherwise, through the system's dialog. On a file with no changes it used to do nothing, which read as broken.
- A right-click on any file or folder in either list: Open, Preview in browser (.html), Open with its app, Show in Explorer (with the file selected), Copy path, Copy relative path, Delete. "Open with its app" is not offered for kinds Windows runs (.exe, .bat, .ps1 and the like), so a file the agent wrote cannot be started by a click that reads as opening it.

## The problem log

Some faults leave nothing to see. The browse stuck on "Opening" was not a failed tool, no reply ended, and the chat was never saved. Every tool call is now watched (`diagnostics::Watch`):

- one still running at 90 s is written down while it runs (`tool_hung`);
- one that ends after that is written down as slow (`tool_slow`);
- one dropped unfinished after 8 s or more is written down with how long it had run (`tool_abandoned`).

Each comes with a one-line account of what the call was doing: the command, the address, the browse's steps, never a file's body, with keys scrubbed. Whatever points at the app, this PC or the provider is also written to `problems.md` beside `diagnostics.jsonl`, newest first. Whoever fixes the app next reads what went wrong there, not in a chat.

## Cheaper, steadier rounds

Six tasks of different kinds (a bug fix with tests, a web page, a data question, research, a refactor, a shell job) were run on Claude Haiku 5.5, GLM 5.3 Flash, DeepSeek and a free Nemotron, and read request by request. Cache reads ran at about 72% of input on Haiku, 9–13% on GLM, 20–25% on DeepSeek and 27–31% on Nemotron, and every task passed. What the models lost rounds and tokens to, and the fixes:

- **Claude's cache broke whenever the tool list changed.** A list one tool shorter read 0 of 16,876 tokens from the cache and wrote them all again at the hour's double price. The mark that held the rules now sits at the end of the everyday tools (`load_tools`), before any group loaded later, so the tools are read from the cache whatever was loaded since (`anthropic::request`).
- **Pruning counted the rules as history.** It started stubbing written files at a reply's third round, and each stub rewrote Claude's cache from there (3,043 tokens each time). The rules are not counted now.
- **A draft carried over after a cut-off rode in every later request**: 18.5K characters a round on GLM, after its files were written. It shrinks once they are.
- **"tests" in a request loaded all of code navigation**: 6.9K characters of tools a round for a plain pytest task. Running tests is now a group of its own.
- **A failing test said only its name**, and the agent ran the suite again by hand to see why. The result now carries pytest's FAILURES section with short tracebacks (or another runner's last lines), at most 60 lines.
- **Smaller slips:** a URL in quotes or angle brackets is read without them (a quoted URL cost GLM a round); a `find` in a fetched page shows 600 characters around each match; `py`, `rm`, `cp`, `mv`, `pwd` and `sleep` run (the last five through PowerShell); `explorer` opens a folder or selects a file.

Not measured again after the fixes: the numbers above are from before them.

## Security: the app's own gaps

The app was attacked as a target, not the models: what a web page, a repository, a downloaded skill or a crafted reply could make it do. Fixed:

- **Protected paths, by any spelling.** `.git` and the other protected places are judged where a path really lands (`snapshots::protected_at`). A junction, a symlink, an 8.3 short name (`GIT~1`), a trailing dot or space, or a `:stream` suffix reached them under another name. A file with more than one name (a hard link) is not written: writing it would change a file outside the workspace.
- **Requests that end up somewhere private.** A public-looking name that resolves to this machine or the LAN is refused. The request is pinned to the addresses that were checked, so a second lookup cannot answer differently. Each redirect hop is checked as the first URL was, and a download has one clock from request to last byte. A request to this machine asks first in Manual and Critical modes.
- **Commands that look but write.** A git "look" runs without asking only with the flags on a list: `blame --contents`, `diff --output`, `--no-index` and the like ask first, as do paths outside the repository. A system tool asked only to look may take only its looking switches (`/S` names another host, `-f` writes a file). git runs with a clean environment, so a repository's own config cannot name a program for it to run.
- **A skill's files** must be plain relative names inside the skill's folder: no `..`, no drive, no stream.
- **The approval card shows hidden characters.** Control, bidirectional and zero-width marks are shown as `<U+XXXX>` and counted. The command is wrapped, never scrolled, so its tail is always in sight.
- **Links in a reply** open only for web and mail. `file:`, `javascript:` and app schemes are shown, not followed; the export does the same.
- **Bounds.** An MCP server's answer is read only up to a size limit, so a server that keeps sending cannot fill memory before the timeout. The type checker runs from a fixed folder of its own. The sandbox never mounts a whole drive. The diagnostics log scrubs keys from text facts too.

## Watching a video

After Gemini's agentic video mode, the model navigates a video instead of being fed every frame (`tools/video.rs`, the `video` group):

- `video_overview`: one contact sheet and a text map of the whole video;
- `video_look`: a stretch;
- `video_frame`: one frame up close;
- `video_scenes`: the cuts;
- `video_transcript`: the speech (faster-whisper when installed).

A URL is fetched with yt-dlp; ffmpeg and ffprobe come from PATH, and nothing is bundled. The two tools that are only pictures are offered to models that can see; the overview, the scenes and the transcript serve any model. Timestamps are drawn with a 5×7 bitmap font of the app's own: ffmpeg's drawtext needs a font file and two levels of escaping.

Checked in terminal mode on a 6-second clip (3 s of a test pattern, then 3 s of red). Haiku 5.5 loaded the group, took the overview, asked for the cuts and looked at 2.5–3.5 s. It answered that the picture cuts to red at 3.0 s, and said which stretches it had not looked at, in four rounds for $0.0047. The transcript path (faster-whisper) is not checked yet.

## Smaller things

- The panels that slide over from the right started at the window's top and covered the title bar. They now start below it.
- The **Computer** chip is now **Use**.
- In a chat narrowed by the Browser pane:
  - the reply's small print was faded in scopes that could not wrap, so a piece of it ran past the column and widened the whole reply (the prose wrapped 9 points outside the chat card);
  - replies under 480 points are no longer cut to three quarters of the column (they wrapped at about 25 characters);
  - the cost in the header is left out where it would run under the sidebar button.

## Checking the look without touching the window

`APIM_SHOT=out.png` makes the program draw one state off screen, save a picture of it and quit. `APIM_SHOT_STATE` names the state as a comma-separated list (`settings`, `tab4`, `wait-row`, `stalled`, `plugins`, `plugin-search` with `APIM_SHOT_QUERY`, `plugin-add`, `ask-skill`, `ask-look`, `btw`, `wait-output` and `wait-output-note` (a step watching a program, with a note passed to it), `theme-midnight`, `no-sidebar`, `up-330` to turn the wheel back that many points, `select-300-200-600-260` to drag between two points and press Ctrl+C (what it copies is printed, and kept from the real clipboard; `wheel-N` turns the wheel N points down mid-drag, `hold-MS` keeps the mouse down at the second point that long, `away-N` turns the wheel after letting go, `late-MS` starts it later), `maximized,f11` for full screen, and more in `ui/mod.rs`), `APIM_SHOT_CHAT` picks the chat by a part of its title, and `APIM_SHOT_SIZE=1400x900` sets the window.

`APIM_SHOT_INBOX=<file>` makes whoever started a `send` self-portrait its user while the reply runs. One command a file, taken when it can be acted on and then deleted: `answer <text>` or `skip` for the question on screen, `allow` or `deny` for an approval (what is asked stands in the file of the same name ending `.ask`), `note <text>` for a "btw", `stop` for the Stop button, and `type <text>`, `attach <path>`, `open <part of a title>`, `new` and `send` to move between chats as a hand would, and `click <x> <y>` for the mouse (points in the window). `bench/live/live.py` drives the live benchmark with it.

`APIM_SHOT_STATE=send` with `APIM_SHOT_DRAFT="..."` really sends that message and takes the picture when the reply (or the compaction, for `/compact`) has ended. From Git Bash a draft that starts with `/` is rewritten into a path (`/compact` arrives as `C:/Program Files/Git/compact` and is sent as a message): set `MSYS2_ENV_CONV_EXCL=APIM_SHOT_DRAFT` first. Point `APIM_DATA_DIR` at a spare folder first, so the chat it makes is not one of yours.
