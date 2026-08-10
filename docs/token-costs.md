# Where the tokens go

Every number here came out of `npm run cost:lab`, which drives the real chat
route against a fake DeepSeek that simulates the real prompt cache (prefix
match, 64-token blocks) and bills at the real rates. Nothing in this document
is estimated from reading the code.

That distinction matters on this project. An earlier round of "optimisations"
was picked by pattern-matching — big file, must be slow — and half of it was
wrong while the real bottlenecks went untouched. So: measure first.

```bash
npm run cost:lab                                  # 12 rounds, high effort
SIM_ROUNDS=40 SIM_EFFORT=max npm run cost:lab     # a long, expensive task
SIM_BUDGET=0.10 npm run cost:lab                  # check the spending limit
```

## The shape of the bill

A measured 40-round agent task on `deepseek-v4-pro` at max effort, in a
250-file workspace:

| | tokens | cost | share |
|---|---|---|---|
| output (reasoning) | 359k | $0.312 | **59%** |
| input, cache misses | 473k | $0.206 | 39% |
| input, cache hits | 2.2M | $0.008 | 2% |
| **total** | | **$0.527** | |

Two things fall out of this immediately.

**Cached input is nearly free.** 2.2 million tokens cost less than a cent.
Cache hits are $0.003625/M against $0.435/M for a miss — 120x. Anything that
stays in the cached prefix is not worth optimising.

**Reasoning output is the single largest line.** It is billed at $0.87/M, the
most expensive rate on the price list, and on max effort the model writes
roughly 9k tokens of it *per round*.

## What was actually wrong

### 1. Moving the file listing invalidated the whole cache

The workspace listing was kept current by deleting the old copy and appending
a fresh one. Deleting a message near the front of the array shifts everything
after it, so the request stops matching the cached prefix almost immediately
and the entire conversation is re-read at full price.

Measured, on the same 40-round task:

| | missed input tokens |
|---|---|
| task that writes files every 3rd round | 702k |
| identical task that only reads | 473k |

**229k tokens — a third of all input on the task — bought nothing but moving a
directory listing to the bottom of the array.** Write-heavy work was billed at
1.3x read-only work for purely structural reasons.

Fixed in `src/lib/tree-delta.ts`. The first listing is sent once and never
moves again. Each change is a short message appended at the end:

```
Workspace changes since the last full listing (+ added, ~ modified, - removed):
  + src/generated/step3.ts  (820B)
  ~ src/lib/store.ts  (12KB)
```

Appending is free — every byte in front of a new final message is unchanged,
so it all still hits the cache. A change that cost a 7k-token re-read now
costs about 15 tokens. After it: 1.8k missed tokens, down from 28.6k, and
write-heavy tasks cost the same as read-only ones.

Deltas re-baseline after 40 changes or 8k characters, so a bulk operation
(unzipping an archive) produces one fresh listing rather than a diff longer
than the tree.

### 2. Compaction was costing money, not saving it

Compaction folded old agent rounds into summaries to remove reasoning, on the
correct observation that reasoning is ~93% of a transcript. The conclusion did
not follow.

Old reasoning sits in the **cached** prefix, at $0.003625/M. It is the largest
thing in the transcript and very nearly the cheapest. Compaction rewrites the
middle of that prefix, so everything after the edit is re-read at $0.435/M,
once, in full.

The trade is: pay full price for the whole remaining transcript today, to save
the *cached* rate on the removed part every round after. Break-even:

| compaction removes | breaks even after |
|---|---|
| 50% of the transcript | 120 rounds |
| 20% of the transcript | 480 rounds |

`MAX_TOOL_ROUNDS` is 40. It could never pay for itself. Measured:

| | 20 rounds | 40 rounds | 60 rounds |
|---|---|---|---|
| compaction on | $0.2490 | $0.5236 | $0.7856 |
| compaction off | $0.2393 | $0.4929 | $0.7588 |

Compaction still has a real job — DeepSeek's window is 1M tokens and a
transcript that reaches it fails outright — so the threshold moved from
120k characters (~33k tokens, hit by any real task) to 1.8M characters
(~500k tokens, half the window). It is now a safety valve, not a cost measure.

### 3. On V4 Pro, "low" effort does nothing

From DeepSeek's own documentation:

| requested | flash actually uses | pro actually uses |
|---|---|---|
| low | low | **high** |
| high | high | high |
| max | max | max |

Pro has two real settings, not four. Asking Pro to think less has no effect
whatsoever — the only ways to spend less on reasoning are Max→High, or
switching to Flash. This is now stated in the settings UI rather than left for
someone to discover from a bill.

## What is not a problem

Recorded so it is not "optimised" again:

- **Tool schemas.** 26 tools, 14,338 characters, ~4k tokens — but they sit at
  the very front of the prefix and are identical on every request, so they are
  paid for once per conversation and cached thereafter. Removing tools to save
  tokens would save ~$0.0016 on a 40-round task and cost the agent its hands.
- **The system prompt.** ~1k tokens, cached, 0.1% of the bill.
- **The file tree itself.** After the delta fix, 1.8k tokens over 40 rounds.
  It was never the tree that was expensive — it was moving it.
- **Cached input in general.** 2.2M tokens for $0.008.

## The spending limit

None of the above bounds anything. They make tokens cheaper; only a cap makes
them finite.

The failure it exists for: a task the model cannot finish. It reads, tries,
fails, reasons about why, tries again. Every round is legitimate by every
measure the app has — tools succeed, the model makes sense, nothing errors. It
simply never converges, and nothing was watching the total.

`src/lib/budget.ts`, enforced in the agent loop:

- Checked **between rounds**, before the tools run. Stopping mid-stream would
  pay for a reply nobody can use; stopping after the tools would pay for
  results nothing will read.
- **Predictive.** It stops when the *next* round would exceed the cap, not
  after it already has. Checking only afterwards overshoots by a full round.
- **Warns at 80%**, so being cut off is never a surprise.
- **Leaves the run resumable.** Pending tool calls are answered (an unanswered
  `tool_call` is a 400 and an unresumable transcript), the reply is flagged
  incomplete, and Resume continues from there. A cap that discarded the work
  it just paid for would be worse than no cap.
- **Off by default.** A limit nobody chose that halts a task is its own bug.

Verified end-to-end: a task that would have cost $0.63 warned at $0.082 and
stopped at $0.0937 against a $0.10 cap, without ever crossing it.

## Rules of thumb

1. **Never edit or move anything in the transcript except the tail.** Appending
   is free. Any change further forward costs a full-price re-read of everything
   after it.
2. **Cached tokens are not worth removing.** At 120x apart, a token you keep in
   the prefix is cheaper than the rewrite needed to drop it.
3. **Reasoning output is the real expense.** It is the priciest rate and it
   scales with effort. Effort selection matters more than any prompt trimming.
4. **Measure before claiming a bottleneck.** `npm run cost:lab` takes under a
   minute.
