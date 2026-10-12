"""Unpack a PAK1 archive: python unpak.py <archive> <out_dir>. Names with a bad checksum are printed; exit code 1 if any."""
import os
import struct
import sys
import zlib


def unpack(archive, out_dir):
    data = open(archive, "rb").read()
    if data[:4] != b"PAK1":
        raise SystemExit("not a PAK1 archive")
    _, count = struct.unpack_from("<HI", data, 4)
    pos, bad = 10, []
    for index in range(count):
        size = data[pos]
        name = data[pos + 1 : pos + 1 + size].decode("utf-8")
        offset, stored, crc, flags = struct.unpack_from("<IIIB", data, pos + 1 + size)
        pos += 1 + size + 13
        raw = data[offset : offset + stored]
        if flags & 1:
            key = (index * 31 + 7) & 0xFF
            raw = bytes(b ^ key for b in raw)
        if flags & 2:
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                pass
        if zlib.crc32(raw) != crc:
            bad.append(name)
        path = os.path.join(out_dir, *name.split("/"))
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "wb") as f:
            f.write(raw)
    return count, bad


if __name__ == "__main__":
    count, bad = unpack(sys.argv[1], sys.argv[2])
    sys.stdout.reconfigure(encoding="utf-8")
    for name in bad:
        print("corrupt:", name)
    sys.exit(1 if bad else 0)
