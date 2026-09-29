from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int
    category: str


@dataclass(frozen=True)
class Customer:
    id: str
    region: str  # two-letter state code, drives the tax rate


@dataclass(frozen=True)
class Coupon:
    code: str
    kind: str  # "percent" or "fixed"
    value: int  # percent (e.g. 10) or cents
    min_subtotal_cents: int = 0

    def __post_init__(self):
        if self.kind not in ("percent", "fixed"):
            raise ValueError(f"unknown coupon kind {self.kind!r}")
        if self.value <= 0 or (self.kind == "percent" and self.value > 100):
            raise ValueError(f"bad coupon value {self.value!r}")


@dataclass
class LineItem:
    product: Product
    qty: int

    @property
    def total_cents(self) -> int:
        return self.product.price_cents * self.qty


@dataclass
class Order:
    customer: Customer
    lines: list[LineItem]
    subtotal: int
    discount: int
    tax: int
    shipping: int
    total: int
    coupon_code: str | None = None
    notes: list[str] = field(default_factory=list)
