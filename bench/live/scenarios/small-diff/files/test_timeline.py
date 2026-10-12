import unittest

from timeline import busiest_day, gaps, parse, window

EVENTS = [{"name": "a", "at": 100}, {"name": "b", "at": 200}, {"name": "c", "at": 300}]


class TimelineTest(unittest.TestCase):
    def test_window_includes_both_ends(self):
        self.assertEqual([e["name"] for e in window(EVENTS, 100, 300)], ["a", "b", "c"])

    def test_parse(self):
        self.assertEqual(parse("1970-01-02 00:01"), 86460)

    def test_gaps(self):
        self.assertEqual(gaps(EVENTS, 100), [("a", "b"), ("b", "c")])

    def test_busiest_day(self):
        self.assertEqual(busiest_day(EVENTS + [{"name": "d", "at": 86400}]), 0)
