"""Run a directory of unittest files against the package in cwd; print pass/total as JSON."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
suite_dir = sys.argv[1]
loader = unittest.TestLoader()
suite = loader.discover(suite_dir, top_level_dir=suite_dir)


class Result(unittest.TextTestResult):
    pass


def summary(tb):
    lines = tb.strip().splitlines()
    for line in lines:
        if line.startswith(("AssertionError", "calc.", "TypeError", "AttributeError", "ImportError", "NameError")):
            return line[:200]
    return lines[-1][:200]


stream = open(os.devnull, "w")
res = unittest.TextTestRunner(stream=stream, resultclass=Result, verbosity=0).run(suite)
failed = sorted({str(t).split(" ")[0] for t, _ in res.failures + res.errors})
print(json.dumps({"run": res.testsRun, "failed": failed, "errors": len(res.failures) + len(res.errors),
                  "detail": [summary(tb) for _, tb in (res.failures + res.errors)][:12]}))
