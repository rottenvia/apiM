import csv

totals = {}
with open("sales.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        totals[row["region"]] = totals.get(row["region"], 0) + int(row["units"]) * round(float(row["unit_price"]) * 100)
ranked = sorted(totals.items(), key=lambda kv: -kv[1])
for region, cents in ranked:
    print(f"{region} {cents / 100:.2f}")
with open("report.md", "w", encoding="utf-8") as out:
    out.write("| Region | Revenue |\n|---|---|\n" + "".join(f"| {region} | {cents / 100:.2f} |\n" for region, cents in ranked))
