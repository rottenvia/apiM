import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import os, stat, zipfile
top = [" ".join(line.split()) for line in (c.ws / "top3.txt").read_text("utf-8-sig").splitlines() if line.strip()] if (c.ws / "top3.txt").exists() else []
c.row("top3.txt", top == ['cache/render.tmp 50000', 'audio/menu theme.ogg 20000', 'img/фон (1).png 5000'], top)
def names():
    with zipfile.ZipFile(c.ws / "dist" / "assets.zip") as z:
        return sorted(n for n in z.namelist() if not n.endswith("/"))
def sound():
    with zipfile.ZipFile(c.ws / "dist" / "assets.zip") as z:
        return all(z.read(n) == (FILES / "assets" / n).read_bytes() for n in ['audio/click.ogg', 'audio/menu theme.ogg', 'data/levels [draft].json', 'img/logo.png', 'img/фон (1).png', 'licence.txt', 'tmp-notes.txt'])
c.test("the zip holds the right files under the right names", lambda: True if names() == ['audio/click.ogg', 'audio/menu theme.ogg', 'data/levels [draft].json', 'img/logo.png', 'img/фон (1).png', 'licence.txt', 'tmp-notes.txt'] else names())
c.test("the files in the zip are whole", sound)
licence = c.ws / "assets" / "licence.txt"
c.row("assets/licence.txt is read-only", licence.exists() and not os.stat(licence).st_mode & stat.S_IWRITE)
c.row("assets/licence.txt still holds its text", licence.exists() and licence.read_bytes() == (FILES / "assets" / "licence.txt").read_bytes())
c.row("nothing under assets/ was lost", all((c.ws / rel).is_file() for rel in ['assets/audio/click.ogg', 'assets/audio/menu theme.ogg', 'assets/audio/old.tmp', 'assets/cache/render.tmp', 'assets/data/levels [draft].json', 'assets/img/logo.png', 'assets/img/фон (1).png', 'assets/licence.txt', 'assets/tmp-notes.txt']))

c.done()
