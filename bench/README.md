# apiM benchmark

25 real tasks the agent must complete through the real app, each graded by a
hidden check it never sees. Use it to tell whether a change made the agent
better or worse — not just whether anything broke.

## Run it

```bash
npm run test:bench                         # free: proves every check is honest
OPENROUTER_API_KEY=sk-or-… npm run bench   # all 25 tasks on DeepSeek V4.1 Flash
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

## The tasks

| kind | tasks |
|---|---|
| bug fixes | py-pagination-bug, js-date-format-bug, py-traceback-debug, fix-failing-suite, log-root-cause |
| features | py-lru-cache, py-cli-subcommands, js-event-emitter, js-url-router, js-debounce-throttle, js-natural-sort, ts-inventory-feature, multi-file-feature, spec-implementation, python-package-main |
| refactors | py-rename-refactor, js-callbacks-to-async, config-migration |
| data | py-csv-report, py-sqlite-queries, js-markdown-table, html-table-extract |
| other | py-perf-quadratic (speed), py-write-tests (tests graded by hidden buggy variants), explore-large-codebase (79-file service, questions that need tracing) |

## Adding a task

`bench/tasks/<id>/` holds `task.json` (title, category, language,
difficulty, prompt, timeoutMinutes, budgetUsd), `files/` (the starting
workspace), `check/check.py` or `check/check.mjs` (the hidden grader: run
from a copy of the final workspace, exit 0 to pass, print `SCORE a/b` for
partial credit) and `solution/` (a reference solution). `npm run test:bench`
must pass: the check has to fail on `files/` and pass on `files/` +
`solution/`.
