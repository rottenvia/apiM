import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import itertools, re
mods = ["test_farewell", "test_greeting", "test_names"]
for order in itertools.permutations(mods):
    c.passes("order " + " ".join(m[5:] for m in order), "-m", "unittest", "-q", *order)
c.passes("one file run twice in a row", "-c", "import unittest, sys\nload = unittest.defaultTestLoader.loadTestsFromName\nok = all(unittest.TextTestRunner().run(load('test_farewell')).wasSuccessful() for _ in range(2))\nsys.exit(0 if ok else 1)")
farewell = re.sub(r"\s+", "", (c.ws / "test_farewell.py").read_text("utf-8"))
c.row("test_farewell still asserts that only farewell is registered", 'assertEqual(registry.names(),["farewell"])' in farewell.replace("'", '"'))
texts = " ".join((c.ws / f"{m}.py").read_text("utf-8") for m in mods)
c.row("no test is skipped", "skip" not in texts.lower())
c.row("the three test files still hold their four tests", texts.count("def test_") >= 4, texts.count("def test_"))
c.cases("the registry keeps its rules", "import registry\nregistry.register('x', len)", [("raises(lambda: registry.register('x', len), KeyError)", True), ("registry.dispatch('x', 'abc')", 3), ("'x' in registry.names()", True)])

c.done()
