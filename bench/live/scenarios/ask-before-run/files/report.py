"""Prints the stock table."""
import csv

from tablekit import render

with open("stock.csv", newline="", encoding="utf-8") as f:
    rows = list(csv.reader(f))
print(render(rows[0], rows[1:]))
