# restock

Works out what to re-order for the shop's warehouse.

    python3 restock.py data/stock.csv data/orders.jsonl

## Inputs

`stock.csv` columns: `sku,name,on_hand,reorder_point,pack_size`.
A blank `pack_size` means the item is bought individually (packs of 1).

`orders.jsonl` has one JSON object per line:

    {"id": "SO-1", "status": "shipped", "lines": [{"sku": "A-100", "qty": 2}]}

`status` is one of `open`, `shipped`, `cancelled`. A line without `qty`
means 1. SKU codes are case-insensitive and are sometimes typed with stray
spaces around them; `a-100 ` and `A-100` are the same product.

## Rules

* Cancelled orders are ignored; every other order uses up stock.
* `remaining = on_hand - units ordered` (it can go negative).
* An item needs restocking when `remaining <= reorder_point`. We then order
  enough whole packs to bring it up to at least `2 * reorder_point`:
  `packs = ceil((2 * reorder_point - remaining) / pack_size)`,
  `order = packs * pack_size` units.
* Order lines for SKUs that are not in the stock file are reported as
  unknown, with the total units ordered.

## Output

One line per item that needs restocking, sorted by SKU:

    B-220 remaining=3 order=7

followed by one line per unknown SKU, sorted by SKU:

    UNKNOWN Z-999 4

SKUs are always printed upper-case. If there is nothing to report the
program prints `nothing to restock`.
