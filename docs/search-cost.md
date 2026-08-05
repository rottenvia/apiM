# Web search cost

Notes on what search actually costs, what was changed, and what was
deliberately not changed. Prices verified 2026-08-05.

## The unit you are billed in is not a question

Providers bill per **request**. One question you type can fire several:

```
you ask one question
   ↓
round 1:  3-4 requests   ← each one billed
   ↓ a cheap model judges: "still missing the version number"
round 2:  3 more requests
   ↓ ... up to MAX_SEARCH_ROUNDS (5)
   ↓
the best 8 sources go to the model
```

So a "1,000 free credits" tier is nowhere near a thousand questions. Before
these changes it was closer to a hundred, because every request went out at
advanced depth, which Tavily bills at **2 credits each**.

Measured: an easy question cost **8 credits**, a hard one **14**.

## Results are free; requests are not

`max_results` was 5. Providers include up to **10 results in the base price** —
Exa is `$7/1k requests, up to 10 results`, Tavily's credit cost does not vary
with result count. Asking for 5 paid the ten-result price for half the sources,
so more requests were needed to reach the same coverage.

Raising it to 10 costs nothing and is the single largest saving here.

## Profiles

Set in Settings → *Web search cost*. Stored per browser, sent with each
request as `searchProfile`.

| | Thorough | **Balanced** (default) | Frugal |
|---|---|---|---|
| Opening round | 4 queries, advanced | 3 queries, basic | 2 queries, basic |
| Follow-up round | 3 queries, advanced | 3 queries, **advanced** | 2 queries, basic |
| Results per query | 10 | 10 | 10 |
| Easy question | 8 credits | **3** | 2 |
| Hard question | 14 credits | **9** | 4 |

`quality` reproduces the pre-existing behaviour exactly. It exists so there is
always a known-good setting to fall back to if `balanced` ever reads thin.

### Why balanced is not simply "cheaper and worse"

Advanced depth is not a scam — combined with `include_raw_content: "markdown"`
it returns the parsed full page instead of a ~500 character snippet, so a
detail sitting just past the snippet boundary is still visible. Using basic
everywhere **would** be worse.

Balanced instead spends depth where it is earned:

- the opening round casts wide and shallow
- `assessSufficiency` — which already existed — names the concrete gap
- only the round chasing that gap pays for full-page reads

Questions that settle in one round never needed the deep read. Questions that
do not settle still get it.

The 8 sources that actually reach the model are chosen by `rank()` after
dedup, and that is untouched.

## Cache

`src/lib/search-cache.ts`. Keyed on a hash of query + provider + depth +
result count, stored under `data/search-cache/`.

- **24 hour TTL** — long enough to cover a working session and its retries,
  short enough that "the latest version of X" is not answered from last week
- **`time_range` queries are never cached** — those are explicitly asking what
  changed recently
- **Depth is part of the key** — reusing a skimmed result for an advanced
  request would silently downgrade it
- **Empty results are not cached** — usually a transient provider failure, and
  caching one would lock the failure in for a day
- Capped at 500 entries, oldest pruned first

A cache hit returns exactly the bytes the provider returned, so answers are
identical. There is a test that asserts this.

## Meter

`src/lib/search-usage.ts`, shown in Settings and per-reply in the message
footer as `+$0.024 search`.

Counted **locally**, not read from the provider, because most do not report a
remaining balance per response. This is accurate as long as this app is the
only consumer of the key — which is the intended setup — and the UI says it is
an estimate.

Tracked per provider: billed requests, cache hits, estimated USD, remaining
free allowance. Resets automatically on the 1st, because free allowances do.

Counters are written fire-and-forget so metering never delays a search;
`flushUsage()` drains the queue before any read.

## Provider rates

Per request, pay-as-you-go, verified 2026-08-05.

| Provider | Cost | Free per month | Card needed | Depth doubles |
|---|---|---|---|---|
| Exa | $0.007 | **$10** (+$20 signup) | No | No |
| Tavily | $0.008 | 1,000 credits (~$8) | No | **Yes** |
| Linkup | $0.005 | ~$5 (+4,000 signup) | No | No |
| Serper | $0.001 | 2,500 one-time | No | No |

Notes:

- **Brave killed its free tier in February 2026.** Replaced with $5/month
  credit, credit card required at signup, plus an attribution requirement.
  Grandfathered accounts keep 2,000/month.
- **Tavily was acquired by Nebius** in February 2026.
- **Google Custom Search** is closed to new customers and shuts down
  1 January 2027. **Bing's Search API** was retired 11 August 2025.

That volatility is the main argument for the provider pool below.

## Not built yet

**Provider pool with failover.** Currently only Tavily is wired up.
`src/lib/search-types.ts` and the usage meter are already provider-keyed, and
`exhausted` on a provider summary is the signal the pool would key off. The
work is an adapter per provider behind one interface, plus an ordered list
that retries the next one on a quota error.

**Do not build:** a self-hosted index. SearXNG gets fingerprinted and blocked
by Google within a handful of queries, and a real index is a datacentre
problem, not a weekend one.

---

# Resilience and context (added later)

## Retry

`src/lib/retry.ts`. Wraps the DeepSeek call in the agent loop.

Before, any failure ended the run:

```
send({ type: "error", ... }); close(); return;
```

One dropped connection on round thirty-two of a forty-round task discarded
everything, including the tokens already paid for on the previous
thirty-one rounds.

Now: 3 attempts, exponential backoff from 700ms capped at 8s, with jitter.

- **Retried:** 408, 409, 425, 429, all 5xx, dropped connections, timeouts
- **Not retried:** 400, 401, 402, 403, 404, 422 — a rejected key or an empty
  balance fails identically every time, so retrying only delays an error the
  user needs to see
- `Retry-After` is honoured when the server sends one; ignoring it tends to
  earn a longer ban
- Pressing Stop aborts the backoff immediately rather than waiting it out
- Each retry emits a `retrying` event, shown under the loading dots — an
  unexplained 8-second pause reads as a freeze

## Pruning

`src/lib/prune.ts`. Applied to the copy sent upstream only; the stored
transcript keeps everything.

Every round resends the whole conversation, so the full text of a file read on
round three is paid for again on rounds four through forty. Once the model has
acted on it, that text is dead weight — but the fact the read happened still
matters.

So old results are **collapsed, not dropped**:

```
[earlier read_file result, 240 lines / 8,120 chars, collapsed to save
 context — def main(): ... . Call the tool again if you need the full output.]
```

- Last **12** results stay verbatim — the model is usually working with what
  it just read
- Only results over **400 chars** are collapsed; below that the placeholder is
  bigger than the content
- Nothing happens below **24,000 chars** total
- Measured: **53% smaller** on a 30-round transcript

### The trade-off

If the model needs content from an old result it must re-read the file, which
costs one extra round. That is the deal: rare re-reads in exchange for every
long run being roughly half price.

### Invariants

All three produce a 400 from DeepSeek if broken, and all three are asserted in
`npm run test:resilience`:

- every `tool_call` keeps a matching `tool` reply, including parallel calls
- `reasoning_content` stays verbatim on tool-calling assistant turns
- the system prompt and the user's question are never touched

Message count is unchanged — only the content of old tool replies shrinks.
