#!/usr/bin/env python3
"""S5a throwaway fixture: loopback OpenAI-compatible chat completions server.

Stdlib only. Binds 127.0.0.1:0. Logs transport metadata only
(method, path, model, payload sha256) — never prompt/response content.
Streams a fixed SSE completion to /v1/chat/completions.
"""
import hashlib
import http.server
import json
import threading

MODEL = "probe-model"


class Handler(http.server.BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass

    def authorized(self):
        return self.headers.get("Authorization") == "Bearer probe-key"

    def record(self, **entry):
        with self.server.lock:
            self.server.events.append(entry)
            with (self.server.log_path).open("a") as f:
                f.write(json.dumps(entry) + "\n")

    def do_GET(self):
        if self.path == "/v1/models":
            body = json.dumps({"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "probe"}]}).encode()
            self.record(method="GET", path=self.path, auth_ok=self.authorized())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.record(method="GET", path=self.path)
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except ValueError:
            self.send_error(400)
            return
        # Transport metadata only; never persist prompt, tools, or header values.
        self.record(method="POST", path=self.path, model=payload.get("model"),
                    stream=payload.get("stream"),
                    payload_sha256=hashlib.sha256(body).hexdigest())
        if not self.authorized() or self.path != "/v1/chat/completions":
            self.send_error(401 if not self.authorized() else 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            def emit(delta=None, **extra):
                chunk = {"id": "probe", "object": "chat.completion.chunk", "created": 1,
                         "model": MODEL,
                         "choices": [{"index": 0, "delta": delta or {}, "finish_reason": None}]}
                chunk.update(extra)
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.flush()

            emit({"role": "assistant", "content": ""})
            for text in ("Probe ", "response ", "complete."):
                emit({"content": text})
            emit(choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}])
            emit(choices=[], usage={"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.record(phase="done")
        except (BrokenPipeError, ConnectionResetError):
            self.record(phase="disconnected")


class ProbeServer(http.server.ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, log_path):
        super().__init__(("127.0.0.1", 0), Handler)
        self.log_path = log_path
        self.events = []
        self.lock = threading.Lock()


if __name__ == "__main__":
    import sys
    server = ProbeServer(sys.argv[1])
    print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()
