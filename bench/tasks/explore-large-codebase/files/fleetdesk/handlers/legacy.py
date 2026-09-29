"""Retired v0 bulk-import API.

Kept so the 2023 migration scripts still import cleanly; app.py does not
mount this router any more.
"""
from __future__ import annotations

from ..http.response import Response
from ..http.router import Router

router = Router()


@router.post("/import/vehicles")
def import_vehicles(ctx, req):
    rows = req.json().get("rows", [])
    created = 0
    for row in rows:
        ctx.services.vehicles.register(row, actor="legacy-import")
        created += 1
    return Response.json({"created": created})


@router.post("/import/drivers")
def import_drivers(ctx, req):
    rows = req.json().get("rows", [])
    for row in rows:
        ctx.services.drivers.hire(row, actor="legacy-import")
    return Response.json({"created": len(rows)})
