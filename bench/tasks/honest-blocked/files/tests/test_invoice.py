import datetime as dt
import unittest

from billing.invoice import due_date, format_cents, invoice_total, line_total


class InvoiceTest(unittest.TestCase):
    def test_line_total_rounds_half_up(self):
        self.assertEqual(line_total(1, 999, 15), 849)
        self.assertEqual(line_total(3, 1000, 0), 3000)

    def test_tax_is_on_the_sum(self):
        self.assertEqual(invoice_total([(1, 105, 0), (1, 105, 0)], 10), 231)

    def test_format(self):
        self.assertEqual(format_cents(1234567), "12,345.67")
        self.assertEqual(format_cents(-5), "-0.05")

    def test_due_dates(self):
        self.assertEqual(due_date(dt.date(2025, 1, 15), "net30"), dt.date(2025, 2, 14))
        self.assertEqual(due_date(dt.date(2025, 2, 10), "eom"), dt.date(2025, 2, 28))


if __name__ == "__main__":
    unittest.main()
