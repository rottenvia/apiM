"""Builds the tree in the current folder: python.exe, its DLLs and its library, two faults put in, one commit."""
import os, shutil, subprocess, sys
from pathlib import Path


def swap(rel, old, new):
    text = Path(rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
    assert text.count(old) == 1, (rel, text.count(old))
    Path(rel).write_bytes(text.replace(old, new).encode("utf-8"))


BASE = Path(sys.base_prefix)
assert sys.version_info[:2] == (3, 11) and os.name == "nt", "written against Python 3.11 on Windows"
skip = shutil.ignore_patterns("site-packages", "__pycache__", "_bundled", "tcl*", "tk*", "_tkinter*", "idlelib", "turtledemo")
shutil.copytree(BASE / "Lib", "Lib", ignore=skip)
shutil.copytree(BASE / "DLLs", "DLLs", ignore=skip)
for f in [*BASE.glob("*.dll"), BASE / "python.exe"]:
    shutil.copy2(f, f.name)
swap("Lib/fnmatch.py", "    result = []\n    pat = os.path.normcase(pat)\n", "    result = []\n")
swap("Lib/email/_parseaddr.py", "(tzoffset % 100)*60)", "(tzoffset % 100))")
Path(".gitignore").write_text("python.exe\n*.dll\nDLLs/\n__pycache__/\n", "utf-8")
env = dict(os.environ, GIT_AUTHOR_NAME="Dana", GIT_AUTHOR_EMAIL="dana@example.org", GIT_COMMITTER_NAME="Dana", GIT_COMMITTER_EMAIL="dana@example.org")
for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "The library of CPython 3.11, with our changes"]):
    subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", *args], check=True, capture_output=True, env=env)
