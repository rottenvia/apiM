"""A tiny items API.  python server.py [port]"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

with open("items.json", encoding="utf-8") as f:
    ITEMS = json.load(f)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.send(200, {"ok": True})
        if url.path == "/items":
            limit = int(parse_qs(url.query).get("limit", ["50"])[0])
            return self.send(200, {"items": ITEMS[:limit], "total": len(ITEMS)})
        self.send(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
