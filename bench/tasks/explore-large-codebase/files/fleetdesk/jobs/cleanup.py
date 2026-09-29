"""Hourly clean-up tasks (scheduled by the ops cron image)."""
from __future__ import annotations

from ..utils.logging import get_logger

log = get_logger(__name__)


def purge_tokens(ctx) -> int:
    removed = ctx.repos.tokens.purge_expired(ctx.clock.now())
    log.info("purged %d expired tokens", removed)
    return removed


def purge_caches(ctx) -> int:
    removed = ctx.services.presence.sweep() + ctx.services.vehicles.refresh_cache()
    log.info("purged %d cache entries", removed)
    return removed


def hourly(ctx) -> None:
    purge_tokens(ctx)
    purge_caches(ctx)
    ctx.journal.flush()
