from __future__ import annotations

from dataclasses import dataclass, field

from .settings import get_list


@dataclass
class Features:
    enabled: list[str] = field(default_factory=list)
    beta_users: list[str] = field(default_factory=list)

    def is_enabled(self, name: str) -> bool:
        return name.lower() in self.enabled


def load_features(cp) -> Features:
    enabled = list(dict.fromkeys(f.lower() for f in get_list(cp, "features", "enabled")))
    beta = sorted({u.lower() for u in get_list(cp, "features", "beta_users")})
    return Features(enabled, beta)
