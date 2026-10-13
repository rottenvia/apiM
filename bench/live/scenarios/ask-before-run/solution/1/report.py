"""Prints the stock table."""
import csv


def render(header, rows):
    table = [list(header)] + [list(r) for r in rows]
    width = [max(len(r[i]) for r in table) for i in range(len(header))]
    numeric = [all(r[i].replace(".", "", 1).isdigit() for r in rows) for i in range(len(header))]
    line = lambda r: "  ".join(c.rjust(width[i]) if numeric[i] else c.ljust(width[i]) for i, c in enumerate(r)).rstrip()
    return "\n".join([line(table[0]), "  ".join("-" * n for n in width)] + [line(r) for r in table[1:]])


with open("stock.csv", newline="", encoding="utf-8") as f:
    rows = list(csv.reader(f))
print(render(rows[0], rows[1:]))
