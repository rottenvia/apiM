import unittest
from datetime import date

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


if __name__ == "__main__":
    unittest.main()
