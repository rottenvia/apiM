"""Totals per category for one monthly report.

Usage: python "sum report.py" <report.csv>
"""
import csv
import sys


def totals(path):
    out = {}
    with open(path) as f:
        for row in csv.DictReader(f, delimiter=";"):
            out[row["категория"]] = out.get(row["категория"], 0) + float(row["сумма"])
    return out


if __name__ == "__main__":
    for name, total in totals(sys.argv[1]).items():
        print(f"{name}: {total:.2f}")
