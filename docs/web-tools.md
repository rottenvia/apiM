# Why three web tools instead of one

You asked: *"why do we need inspect something when we have browse now? or
fetch url?"*

Fair question, and the honest answer is that one of them **is** nearly
redundant now. Here are the measurements, then the rule.

## The numbers

Same realistic documentation page, measured three ways (`~9k tokens of raw
HTML`, which is an ordinary article page):

| Tool | What comes back | Tokens | Speed |
|---|---|---|---|
| `inspect_page` | selectors only | **389** | ~10ms |
| `fetch_url` | readable text | **3,720** | ~10ms |
| `browse` | rendered DOM + text + console | 4,000+ | **~1–3s** |

Two things fall out:

- `fetch_url` is **2.5× smaller** than raw HTML, because it strips markup.
- `inspect_page` is **9.6× smaller** than that, because it strips prose.
- `browse` costs a **browser launch** — roughly 20–50× slower than a fetch.

## So when does each one win?

**`fetch_url` — reading. The default for any page that is text.**

Documentation, an article, a changelog, a README, an API reference. The
content is in the HTML the server sends, and you want the words, not the
markup. It is fast and it is the cheapest way to *read* something.

**`inspect_page` — writing a selector against a static page.**

You are building a userscript or a scraper for a server-rendered site. You do
not want to read the page; you want its ids and classes. 389 tokens instead
of 3,720 is a real saving when this happens on round three of twenty, because
that output is resent on every round afterwards.

**`browse` — anything that JavaScript builds, and anything you need to *see*.**

Three jobs nothing else can do:
1. **Run the scripts.** React/Vue/Next sites send an empty shell.
2. **Interact.** Click, type, scroll, wait — a fetch gets one static snapshot.
3. **Look at your own work.** Screenshot a page you built and read the console.

## The rule

> Use `fetch_url` to **read**. Use `inspect_page` to get **selectors cheaply**
> from a static page. Use `browse` when the page is an **app**, when you need
> to **interact**, or when you need to **see** it.

## The honest part: `inspect_page` is now the weak one

`browse` does everything `inspect_page` does and does it correctly on more
sites. The only thing keeping `inspect_page` is that it is **10× cheaper and
100× faster** on the pages where it works.

But it used to be actively harmful. On an app page it returned:

```
ids: ["root"]    classes: []
```

...and reported that as success. **That is the Faceit failure.** The agent was
told the page had one empty div, so it wrote an overlay hooking into nothing.
Not a reasoning failure — it was given a wrong answer and believed it.

So this round both tools learned to recognise an app shell:

- **`fetch_url`** now appends a warning and names `browse` as the fix.
- **`inspect_page`** now **refuses outright** — returning `id=root` as "the
  page structure" is the original bug in its purest form.

Detection needs three signals together (scripts present, an empty known mount
point like `#root`/`#app`/`#__next`, and very little text for the amount of
markup), so it stays quiet where these tools genuinely work. Verified against
seven cases including a server-rendered app and an article that loads
analytics: **no false positives**.

That is the difference between three tools that overlap and three tools where
the wrong choice silently costs you money. They now hand off to each other
instead of failing quietly.

## Would I delete `inspect_page`?

Not yet, and here is the tradeoff rather than a preference:

- **Keep it:** it is 10× cheaper on static pages, which matters on long runs.
- **Delete it:** one fewer decision for the model to get wrong, and `browse`
  is strictly more capable.

It is worth keeping while the cost difference is real and the failure mode is
fixed. If it turns out the model still reaches for it on app sites even with
the refusal in place, that is evidence to remove it — and the refusal message
makes that visible in the diagnostics report rather than invisible.
