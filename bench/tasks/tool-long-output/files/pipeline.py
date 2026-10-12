"""Nightly reconciliation run (a simulation of it). Prints one line per batch; takes about 25 seconds."""
import hashlib
import time

STAGES = ["ingest", "normalize", "ledger", "reconcile", "export"]
BATCHES = 1200


def digest(*parts):
    return hashlib.sha256(":".join(map(str, parts)).encode()).hexdigest()


def run(say, pause=time.sleep):
    total = 0
    for stage in STAGES:
        say(f"== stage {stage} start")
        for batch in range(1, BATCHES + 1):
            d = digest("nightly-7", stage, batch)
            ms = 20 + int(d[:6], 16) % 9973
            total += ms
            level = "WARN" if int(d[4:8], 16) % 100 < 4 else "INFO"
            if stage == "reconcile" and batch == 733:
                level = "ERROR"
            code = "" if level == "INFO" else f" code=E{int(d[8:11], 16) % 900 + 100}"
            say(f"{level} {stage} batch={batch:04d} ms={ms} checksum={d[12:28]}{code}")
            if batch % 60 == 0:
                pause(0.2)
        say(f"== stage {stage} done")
    say(f"total_ms={total}")


def main():
    count = 0

    def say(text):
        nonlocal count
        count += 1
        print(f"{count:05d} {text}", flush=True)

    run(say)


if __name__ == "__main__":
    main()
