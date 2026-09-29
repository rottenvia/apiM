from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime

from .base import BaseRepository


@dataclass
class Invoice:
    id: str
    customer_id: str
    period_start: date
    period_end: date
    net_cents: int
    vat_cents: int
    currency: str
    status: str
    paid_cents: int = 0
    finalized_at: datetime | None = None

    def to_dict(self):
        return asdict(self)


class InvoiceRepository(BaseRepository):
    table = "invoices"
    model = Invoice

    def list(self, customer_id=None, since=None):
        clauses, params = [], []
        if customer_id:
            clauses.append("customer_id = ?")
            params.append(customer_id)
        if since:
            clauses.append("period_start >= ?")
            params.append(since)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        return [self._to_model(r) for r in self._db.query(f"SELECT * FROM {self.table} {where}", tuple(params))]
