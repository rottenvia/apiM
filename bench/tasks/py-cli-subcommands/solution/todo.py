#!/usr/bin/env python3
"""Tiny todo-list CLI.

    python3 todo.py [--db PATH] add TEXT... [--priority low|normal|high]
    python3 todo.py [--db PATH] list [--all] [--priority P]
    python3 todo.py [--db PATH] done ID [ID ...]
    python3 todo.py [--db PATH] remove ID
"""
import argparse
import json
import os
import sys
import tempfile

PRIORITIES = ("low", "normal", "high")


class UserError(Exception):
    pass


def load(path):
    if not os.path.exists(path):
        return {"next_id": 1, "tasks": []}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise UserError(f"cannot read {path}: {e}") from None
    if (not isinstance(data, dict) or not isinstance(data.get("tasks"), list)
            or not isinstance(data.get("next_id"), int)
            or not all(isinstance(t, dict) and {"id", "text", "done", "priority"} <= set(t) for t in data["tasks"])):
        raise UserError(f"{path} is not a todo database")
    return data


def save(path, data):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".todo-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def find(data, task_id):
    for t in data["tasks"]:
        if t["id"] == task_id:
            return t
    raise UserError(f"no task #{task_id}")


def cmd_add(data, args):
    text = " ".join(args.text).strip()
    text = " ".join(text.split())
    if not text:
        raise UserError("task text must not be empty")
    task = {"id": data["next_id"], "text": text, "done": False, "priority": args.priority}
    data["tasks"].append(task)
    data["next_id"] += 1
    print(f"Added #{task['id']}: {text}")
    return True


def cmd_list(data, args):
    shown = [t for t in sorted(data["tasks"], key=lambda t: t["id"])
             if (args.all or not t["done"]) and (args.priority is None or t["priority"] == args.priority)]
    if not shown:
        print("No tasks.")
    for t in shown:
        mark = "x" if t["done"] else " "
        flag = " (!)" if t["priority"] == "high" else ""
        print(f"#{t['id']} [{mark}] {t['text']}{flag}")
    return False


def cmd_done(data, args):
    tasks = [find(data, i) for i in args.ids]  # validate all first
    for t in tasks:
        if t["done"]:
            print(f"#{t['id']} was already done")
        else:
            t["done"] = True
            print(f"Done #{t['id']}")
    return True


def cmd_remove(data, args):
    t = find(data, args.id)
    data["tasks"].remove(t)
    print(f"Removed #{t['id']}: {t['text']}")
    return True


def build_parser():
    p = argparse.ArgumentParser(prog="todo.py", description="A tiny todo list.")
    p.add_argument("--db", default="todo.json", help="JSON file to store tasks in (default: todo.json)")
    sub = p.add_subparsers(dest="command", required=True)
    a = sub.add_parser("add", help="add a task")
    a.add_argument("text", nargs="+")
    a.add_argument("--priority", choices=PRIORITIES, default="normal")
    a.set_defaults(func=cmd_add)
    l = sub.add_parser("list", help="list tasks")
    l.add_argument("--all", action="store_true", help="include done tasks")
    l.add_argument("--priority", choices=PRIORITIES)
    l.set_defaults(func=cmd_list)
    d = sub.add_parser("done", help="mark tasks as done")
    d.add_argument("ids", nargs="+", type=int, metavar="ID")
    d.set_defaults(func=cmd_done)
    r = sub.add_parser("remove", help="remove a task")
    r.add_argument("id", type=int, metavar="ID")
    r.set_defaults(func=cmd_remove)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        data = load(args.db)
        if args.func(data, args):
            save(args.db, data)
    except UserError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
