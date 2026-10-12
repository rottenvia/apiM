import unittest

import registry


class _Clean(unittest.TestCase):
    def setUp(self):
        registry.clear()
        self.addCleanup(registry.clear)


class NamesTest(_Clean):
    def test_names_are_sorted(self):
        self.assertEqual(registry.names(), sorted(registry.names()))

    def test_unknown_name(self):
        self.assertRaises(KeyError, registry.dispatch, "no-such-handler")
