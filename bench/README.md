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
