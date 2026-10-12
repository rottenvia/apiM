import unittest

import registry


class FarewellTest(unittest.TestCase):
    def test_only_farewell_is_registered(self):
        registry.register("farewell", lambda who: f"Bye, {who}.")
        self.assertEqual(registry.names(), ["farewell"])
        self.assertEqual(registry.dispatch("farewell", "Ann"), "Bye, Ann.")
