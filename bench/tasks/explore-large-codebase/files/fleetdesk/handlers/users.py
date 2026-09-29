from __future__ import annotations

from ..http.auth import current_actor, require_role
from ..http.response import Response
from ..http.router import Router

router = Router()


@router.get("/me")
def me(ctx, req):
    return Response.json(req.user.to_dict())


@router.get("/")
@require_role("admin")
def list_users(ctx, req):
    return Response.json({"items": [u.to_dict() for u in ctx.services.users.list()]})


@router.post("/")
@require_role("admin")
def invite_user(ctx, req):
    body = req.json()
    user = ctx.services.users.invite(body["email"], body.get("roles", []), actor=current_actor(req))
    return Response.json(user.to_dict(), status=201)


@router.put("/{user_id}/roles")
@require_role("admin")
def set_roles(ctx, req):
    user = ctx.services.users.set_roles(req.path_params["user_id"], req.json().get("roles", []),
                                        actor=current_actor(req))
    return Response.json(user.to_dict())


@router.post("/me/password")
def change_password(ctx, req):
    body = req.json()
    ctx.services.users.change_password(req.user.id, body.get("old", ""), body.get("new", ""))
    ctx.services.sessions.revoke_all(req.user.id)
    return Response.no_content()
