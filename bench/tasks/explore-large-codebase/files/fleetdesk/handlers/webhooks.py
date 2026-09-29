"""Inbound webhooks from the telematics provider and the payment processor.

These live under a public prefix (see http.public_prefixes): the senders
cannot obtain bearer tokens, so every handler authenticates the sender itself
with an HMAC signature.
"""
from __future__ import annotations

from ..http.auth import verify_signature
from ..http.response import Response
from ..http.router import Router
from ..utils.validation import parse_datetime

router = Router()


@router.post("/telematics/events")
def telematics_events(ctx, req):
    verify_signature(req, ctx.config.get("webhooks.telematics.secret"))
    events = req.json().get("events", [])
    accepted = ctx.services.trips.ingest_positions(events)
    return Response.json({"accepted": accepted}, status=202)


@router.post("/telematics/replay")
def replay_telematics(ctx, req):
    """Re-ingest provider events for a time window (used after outages)."""
    body = req.json()
    window_start = parse_datetime(body["from"])
    window_end = parse_datetime(body["to"])
    count = ctx.services.trips.replay_window(window_start, window_end, vehicle_id=body.get("vehicle_id"))
    ctx.services.audit.record("telematics", "telematics.replayed", body.get("vehicle_id") or "*", events=count)
    return Response.json({"replayed": count}, status=202)


@router.get("/telematics/health")
def telematics_health(ctx, req):
    return Response.json({"ok": True, "last_event": ctx.services.trips.last_position_at()})


@router.post("/payments/notify")
def payment_notification(ctx, req):
    verify_signature(req, ctx.config.get("webhooks.payments.secret"), header="X-Pay-Signature")
    body = req.json()
    ctx.services.billing.record_payment(body["invoice_id"], body["amount_cents"], body["reference"])
    return Response.no_content()
