from __future__ import annotations

import logging
import time

from ..errors import AuthenticationError
from ..utils.ids import new_id
from .errors import error_response

log = logging.getLogger("fleetdesk.http")

# endpoints that must work before a client has a token
PUBLIC_PATHS = frozenset({"/api/v1/auth/login", "/api/v1/auth/refresh"})


class RequestLogMiddleware:
    def __call__(self, ctx, req, next_):
        req.request_id = req.header("X-Request-Id") or new_id("req")
        started = time.monotonic()
        resp = next_(ctx, req)
        log.info("%s %s -> %s (%.1fms) id=%s", req.method, req.path, resp.status,
                 (time.monotonic() - started) * 1000, req.request_id)
        resp.headers.setdefault("X-Request-Id", req.request_id)
        return resp


class ErrorMiddleware:
    def __call__(self, ctx, req, next_):
        try:
            return next_(ctx, req)
        except Exception as exc:  # noqa: BLE001 - last line of defence
            resp = error_response(exc)
            if resp.status >= 500:
                log.exception("unhandled error on %s %s", req.method, req.path)
            return resp


class AuthMiddleware:
    """Authenticates every request with a bearer token, except public ones."""

    def __init__(self, auth_service, public_prefixes=()):
        self.auth = auth_service
        self.public_prefixes = tuple(public_prefixes or ())

    def is_public(self, path: str) -> bool:
        return path in PUBLIC_PATHS or any(path.startswith(p) for p in self.public_prefixes)

    def __call__(self, ctx, req, next_):
        if self.is_public(req.path):
            req.user = None
            return next_(ctx, req)
        user = self.auth.authenticate(req.bearer_token())
        if user is None:
            raise AuthenticationError("missing or invalid token")
        req.user = user
        return next_(ctx, req)
