from __future__ import annotations

from datetime import timedelta

from ..errors import AuthenticationError
from ..utils.ids import new_token
from .user_service import check_password


class AuthService:
    def __init__(self, users, tokens, sessions, clock, config):
        self._users = users
        self._tokens = tokens
        self._sessions = sessions
        self._clock = clock
        self._ttl = timedelta(minutes=config.get("auth.token_ttl_minutes"))
        self._refresh_ttl = timedelta(days=config.get("auth.refresh_ttl_days"))

    def login(self, email, password):
        user = self._users.find_by_email(email.strip().lower())
        if user is None or not user.password_hash or not check_password(password, user.password_hash):
            raise AuthenticationError("invalid credentials")
        return self._issue(user.id)

    def _issue(self, user_id):
        now = self._clock.now()
        access, refresh = new_token(), new_token()
        self._tokens.insert(access, user_id, "access", now + self._ttl)
        self._tokens.insert(refresh, user_id, "refresh", now + self._refresh_ttl)
        return {"access_token": access, "refresh_token": refresh, "expires_in": int(self._ttl.total_seconds())}

    def refresh(self, refresh_token):
        row = self._tokens.get(refresh_token)
        if row is None or row["kind"] != "refresh" or row["expires_at"] <= self._clock.now():
            raise AuthenticationError("invalid refresh token")
        self._tokens.revoke(refresh_token)
        return self._issue(row["user_id"])

    def authenticate(self, token):
        if not token:
            return None
        row = self._tokens.get(token)
        if row is None or row["kind"] != "access" or row["expires_at"] <= self._clock.now():
            return None
        return self._users.get(row["user_id"])

    def logout(self, token):
        if token:
            self._tokens.revoke(token)
        self._tokens.purge_expired(self._clock.now())
