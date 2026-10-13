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

    def test_renew_twice_and_no_more(self):
        state = fresh()
        core.lend(state, "b1", "m1", date(2026, 3, 1))
        core.renew(state, "b1")
        self.assertEqual(core.renew(state, "b1")["due"], "2026-04-12")
        with self.assertRaises(core.LoanError):
            core.renew(state, "b1")

    def test_return_of_a_book_that_is_not_out(self):
        with self.assertRaises(core.LoanError):
            core.give_back(fresh(), "b1", date(2026, 3, 5))

    def test_a_fourth_book_is_refused(self):
        state = fresh()
        for n in (3, 4):
            core.add_book(state, f"b{n}", "More", 500)
        for n in (1, 2, 3):
            core.lend(state, f"b{n}", "m1", date(2026, 3, 1))
        with self.assertRaises(core.LoanError):
            core.lend(state, "b4", "m1", date(2026, 3, 1))


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
