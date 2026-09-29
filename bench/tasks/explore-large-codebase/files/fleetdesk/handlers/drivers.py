from __future__ import annotations

from ..http.auth import current_actor, require_role
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_limit

router = Router()


@router.get("/")
def list_drivers(ctx, req):
    active = req.query.get("active", "true").lower() != "false"
    drivers = ctx.services.drivers.list(active_only=active, limit=parse_limit(req.query.get("limit")))
    return Response.json({"items": [d.to_dict() for d in drivers]})


@router.get("/{driver_id}")
def get_driver(ctx, req):
    return Response.json(ctx.services.drivers.get(req.path_params["driver_id"]).to_dict())


@router.post("/")
@require_role("hr", "admin")
def create_driver(ctx, req):
    driver = ctx.services.drivers.hire(req.json(), actor=current_actor(req))
    return Response.json(driver.to_dict(), status=201)


@router.post("/{driver_id}/license")
@require_role("hr", "admin")
def update_license(ctx, req):
    body = req.json()
    driver = ctx.services.drivers.update_license(req.path_params["driver_id"], body.get("number"),
                                                 body.get("expires"), actor=current_actor(req))
    return Response.json(driver.to_dict())


@router.post("/{driver_id}/suspend")
@require_role("hr", "admin")
def suspend_driver(ctx, req):
    ctx.services.drivers.suspend(req.path_params["driver_id"], req.json().get("reason", ""), actor=current_actor(req))
    return Response.no_content()
