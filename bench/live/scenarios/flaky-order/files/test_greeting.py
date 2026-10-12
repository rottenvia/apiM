import unittest

import registry


class GreetingTest(unittest.TestCase):
    def test_greeting(self):
        registry.register("greet", lambda who: f"Hello, {who}!")
        self.assertEqual(registry.dispatch("greet", "Ann"), "Hello, Ann!")
