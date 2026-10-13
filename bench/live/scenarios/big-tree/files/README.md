# pylib

Our build of Python's standard library: CPython 3.11, with our own changes on top.

`python.exe` in this folder runs **this** tree (`Lib/`):

    .\python.exe -m unittest test.test_glob
    .\python.exe -c "import glob; print(glob.__file__)"

The `python` on the PATH is the machine's own and has none of our changes: a fault seen here does not show there.
The tests of a module are in `Lib/test/`.
