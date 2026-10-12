import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import re
left = []
c.cases('stats', 'from kit.stats import median', [('median([3, 1, 2])', 2), ('median([4, 1, 3, 2])', 2.5), ('median([5])', 5)])
c.cases('chunks', 'from kit.chunks import chunk', [('chunk([1, 2, 3], 2)', [[1, 2], [3]]), ('chunk([1, 2, 3, 4], 2)', [[1, 2], [3, 4]]), ('chunk([1], 3)', [[1]]), ('chunk([], 2)', [])])
c.cases('titles', 'from kit.titles import title_case', [("title_case('the lord of the rings')", 'The Lord of the Rings'), ("title_case('a tale of two cities')", 'A Tale of Two Cities'), ("title_case('war and peace')", 'War and Peace')])
c.cases('durations', 'from kit.durations import parse', [("parse('1h30m')", 5400), ("parse('45s')", 45), ("parse('2h')", 7200), ("raises(lambda: parse('soon'), ValueError)", True)])
c.cases('intervals', 'from kit.intervals import merge', [('merge([[1, 2], [2, 3]])', [[1, 3]]), ('merge([[5, 6], [1, 3], [2, 4]])', [[1, 4], [5, 6]]), ('merge([[1, 2], [3, 4]])', [[1, 2], [3, 4]])])
c.cases('roman', 'from kit.roman import to_roman', [('to_roman(4)', 'IV'), ('to_roman(1994)', 'MCMXCIV'), ('to_roman(14)', 'XIV'), ('to_roman(8)', 'VIII')])
c.cases('flat', 'from kit.flat import flatten', [('flatten([1, [2, [3]]])', [1, 2, 3]), ('flatten([[1, 2], [3]])', [1, 2, 3]), ("flatten([[[['x']]]])", ['x'])])
c.cases('wrap', 'from kit.wrap import wrap', [("wrap('aaaa bbb', 7)", ['aaaa', 'bbb']), ("wrap('aaa bbb ccc', 7)", ['aaa bbb', 'ccc']), ("wrap('one', 10)", ['one'])])
c.as_at_start(FILES, *[f"tests/test_{n}.py" for n in ['stats', 'chunks', 'titles', 'durations', 'intervals', 'roman', 'flat', 'wrap']])
c.done()
