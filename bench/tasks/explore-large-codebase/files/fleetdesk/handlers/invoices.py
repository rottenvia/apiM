from __future__ import annotations

from ..http.auth import current_actor, require_role
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_date

router = Router()


@router.get("/")
@require_role("finance", "admin")
def list_invoices(ctx, req):
    invoices = ctx.services.billing.list_invoices(customer_id=req.query.get("customer"),
                                                  since=parse_date(req.query.get("since")))
    return Response.json({"items": [i.to_dict() for i in invoices]})


@router.post("/")
@require_role("finance", "admin")
def draft_invoice(ctx, req):
    body = req.json()
    invoice = ctx.services.billing.draft(body["customer_id"], parse_date(body["period_start"]),
                                         parse_date(body["period_end"]), actor=current_actor(req))
    return Response.json(invoice.to_dict(), status=201)


@router.post("/{invoice_id}/finalize")
@require_role("finance", "admin")
def finalize_invoice(ctx, req):
    invoice = ctx.services.billing.finalize(req.path_params["invoice_id"], actor=current_actor(req))
    return Response.json(invoice.to_dict())


@router.post("/{invoice_id}/void")
@require_role("finance", "admin")
def void_invoice(ctx, req):
    ctx.services.billing.void(req.path_params["invoice_id"], req.json().get("reason", ""), actor=current_actor(req))
    return Response.no_content()
