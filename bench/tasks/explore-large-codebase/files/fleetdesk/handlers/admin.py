"""Operator endpoints."""
from __future__ import annotations

from ..http.auth import current_actor, require_role
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_limit

router = Router()


@router.get("/audit")
@require_role("admin", "auditor")
def list_audit(ctx, req):
    ctx.journal.flush()  # make sure buffered records are visible
    rows = ctx.repos.audit.list_recent(limit=parse_limit(req.query.get("limit"), default=200))
    return Response.json({"items": rows})


@router.post("/sessions/purge")
@require_role("admin")
def purge_sessions(ctx, req):
    result = ctx.services.retention.run(now=ctx.clock.now())
    ctx.services.audit.record(current_actor(req), "admin.sessions_purged", "sessions", **result)
    return Response.json(result)


@router.post("/maintenance")
@require_role("admin")
def run_maintenance(ctx, req):
    """Quick housekeeping pass that ops can trigger by hand."""
    now = ctx.clock.now()
    sessions = ctx.repos.sessions
    removed = sessions.purge_expired(now)
    ctx.services.presence.sweep()
    ctx.journal.flush()
    ctx.services.audit.record(current_actor(req), "admin.maintenance", "system", sessions_removed=removed)
    return Response.json({"sessions_removed": removed})


@router.post("/cache/flush")
def flush_cache(ctx, req):
    ctx.services.presence.clear()
    return Response.no_content()


@router.get("/config")
@require_role("admin")
def show_config(ctx, req):
    safe = {k: ("***" if "secret" in k else v) for k, v in ctx.config.as_dict().items()}
    return Response.json(safe)
