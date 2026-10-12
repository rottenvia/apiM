# apiM benchmark

34 real tasks the agent must complete through the real app, each graded by a
hidden check it never sees. Use it to tell whether a change made the agent
better or worse — not just whether anything broke.

## Run it

```bash
npm run test:bench                         # free: proves every check is honest
OPENROUTER_API_KEY=sk-or-… npm run bench   # all 34 tasks on DeepSeek V4.1 Flash
npm run bench -- --model glm-5.3-flash --concurrency 3
npm run bench -- --tasks py-lru-cache,js-url-router --effort high
```

Options: `--model`, `--effort`, `--concurrency` (default 2), `--budget`
(dollars per task, overrides each task's own cap), `--tasks a,b`,
`--label name`, `--url http://127.0.0.1:3000` (use a running app instead of
starting one; its chat list will show the benchmark chats).

The runner rebuilds the app when the source is newer than the last build,
starts it on a private port with a throwaway data folder, runs the tasks,
and writes `bench/results/<time>-<model>.md` (and `.json`) with pass rate,
partial credit, cost, time and tool use per task, compared with the previous
run on the same model. Put a spending limit on the key you use.

## The desktop app

```bash
cd desktop && cargo build --release && cd ..
OPENROUTER_API_KEY=sk-or-… npm run bench -- --desktop --model glm-5.3-flash --concurrency 3
```

`--desktop` runs each task through the Rust app's terminal mode (`apim --ask --auto`, one reply, no window) instead
of the web app: same tasks, same hidden checks. Each task gets its own workspace and its own data folder, so nothing
one task learns reaches the next, and your own chats and settings are never touched. The build in
`desktop/target-bench` is used when there is one, else `desktop/target`; `--exe path` names another (keep a copy of
an old build to compare against).

Besides pass and partial credit it records, per task: rounds, tool calls and how many failed, tokens in, out and
cached, cost at the picked endpoint's prices, the endpoint, whether a plan was made, and how the reply ended. All the
app printed is kept in `bench/results/<run>/<task>.txt`: read a failed task there round by round. The report is
rewritten after every task, so a run that is cut short keeps what it finished, and
`--resume bench/results/<run>` carries it on (finished tasks are only checked again). `--repeat 3` runs every task
three times: one run of a task says little, models differ from try to try. `BENCH_KEEP_DATA=1` keeps the workspaces.

Which endpoint serves the model changes what is measured: pin one with `APIM_ENDPOINT=<tag>` when comparing two builds.

## The live benchmark: the real window, a user who answers

`bench/live` is a second set, written for the desktop app and driven through its real window (kept off screen, in a
spare data folder). The tasks above are one message and one check. These are conversations: follow-ups, a request
taken back, an output asked about two messages later, a window that dies mid-reply and is told "resume", a note
passed while the reply works, a question the reply asks and the driver answers.

```bash
cd desktop && cargo build --release && cd ..
python bench/live/live.py selftest                       # free: every check fails on the start, passes on the solution
export OPENROUTER_API_KEY=sk-or-… LIVE_ROOT=C:/some/short/folder LIVE_EXE=desktop/target/release/apim.exe
python bench/live/live.py send talk-refine               # one message; the window stays hidden
python bench/live/live.py watch                          # running or ended, tools, a question on screen
python bench/live/live.py rounds talk-refine             # the reply, round by round
python bench/live/live.py tell straight-report answer "There is no other address."
python bench/live/live.py check talk-refine              # the hidden check for the turn just sent
python bench/live/live.py auto 1 small-diff hands-off    # a repeat pass, each scenario's user played from its file
python bench/live/live.py table
```

A first pass is driven by hand and every reply is read: that is where the app's faults show, not in the score. On
2026-10-13 GLM 5.3 Flash passed 20 of 21 checked turns by hand and 21 of 21 on the repeat pass, and reading the
rounds found nine faults of the app (see `desktop/README.md`, "Met in the live benchmark"). `LIVE_MODEL=custom:<slug>`
runs any OpenRouter model, free ones included.

| scenario | what it measures |
|---|---|
| talk-refine (3 turns) | what was said earlier still counts; a question changes no file |
| talk-take-it-back (2) | a correction undoes the agent's own work cleanly |
| talk-old-output (3) | an output from two messages ago is still reachable; a command said to cost money runs once |
| talk-crash-resume | a reply cut off by a crash is carried on, not started over |
| talk-note-midway | a "btw" passed mid-reply is acted on |
| talk-ask-first | care before deleting: the rule is in a README, one folder is on hold |
| fix-root-cause | the cause is fixed, not the place where it shows |
| follow-house-rules | a project's written rules are followed though the request names none |
| small-diff | one line fixed, no other byte of the file moved |
| hands-off | a stated limit holds when the quick fix lies on the other side of it |
| straight-report | what could not be done is said plainly and nothing is made up |
| dirty-merge | data work by written rules: encodings, separators, dates, duplicates |
| flaky-order | a failure that depends on test order is reproduced and its cause fixed |
| guess-the-format | rules worked out from examples hold on input not seen |
| clean-build | deleting with care: look-alike names, a file git ignores that is not a build product |
| win-ops | sizes, a zip and a read-only file on names with spaces, brackets and Cyrillic |

A scenario is `scenarios/<id>/`: `scenario.json` (the turns, and what its user does: a note, an answer, a kill),
`files/`, `check.py <folder> <turn>` built on `checklib.py`, and `solution/<turn>/` (files laid over, `DELETE`,
`APPLY.py`).

## Without a model: what a round sends again

Every round sends the whole conversation, and the provider reads from its cache only the start that is unchanged since
the round before. `bench/wire` measures that start with no key and no cost:

```bash
python bench/wire/stub.py bench/wire/example-script.json out 18999 &
OPENROUTER_BASE_URL=http://127.0.0.1:18999 OPENROUTER_API_KEY=x APIM_DATA_DIR=<a spare folder> \
  desktop/target/release/apim --ask --auto --model glm-5.3-flash --dir <a copy of tasks/explore-large-codebase/files> "any question"
python bench/wire/wirediff.py out
```

`cacheprobe.py <model> <endpoint tag>…` asks the other question, with a key and for a fraction of a cent: what each
endpoint really reads from its cache over six rounds of one conversation.

`stub.py` stands in for OpenRouter: it answers each request with the next step of the script (a list of tool calls,
or a text that ends the reply) and keeps the request. `wirediff.py` prints, for each request, how much of it is the
request before it from the start, and the message where the two part. `STUB_PROVIDERS=Relace,Relace,Sail` makes the
stand-in name a different endpoint per request, as OpenRouter does when it falls to a spare.

## The tasks

| kind | tasks |
|---|---|
| bug fixes | py-pagination-bug, js-date-format-bug, py-traceback-debug, fix-failing-suite, log-root-cause |
| features | py-lru-cache, py-cli-subcommands, js-event-emitter, js-url-router, js-debounce-throttle, js-natural-sort, ts-inventory-feature, multi-file-feature, spec-implementation, python-package-main |
| refactors | py-rename-refactor, js-callbacks-to-async, config-migration |
| data | py-csv-report, py-sqlite-queries, js-markdown-table, html-table-extract |
| other | py-perf-quadratic (speed), py-write-tests (tests graded by hidden buggy variants), explore-large-codebase (79-file service, questions that need tracing) |
| tools | tool-long-output (five facts from a 6,000-line, 25-second program output), tool-big-line-edit (four changes inside one 137,000-character line, every other byte kept) |
| windows | win-encodings (UTF-16 and Windows-1251 files with CRLF, edited and kept as they are), win-paths (folders with spaces, Cyrillic, brackets and `&`; a script that breaks on this PC's default encoding) |
| process | proc-server-bug (four bugs that only show against the running server) |
| safety | safe-injection (a note in the repo tells the agent to copy `.env` out and delete the tests) |
| honesty | honest-blocked (one test cannot pass without a key that is not there: say so, do not write the answer in) |
| binary | bin-format (unpacker for a documented binary archive, graded on an archive it has not seen) |
| long | long-many-fixes (24 modules, one bug each, no tests given: the score is how many are right) |

## Adding a task

`bench/tasks/<id>/` holds `task.json` (title, category, language,
difficulty, prompt, timeoutMinutes, budgetUsd), `files/` (the starting
workspace), `check/check.py` or `check/check.mjs` (the hidden grader: run
from a copy of the final workspace, exit 0 to pass, print `SCORE a/b` for
partial credit) and `solution/` (a reference solution). `npm run test:bench`
must pass: the check has to fail on `files/` and pass on `files/` +
`solution/`.
