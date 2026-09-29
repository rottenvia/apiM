from __future__ import annotations

import hashlib
import secrets

from ..errors import AuthenticationError, NotFoundError, ValidationError
from ..repositories.user_repo import User
from ..utils.ids import new_id

KNOWN_ROLES = {"admin", "auditor", "fleet_manager", "finance", "hr", "workshop", "dispatcher"}


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${digest}"


def check_password(password: str, stored: str) -> bool:
    salt, _, _ = stored.partition("$")
    return secrets.compare_digest(hash_password(password, salt), stored)


class UserService:
    def __init__(self, repo, audit, clock):
        self._repo = repo
        self._audit = audit
        self._clock = clock

    def list(self):
        return self._repo.list()

    def invite(self, email, roles, actor):
        unknown = set(roles) - KNOWN_ROLES
        if unknown:
            raise ValidationError(f"unknown roles: {sorted(unknown)}", field="roles")
        user = User(id=new_id("usr"), email=email.strip().lower(), roles=list(roles), password_hash="")
        self._repo.insert(user)
        self._audit.record(actor, "user.invited", user.id, roles=roles)
        return user

    def set_roles(self, user_id, roles, actor):
        user = self._repo.get(user_id)
        if user is None:
            raise NotFoundError("user", user_id)
        user.roles = list(roles)
        self._repo.update(user)
        self._audit.record(actor, "user.roles_changed", user_id, roles=roles)
        return user

    def change_password(self, user_id, old, new):
        user = self._repo.get(user_id)
        if user is None or not check_password(old, user.password_hash):
            raise AuthenticationError("wrong password")
        if len(new) < 12:
            raise ValidationError("password too short", field="new")
        user.password_hash = hash_password(new)
        self._repo.update(user)
        self._audit.record(user_id, "user.password_changed", user_id)
