from collections import namedtuple

StockItem = namedtuple("StockItem", "sku name on_hand reorder_point pack_size")
Order = namedtuple("Order", "id status lines")  # lines: list of (sku, qty)
Restock = namedtuple("Restock", "sku remaining units")
