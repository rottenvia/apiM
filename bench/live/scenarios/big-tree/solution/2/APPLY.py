"""The reference solution of this turn, applied to the tree given as the first argument."""
import os, shutil, subprocess, sys
from pathlib import Path


def swap(rel, old, new):
    text = Path(rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
    assert text.count(old) == 1, (rel, text.count(old))
    Path(rel).write_bytes(text.replace(old, new).encode("utf-8"))

os.chdir(sys.argv[1])
swap("Lib/calendar.py", '        help="output type (text or html)"\n    )\n', '        help="output type (text or html)"\n    )\n    parser.add_argument(\n        "-f", "--first-weekday",\n        type=int, default=0,\n        help="weekday the week starts on (0 is Monday, 6 is Sunday; default 0)"\n    )\n')
swap("Lib/calendar.py", "            cal = HTMLCalendar()\n", "            cal = HTMLCalendar()\n        cal.setfirstweekday(options.first_weekday)\n")
swap("Lib/calendar.py", "            cal = TextCalendar()\n", "            cal = TextCalendar()\n        cal.setfirstweekday(options.first_weekday)\n")
swap("Lib/test/test_calendar.py", "    def test_option_lines(self):\n", "    def test_option_first_weekday(self):\n        self.assertFailure('-f', 'spam')\n        stdout = self.run_ok('--first-weekday', '6', '2004')\n        self.assertIn(b'Su Mo Tu We Th Fr Sa', stdout)\n\n    def test_option_lines(self):\n")
