"""Minimal router: path templates like /vehicles/{id}, mounted under prefixes."""
from __future__ import annotations

import re

from .request import Request
from .response import Response, json_error


class Router:
    def __init__(self):
        self._routes = []  # (method, template, handler)

    def add(self, method: str, template: str, handler):
        self._routes.append((method.upper(), template, handler))
        return handler

    def _decorator(self, method):
        def register(template):
            def wrap(handler):
                return self.add(method, template, handler)
            return wrap
        return register

    @property
    def get(self):
        return self._decorator("GET")

    @property
    def post(self):
        return self._decorator("POST")

    @property
    def put(self):
        return self._decorator("PUT")

    @property
    def delete(self):
        return self._decorator("DELETE")

    def routes(self):
        return list(self._routes)


def _compile(template: str):
    pattern = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", template.rstrip("/") or "/")
    return re.compile("^" + pattern + "$")


class App:
    def __init__(self, ctx):
        self.ctx = ctx
        self._middleware = []
        self._table = []  # (method, full path, regex, handler)
        self._after = []

    def use(self, middleware):
        self._middleware.append(middleware)

    def after_request(self, fn):
        self._after.append(fn)

    def mount(self, prefix: str, router: Router):
        for method, template, handler in router.routes():
            full = prefix.rstrip("/") + ("" if template == "/" else template)
            self._table.append((method, full, _compile(full), handler))

    def routes(self):
        return [(m, p, h) for m, p, _, h in self._table]

    def _dispatch(self, ctx, req: Request) -> Response:
        allowed = False
        for method, _, regex, handler in self._table:
            match = regex.match(req.path.rstrip("/") or "/")
            if not match:
                continue
            allowed = True
            if method == req.method:
                req.path_params = match.groupdict()
                return handler(ctx, req)
        return json_error(405 if allowed else 404, "method not allowed" if allowed else "not found")

    def handle(self, req: Request) -> Response:
        call = self._dispatch
        for mw in reversed(self._middleware):
            call = (lambda m, nxt: (lambda ctx, r: m(ctx, r, nxt)))(mw, call)
        try:
            return call(self.ctx, req)
        finally:
            for fn in self._after:
                fn(req)
