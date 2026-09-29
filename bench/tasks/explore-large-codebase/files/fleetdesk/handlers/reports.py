from __future__ import annotations

from ..http.auth import require_role
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_date

router = Router()


@router.get("/utilisation")
def utilisation(ctx, req):
    rows = ctx.services.reports.utilisation(parse_date(req.query.get("from")), parse_date(req.query.get("to")))
    return Response.json({"rows": rows})


@router.get("/maintenance-costs")
@require_role("finance", "admin")
def maintenance_costs(ctx, req):
    return Response.json({"rows": ctx.services.reports.maintenance_costs(req.query.get("year"))})


@router.post("/exports")
@require_role("finance", "admin")
def request_export(ctx, req):
    job_id = ctx.services.reports.request_export(req.json().get("report"), req.user.id)
    return Response.json({"job": job_id}, status=202)
