import unittest
from datetime import date, timedelta

from loans import core


def fresh():
    state = {"books": {}, "members": {}, "loans": []}
    core.add_book(state, "b1", "Dune", 1250)
    core.add_book(state, "b2", "Emma", 800)
    core.add_member(state, "m1", "Ada")
    return state


class Lending(unittest.TestCase):
    def test_due_in_two_weeks(self):
        loan = core.lend(fresh(), "b1", "m1", date(2026, 3, 1))
        self.assertEqual(loan["due"], "2026-03-15")

    def test_a_book_is_lent_once(self):
        state = fresh()
        core.lend(state, "b1", "m1", date(2026, 3, 1))
        with self.assertRaises(core.LoanError):
            core.lend(state, "b1", "m1", date(2026, 3, 2))

    def test_return(self):
        state = fresh()
        core.lend(state, "b1", "m1", date(2026, 3, 1))
        self.assertEqual(core.give_back(state, "b1", date(2026, 3, 5))["returned"], "2026-03-05")

    def test_report_lists_what_is_out(self):
        state = fresh()
        core.lend(state, "b1", "m1", date(2026, 3, 1))
        self.assertEqual(core.report(state), ["Dune  m1  due 2026-03-15"])

    def test_report_with_nothing_out(self):
        self.assertEqual(core.report(fresh()), ["no loans"])


class Fines(unittest.TestCase):
    def late(self, state, days):
        loan = core.lend(state, "b2", "m1", date(2026, 3, 1))
        return loan, date(2026, 3, 15) + timedelta(days=days)

    def test_a_quarter_a_day(self):
        state = fresh()
        loan, today = self.late(state, 3)
        self.assertEqual(core.fine_cents(loan, state, today), 75)

    def test_never_more_than_the_price(self):
        state = fresh()
        loan, today = self.late(state, 60)
        self.assertEqual(core.fine_cents(loan, state, today), 800)

    def test_nothing_when_on_time(self):
        state = fresh()
        loan, today = self.late(state, 0)
        self.assertEqual(core.fine_cents(loan, state, today), 0)


if __name__ == "__main__":
    unittest.main()
