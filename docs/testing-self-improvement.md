# Testing whether the agent actually learns

The mechanism is verified by `npm run test:lessons` — storage, self-correction,
the evidence rule, the cap. What no test can tell us is whether a real model,
shown real outcomes, writes lessons worth having.

That needs real runs. These scenarios are designed so that each one produces a
**clear pass or fail**, not a vague impression. Every scenario has a
prediction written down in advance; if the result does not match, the design is
wrong and we change it rather than explaining the result away.

Run each with **Settings → Misc → Learn from this project** turned on.

---

## The one rule that makes this worth doing

**Write down what you expect before you run it.** A lesson file always looks
plausible after the fact — that is the trap. The only way to learn anything is
to commit to a prediction first.

---

## Scenario 1 — Does it learn a fact it could not have guessed?

**Why this one first:** if it fails here, nothing else matters.

**Setup.** In a fresh chat, create a small project with a deliberate quirk the
model cannot infer from filenames:

```
package.json      with  "scripts": { "check": "node verify.js" }
verify.js         exits 1 unless run with  --strict
README.md         says nothing about --strict
```

**Task.** *"Run the project's check script and make it pass."*

**Prediction.** It runs `npm run check`, gets exit 1, discovers `--strict`, and
writes something equivalent to *"the check script needs --strict or it exits 1"*.

**Pass.** A lesson naming `--strict`, with the failed command as evidence.
**Fail.** No lesson, or a vague one like *"run the check script carefully"*.

**What a failure means.** The refine prompt is not extracting causally useful
facts. Fixable by tightening the prompt — not a reason to abandon the feature.

---

## Scenario 2 — The one that matters most: does it correct itself?

This is the scenario that justifies calling it *self*-improving. Everything
else is note-taking.

**Setup.** Continue in the **same chat** as Scenario 1.

1. Confirm `LESSONS.md` contains the `--strict` lesson.
2. Now **change the project underneath it**: edit `verify.js` so it passes
   without the flag.
3. Task: *"Run the check script again."*

**Prediction.** It runs the command, it succeeds without `--strict`, and the
old lesson is marked superseded with a correction linked to it.

**Pass.** `LESSONS.md` shows the original struck through and a new entry.
The prompt block (visible by the model's behaviour) no longer asserts
`--strict`.
**Fail.** The old lesson stays live, or it keeps adding `--strict` out of habit.

**What a failure means.** The `replaces` path is not being used by the model.
Worth fixing hard — a system that cannot unlearn is worse than one that never
learned, because it is confidently wrong.

---

## Scenario 3 — Does it refuse to invent?

**Why this matters:** the failure mode nobody notices is a lesson file full of
confident nonsense. Most tasks teach nothing, and the correct output is silence.

**Setup.** A fresh chat with a trivial workspace (one `hello.js`).

**Task.** *"Add a comment to the top of hello.js."*

**Prediction.** One `edit_file`, no failures, **no lessons written at all**.

**Pass.** `LESSONS.md` is absent or unchanged.
**Fail.** Anything like *"this project uses JavaScript"* or *"comments improve
readability"* — generic filler, which is exactly what the old Self-Critic
plugin produced and why it was useless.

**What a failure means.** The "learning nothing is the normal answer"
instruction is not holding. This is the single most important negative test.

---

## Scenario 4 — Does a lesson actually save a round?

The whole economic case is that a lesson prevents a repeated wrong turn.
This measures whether it does.

**Setup.** Two chats, same deliberately quirky project (Scenario 1's).

- **Chat A:** lessons **off**. Ask a task that needs the quirk. Note the number
  of tool rounds and the cost shown on the reply.
- **Chat B:** lessons **on**. Run the same task twice. Compare the **second**
  run's rounds and cost against Chat A.

**Prediction.** Chat B's second run uses at least one fewer round, because it
does not rediscover the quirk.

**Pass.** Fewer rounds, lower cost, same result.
**Fail.** Same or more rounds — the lesson is being read but not acted on.

**What a failure means.** The lessons block is in the prompt but not persuasive.
Position or wording problem, not a storage problem.

---

## Scenario 5 — Does it survive being wrong twice?

**Why:** a belief that flip-flops is more dangerous than one that is simply
wrong, because confidence should fall and it might not.

**Setup.** Force a fact to change twice — quirk on, then off, then on again.

**Prediction.** The file accumulates a visible chain of supersessions, and the
final live lesson is the current truth. Confidence on the flip-flopping lesson
should not read as `high`.

**Pass.** Correct final state; history readable.
**Fail.** Two contradictory live lessons at once. That would be a real bug —
the model would be reading both.

---

## Scenario 6 — Does it stay small?

**Setup.** Run ten varied tasks in one chat with lessons on.

**Prediction.** `LESSONS.md` stays at or under 40 entries, each one line, and
the file stays under roughly 700 tokens.

**Pass.** Capped and readable.
**Fail.** Sprawl, duplicates that should have merged into confirmations, or
multi-paragraph entries.

**What a failure means.** The dedupe key is too strict — near-identical
phrasings are being stored separately instead of confirming each other.

---

## Scenario 7 — The realistic one

Everything above is synthetic. This is the actual use case.

**Setup.** Your Faceit extension zip, in a fresh chat, lessons on.

1. *"Tell me what's inside and how the live match scanning works."*
2. *"Add a setting to disable the scanner."*
3. *"Now add a second setting for the poll interval."*

**Prediction.** By task 3 the lessons contain real facts about *that* codebase
— where settings live, how the manifest is structured, which file holds the
scanner — and task 3 needs less exploration than task 2 did.

**Pass.** Task 3 goes more or less straight to the right files.
**Fail.** It re-reads the same files it read in task 2.

This is the scenario that decides whether the feature stays.

---

## What to send back

For any scenario, the useful evidence is:

1. The contents of `LESSONS.md` (open it from the file panel)
2. Rounds and cost shown under each reply
3. Whether the prediction held

A single run of **Scenario 3** and **Scenario 7** is worth more than all the
synthetic ones — one proves it stays quiet when there is nothing to learn, the
other proves it helps when there is.

---

## Known limits, stated up front

- **Only testable facts self-correct.** *"npm install fails"* can be disproved
  by an exit code. *"the user prefers tabs"* cannot, and will go stale
  silently. Roughly 80% of useful lessons are the testable kind.
- **Lessons are per chat.** Deliberate: facts about a Chrome extension are
  noise in an unrelated project.
- **A refine pass costs a fraction of a cent**, on Flash with thinking off. If
  a scenario shows it costing meaningfully more, that is a bug — report it.
