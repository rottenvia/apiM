from __future__ import annotations

from ..errors import NotFoundError, StateError, ValidationError
from ..repositories.invoice_repo import Invoice
from ..utils.ids import new_id


class BillingService:
    RATE_CENTS_PER_KM = 42

    def __init__(self, invoices, trips, audit, config, clock):
        self._invoices = invoices
        self._trips = trips
        self._audit = audit
        self._currency = config.get("billing.currency")
        self._vat = config.get("billing.vat_rate")
        self._clock = clock

    def list_invoices(self, customer_id=None, since=None):
        return self._invoices.list(customer_id=customer_id, since=since)

    def draft(self, customer_id, start, end, actor):
        if end < start:
            raise ValidationError("period_end before period_start", field="period_end")
        km = self._trips.total_distance(customer_id, start, end)
        net = round(km * self.RATE_CENTS_PER_KM)
        invoice = Invoice(id=new_id("inv"), customer_id=customer_id, period_start=start, period_end=end,
                          net_cents=net, vat_cents=round(net * self._vat), currency=self._currency, status="draft")
        self._invoices.insert(invoice)
        self._audit.record(actor, "invoice.drafted", invoice.id, net_cents=net)
        return invoice

    def _get(self, invoice_id):
        invoice = self._invoices.get(invoice_id)
        if invoice is None:
            raise NotFoundError("invoice", invoice_id)
        return invoice

    def finalize(self, invoice_id, actor):
        invoice = self._get(invoice_id)
        if invoice.status != "draft":
            raise StateError(f"invoice {invoice_id} is {invoice.status}")
        invoice.status, invoice.finalized_at = "final", self._clock.now()
        self._invoices.update(invoice)
        self._audit.record(actor, "invoice.finalized", invoice_id)
        return invoice

    def void(self, invoice_id, reason, actor):
        invoice = self._get(invoice_id)
        if invoice.status == "paid":
            raise StateError("paid invoices cannot be voided")
        invoice.status = "void"
        self._invoices.update(invoice)
        self._audit.record(actor, "invoice.voided", invoice_id, reason=reason)

    def record_payment(self, invoice_id, amount_cents, reference):
        invoice = self._get(invoice_id)
        invoice.paid_cents += amount_cents
        if invoice.paid_cents >= invoice.net_cents + invoice.vat_cents:
            invoice.status = "paid"
        self._invoices.update(invoice)
        self._audit.record("payments", "invoice.payment_recorded", invoice_id, reference=reference)

    def on_trip_completed(self, trip):
        # usage-based customers are billed monthly; nothing to do per trip yet
        return None
