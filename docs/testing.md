# How to test apiM

## The short answer

```bash
npm test
```

That runs **every** suite — 1,361 checks across 39 files — in about 90
seconds. Green means the whole app is behaving. Anything red is printed with
the failing lines and the command to re-run just that piece.

You do not need to know which suites exist or what order they go in.

## What it does not do

**It never spends money.** One suite, `npm run test:real`, calls the live
DeepSeek API and asks for your key. It is deliberately excluded — a command
called "test" should not be able to cost anything. Run it by hand when you
want to check the real API end to end; it costs a fraction of a cent.

## Running one thing

While working on something specific, run only that:

```bash
npm test plan            # just the plan suite
npm test plan browser    # a couple of them
npm run test:plan        # the same thing, directly
```

## Reading the output

```
  PASS  adversarial    66 checks              1.0s
  FAIL  plan           43 checks              3.2s

  1361 checks across 39 suites  (228s of work)
```

"228s of work in 90s" is because most suites run in parallel. Four need a real
server and run one at a time afterwards, which is why they appear last.

On failure you get the failing lines and `(run it alone: npm run test:plan)`.
Running it alone gives the full output.

## The three other commands

```bash
npm run typecheck   # types are consistent
npm run lint        # no unused code or React mistakes
npm run score       # rates all 33 agent tools, and fails if one is unrated
```

`npm run score` is worth running after adding a tool: it exits non-zero if a
tool is registered but has no rating, which stops a tool being added and
quietly forgotten.

## What the suites cover

Rough shape, so you know what a failure means:

| Area | Suites |
|---|---|
| Agent behaviour | `plan` `adversarial` `agent` `agentloss` `lessons` `refine` |
| Tools | `tools2` `tools3` `browser` `web` `documents` `runner` `processes` |
| Safety | `agentsafety` `hardening` `resilience` `auth` |
| Cost | `cost` `budget` `compact` `balance` |
| Files | `workspace` `archive` `zip` `snapshots` `diff` `tree` `install` |
| Interface | `design` `layout` `timeline` `reasoning` `btw` |
| Storage | `folders` `titles` `delete` `resume` |

`adversarial` is the one to read if you are curious: every check in it is an
attack that worked before it was fixed.

## Two things worth knowing about how this works

### Tests get their own data directory

Six suites clear `data/` to start from a known state. Correct alone,
destructive in parallel — they delete each other's fixtures mid-run.

Building this runner is how that was found: **nine suites failed together and
every one of them passed alone.** That is the signature of shared state, and
it is exactly the class of bug a piecemeal test process hides, because you
never run the pieces at the same time.

Each suite now gets `.test-data/<name>/` through `APIM_DATA_ROOT`, which the
app reads too, so the code under test and the test agree on where files live.
Unset in normal use.

### Tests measure behaviour, not the clock

One check asserted `warmMs * 3 < coldMs` to prove the sidebar cache worked. It
passed alone and failed under `npm test`, because six suites sharing a CPU
make a cold read land in 8ms on a lucky slice.

It now counts how many summary objects were reused — `26/26` when the cache
works, `0/26` when it does not. Verified both ways by deliberately breaking
the cache.

A test that measures the machine rather than the code will eventually lie in
one direction or the other.

## If you change something

```bash
npm test && npm run typecheck && npm run lint
```

If a test fails, read what it says before changing it. Several assertions in
this repo were pinned to exact source text and broke when the code got *more*
correct — the fix each time was to test the property, not the phrasing.
