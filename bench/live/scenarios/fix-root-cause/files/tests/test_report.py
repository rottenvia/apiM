import unittest

from ledger import report, store


class ReportTest(unittest.TestCase):
    def setUp(self):
        store.reset()

    def test_one_account(self):
        store.open_account("carol")
        store.post("carol", 250, "refund")
        self.assertEqual(report.statement("carol"), ["refund: 2.50", "balance: 2.50"])

    def test_two_accounts(self):
        store.open_account("alice")
        store.open_account("bob")
        store.post("alice", 5000, "salary")
        store.post("bob", 1200, "gift")
        self.assertEqual(report.balance("alice"), 5000)
        self.assertEqual(report.balance("bob"), 1200)
