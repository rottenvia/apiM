"""TLV-X v1 encoder/decoder. See SPEC.md."""
from __future__ import annotations


class TLVError(ValueError):
    """Raised for any message that cannot be encoded or decoded."""


def encode(message: dict, *, crc: bool = True) -> bytes:
    raise NotImplementedError


def decode(data: bytes) -> dict:
    raise NotImplementedError
