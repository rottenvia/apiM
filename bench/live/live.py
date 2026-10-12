#!/usr/bin/env python
"""The live benchmark's hands. Every message goes through a real apiM window, kept off screen, in a spare data
folder; whoever runs this is the user of that window: sends, reads, answers, passes notes, stops.

  live.py send <scenario> [turn] [--lane N] [--say TEXT]   send that turn's message in the scenario's chat
  live.py watch                                            every scenario: running or ended, rounds, cost, a question on screen
  live.py rounds <scenario> [--turn N] [--wide]            what a reply did, round by round
  live.py tell <scenario> answer|skip|note|stop [TEXT]     act in the window while a reply runs
  live.py kill <scenario>                                  end the window as a crash would
  live.py reset <scenario>                                 forget a scenario's run, to send it afresh
  live.py check <scenario> [turn]                          the hidden check, on a copy of the chat's folder
  live.py selftest [scenario]                              every check fails on the start files, passes on the solution
  live.py table                                            scores, rounds, tokens and cost per scenario and turn
  live.py auto <lane> <scenario> [<scenario> ...]          a repeat pass: every turn sent, noted, answered and checked
                                                           as the scenario says; read the failures by hand after

A first pass is driven by hand: send, watch, read the rounds, answer. `auto` is for running the set again on
another build or model, in a rig of its own (another LIVE_ROOT).

Environment: LIVE_ROOT (the rig's folder, short path), LIVE_EXE (the app to drive), LIVE_MODEL, LIVE_EFFORT,
LIVE_BUDGET (dollars a chat), OPENROUTER_API_KEY.
"""
import ctypes, hashlib, json, os, re, shutil, subprocess, sys, time, uuid
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCENARIOS = HERE / "scenarios"
ROOT = Path(os.environ.get("LIVE_ROOT", "C:/Windows/TEMP/claude/lv"))
EXE = Path(os.environ.get("LIVE_EXE", ROOT / "apim-live.exe"))
SETTINGS = {"model": os.environ.get("LIVE_MODEL", "glm-5.3-flash"), "effort": os.environ.get("LIVE_EFFORT", "high"), "approval": "auto", "budget_usd": float(os.environ.get("LIVE_BUDGET", "0.4")), "lessons_enabled": False}
# LIVE_MODEL=custom:<openrouter slug> runs a model the app's own list does not have.
if SETTINGS["model"].startswith("custom:"):
    SETTINGS["custom_models"] = [{"api_model": SETTINGS["model"][7:], "label": SETTINGS["model"][7:], "context_length": 200_000, "max_output_tokens": 32_000}]
# Not the work itself: what the app and the tools leave behind.
LEFTOVERS = {".outputs", ".snapshots", "__pycache__", ".pytest_cache", ".git", "node_modules"}

K = ctypes.windll.kernel32
K.CreateFileW.restype = K.OpenProcess.restype = wintypes.HANDLE
K.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
K.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
for f in (K.QueryFullProcessImageNameW, K.GetExitCodeProcess, K.TerminateProcess, K.CloseHandle):
    f.argtypes = None


def rm(path):
    """Deletes a folder even when a file in it is read-only."""
    if Path(path).exists():
        shutil.rmtree(path, onerror=lambda fn, p, _: (os.chmod(p, 0o666), fn(p)))


def read_shared(path):
    """Reads a file the app may be renaming over this very moment: every sharing right, or its save would fail."""
    import msvcrt
    h = K.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x80, None)
    if h is None or h == wintypes.HANDLE(-1).value:
        return None
    with os.fdopen(msvcrt.open_osfhandle(h, os.O_RDONLY), "rb") as f:
        return f.read()


def image(pid):
    """The program a process id runs, when it is still running."""
    h = K.OpenProcess(0x1000, False, pid)
    if not h:
        return None
    buf, n, code = ctypes.create_unicode_buffer(520), wintypes.DWORD(520), wintypes.DWORD()
    ok = K.QueryFullProcessImageNameW(wintypes.HANDLE(h), 0, buf, ctypes.byref(n))
    K.GetExitCodeProcess(wintypes.HANDLE(h), ctypes.byref(code))
    K.CloseHandle(wintypes.HANDLE(h))
    return buf.value if ok and code.value == 259 else None


