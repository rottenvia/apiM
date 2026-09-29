from __future__ import annotations

import logging

_audit_logger = logging.getLogger("fleetdesk.audit")


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def audit_log(message: str, **fields) -> None:
    """Human-readable audit line for the log stream (not the audit trail)."""
    extra = " ".join(f"{k}={v}" for k, v in sorted(fields.items()))
    _audit_logger.info("%s %s", message, extra)


def configure(level: str = "INFO") -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)-5s %(name)s: %(message)s")
