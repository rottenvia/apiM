"""Runs the test files in one process, in a shuffled order, as the CI server does: python ci.py [--seed N]"""
import random
import sys
import unittest
from pathlib import Path

seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else random.randrange(10_000)
modules = sorted(path.stem for path in Path(__file__).parent.glob("test_*.py"))
random.Random(seed).shuffle(modules)
print(f"seed {seed}: {' '.join(modules)}")
suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(name) for name in modules)
sys.exit(0 if unittest.TextTestRunner().run(suite).wasSuccessful() else 1)
