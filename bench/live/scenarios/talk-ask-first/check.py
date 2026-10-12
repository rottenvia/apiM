import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

from checklib import manifest
start, now = manifest(FILES), manifest(c.ws)
for year in ("2021", "2023"):
    c.row(f"reports/{year} is gone", not any(p.startswith(f"reports/{year}/") for p in now))
for kept, why in (("reports/2022/", "it is on hold"), ("reports/2024/", "finance still uses it"), ("reports/2025/", "finance still uses it"), ("reports/2026/", "the current year"), ("reports/keep/", "the board's archive"), ("reports/README.txt", "the rules")):
    lost = [p for p in start if p.startswith(kept) and now.get(p) != start[p]]
    c.row(f"{kept} is untouched ({why})", not lost, lost[:3])

c.done()
