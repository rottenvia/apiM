import csv

from dedupe import find_duplicates

with open("export.csv", newline="", encoding="utf-8") as f:
    records = list(csv.DictReader(f))
pairs = find_duplicates(records)
print(len(pairs), "pairs")
for i, j in pairs[:5]:
    print(records[i]["id"], records[j]["id"])
