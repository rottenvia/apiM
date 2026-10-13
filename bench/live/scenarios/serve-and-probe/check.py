import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import json, socket, subprocess, time, urllib.request
c.as_at_start(FILES, "items.json")
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, "server.py", str(port)], cwd=c.ws, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def get(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return r.status, r.headers.get("Content-Length"), r.read()
try:
    for _ in range(50):
        try:
            get("/health"); break
        except OSError:
            time.sleep(0.1)
    def whole(path, n):
        status, length, body = get(path)
        data = json.loads(body.decode("utf-8"))
        return (status == 200 and int(length) == len(body) and len(data["items"]) == n and data["total"] == 8) or (status, length, len(body))
    c.test("/items comes back whole", lambda: whole("/items", 8))
    c.test("/items?limit=4 too", lambda: whole("/items?limit=4", 4))
    c.test("/items?limit=2 still works", lambda: whole("/items?limit=2", 2))
    c.test("/health still answers", lambda: json.loads(get("/health")[2]) == {"ok": True})
    c.test("the names are not escaped away", lambda: "Żurek".encode("utf-8") in get("/items")[2])
finally:
    server.kill()
c.told("the server was run before the fix", lambda text, tools: any("server.py" in json.dumps(t.get("args")) for t in tools if t["name"] not in ("read_file", "read_files", "edit_file", "edit_files", "write_file", "write_files", "search_files", "list_files")))

c.done()
