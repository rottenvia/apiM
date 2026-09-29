from __future__ import annotations

from .models import Product


class UnknownProduct(KeyError):
    pass


class Catalog:
    def __init__(self, products: list[Product] = ()):
        self._products = {p.sku: p for p in products}

    def add(self, product: Product) -> None:
        self._products[product.sku] = product

    def get(self, sku: str) -> Product:
        try:
            return self._products[sku]
        except KeyError:
            raise UnknownProduct(sku) from None

    def __contains__(self, sku: str) -> bool:
        return sku in self._products


def demo_catalog() -> Catalog:
    return Catalog([
        Product("BK-001", "The Pragmatic Gardener", 2499, "books"),
        Product("BK-002", "Soup for Programmers", 1850, "books"),
        Product("BK-003", "A Short History of Tea", 999, "books"),
        Product("ST-001", "Notebook A5, dotted", 450, "stationery"),
        Product("ST-002", "Gel pen, black", 199, "stationery"),
        Product("EL-001", "USB-C cable 2m", 1299, "electronics"),
        Product("EL-002", "Desk lamp", 4599, "electronics"),
    ])
