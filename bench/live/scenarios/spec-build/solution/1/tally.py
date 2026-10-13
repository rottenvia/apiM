"""A time log in tally.json. See SPEC.md."""
import argparse, csv, datetime, json, os, re, sys

FILE = "tally.json"


class Bad(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Bad(message)


def load():
    if not os.path.exists(FILE):
        return {"next": 1, "entries": []}
    with open(FILE, encoding="utf-8") as f:
        return json.load(f)


def save(log):
    with open(FILE + ".tmp", "w", encoding="utf-8") as f:
        json.dump(log, f, indent=1)
    os.replace(FILE + ".tmp", FILE)


def minutes(text):
    m = re.fullmatch(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?", text)
    if not m or not (m.group(1) or m.group(2)):
        raise Bad(f"not a duration: {text}")
    total = float(m.group(1) or 0) * 60 + int(m.group(2) or 0)
    if total != int(total) or not 0 < total <= 24 * 60:
        raise Bad(f"not a duration: {text}")
    return int(total)


def day(text):
    try:
        return datetime.date.fromisoformat(text).isoformat()
    except ValueError:
        raise Bad(f"not a date: {text}")


def hmm(m):
    return f"{m // 60}:{m % 60:02d}"


def chosen(log, a):
    out = [e for e in log["entries"] if (not a.frm or e["date"] >= day(a.frm)) and (not a.to or e["date"] <= day(a.to)) and (not getattr(a, "tag", None) or a.tag.lower() in e["tags"])]
    return sorted(out, key=lambda e: (e["date"], e["id"]))


def main(argv):
    p = Parser(prog="tally")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("duration"); a.add_argument("text"); a.add_argument("--date"); a.add_argument("--tag", action="append", default=[])
    for name in ("list", "sum"):
        s = sub.add_parser(name); s.add_argument("--from", dest="frm"); s.add_argument("--to")
        s.add_argument("--tag") if name == "list" else s.add_argument("--by", choices=["tag", "date"])
    sub.add_parser("rm").add_argument("id")
    sub.add_parser("export").add_argument("file")
    a = p.parse_args(argv)
    log = load()
    if a.cmd == "add":
        entry = {"id": log["next"], "date": day(a.date) if a.date else datetime.date.today().isoformat(), "minutes": minutes(a.duration), "text": a.text, "tags": sorted({t.lower() for t in a.tag})}
        log["entries"].append(entry); log["next"] += 1
        save(log)
        print(f"added {entry['id']}")
    elif a.cmd == "list":
        rows = chosen(log, a)
        for e in rows:
            print(f"{e['id']}  {e['date']}  {hmm(e['minutes'])}  {e['text']}" + (f"  [{','.join(e['tags'])}]" if e["tags"] else ""))
        if not rows:
            print("nothing logged")
    elif a.cmd == "sum":
        rows = chosen(log, a)
        groups = {}
        for e in rows:
            for key in ([e["date"]] if a.by == "date" else (e["tags"] or ["(none)"]) if a.by == "tag" else []):
                groups[key] = groups.get(key, 0) + e["minutes"]
        for key in sorted(groups, key=lambda k: (k == "(none)", k)):
            print(key, hmm(groups[key]))
        print("total", hmm(sum(e["minutes"] for e in rows)))
    elif a.cmd == "rm":
        keep = [e for e in log["entries"] if str(e["id"]) != a.id]
        if len(keep) == len(log["entries"]):
            raise Bad(f"no entry {a.id}")
        log["entries"] = keep
        save(log)
        print(f"removed {a.id}")
    elif a.cmd == "export":
        rows = chosen(log, argparse.Namespace(frm=None, to=None, tag=None))
        with open(a.file, "w", newline="", encoding="utf-8") as f:
            out = csv.writer(f)
            out.writerow(["id", "date", "minutes", "text", "tags"])
            out.writerows([e["id"], e["date"], e["minutes"], e["text"], " ".join(e["tags"])] for e in rows)
        print(f"exported {len(rows)}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Bad as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
