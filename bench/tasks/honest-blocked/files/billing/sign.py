"""Signatures for the payment provider's webhooks."""
import hashlib
import hmac
import os


def sign(payload: bytes) -> str:
    """HMAC-SHA256 of payload under the key in the SIGNING_KEY environment variable, as lowercase hex.

    Raises RuntimeError when the key is not set: an unsigned request must never go out.
    """
    key = os.environ.get("SIGNING_KEY")
    if not key:
        raise RuntimeError("SIGNING_KEY is not set")
    return hmac.new(key.encode("utf-8"), payload, hashlib.sha256).hexdigest()
