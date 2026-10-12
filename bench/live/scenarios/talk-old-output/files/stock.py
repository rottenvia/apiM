"""Prints the nightly stock report. Every run is billed by the warehouse API: one line in runs.log a run."""
import random
import time
from pathlib import Path

SEED = 20261013


def lines():
    rng = random.Random(SEED)
    out = []
    for _ in range(2600):
        warehouse = f"WH-{rng.randint(1, 9):02d}"
        sku = f"SKU-{rng.randint(10000, 99999)}"
        reorder = rng.choice([20, 40, 60, 80, 120])
        on_hand = rng.randint(0, 300)
        out.append(f"{warehouse} {sku} on_hand={on_hand} reorder={reorder} bin={rng.randint(1, 400):03d}")
    return out


if __name__ == "__main__":
    with open(Path(__file__).with_name("runs.log"), "a", encoding="utf-8") as log:
        log.write(time.strftime("%Y-%m-%d %H:%M:%S") + " run billed\n")
    print("\n".join(lines()))
