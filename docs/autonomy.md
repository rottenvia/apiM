# The road to "make me $100"

You described the goal as: give the agent a task and it does everything alone,
asking only when it genuinely needs you.

That is the right target, and it is worth being precise about what stands
between here and there — because the gap is not what it looks like.

## What was actually missing (and is now fixed)

### The agent was told not to ask you

You said you had never seen the question popup. The popup has existed the
whole time, working, with buttons. **The prompt was telling the model not to
use it.** Three separate discouragements: *"sparingly, since every question
interrupts the user"* in the system prompt, and *"do not use it... every
question interrupts the user"* in the tool description.

The model was obeying. It guessed instead of asking — which is exactly how you
end up with work you throw away.

Both now say the opposite: ask early, offer options, one question up front is
cheaper than twenty rounds in the wrong direction.

### The agent knew what it had done, but not what it was doing

The loop runs as many rounds as the task needs. Everything it *did*
survives into the transcript. Nothing recorded what it was *trying to do*.

That produces three failures, all of which look like the model being stupid
and none of which are:

- **Stopping early.** From inside round twelve, the work so far looks like a
  complete answer. So it writes a confident summary and stops.
- **Forgetting requirements.** "Also make it work on mobile" was in the first
  message and nowhere in the last thirty rounds of context.
- **Claiming success without checking.** Nothing distinguished *wrote the
  file* from *verified the file works*.

`make_plan` / `update_plan` fix all three. The plan sits at the end of every
request — always the last thing read, and free, because everything before it
still hits the prompt cache.

**A step cannot be marked done without saying how it was checked.** "Done" is
the word an agent over-claims; requiring one line of evidence makes
over-claiming take deliberate effort instead of happening by default.

And the loop now **refuses to end on an unfinished plan**. Proved end to end:
a mock model scripted to announce *"All done! I have completed the task."*
after one step of three is pushed back and finishes at 3/3.

### The agent had to ask permission to read

Every command stopped and waited for a click — including `node --version`.
Being asked about harmless things teaches you to click through prompts without
reading them, which makes the prompt worse at the job it exists for.

Read-only commands now run freely. The line is drawn on **arguments, not
programs**: `git status` is free, `git push` is not, same binary. A read
subcommand carrying `--output=` or a redirect is disqualified.

## Honest tool scorecard

| Tool | Reliability | Potential | Note |
|---|---|---|---|
| `read_file` `write_file` `list_files` `move_file` `delete_file` | 96–98% | 90–98% | Mature |
| `read_files` `write_files` | 95–97% | 85–90% | Mature |
| `edit_file` `edit_files` | 95–97% | 85–93% | Whitespace-tolerant |
| `apply_patch` | 95% | 90% | Atomic multi-edit |
| `search_files` | 92% | 90% | Regex, glob, context |
| `run_tests` | 90% | 85% | Never fakes a pass |
| `http_request` | 93% | 90% | Status, timing, JSON |
| `wait_for_output` | 95% | 90% | No more guessed sleeps |
| `make_plan` `update_plan` | 95% | 90% | Evidence enforced |
| `ask_user` | 90% | **90%** | Was 80% — the prompt was the blocker |
| `undo_file` | 96% | 92% | 10 versions |
| `read_document` | 94% | 92% | PDF included |
| `fetch_url` `inspect_page` | 90–93% | 80–85% | Warn on app shells |
| `browse` | logic tested | ~85% | Adapter untestable here |
| `run_command` | 85% | **78%** | Still the weakest |
| `start_process` `read_process` `stop_process` | 85–95% | 70–90% | |
| `view_image` | 85% | 70% | Needs a vision key |

**`run_command` is still last, deliberately.** No shell — a shell would make
the allow-list meaningless. That is a real capability limit and the correct
trade.

## What still stands between this and "make me $100"

Being honest about the remaining distance:

1. **The browser adapter is untested.** 44 checks cover the logic; ~30 lines
   of Playwright calls have never executed here. Install it and try it — that
   is the only way to close the gap.
2. **No memory across chats.** You rejected this deliberately, and it is the
   right call for now — but a genuinely autonomous long-running agent
   eventually needs somewhere durable to keep findings.
3. **No scheduling.** "Check this every hour" needs a server that stays
   running. That is the Hetzner question, not a code question.
4. **No money handling, and it should stay that way.** Anything that spends or
   earns should stop and ask. The spend cap exists precisely because an agent
   with an unbounded budget is a bad idea.
5. **Verification is self-reported.** The plan requires evidence, but the
   agent writes its own evidence. `run_tests` and `browse` make it checkable;
   nothing makes it *provable*.

Point 5 is the deepest one. An agent that grades its own homework is the
fundamental limit, and every tool that returns a hard fact — a test result, a
status code, a screenshot — is a small step away from it. That is the direction
worth keeping.
