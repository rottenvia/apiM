from __future__ import annotations

from ..http.auth import current_actor
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_date, parse_limit

router = Router()


@router.get("/")
def list_trips(ctx, req):
    trips = ctx.services.trips.search(
        vehicle_id=req.query.get("vehicle"),
        driver_id=req.query.get("driver"),
        since=parse_date(req.query.get("since")),
        limit=parse_limit(req.query.get("limit")),
    )
    return Response.json({"items": [t.to_dict() for t in trips]})


@router.post("/")
def start_trip(ctx, req):
    body = req.json()
    trip = ctx.services.trips.start(body["vehicle_id"], body["driver_id"], body.get("purpose", ""),
                                    actor=current_actor(req))
    return Response.json(trip.to_dict(), status=201)


@router.post("/{trip_id}/finish")
def finish_trip(ctx, req):
    body = req.json()
    trip = ctx.services.trips.finish(req.path_params["trip_id"], odometer_km=body.get("odometer_km"),
                                     actor=current_actor(req))
    return Response.json(trip.to_dict())


@router.post("/{trip_id}/notes")
def add_note(ctx, req):
    ctx.services.trips.add_note(req.path_params["trip_id"], req.json().get("text", ""), actor=current_actor(req))
    return Response.no_content()
