from __future__ import annotations

from ..http.auth import current_actor, require_role
from ..http.response import Response
from ..http.router import Router

router = Router()


@router.get("/tickets")
def list_tickets(ctx, req):
    status = req.query.get("status")
    tickets = ctx.services.maintenance.list_tickets(status=status)
    return Response.json({"items": [t.to_dict() for t in tickets]})


@router.post("/tickets")
def open_ticket(ctx, req):
    body = req.json()
    ticket = ctx.services.maintenance.open_ticket(body["vehicle_id"], body.get("summary", ""),
                                                  severity=body.get("severity", "normal"), actor=current_actor(req))
    return Response.json(ticket.to_dict(), status=201)


@router.post("/tickets/{ticket_id}/assign")
@require_role("workshop", "admin")
def assign_ticket(ctx, req):
    ticket = ctx.services.maintenance.assign(req.path_params["ticket_id"], req.json()["mechanic"],
                                             actor=current_actor(req))
    return Response.json(ticket.to_dict())


@router.post("/tickets/{ticket_id}/close")
@require_role("workshop", "admin")
def close_ticket(ctx, req):
    body = req.json()
    ticket = ctx.services.maintenance.close(req.path_params["ticket_id"], body.get("resolution", ""),
                                            cost_cents=body.get("cost_cents", 0), actor=current_actor(req))
    return Response.json(ticket.to_dict())
