import json, os, socket, subprocess, sys, time, urllib.error, urllib.request

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
sock.close()
server = subprocess.Popen([sys.executable, os.path.join("app", "server.py")], env={**os.environ, "PORT": str(port)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = f"http://127.0.0.1:{port}"


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except Exception:
            return e.code, None
    except Exception as e:
        return 0, str(e)


checks = []
try:
    for _ in range(50):
        if call("GET", "/items")[0] == 200:
            break
        time.sleep(0.1)
    checks.append(("the server starts and lists nothing", call("GET", "/items") == (200, {"items": []})))
    a = call("POST", "/items", {"name": "bolt", "qty": 40})
    checks.append(("an item is created", a == (201, {"id": 1, "name": "bolt", "qty": 40})))
    b = call("POST", "/items", {"name": "Гайка М8 ☕", "qty": 15})
    checks.append(("a name outside ASCII comes back whole", b == (201, {"id": 2, "name": "Гайка М8 ☕", "qty": 15})))
    checks.append(("it reads back whole too", call("GET", "/items/2") == (200, {"id": 2, "name": "Гайка М8 ☕", "qty": 15})))
    checks.append(("a quantity given as text is refused", call("POST", "/items", {"name": "nut", "qty": "7"})[0] == 400))
    checks.append(("a negative quantity is refused", call("POST", "/items", {"name": "nut", "qty": -1})[0] == 400))
    checks.append(("stats count what is stored", call("GET", "/stats") == (200, {"count": 2, "total_qty": 55})))
    checks.append(("an unknown id is a 404 on delete", call("DELETE", "/items/99")[0] == 404))
    checks.append(("the server is still up after that", call("GET", "/items")[0] == 200))
    checks.append(("delete works", call("DELETE", "/items/1")[0] == 204 and call("GET", "/items/1")[0] == 404))
    checks.append(("stats follow a delete", call("GET", "/stats") == (200, {"count": 1, "total_qty": 15})))
    c = call("POST", "/items", {"name": "washer", "qty": 0})
    checks.append(("ids are not reused", c[0] == 201 and isinstance(c[1], dict) and c[1].get("id") == 3))
finally:
    server.kill()
for label, ok in checks:
    if not ok:
        print(f"FAIL {label}")
good = sum(1 for _, ok in checks if ok)
print(f"SCORE {good}/12")
sys.exit(0 if good == 12 else 1)
