"""Map exceptions escaping handlers to HTTP responses."""
from __future__ import annotations

from .. import errors
from .response import json_error

# checked in order; the first matching class wins
STATUS_BY_ERROR = [
    (errors.AuthenticationError, 401),
    (errors.PermissionDenied, 403),
    (errors.NotFoundError, 404),
    (errors.ConflictError, 409),
    (errors.ValidationError, 422),
    (ValueError, 400),
    (errors.FleetError, 500),
]


def status_for(exc: BaseException) -> int:
    for cls, status in STATUS_BY_ERROR:
        if isinstance(exc, cls):
            return status
    return 500


def error_response(exc: BaseException):
    status = status_for(exc)
    message = str(exc) if status < 500 else "internal error"
    extra = {}
    if isinstance(exc, errors.ValidationError) and exc.field:
        extra["field"] = exc.field
    return json_error(status, message, **extra)
