"""Hidden test vectors for tlv.py (produced by the reference implementation)."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

if len(sys.argv) == 1:
    # run the real work in a child so a hang or crash in tlv.py can't wedge the check
    try:
        r = subprocess.run([sys.executable, __file__, "--worker"], capture_output=True, text=True, timeout=60)
        sys.stdout.write(r.stdout)
        sys.stdout.write(r.stderr[-2000:])
        sys.exit(r.returncode)
    except subprocess.TimeoutExpired:
        print("FAIL: tlv.py did not finish within 60s (infinite loop?)")
        print("SCORE 0/1")
        sys.exit(1)

sys.path.insert(0, os.getcwd())
V = json.load(open(os.path.join(HERE, "vectors.json"), encoding="utf-8"))
SAFE = {"__builtins__": {}, "bytearray": bytearray}

cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


def same(a, b):
    """Equality that also distinguishes bool from int and bytes from str."""
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    return a == b


def short(x, n=160):
    s = repr(x)
    return s if len(s) <= n else s[:n] + "..."


total_expected = len(V["valid"]) * 2 + len(V["invalid_decode"]) + len(V["invalid_encode"]) + len(V["encode_equiv"]) + 1
try:
    import tlv
    TLVError = tlv.TLVError
except Exception as e:  # noqa: BLE001
    print(f"FAIL cannot import tlv: {type(e).__name__}: {e}")
    print(f"SCORE 0/{total_expected}")
    sys.exit(1)

expect("TLVError is a ValueError subclass", isinstance(TLVError, type) and issubclass(TLVError, ValueError))

for v in V["valid"]:
    value = eval(v["value"], SAFE)
    data = bytes.fromhex(v["hex"])
    try:
        got = tlv.decode(data)
        expect(f"decode: {v['name']}", same(got, value), f"got {short(got)}, want {short(value)}")
    except Exception as e:  # noqa: BLE001
        expect(f"decode: {v['name']}", False, f"raised {type(e).__name__}: {e}")
    try:
        enc = tlv.encode(value, crc=v["crc"])
        ok = isinstance(enc, (bytes, bytearray)) and bytes(enc) == data
        expect(f"encode: {v['name']} (crc={v['crc']})", ok,
               f"got {bytes(enc).hex()[:120] if isinstance(enc, (bytes, bytearray)) else short(enc)}, want {v['hex'][:120]}")
    except Exception as e:  # noqa: BLE001
        expect(f"encode: {v['name']} (crc={v['crc']})", False, f"raised {type(e).__name__}: {e}")

for v in V["invalid_decode"]:
    data = bytes.fromhex(v["hex"])
    try:
        got = tlv.decode(data)
        expect(f"reject on decode: {v['name']}", False, f"accepted {data.hex()} -> {short(got)}")
    except TLVError:
        expect(f"reject on decode: {v['name']}", True)
    except Exception as e:  # noqa: BLE001
        expect(f"reject on decode: {v['name']}", False, f"raised {type(e).__name__} instead of TLVError")

for v in V["invalid_encode"]:
    value = eval(v["value"], SAFE)
    try:
        got = tlv.encode(value)
        expect(f"reject on encode: {v['name']}", False, f"produced {bytes(got).hex()[:80]}")
    except TLVError:
        expect(f"reject on encode: {v['name']}", True)
    except Exception as e:  # noqa: BLE001
        expect(f"reject on encode: {v['name']}", False, f"raised {type(e).__name__} instead of TLVError")

for v in V["encode_equiv"]:
    try:
        a, b = tlv.encode(eval(v["a"], SAFE)), tlv.encode(eval(v["b"], SAFE))
        expect(v["name"], bytes(a) == bytes(b), f"{bytes(a).hex()} != {bytes(b).hex()}")
    except Exception as e:  # noqa: BLE001
        expect(v["name"], False, f"raised {type(e).__name__}: {e}")

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
