# "btw" — asking a small question without touching the main task

## The problem, stated precisely

The main task is running: the agent is twenty rounds into your extension,
writing files. You want to ask something small and unrelated — *"btw what does
`chrome.storage.sync` cost in quota?"*

Today there is exactly one thing you can do: **press Stop**. That kills the run.
Even with Continue, you have paused real work to ask a trivia question.

The requirement is two things happening at once, which the current design
forbids in one line:

```ts
if (!content.trim() || isLoading || !hasKeys) return;   // page.tsx:673
```

One conversation, one `AbortController`, one stream. Sending anything while a
reply is in flight is refused.

---

## Why the obvious designs are wrong

**Just allow a second message into the same chat.** This is what most apps do
and it is why they feel chaotic. Two replies stream into one column, tool
activity from the main task interleaves with prose from the side question, and
`conversationHistory` now contains a half-finished reply — so the *main* task's
next round sees your trivia question and may act on it. It corrupts the thing
it was meant not to disturb.

**Open a second chat.** Clean isolation, but it is not "btw" — it is "go
somewhere else". You lose the context you were looking at, and the answer
arrives detached from the work that prompted it.

**Queue it until the task finishes.** Safe and useless: the whole point is that
you want the answer *now*, while the long task runs.

---

## The design: a side channel, not a second conversation

Two isolated processes, one screen. The key decisions:

### 1. It is a different *kind* of request, not another turn

A btw is answered by a **separate, stateless call** that never enters the main
transcript. It gets:

- your question
- the workspace file tree (so *"where is the scanner?"* works)
- the last **user** message for context — never the in-flight reply

It does **not** get: the main task's reasoning, its tool results, or its
partial answer. And nothing it produces is appended to `conversationHistory`.

This is the whole safety argument. The main task cannot see the btw, so the btw
cannot derail it. Isolation is structural, not a matter of being careful.

### 2. It is read-only

No `tools` parameter at all. A btw cannot write files, run commands, or touch
the workspace the main task is actively editing. Two writers on one workspace
is a corruption bug waiting to happen, and no amount of locking makes it a good
idea while a long task is mid-edit.

If a question genuinely needs the agent to *do* something, that is not a btw —
that is the next task, and it should wait.

### 3. It runs on Flash with thinking off

A btw is a quick question. Pro with max reasoning would cost more than the main
task's next round. Flash, thinking disabled, capped output — a fraction of a
cent, and it comes back in a second or two rather than after a minute of
deliberation.

If the answer is unsatisfying, there is an **"Ask properly"** action that
re-sends it as a normal message once the main task finishes.

---

## Where it lives on screen

This is the part that has to not ruin the interface.

**Not in the message column.** The message column is a single chronological
thread; putting a parallel exchange in it breaks the one thing a transcript
guarantees — that reading top to bottom is reading what happened in order.

**A dock above the composer.** Collapsed to a single line by default:

```
┌──────────────────────────────────────────────────────────┐
│  ⋯  working — round 12, editing content.js               │  ← existing status
├──────────────────────────────────────────────────────────┤
│  btw · chrome.storage.sync quota?              ▾  ✕      │  ← the dock
├──────────────────────────────────────────────────────────┤
│  [ message the agent…                          ] [ ↑ ]   │  ← composer
└──────────────────────────────────────────────────────────┘
```

Expanded, it becomes a small scrollable panel showing the question and answer.
It never pushes the transcript around: it is positioned above the composer and
the message list keeps its scroll position.

**Why here.** It sits between the status line (what the main task is doing) and
the composer (what you are typing). That is exactly its conceptual place —
attached to the conversation, not part of it.

### How you trigger it

Typing `btw ` at the start of a message while a task is running switches the
composer into btw mode — the send button changes to a distinct icon and the
placeholder reads *"quick question, won't interrupt the task"*. Same for a
keyboard shortcut, and a small `btw` toggle at the left of the composer.

**Why a prefix.** It costs nothing to discover, matches how you already
described it, and it is impossible to send one by accident: you have to type
the word.

---

## What happens to Stop

This is the concern you raised, and it is the right one.

**Stop stays bound to the main task, always.** A btw never captures it. The
button keeps its meaning: *stop the thing that is doing work*.

The btw gets its own small `✕` on its row. Dismissing a btw aborts only its own
request. Two controllers, each labelled by proximity to the thing it controls —
Stop lives with the status line, `✕` lives on the btw row.

If a btw is in flight and you press Stop, the main task stops and the btw keeps
going. That is the correct behaviour: they are independent, and the UI says so
by never putting the two controls in the same place.

---

## What it costs to build

| Piece | Size | Risk |
|---|---|---|
| `POST /api/btw` — stateless, no tools, Flash | small | low |
| Second abort controller, kept out of `abortRef` | small | low |
| Dock component, collapsed/expanded | medium | low |
| Composer `btw ` prefix detection + mode | small | medium — must not misfire on a normal message beginning "btw" when nothing is running |
| Guarding `conversationHistory` so btw never leaks in | small | **highest** — this is the one that could corrupt a main task |

The last row is where the care goes. My plan is that the btw path never touches
`messages` state at all: it holds its own `{question, answer}` in the dock's
own state, and the persistence layer never sees it. A btw is not saved to the
chat, by design — it is a question you asked in passing, not part of the record.

**Open question for you:** should a btw be *saveable*? There is an argument for
a "keep this" action that appends it to the transcript once the main task
finishes, for when the throwaway question turns out to matter. I would build it
without that first, and add it only if you miss it.

---

## What I would not do

- **No tools in a btw.** Tempting, and it is how this feature becomes a second
  agent fighting the first over the same files.
- **No btw when nothing is running.** If the agent is idle, `btw ` is just a
  normal message — it sends as usual. A parallel channel with nothing to be
  parallel to is a worse version of the main input.
- **No more than one btw at a time.** A second one replaces the first. Multiple
  parallel side-questions is a chat app, not a dock.

---

## Honest uncertainty

I have designed this against the code and I am confident about the isolation
argument — it follows from the transcript being separate. What I cannot
predict is whether the dock **feels** right, because I cannot see motion or use
the app. The two things most likely to be wrong:

1. **The dock may be too subtle.** An answer arriving in a collapsed one-line
   row above the composer might go unnoticed while you are reading the main
   reply.
2. **The prefix may feel clumsy** compared to a dedicated button.

Both are cheap to change once you have used it once. The expensive part — the
isolation — is the part I am sure about.
