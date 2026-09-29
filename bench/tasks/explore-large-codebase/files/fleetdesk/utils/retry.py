"""Retry with exponential backoff."""
from __future__ import annotations

import random
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int
    initial_ms: int
    multiplier: float
    max_ms: int
    jitter: float = 0.1

    @classmethod
    def from_config(cls, config, prefix: str) -> "RetryPolicy":
        """Read <prefix>.max_attempts / backoff_initial_ms / backoff_multiplier / backoff_max_ms,
        falling back to the shared http.retry.* settings for anything the prefix doesn't set."""

        def pick(name: str):
            value = config.get(f"{prefix}.{name}")
            if value is None:
                value = config.get(f"http.retry.{name}")
            return value

        return cls(
            max_attempts=int(pick("max_attempts")),
            initial_ms=int(pick("backoff_initial_ms")),
            multiplier=float(pick("backoff_multiplier")),
            max_ms=int(pick("backoff_max_ms")),
        )

    def delay_ms(self, attempt: int) -> float:
        """Delay before retry number `attempt` (1-based)."""
        base = min(self.max_ms, self.initial_ms * self.multiplier ** (attempt - 1))
        return base * (1 + random.uniform(-self.jitter, self.jitter))


def retry_call(fn, policy: RetryPolicy, retry_on=(Exception,), sleep=time.sleep):
    attempt = 1
    while True:
        try:
            return fn()
        except retry_on:
            if attempt >= policy.max_attempts:
                raise
            sleep(policy.delay_ms(attempt) / 1000)
            attempt += 1
