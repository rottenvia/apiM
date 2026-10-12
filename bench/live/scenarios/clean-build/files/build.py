"""Builds tinyapp: byte-compiles src/ into build/ and packs dist/tinyapp.zip."""
import compileall, shutil, zipfile
from pathlib import Path

root = Path(__file__).parent
shutil.rmtree(root / "build", ignore_errors=True)
compileall.compile_dir(root / "src", quiet=1)
(root / "build").mkdir()
for pyc in (root / "src").rglob("*.pyc"):
    shutil.copy(pyc, root / "build" / pyc.name)
(root / "dist").mkdir(exist_ok=True)
with zipfile.ZipFile(root / "dist" / "tinyapp.zip", "w") as z:
    for f in (root / "build").iterdir():
        z.write(f, f.name)
