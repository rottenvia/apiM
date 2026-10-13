"""Imports the card file of the old system. Frozen: the archive team runs it exactly as it is."""
import csv
import json
import sys


def convert(row):
    return {"title": row["TITLE"].strip(), "price_cents": int(float(row["PRICE"]) * 100)}


if __name__ == "__main__":
    json.dump([convert(row) for row in csv.DictReader(open(sys.argv[1], newline=""))], sys.stdout, indent=1)
