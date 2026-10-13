"""python make_export.py [rows] [seed]: writes export.csv, shaped like the real customer export."""
import csv
import random
import sys

rows = int(sys.argv[1]) if len(sys.argv) > 1 else 300
rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
domains = ["gmail.com", "googlemail.com", "example.org", "mail.test", "corp.example"]
people = []
with open("export.csv", "w", newline="", encoding="utf-8") as f:
    out = csv.writer(f)
    out.writerow(["id", "email", "name"])
    for i in range(rows):
        if people and rng.random() < 0.06:
            local, domain = rng.choice(people)
            if domain in ("gmail.com", "googlemail.com"):
                domain = rng.choice(["gmail.com", "googlemail.com"])
                if len(local) > 3 and rng.random() < 0.5:
                    cut = rng.randint(1, len(local) - 1)
                    local = local[:cut] + "." + local[cut:]
            if rng.random() < 0.4:
                local += "+" + rng.choice(["shop", "news", "x"])
            email = (local + "@" + domain).upper() if rng.random() < 0.2 else local + "@" + domain
        else:
            local, domain = f"user{i}x{rng.randint(10, 99)}", rng.choice(domains)
            people.append((local, domain))
            email = local + "@" + domain
        out.writerow([i, " " + email if rng.random() < 0.05 else email, f"Customer {i}"])
