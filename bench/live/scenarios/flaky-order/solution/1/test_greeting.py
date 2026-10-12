import unittest

import registry


class _Clean(unittest.TestCase):
    def setUp(self):
        registry.clear()
        self.addCleanup(registry.clear)


class GreetingTest(_Clean):
    def test_greeting(self):
        registry.register("greet", lambda who: f"Hello, {who}!")
        self.assertEqual(registry.dispatch("greet", "Ann"), "Hello, Ann!")
