"""A stand-in for OpenRouter that plays a script of tool calls and keeps every request it is sent.

    python stub.py script.json out_dir [port]

script.json: a list of steps; a step is a text (the reply ends on it) or a list of {"name", "args"} tool calls.
Each request body is written to out_dir/req-NN.json. Used with OPENROUTER_BASE_URL=http://127.0.0.1:PORT.
"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

script = json.load(open(sys.argv[1], encoding="utf-8"))
out_dir = sys.argv[2]
port = int(sys.argv[3]) if len(sys.argv) > 3 else 18999
os.makedirs(out_dir, exist_ok=True)
state = {"n": 0}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'{"error":"no listing here"}'
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with lock:
            n = state["n"]
            state["n"] += 1
        with open(os.path.join(out_dir, f"req-{n + 1:02d}.json"), "wb") as f:
            f.write(raw)
        step = script[n] if n < len(script) else "Done."
        chunks = []
        if isinstance(step, str):
            chunks.append({"choices": [{"delta": {"content": step}, "finish_reason": "stop"}]})
        else:
            calls = [{"index": i, "id": f"c{n}_{i}", "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}} for i, c in enumerate(step)]
            chunks.append({"choices": [{"delta": {"tool_calls": calls}, "finish_reason": "tool_calls"}]})
        chunks.append({"choices": [], "usage": {"prompt_tokens": len(raw) // 4, "completion_tokens": 10, "total_tokens": len(raw) // 4 + 10}})
        # STUB_PROVIDERS=Relace,Relace,Sail names who "answered" each request in turn, as OpenRouter does in its stream.
        names = [x for x in os.environ.get("STUB_PROVIDERS", "").split(",") if x]
        if names:
            for c in chunks:
                c["provider"] = names[n % len(names)]
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


print(f"stub on {port}, {len(script)} steps", flush=True)
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
