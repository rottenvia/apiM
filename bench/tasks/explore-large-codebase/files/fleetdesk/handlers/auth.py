from __future__ import annotations

from ..http.response import Response
from ..http.router import Router

router = Router()


@router.post("/login")
def login(ctx, req):
    body = req.json()
    tokens = ctx.services.auth.login(body.get("email", ""), body.get("password", ""))
    return Response.json(tokens)


@router.post("/refresh")
def refresh(ctx, req):
    return Response.json(ctx.services.auth.refresh(req.json().get("refresh_token", "")))


@router.post("/logout")
def logout(ctx, req):
    ctx.services.auth.logout(req.bearer_token())
    return Response.no_content()
