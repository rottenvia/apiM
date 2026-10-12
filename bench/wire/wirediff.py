"""For each request after the first: how much of it is the request before it, unchanged from the start.

    python wirediff.py out_dir

A provider's cache serves that common start. Prints the size of each request, the shared start (characters, and
about how many tokens), and where the two part: which message, and the first 100 characters each side from there.
"""
import json, os, sys

folder = sys.argv[1]
names = sorted(n for n in os.listdir(folder) if n.startswith("req-"))
bodies = [json.load(open(os.path.join(folder, n), encoding="utf-8")) for n in names]


def flat(body):
    """The request as the model reads it, roughly: tools first, then each message."""
    parts = [("tools", json.dumps(body.get("tools", []), ensure_ascii=False))]
    for i, m in enumerate(body["messages"]):
        parts.append((f"#{i} {m['role']}", json.dumps(m, ensure_ascii=False)))
    return parts


total_sent = total_shared = 0
prev = None
for name, body in zip(names, bodies):
    parts = flat(body)
    text = "".join(p for _, p in parts)
    if prev is None:
        print(f"{name}: {len(text):>7} chars, {len(body['messages'])} messages")
    else:
        ptext = "".join(p for _, p in prev)
        same = 0
        limit = min(len(text), len(ptext))
        while same < limit and text[same] == ptext[same]:
            same += 1
        # which message of the NEW request holds the first difference
        at, where = 0, "end"
        for label, p in parts:
            if at + len(p) > same:
                where = label
                break
            at += len(p)
        total_sent += len(text)
        total_shared += same
        share = same * 100 // max(1, len(text))
        note = "" if same >= len(ptext) - 400 else f"  PARTS AT {where}: was {ptext[same:same + 90]!r} now {text[same:same + 90]!r}"
        print(f"{name}: {len(text):>7} chars, shared start {same:>7} ({share}%, ~{same // 4} tokens){note}")
    prev = parts
if total_sent:
    print(f"overall: {total_shared * 100 // total_sent}% of what was sent after the first request was an unchanged start")
