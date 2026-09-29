"""Authorization helpers for handlers."""
from __future__ import annotations

import functools
import hashlib
import hmac

from ..errors import AuthenticationError, PermissionDenied


def require_role(*roles: str):
    """Handler decorator: the authenticated user must have one of `roles`."""
    def decorate(handler):
        @functools.wraps(handler)
        def wrapper(ctx, req):
            user = req.user
            if user is None:
                raise AuthenticationError("authentication required")
            if not set(roles) & set(user.roles):
                raise PermissionDenied(f"requires one of: {', '.join(roles)}")
            return handler(ctx, req)
        return wrapper
    return decorate


def current_actor(req) -> str:
    return req.user.id if req.user is not None else "anonymous"


def verify_signature(req, secret: str, header: str = "X-Signature") -> None:
    """Inbound webhooks are authenticated with an HMAC-SHA256 of the raw body."""
    if not secret:
        raise AuthenticationError("webhook secret not configured")
    sent = req.header(header, "")
    expected = hmac.new(secret.encode(), req.body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sent, expected):
        raise AuthenticationError("bad webhook signature")
