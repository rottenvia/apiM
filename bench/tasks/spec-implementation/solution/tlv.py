"""TLV-X v1 encoder/decoder (see SPEC.md)."""
from __future__ import annotations

MAGIC = b"\xb7\x1e"
VERSION = 1
FLAG_CRC = 0x01
MAX_VARINT = (1 << 28) - 1
MAX_DEPTH = 16
INT_MIN, INT_MAX = -(1 << 63), (1 << 63) - 1

T_NULL, T_BOOL, T_INT, T_BYTES, T_STRING, T_LIST, T_MAP = range(7)


class TLVError(ValueError):
    """Raised for any message that cannot be encoded or decoded."""


# ------------------------------------------------------------------ helpers
def crc16(data: bytes) -> int:
    """CRC-16/IBM-SDLC (X-25): poly 0x1021 reflected (0x8408), init 0xFFFF, xorout 0xFFFF."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc ^ 0xFFFF


def _varint(n: int) -> bytes:
    if not 0 <= n <= MAX_VARINT:
        raise TLVError(f"varint out of range: {n}")
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _int_bytes(v: int) -> bytes:
    for width in (1, 2, 4, 8):
        lo, hi = -(1 << (8 * width - 1)), (1 << (8 * width - 1)) - 1
        if lo <= v <= hi:
            return v.to_bytes(width, "big", signed=True)
    raise TLVError(f"integer out of range: {v}")


# ------------------------------------------------------------------ encode
def _tag(type_: int, field: int) -> bytes:
    if field < 31:
        return bytes([(type_ << 5) | field])
    return bytes([(type_ << 5) | 31]) + _varint(field)


def _item(field: int, value, depth: int) -> bytes:
    if value is None:
        return _tag(T_NULL, field)
    if isinstance(value, bool):
        return _tag(T_BOOL, field) + (b"\x01" if value else b"\x00")
    if isinstance(value, int):
        if not INT_MIN <= value <= INT_MAX:
            raise TLVError(f"integer out of range: {value}")
        payload = _int_bytes(value)
        return _tag(T_INT, field) + _varint(len(payload)) + payload
    if isinstance(value, (bytes, bytearray)):
        return _tag(T_BYTES, field) + _varint(len(value)) + bytes(value)
    if isinstance(value, str):
        try:
            payload = value.encode("utf-8")
        except UnicodeEncodeError as e:
            raise TLVError(f"string is not encodable as UTF-8: {e}") from None
        return _tag(T_STRING, field) + _varint(len(payload)) + payload
    if isinstance(value, (list, tuple)):
        if depth + 1 > MAX_DEPTH:
            raise TLVError("nesting too deep")
        payload = b"".join(_item(0, v, depth + 1) for v in value)
        return _tag(T_LIST, field) + _varint(len(payload)) + payload
    if isinstance(value, dict):
        if depth + 1 > MAX_DEPTH:
            raise TLVError("nesting too deep")
        payload = _map_body(value, depth + 1)
        return _tag(T_MAP, field) + _varint(len(payload)) + payload
    raise TLVError(f"unsupported type: {type(value).__name__}")


def _map_body(d: dict, depth: int) -> bytes:
    for k in d:
        if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= MAX_VARINT:
            raise TLVError(f"bad map key: {k!r}")
    return b"".join(_item(k, d[k], depth) for k in sorted(d))


def encode(message: dict, *, crc: bool = True) -> bytes:
    if not isinstance(message, dict):
        raise TLVError("message must be a dict")
    body = _map_body(message, 0)
    out = MAGIC + bytes([VERSION, FLAG_CRC if crc else 0]) + _varint(len(body)) + body
    if crc:
        out += crc16(out).to_bytes(2, "big")
    return out


# ------------------------------------------------------------------ decode
class _Reader:
    def __init__(self, data: bytes, pos: int, end: int):
        self.data, self.pos, self.end = data, pos, end

    def byte(self) -> int:
        if self.pos >= self.end:
            raise TLVError("truncated")
        b = self.data[self.pos]
        self.pos += 1
        return b

    def take(self, n: int) -> bytes:
        if n > self.end - self.pos:
            raise TLVError("truncated")
        chunk = self.data[self.pos:self.pos + n]
        self.pos += n
        return chunk

    def varint(self) -> int:
        value = 0
        for i in range(4):
            b = self.byte()
            value |= (b & 0x7F) << (7 * i)
            if not b & 0x80:
                if i > 0 and b == 0:
                    raise TLVError("non-minimal varint")
                return value
        raise TLVError("varint longer than 4 bytes")


def _read_items(r: _Reader, depth: int, is_list: bool):
    out = [] if is_list else {}
    last = 0
    while r.pos < r.end:
        tag = r.byte()
        type_, field = tag >> 5, tag & 0x1F
        if field == 31:
            field = r.varint()
            if field < 31:
                raise TLVError("extended field number below 31")
        if is_list and field != 0:
            raise TLVError("list item with a field number")
        if not is_list:
            if field == 0:
                raise TLVError("map item with field number 0")
            if field <= last:
                raise TLVError("map fields not strictly increasing")
            last = field
        if type_ == T_NULL:
            value = None
        elif type_ == T_BOOL:
            b = r.byte()
            if b > 1:
                raise TLVError("bad BOOL byte")
            value = b == 1
        elif type_ in (T_INT, T_BYTES, T_STRING, T_LIST, T_MAP):
            n = r.varint()
            if n > r.end - r.pos:
                raise TLVError("item runs past its container")
            if type_ == T_INT:
                if n not in (1, 2, 4, 8):
                    raise TLVError("bad INT width")
                value = int.from_bytes(r.take(n), "big", signed=True)
                if len(_int_bytes(value)) != n:
                    raise TLVError("INT not in its shortest width")
            elif type_ == T_BYTES:
                value = bytes(r.take(n))
            elif type_ == T_STRING:
                try:
                    value = bytes(r.take(n)).decode("utf-8")
                except UnicodeDecodeError:
                    raise TLVError("invalid UTF-8") from None
            else:
                if depth + 1 > MAX_DEPTH:
                    raise TLVError("nesting too deep")
                sub = _Reader(r.data, r.pos, r.pos + n)
                value = _read_items(sub, depth + 1, type_ == T_LIST)
                r.pos += n
        else:
            raise TLVError("reserved type 7")
        if is_list:
            out.append(value)
        else:
            out[field] = value
    return out


def decode(data: bytes) -> dict:
    data = bytes(data)
    if len(data) < 5:
        raise TLVError("truncated header")
    if data[:2] != MAGIC:
        raise TLVError("bad magic")
    if data[2] != VERSION:
        raise TLVError(f"unsupported version {data[2]}")
    flags = data[3]
    if flags & ~FLAG_CRC:
        raise TLVError("reserved flag bits set")
    has_crc = bool(flags & FLAG_CRC)
    r = _Reader(data, 4, len(data))
    body_len = r.varint()
    body_start = r.pos
    expected_total = body_start + body_len + (2 if has_crc else 0)
    if len(data) != expected_total:
        raise TLVError("length mismatch")
    if has_crc:
        stored = int.from_bytes(data[-2:], "big")
        if crc16(data[:-2]) != stored:
            raise TLVError("CRC mismatch")
    return _read_items(_Reader(data, body_start, body_start + body_len), 0, False)
