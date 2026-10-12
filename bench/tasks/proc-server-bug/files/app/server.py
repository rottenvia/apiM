"""Tiny inventory service. Start: python app/server.py   (PORT picks the port, default 8765)

GET    /items        -> {"items": [...]}
POST   /items        -> 201 and the new item; body {"name": str, "qty": int}
GET    /items/<id>   -> the item, or 404
DELETE /items/<id>   -> 204, or 404
GET    /stats        -> {"count": <items now stored>, "total_qty": <sum of their qty>}
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ITEMS = {}
NEXT_ID = [1]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body.decode("utf-8"))))
        self.end_headers()
        self.wfile.write(body)

    def item_id(self):
        parts = self.path.strip("/").split("/")
        return int(parts[1]) if len(parts) == 2 and parts[0] == "items" and parts[1].isdigit() else None

    def do_GET(self):
        if self.path == "/items":
            return self.send_json(200, {"items": list(ITEMS.values())})
        if self.path == "/stats":
            return self.send_json(200, {"count": NEXT_ID[0] - 1, "total_qty": sum(i["qty"] for i in ITEMS.values())})
        item = ITEMS.get(self.item_id())
        if item is None:
            return self.send_json(404, {"error": "not found"})
        self.send_json(200, item)

    def do_POST(self):
        if self.path != "/items":
            return self.send_json(404, {"error": "not found"})
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            name, qty = data["name"], data["qty"]
            if not isinstance(name, str) or not name.strip():
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": "name (text) and qty (a whole number, 0 or more) are required"})
        item = {"id": NEXT_ID[0], "name": name, "qty": qty}
        ITEMS[item["id"]] = item
        NEXT_ID[0] += 1
        self.send_json(201, item)

    def do_DELETE(self):
        del ITEMS[self.item_id()]
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    print(f"listening on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
