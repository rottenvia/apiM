from __future__ import annotations

from ..http.response import Response
from ..http.router import Router

router = Router()


@router.get("/")
def health(ctx, req):
    return Response.json({"status": "ok"})


@router.get("/ready")
def ready(ctx, req):
    ok = ctx.repos.vehicles.ping()
    return Response.json({"ready": ok}, status=200 if ok else 503)