def alive(st):
    return bool(st.get("pid")) and Path(image(st["pid"]) or "x").name.lower() == EXE.name.lower()


def state_path(name):
    return ROOT / "state" / f"{name}.json"


def load(name):
    p = state_path(name)
    return json.loads(p.read_text("utf-8")) if p.exists() else None


def save(name, st):
    state_path(name).parent.mkdir(parents=True, exist_ok=True)
    state_path(name).write_text(json.dumps(st, indent=1), "utf-8")


def scenario(name):
    return json.loads((SCENARIOS / name / "scenario.json").read_text("utf-8"))


def manifest(folder):
    out = {}
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file() and not LEFTOVERS & set(p.relative_to(folder).parts):
            out[p.relative_to(folder).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def chat_of(st):
    """The chat's record as it is on disk now (the app may have renamed its folder after the title)."""
    for p in (Path(st["data"]) / "chats").glob("*/chat.json"):
        raw = read_shared(p)
        try:
            chat = json.loads(raw) if raw else None
        except ValueError:
            chat = None
        if chat and chat.get("id") == st["chat"]:
            return chat
    return None


def send(name, turn=None, lane=1, say=None):
    sc, st = scenario(name), load(name)
    if st is None:
        data, ws = ROOT / f"lane{lane}" / "data", ROOT / f"lane{lane}" / "ws" / name
        rm(ws)
        shutil.copytree(SCENARIOS / name / "files", ws)
        (data / "chats" / name).mkdir(parents=True, exist_ok=True)
        if not (data / "settings.json").exists():
            (data / "settings.json").write_text(json.dumps(SETTINGS), "utf-8")
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        st = {"chat": str(uuid.uuid4()), "data": str(data), "ws": str(ws), "turn": 0, "pid": None, "turns": {}}
        (data / "chats" / name / "chat.json").write_text(json.dumps({"id": st["chat"], "title": name, "archived": False, "createdAt": now, "updatedAt": now, "messages": [], "desktop": {"folder": str(ws)}}), "utf-8")
    if alive(st):
        sys.exit(f"{name}: a reply is still running (pid {st['pid']})")
    turn = turn or st["turn"] + 1
    text = say or sc["turns"][turn - 1]["say"]
    side = ROOT / "state" / name
    side.mkdir(parents=True, exist_ok=True)
    (side / f"before-{turn}.json").write_text(json.dumps(manifest(st["ws"])), "utf-8")
    env = dict(os.environ, APIM_DATA_DIR=st["data"], APIM_SHOT=str(side / f"turn-{turn}.png"), APIM_SHOT_STATE=os.environ.get("LIVE_STATE", "send,calm,workspace"), APIM_SHOT_CHAT=st["chat"], APIM_SHOT_DRAFT=text, APIM_SHOT_INBOX=str(side / "inbox.txt"), NO_COLOR="1")
    log = open(side / f"turn-{turn}.log", "wb")
    flags = 0x00000008 | 0x00000200  # detached, its own group: it outlives this script
    try:
        p = subprocess.Popen([str(EXE)], env=env, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags | 0x01000000)
    except OSError:
        p = subprocess.Popen([str(EXE)], env=env, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=flags)
    st.update(turn=turn, pid=p.pid)
    st["turns"][str(turn)] = {"said": text, "started": time.time()}
    save(name, st)
    print(f"{name} turn {turn}: sent, pid {p.pid}")


def replies(chat):
    """(question, reply) pairs: each user message that is not a note, with the assistant message after it."""
    out, asked = [], None
    for m in chat.get("messages", []):
        if m.get("role") == "user" and not m.get("note"):
            asked = m
        elif m.get("role") == "assistant" and asked is not None:
            out.append((asked, m))
            asked = None
    if asked is not None:
        out.append((asked, None))
    return out


def cut(text, n):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def priced(reply):
    """The endpoint's prices, when this reply is the one the app named them in."""
    notice = next((s.get("text", "") for s in (reply or {}).get("timeline") or [] if s.get("kind") == "notice" and "per million" in s.get("text", "")), "")
    found = re.search(r"\$([\d.]+) in, \$([\d.]+) cached, \$([\d.]+) out", notice)
    return tuple(map(float, found.groups())) if found else None


def figures(reply, rates=None):
    """Tokens of a reply, and what they cost at `rates` (dollars a million: in, cached, out)."""
    u = (reply or {}).get("usage") or {}
    f = {"in": u.get("prompt_tokens", 0), "out": u.get("completion_tokens", 0), "cached": u.get("prompt_cache_hit_tokens", 0), "cost": 0.0}
    if rates:
        f["cost"] = ((f["in"] - f["cached"]) * rates[0] + f["cached"] * rates[1] + f["out"] * rates[2]) / 1e6
    return f


def watch():
    for p in sorted((ROOT / "state").glob("*.json")):
        name, st = p.stem, json.loads(p.read_text("utf-8"))
        chat = chat_of(st) or {}
        pairs = replies(chat)
        reply = pairs[-1][1] if pairs else None
        tools = (reply or {}).get("toolEvents") or []
        waiting = [t for t in tools if t.get("ok") is None]
        line = f"{name:28} turn {st['turn']} {'RUNNING' if alive(st) else 'ended  '} {int(time.time() - st['turns'][str(st['turn'])]['started']):5}s tools {len(tools):3} failed {sum(t.get('ok') is False for t in tools):2}"
        if reply and reply.get("error"):
            line += " ERROR " + cut(reply["error"], 90)
        if alive(st) and waiting and waiting[-1].get("name") == "ask_user":
            line += " ASKS " + cut(waiting[-1].get("args", ""), 200)
        elif tools:
            line += " | " + tools[-1].get("name", "") + " " + cut(tools[-1].get("summary") or tools[-1].get("args", ""), 70)
        print(line)


def rounds(name, turn=None, wide=False):
    st = load(name)
    chat = chat_of(st)
    pairs = replies(chat)
    asked, reply = pairs[(turn or len(pairs)) - 1]
    n = 400 if wide else 150
    print("USER:", cut(asked.get("content", ""), 300))
    if reply is None:
        return print("(no reply yet)")
    tools = {t["id"]: t for t in reply.get("toolEvents") or []}
    for step in reply.get("timeline") or []:
        kind = step.get("kind")
        if kind == "tool":
            t = tools.get(step.get("id"), {})
            mark = {True: "ok ", False: "FAIL", None: "…  "}[t.get("ok")]
            print(f"  {mark} {t.get('name')} {cut(t.get('args', ''), n)}\n        = {cut(t.get('summary', ''), n)}")
        elif kind == "text":
            print("  SAYS", cut(step.get("text", ""), n * 2))
        elif kind == "notice":
            print("  APP ", cut(step.get("text", ""), n * 2))
        elif kind == "think" and wide:
            print("  THINKS", cut((reply.get("reasoningContent") or "")[step.get("start", 0) : step.get("end", 0)], n * 2))
    for key in ("error", "ending", "incomplete", "usage", "durationMs", "reasoningMs", "contextTokens"):
        if reply.get(key):
            print(f"  [{key}] {cut(json.dumps(reply[key]), 300)}")
    if not reply.get("timeline"):
        print("  SAYS", cut(reply.get("content", ""), 600))
    print("FINAL:", cut(reply.get("content", "")[-700:], 700))


def tell(name, verb, text=""):
    (ROOT / "state" / name).mkdir(parents=True, exist_ok=True)
    (ROOT / "state" / name / "inbox.txt").write_text(f"{verb} {text}".strip(), "utf-8")
    print(f"{name}: told the window to {verb}")


def kill(name):
    st = load(name)
    if not alive(st):
        return print(f"{name}: not running")
    h = K.OpenProcess(1, False, st["pid"])
    K.TerminateProcess(wintypes.HANDLE(h), 1)
    K.CloseHandle(wintypes.HANDLE(h))
    print(f"{name}: killed pid {st['pid']}")


def reset(name):
    """Forgets a scenario's run: its chat, its folder and what was kept about it."""
    st = load(name)
    if st is None:
        return
    if alive(st):
        sys.exit(f"{name}: a reply is still running")
    for p in (Path(st["data"]) / "chats").glob("*/chat.json"):
        if json.loads(read_shared(p) or b"{}").get("id") == st["chat"]:
            rm(p.parent)
    rm(st["ws"])
    rm(ROOT / "state" / name)
    state_path(name).unlink()
    print(f"{name}: forgotten")


def run_check(name, folder, turn, before):
    env = dict(os.environ, LIVE_BEFORE=str(before), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    try:
        r = subprocess.run([sys.executable, str(SCENARIOS / name / "check.py"), str(folder), str(turn)], env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, "the check ran out of time"


def check(name, turn=None):
    st = load(name)
    turn = turn or st["turn"]
    copy = ROOT / "chk" / name
    rm(copy)
    shutil.copytree(st["ws"], copy, ignore=shutil.ignore_patterns(".outputs", ".snapshots", ".git", "node_modules"))
    ok, out = run_check(name, copy, turn, ROOT / "state" / name / f"before-{turn}.json")
    st["turns"][str(turn)].update(passed=ok, score=next((l for l in out.splitlines() if l.startswith("SCORE")), "SCORE ?"))
    save(name, st)
    print(f"{name} turn {turn}: {'PASS' if ok else 'FAIL'}\n{out[-1500:]}")


def selftest(only=None):
    bad = 0
    for folder in sorted(SCENARIOS.iterdir()):
        name = folder.name
        if only and name != only or not (folder / "scenario.json").exists():
            continue
        sc, tmp = scenario(name), ROOT / "self" / name
        rm(tmp)
        shutil.copytree(folder / "files", tmp)
        for turn, said in enumerate(sc["turns"], 1):
            before = ROOT / "self" / f"{name}-before-{turn}.json"
            before.write_text(json.dumps(manifest(tmp)), "utf-8")
            untouched, out = run_check(name, tmp, turn, before) if not said.get("noCheck") else (False, "")
            if untouched != bool(said.get("idlePasses")):
                bad += 1
                print(f"BAD  {name} turn {turn}: the check {'passes' if untouched else 'fails'} with nothing done\n{out[-400:]}")
            overlay = folder / "solution" / str(turn)
            if overlay.exists():
                for gone in (overlay / "DELETE").read_text("utf-8").split() if (overlay / "DELETE").exists() else []:
                    target = tmp / gone
                    shutil.rmtree(target) if target.is_dir() else target.unlink(missing_ok=True)
                shutil.copytree(overlay, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("DELETE", "APPLY.py"))
                if (overlay / "APPLY.py").exists():
                    subprocess.run([sys.executable, str(overlay / "APPLY.py"), str(tmp)], check=True)
            solved, out = run_check(name, tmp, turn, before) if not said.get("noCheck") else (True, "")
            if not solved:
                bad += 1
                print(f"BAD  {name} turn {turn}: the check fails on the solution\n{out[-800:]}")
            else:
                print(f"ok   {name} turn {turn}")
    sys.exit(1 if bad else 0)


def table():
    """Every reply, oldest first within its lane: a lane's prices are the ones its newest notice named."""
    rows = []
    for p in sorted((ROOT / "state").glob("*.json")):
        name, st = p.stem, json.loads(p.read_text("utf-8"))
        for i, (asked, reply) in enumerate(replies(chat_of(st) or {}), 1):
            rows.append(((reply or {}).get("createdAt", ""), st["data"], name, i, reply, st))
    rates, lines, total, good, checked, sent, hit = {}, [], 0.0, 0, 0, 0, 0
    for _, lane, name, i, reply, st in sorted(rows, key=lambda r: r[0]):
        rates[lane] = priced(reply) or rates.get(lane)
        f = figures(reply, rates[lane])
        # A reply carried on after a crash is one reply: its check is the later turn's.
        turn = st["turns"].get(str(i), {})
        turn = turn if "passed" in turn or i < len(st["turns"]) - 1 else st["turns"].get(str(st["turn"]), {})
        verdict = "-" if "passed" not in turn else ("PASS " if turn["passed"] else "FAIL ") + turn.get("score", "").replace("SCORE ", "")
        total, sent, hit = total + f["cost"], sent + f["in"], hit + f["cached"]
        good, checked = good + bool(turn.get("passed")), checked + ("passed" in turn)
        lines.append(f"{name:22} {i:2}  {verdict:11} {len((reply or {}).get('toolEvents') or []):4} {sum(t.get('ok') is False for t in (reply or {}).get('toolEvents') or []):4} {f['in']:8} {f['out']:6} {round(100 * f['cached'] / f['in']) if f['in'] else 0:4}% {f['cost']:7.4f} {((reply or {}).get('durationMs') or 0) // 1000:5}")
    print(f"{'scenario':22} turn result      tools fail      in    out cached    cost  secs")
    print("\n".join(sorted(lines)))
    print(f"{good} of {checked} checked turns pass · {sent:,} tokens in, {round(100 * hit / sent) if sent else 0}% from the cache · ${total:.4f} at the endpoints' prices")


def auto(lane, names):
    """One scenario after another in a lane, each turn sent and checked; what the scenario says its user does is done."""
    for name in names:
        sc = scenario(name)
        for turn, said in enumerate(sc["turns"], 1):
            if sc.get("note") and turn == 1:
                tell(name, "note", sc["note"])
            send(name, turn, lane)
            killed = False
            while alive(load(name)):
                time.sleep(4)
                tools = (replies(chat_of(load(name)) or {}) or [(None, None)])[-1][1] or {}
                tools = tools.get("toolEvents") or []
                asking = tools and tools[-1].get("name") == "ask_user" and tools[-1].get("ok") is None
                if asking and not (ROOT / "state" / name / "inbox.txt").exists():
                    tell(name, "answer" if said.get("answer") else "skip", said.get("answer", ""))
                if said.get("killAtTools") and len(tools) >= said["killAtTools"] and not killed:
                    kill(name)
                    killed = True
                if time.time() - load(name)["turns"][str(turn)]["started"] > 60 * sc.get("minutes", 12):
                    kill(name)
                    print(f"{name} turn {turn}: out of time")
            if not said.get("noCheck"):
                check(name, turn)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    def opt(flag, default=None):
        if flag in args:
            i = args.index(flag)
            value = args[i + 1]
            del args[i : i + 2]
            return value
        return default
    lane, say, turn_opt, wide = int(opt("--lane", 1)), opt("--say"), opt("--turn"), "--wide" in args
    args = [a for a in args if a != "--wide"]
    cmd = args[0] if args else "watch"
    if cmd == "send":
        send(args[1], int(args[2]) if len(args) > 2 else None, lane, say)
    elif cmd == "watch":
        watch()
    elif cmd == "rounds":
        rounds(args[1], int(turn_opt) if turn_opt else None, wide)
    elif cmd == "tell":
        tell(args[1], args[2], " ".join(args[3:]))
    elif cmd == "kill":
        kill(args[1])
    elif cmd == "check":
        check(args[1], int(args[2]) if len(args) > 2 else None)
    elif cmd == "reset":
        reset(args[1])
    elif cmd == "selftest":
        selftest(args[1] if len(args) > 1 else None)
    elif cmd == "table":
        table()
    elif cmd == "auto":
        auto(int(args[1]), args[2:])
    else:
        sys.exit(__doc__)
