from shopkit.reports.monthly import revenue_by_region
from shopkit.util.money import fmt

by_region = revenue_by_region("data/orders-2026-03.csv")
for region in sorted(by_region):
    print(region, fmt(by_region[region]))
print("total", fmt(sum(by_region.values())))
