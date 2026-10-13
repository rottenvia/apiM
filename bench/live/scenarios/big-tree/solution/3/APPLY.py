"""The reference solution of this turn, applied to the tree given as the first argument."""
import os, shutil, subprocess, sys
from pathlib import Path


def swap(rel, old, new):
    text = Path(rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
    assert text.count(old) == 1, (rel, text.count(old))
    Path(rel).write_bytes(text.replace(old, new).encode("utf-8"))

os.chdir(sys.argv[1])
swap("Lib/email/_parseaddr.py", "(tzoffset % 100))", "(tzoffset % 100)*60)")
