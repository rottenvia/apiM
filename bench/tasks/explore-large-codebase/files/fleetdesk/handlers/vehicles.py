from __future__ import annotations

from .. import errors
from ..http.auth import current_actor, require_role
from ..http.response import Response, json_error
from ..http.router import Router
from ..utils.validation import parse_limit

router = Router()


@router.get("/")
def list_vehicles(ctx, req):
    limit = parse_limit(req.query.get("limit"))
    depot = req.query.get("depot")
    vehicles = ctx.services.vehicles.list(depot=depot, limit=limit)
    return Response.json({"items": [v.to_dict() for v in vehicles]})


@router.get("/{vehicle_id}")
def get_vehicle(ctx, req):
    vehicle = ctx.services.vehicles.get(req.path_params["vehicle_id"])
    return Response.json(vehicle.to_dict())


@router.post("/")
@require_role("fleet_manager", "admin")
def create_vehicle(ctx, req):
    payload = req.json()
    try:
        vehicle = ctx.services.vehicles.register(payload, actor=current_actor(req))
    except errors.ConflictError as exc:
        # raced with another registration of the same plate
        return json_error(409, str(exc))
    return Response.json(vehicle.to_dict(), status=201)


@router.put("/{vehicle_id}")
@require_role("fleet_manager", "admin")
def update_vehicle(ctx, req):
    vehicle = ctx.services.vehicles.update(req.path_params["vehicle_id"], req.json(), actor=current_actor(req))
    return Response.json(vehicle.to_dict())


@router.post("/{vehicle_id}/retire")
@require_role("fleet_manager", "admin")
def retire_vehicle(ctx, req):
    reason = req.json().get("reason", "")
    ctx.services.vehicles.retire(req.path_params["vehicle_id"], reason, actor=current_actor(req))
    return Response.no_content()


@router.delete("/{vehicle_id}")
def delete_vehicle(ctx, req):
    ctx.services.vehicles.delete(req.path_params["vehicle_id"], actor=current_actor(req))
    return Response.no_content()
