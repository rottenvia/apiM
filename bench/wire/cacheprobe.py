"""Does an endpoint really read a conversation's unchanged start from its cache?

  OPENROUTER_API_KEY=... python bench/wire/cacheprobe.py <model slug> <endpoint tag> [<endpoint tag> ...]

Plays a six-round conversation with a long start (about 12,000 tokens, and three tools) to each endpoint, each
round the one before plus one exchange, as an agent's rounds are, and prints what the endpoint says it read from
its cache. The start opens with a line no other request has, so only this conversation's own rounds can have put
it there. A round costs a fraction of a cent. `PROBE_GAP` is the pause between rounds in seconds (default 3);
`PROBE_TOOLS=0` leaves the tools out; `PROBE_MARK=top|last|system|both` sends a cache marker.
"""
import json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

KEY = os.environ["OPENROUTER_API_KEY"]
GAP = float(os.environ.get("PROBE_GAP", "3"))
# Real prose, so nothing about the start is special: this repository's own notes.
START = (Path(__file__).resolve().parents[2] / "desktop" / "README.md").read_text("utf-8")[:48_000]
TOOLS = [
    {"type": "function", "function": {"name": name, "description": f"{what} " * 12, "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "Relative to the folder."}, "text": {"type": "string"}, "lines": {"type": "array", "items": {"type": "integer"}}, "reason": {"type": "string"}}, "required": ["path"]}}}
    for name, what in (("read_file", "Reads a file of the folder and gives its text back."), ("write_file", "Writes a whole file, replacing what was there."), ("search_files", "Finds the lines that hold a text."))
]


def ask(model, tag, messages):
    body = {"model": model, "messages": messages, "max_tokens": 24, "reasoning": {"effort": "low"}, "provider": {"only": [tag], "allow_fallbacks": False}, "usage": {"include": True}}
    # PROBE_MARK=top sends one cache_control for the whole request; PROBE_MARK=last marks the newest message, as
    # Anthropic's endpoints need it (they read nothing without one).
    mark = os.environ.get("PROBE_MARK")
    if mark in ("top", "both"):
        body["cache_control"] = {"type": "ephemeral"}
    if mark in ("system", "both"):
        body["messages"] = [{**messages[0], "content": [{"type": "text", "text": messages[0]["content"], "cache_control": {"type": "ephemeral"}}]}] + messages[1:]
    elif mark == "last":
        body["messages"] = messages[:-1] + [{**messages[-1], "content": [{"type": "text", "text": messages[-1]["content"], "cache_control": {"type": "ephemeral"}}]}]
    if os.environ.get("PROBE_TOOLS", "1") != "0":
        body.update(tools=TOOLS, tool_choice="none")
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", json.dumps(body).encode(), {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=90))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code} {e.read()[:120].decode('utf-8', 'replace')}"}
    except Exception as e:
        return {"error": str(e)[:120]}


model = sys.argv[1]
for tag in sys.argv[2:]:
    opening = f"Conversation {time.time():.3f} with {tag}. You answer in one short word and call no tool."
    messages = [{"role": "system", "content": opening + "\n\n" + START}, {"role": "user", "content": "Say: one"}]
    seen, later, cached, cost = [], 0, 0, 0.0
    for n, word in enumerate(["two", "three", "four", "five", "six", "seven"]):
        r = ask(model, tag, messages)
        if "error" in r:
            seen.append("ERR " + str(r["error"])[:70])
            break
        u = r.get("usage", {})
        hit = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        cost += u.get("cost") or 0
        if n:
            later, cached = later + u.get("prompt_tokens", 0), cached + hit
        seen.append(f"{hit}/{u.get('prompt_tokens', 0)}")
        messages += [{"role": "assistant", "content": r["choices"][0]["message"].get("content") or "ok"}, {"role": "user", "content": f"Say: {word}"}]
        time.sleep(GAP)
    print(f"{tag:20} cached/in per round: {'  '.join(seen)}   after the first round: {round(100 * cached / later) if later else 0}% cached   ${cost:.5f}")
