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
- A terminal mode: `apim --ask "your question"` (add `--auto` to let it run commands, `--dir FOLDER` to pick the folder, `--note "text"` to hand the reply a "btw" after its first step, `--think` to print its thinking, every line of it marked `~`)

The browser tool drives a Chromium-family browser already on the PC (Edge, Chrome, Chromium, Brave or Thorium, or the one `APIM_BROWSER_PATH` names) with a throwaway profile. Nothing is bundled or downloaded.

## The computer, not only the chat's folder

The assistant runs on your own computer, and it is told so. It works at three depths: its workspace (the chat's folder, where everything it creates or changes goes), the computer around it, which it can look at, and the Linux sandbox when one is set up. Asked about a crash, a slow start or a setting, it is to investigate (read the logs and crash dumps, ask the event log, check versions and what is running) and to turn to you only for what only you can do. Before this it answered such a question with a list of steps for you, because "it could not see your machine".

- **What it is told about the computer** (`src/machine.rs`), read once when the app starts and sent with every request: the system and its build, the home folder and where programs keep their data, which of the usual programs are installed, the workspace's path, today's date, and how approvals are set. No chat starts by finding these out.
- **Looking at files.** `list_files`, `read_file` and `read_files` take a path written in full (`C:\...`, `~/...`, `%LOCALAPPDATA%\...`). Outside the workspace a folder is listed one level at a time, newest files first. Writing, editing, moving and deleting stay inside the workspace.
- **Asking the system.** `run_command` runs the system's own looking tools (`tasklist`, `systeminfo`, `wevtutil qe`, `reg query`, `sc query` and others; their changing forms are refused) and, on Windows, PowerShell. PowerShell's text is read first: while every command in it only looks (Get, Select, Where, Sort, Format, Measure, Test and their short names) it runs as any other command; text that could change the computer asks you in every mode, "Run automatically" included. That reading is a word list, there to catch a change made in passing; it does not hold a program the assistant writes and runs, which was always free to do what you can do.
- **Approval.** With "Ask me first" you allow each folder outside the workspace before it is looked into ("Look in this folder?", once or for the chat) and each command. With "Run automatically" looking does not ask.
- **Closed places.** Folders and files that keep sign-ins and keys (SSH and cloud keys, browser profiles, the system's credential stores, `.env` files, this app's own settings) are not read by a file tool or named in a PowerShell command, in any mode: what a tool reads goes to the model's provider.

## Which endpoint an OpenRouter model runs on

OpenRouter serves one model from many endpoints, at different prices and speeds (33 for GLM 5.3 Flash, input from $0.04 to $0.225 a million tokens). The app used to keep each catalog model on one endpoint written into the code. It now reads OpenRouter's list for the model (`/models/<id>/endpoints`, with your key: the speeds are only in the signed-in answer) and picks (`provider::choose_endpoint`):

- **The cheapest endpoint that is fast enough**: 40 tokens a second or more over the last half hour. "Cheapest" is what a request of this app costs there, not the input price alone: of the tokens it sends, about seven in ten are read from the cache, three are new, and one token is written per hundred sent.
- **Or one a little dearer and much faster**: up to a quarter more money for at least one and a half times the speed.
- Never one that is down, that failed more than 2% of the last day, that cannot call tools, or that has a smaller context window than the others.

The next two cheapest fast-enough endpoints are kept as spares for when the first is down; nothing else is used, so every token stays on a known price. The pick is made once per model while the app runs: a pick that moved between replies would lose the provider's cache each time. It is said in a reply only when it is not the one picked last time (`endpoints.json` in the data folder remembers the pick and its prices). Cost figures and the spending limit use the picked endpoint's prices, in every session. Free models and other `:variant` ids are left to OpenRouter's own routing. The three numbers (`GOOD_TPS`, `FASTER`, `DEARER`) are at the top of the code that picks.

Two things the list does not say outright, both met on the first day:

- An endpoint may allow less output than the model's page says (128,000 tokens where the page says 131,072). Asked for more, OpenRouter drops the endpoint before trying it and answers "No endpoints found". A request asks for no more than every picked endpoint allows, and if the picked ones still cannot take a request, the pin is dropped for that reply and OpenRouter routes it.
- What an endpoint really costs depends on how well it caches, which is not listed. Measured on one 24-step task with GLM 5.3 Flash: Relace $0.028, Sail Research $0.042, StreamLake $0.044, each caching 70% to 85% of the input. The pick (Relace) was the cheapest of the three in fact as well as on paper.

`APIM_ENDPOINT=streamlake/fp8` keeps every OpenRouter model to the endpoint with that tag, when it serves the model: for comparing endpoints, or for keeping to one you trust.

## Adding a model from a link

Paste a model's openrouter.ai link (or its id, `author/model-name`) into the chat and say to add it: the model in the chat calls `add_model`, the app checks the id with OpenRouter, and the model is in the model menu, with its context window, prices and abilities as OpenRouter lists them. The conversation stays on the model it was on. Settings → Models does the same by hand. The tool is only sent when a message names it or holds such a link, so it costs nothing otherwise.

What an added model gets is what every model gets, because none of it is written per model: the endpoint pick above (not for `:free` and other `:variant` ids), its real prices in the cost figures, and everything under "What a request carries". What it does not get: handling written for one model's habits (the two catalog models have some: DeepSeek is handed its thinking back, GLM's thinking cannot be switched off), and a cache on providers that only cache what a request marks for it (Anthropic's models, for one): the app sends no such marks, so there every round is paid at the full input price.

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

Three more, found by running the same long task before and after:

- **A short answer asked again.** A reply that ended in under forty characters after its steps ("Done.", the one word that was asked for) was read as "the model wrote nothing", asked again twice, a whole request each time, and then marked as stopped mid-task. A short answer is now an answer; only a round with no words at all is picked up.
- **"Are you guessing?" after the work.** A run of eight steps with no plan and no question is reminded to ask before building on a guess. The reminder waited until the model had stopped, which is when the work is done: it cost one more request on every long reply, and the model answered it under its answer ("nothing is ambiguous"). It now rides a request the run makes anyway.
- **Half price on screen.** In DeepSeek's off-peak hours the cost shown was halved for every model, OpenRouter's too, where nothing is discounted. It is halved for DeepSeek's own API only.

A reply the app was closed under (or that died with it) came back with its steps and no word that it had stopped: no Resume. A reply still holding the transcript it was being written from is now read as unfinished, and Resume carries on from its last saved step.

A plan with every step done is cleared when the next message is sent: it stood over the new reply as if it were its plan, and was sent to the model with it.

## A long reply that stopped

Found in one real reply: 160 rounds of work in a sandbox, 48 minutes, $0.27, stopped with two of six plan steps done and no visible way on.

- **Resume was out of sight.** "This reply stopped before it finished", with its Resume button, was drawn above the reply's steps: over two hundred of them. At the bottom, where the reader is, there was one grey line. The panel is now under the reply. (The web still draws it above.)
- **The ceiling on rounds follows the money.** A reply gets 64 rounds, and 32 more up to three times while it is getting somewhere (a plan step done, or three files changed, since the last check): 160 at most. That ceiling is there for the money, and 160 rounds of a cheap model cost a quarter of a dollar. Past it a reply that is still getting somewhere now runs on: up to the spending limit when one is set in Settings, else while what it has spent since its last finished plan step is under $1 (`stall::should_run_on`). The dollar was counted over the whole reply at first, and that paused one at $1.03, three rounds after it had finished its second step, under the words "used every tool round". A pause by this rule now says what it is: "Paused: $1.03 spent with no plan step finished, and no spending limit is set". A model whose price is not known stays at 160. One plan step that takes 120 rounds still pauses the reply and says so: that is the check for work that goes in circles.
- **"Treat it as invented" on real work.** The closing text is held against the tools that ran. Running a command only counted for `run_command`, so a reply that did everything in the sandbox was told its results were invented. `sandbox_run` counts, and a shell counts as having read and written files.
- **A search that said "No matches" for text that was there.** `search_files` left out files over 512 KB without a word, and did not read the `path` a model naturally passes. The result now names the files it left out; `path` keeps the search to one file or folder, and a file named there is searched whatever its size. A match inside a very long line (minified or packed code) comes back with the text around it, one entry per match: it used to show the line's first 400 characters, wherever the match was.
- **Sandbox steps said nothing.** A row read "Ran in sandbox …0-kb-3-line && python3 - <<'EOF' · Sandbox command finished". It now shows the reason the command was given with, and the last line the command printed.
- **Thinking typed as the answer.** GLM does not take its thinking back the way DeepSeek does, so the end of each thought rode back to it as the opening words of its own earlier turns. Shown a hundred turns that open with a thought, it began to think in its replies: 5,000 characters of "Wait… Hmm… Actually…" as answer text, 373 in the thought box. OpenRouter passes a `reasoning` field on to GLM (seen on Relace: a replayed thought is counted in the next prompt), so the end of each thought now rides there and the words stay words. Same size, same cost. Other families keep the old way until the same is seen for them; an endpoint that rejects the field falls back by itself.

The workspace panel's title is gone: five buttons left it 26 pixels, and it read "W…".

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

Set `APIM_PERF=4` before starting the program. It then prints, on stderr, every frame that took it longer than 4 ms to draw, every wait of over 40 ms between two frames while a reply is being written, and, when a reply ends, the longest any of its text waited to be shown. When the program leaves it prints one line more: how many frames it drew, how long the app took over one (median, 95th, 99th, longest), and the same for the time from one frame to the next, which is what the eye gets.

With a self-portrait this is a bench (`APIM_SHOT_STATE`): `scroll` turns the wheel on every frame, `stalled` makes the chat's last reply a running one, `open-step` unfolds each reply's last step with a long detail and brings it into view (its scroll bars drawn without a pointer over them), `wait-row` adds a reply that is being waited on, and `calm` leaves the frames to whatever asks for them, as when nobody touches the window. `APIM_VSYNC=off` draws as fast as it can, which shows what a frame really costs; `APIM_VSYNC=driver` goes back to OpenGL's own wait for the screen.

What that bench found on a PC with a 143 Hz screen, on a copy of a chat whose last reply had 500 steps:

- **A reply being written kept one processor core at 97%.** Laying a frame out took the app 0.4 ms and drawing it 0.8 ms more. The rest was the graphics driver, which spins while it waits for the screen, and the dots under a reply asked for a new frame every frame: 143 a second for as long as the reply ran, hours for a long one. Frames are now held to the screen's pace by asking Windows' compositor (`DwmFlush`), which sleeps: scrolling keeps its 143 frames a second (frame to frame 6.9 ms median, 7.1 ms at the 99th, the same as before) on a quarter of a core. When the compositor does not answer within a frame or so (a screen that is off), it is left alone for two seconds and a short sleep paces the frames. And the slow animations (the dots, the pulse of a running step, the light over a status) ask for thirty frames a second, eight while another window has the keyboard: a reply being waited on now costs about a twelfth of a core.
- **Sending froze the window.** The restore point taken before each question was made on the window's thread: 0.2 to 0.3 s with 1,700 files in the chat's folder, and a new 100 MB file is read, hashed and copied. It is made by the reply's own task now, before its first request; the question gets its restore point a moment later.
- **Deleting a chat froze it too**: 1.4 s for one whose folder held 660 MB. The chat leaves the list at once and its folders are cleared on another thread.

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

## Checking the look without touching the window

`APIM_SHOT=out.png` makes the program draw one state off screen, save a picture of it and quit. `APIM_SHOT_STATE` names the state as a comma-separated list (`settings`, `tab4`, `wait-row`, `stalled`, `plugins`, `plugin-search` with `APIM_SHOT_QUERY`, `plugin-add`, `ask-skill`, `ask-look`, `btw`, `theme-midnight`, `no-sidebar`, `up-330` to turn the wheel back that many points, `select-300-200-600-260` to drag between two points and press Ctrl+C (what it copies is printed, and kept from the real clipboard), `maximized,f11` for full screen, and more in `ui/mod.rs`), `APIM_SHOT_CHAT` picks the chat by a part of its title, and `APIM_SHOT_SIZE=1400x900` sets the window.

`APIM_SHOT_STATE=send` with `APIM_SHOT_DRAFT="..."` really sends that message and takes the picture when the reply (or the compaction, for `/compact`) has ended. From Git Bash a draft that starts with `/` is rewritten into a path (`/compact` arrives as `C:/Program Files/Git/compact` and is sent as a message): set `MSYS2_ENV_CONV_EXCL=APIM_SHOT_DRAFT` first. Point `APIM_DATA_DIR` at a spare folder first, so the chat it makes is not one of yours.
