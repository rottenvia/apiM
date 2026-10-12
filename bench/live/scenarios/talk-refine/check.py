import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

T1 = [("slugify('Hello, World!')", 'hello-world'), ("slugify('  --A  b__c ')", 'a-b-c'), ("slugify('')", 'untitled'), ("slugify('!!!')", 'untitled'), ("slugify('Rock & Roll 2024')", 'rock-roll-2024'), ("slugify('one')", 'one')]
T2 = [("slugify('the quick brown fox jumps over the lazy dog again and again')", 'the-quick-brown-fox-jumps-over-the-lazy'), ("slugify('a' * 50)", 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ("slugify('a' * 50 + ' b')", 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ("slugify('x' * 38 + ' yy zz')", 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), ("len(slugify('ab ' * 30)) <= 40", True), ("slugify('ab ' * 30).endswith('-')", False), ("unique_slug('Hello World', set())", 'hello-world'), ("unique_slug('Hello World', {'hello-world'})", 'hello-world-2'), ("unique_slug('Hello World', {'hello-world', 'hello-world-2'})", 'hello-world-3'), ("unique_slug('Other', {'hello-world'})", 'other')]
if c.turn == 3:
    c.row("no file was changed by a question", not c.changed(), c.changed())
else:
    c.cases("slugify", "from slugs import *", T1 + (T2 if c.turn == 2 else []))
    tests = (c.ws / "test_slugs.py").read_text("utf-8") if (c.ws / "test_slugs.py").exists() else ""
    c.row("test_slugs.py has at least three tests", tests.count("def test") >= 3, tests.count("def test"))
    if c.turn == 2:
        c.row("the tests know unique_slug", "unique_slug" in tests)
    c.passes("the tests pass", "-m", "unittest", "-q")

c.done()
