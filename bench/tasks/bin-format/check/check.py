import hashlib, json, os, shutil, struct, subprocess, sys, zlib


def blob(seed, size):
    out = b""
    n = 0
    while len(out) < size:
        out += hashlib.sha256(f"{seed}:{n}".encode()).digest()
        n += 1
    return out[:size]


def build(entries, corrupt=None):
    """entries: (name, content, flags). Returns the archive bytes; the entry named `corrupt` gets one stored byte flipped."""
    stored = []
    for index, (name, content, flags) in enumerate(entries):
        data = zlib.compress(content, 9) if flags & 2 else content
        if flags & 1:
            key = (index * 31 + 7) & 0xFF
            data = bytes(b ^ key for b in data)
        if name == corrupt:
            data = data[:3] + bytes([data[3] ^ 0x5A]) + data[4:]
        stored.append(data)
    table = sum(1 + len(name.encode("utf-8")) + 13 for name, _, _ in entries)
    offset = 10 + table
    head = b"PAK1" + struct.pack("<HI", 2, len(entries))
    for (name, content, flags), data in zip(entries, stored):
        raw = name.encode("utf-8")
        head += struct.pack("<B", len(raw)) + raw + struct.pack("<IIIB", offset, len(data), zlib.crc32(content), flags)
        offset += len(data)
    return head + b"".join(stored)


def public_entries():
    text = lambda s: s.encode("utf-8")
    return [
        ("readme.txt", text("Field archive, season 4.\nSee notes/ for the survey logs.\n"), 0),
        ("notes/day-01.txt", text("Day 1. Set up camp by the river. " * 40), 2),
        ("notes/day-02.txt", text("Day 2. Rain. Counted 14 herons before noon.\n" * 25), 3),
        ("notes/secret.txt", text("  The cache is under the third pine: 61.7812N 34.3644E  \n"), 3),
        ("notes/заметки.txt", text("Комары. Очень много комаров.\n" * 12), 1),
        ("data/readings.bin", blob("readings", 3000), 0),
        ("data/grid.bin", blob("grid", 5000), 2),
        ("data/samples.csv", text("id;depth;temp\n" + "".join(f"{i};{i * 3 % 17};{(i * 7) % 23}.5\n" for i in range(200))), 3),
        ("img/thumb.raw", blob("thumb", 1024), 1),
        ("empty.txt", b"", 0),
        ("data/calib.bin", blob("calib", 640), 1),
        ("log/trail.log", text("".join(f"step {i} ok\n" for i in range(300))), 2),
    ]


def hidden_entries():
    text = lambda s: s.encode("utf-8")
    return [
        ("a.txt", text("alpha\n"), 1),
        ("deep/er/b.bin", blob("hidden-b", 2222), 3),
        ("deep/c.txt", text("gamma " * 500), 2),
        ("пример.txt", text("пример\n"), 3),
        ("zero.bin", b"", 2),
        ("d.bin", blob("hidden-d", 777), 0),
        ("deep/e.bin", blob("hidden-e", 4096), 1),
    ]


if __name__ == "__main__":
    checks = []
    try:
        got = json.load(open("answers.json", encoding="utf-8"))
    except Exception as e:
        print(f"answers.json: {e}")
        got = {}
    checks.append(("answers.json counts the entries", got.get("entries") == 12))
    checks.append(("answers.json names the one corrupt entry", got.get("corrupt") in (["data/readings.bin"], "data/readings.bin")))
    checks.append(("answers.json has the secret text", str(got.get("secret", "")).strip() == "The cache is under the third pine: 61.7812N 34.3644E"))
    # The tool itself, on an archive it has never seen.
    entries = hidden_entries()
    with open(".bench_check/hidden.pak", "wb") as f:
        f.write(build(entries, corrupt="deep/e.bin"))
    shutil.rmtree(".bench_check/out", ignore_errors=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        run = subprocess.run([sys.executable, "unpak.py", os.path.join(".bench_check", "hidden.pak"), os.path.join(".bench_check", "out")], capture_output=True, timeout=60, env=env)
        ran, err = run.returncode in (0, 1), run.stderr.decode("utf-8", "replace")[-400:]
    except Exception as e:
        ran, err = False, str(e)
    if not ran:
        print(err)
    checks.append(("unpak.py runs on another archive", ran))
    for name, content, _ in entries:
        path = os.path.join(".bench_check", "out", *name.split("/"))
        if name == "deep/e.bin":
            # Written although its checksum is wrong: the bytes that are there, not the original.
            checks.append((f"extracted {name} (the corrupt one is still written)", os.path.isfile(path) and len(open(path, "rb").read()) == len(content)))
        else:
            checks.append((f"extracted {name}", os.path.isfile(path) and open(path, "rb").read() == content))
    for label, ok in checks:
        if not ok:
            print(f"FAIL {label}")
    good = sum(1 for _, ok in checks if ok)
    print(f"SCORE {good}/{len(checks)}")
    sys.exit(0 if good == len(checks) else 1)
