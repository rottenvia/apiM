# TLV-X wire format, version 1

TLV-X is the compact binary envelope our field devices use to report
telemetry. A message carries one *root map*: a set of numbered fields whose
values can be null, booleans, integers, byte strings, text, lists and nested
maps.

All multi-byte fixed-width numbers are **big-endian** (most significant
byte first). Bits are numbered 7 (most significant) to 0.

## 1. Message layout

```
+-------+-------+---------+-------+-------------+----------+-----------+
| 0xB7  | 0x1E  | version | flags | body length |   body   |  CRC-16   |
| 1 B   | 1 B   |   1 B   |  1 B  |   varint    | N bytes  | 2 B (opt) |
+-------+-------+---------+-------+-------------+----------+-----------+
```

* **magic**: the two bytes `B7 1E`.
* **version**: `0x01`. Any other value is unsupported.
* **flags**:
  * bit 0 (`0x01`): a CRC trailer is present.
  * bits 1-7 are reserved. Encoders MUST write them as 0 and decoders MUST
    reject a message that has any of them set.
* **body length**: a varint (section 2), the number of body bytes N.
* **body**: the items of the root map (section 3), exactly N bytes.
* **CRC**: present only if flag bit 0 is set. See section 5.

The message ends exactly after the CRC (or after the body when there is no
CRC). A message that is shorter or longer than its header says is invalid.

## 2. Varints

Lengths and extended field numbers are unsigned LEB128 varints: the value is
split into 7-bit groups, least significant group first. Each group is
written in the low 7 bits of a byte, and bit 7 of the byte is set when more
bytes follow.

    0     -> 00
    127   -> 7F
    128   -> 80 01
    300   -> AC 02
    16384 -> 80 80 01

Constraints (decoders MUST reject violations):

* at most **4 bytes**, so the largest value is 2^28 - 1 (268435455);
* **minimal form**: a varint of more than one byte must not end with a
  `00` byte (`80 00` is not a valid way to write 0).

## 3. Items

Every value is written as an item: a tag, optionally an extended field
number, then a type-specific payload.

### 3.1 Tag byte

```
  bit  7  6  5  4  3  2  1  0
      [ type  ][  field number  ]
```

* bits 7-5: the type code (table below);
* bits 4-0: the field number, 0-30. The value 31 means *extended*: the
  field number follows the tag as a varint. The extended form is only for
  field numbers of 31 and above, so an extended field number below 31 is
  invalid.

| code | type   | payload after the tag (and extended field number)                  |
|------|--------|--------------------------------------------------------------------|
| 0    | NULL   | nothing                                                            |
| 1    | BOOL   | one byte: `00` false, `01` true; any other value is invalid        |
| 2    | INT    | varint length L, then L bytes of two's complement, big-endian      |
| 3    | BYTES  | varint length L, then L raw bytes                                  |
| 4    | STRING | varint length L, then L bytes of UTF-8 (must be valid UTF-8)       |
| 5    | LIST   | varint length L, then L bytes of items (section 3.3)               |
| 6    | MAP    | varint length L, then L bytes of items (section 3.3)               |
| 7    | -      | reserved; invalid                                                  |

### 3.2 Integers

INT is a signed 64-bit integer. L must be 1, 2, 4 or 8, and it must be the
**smallest** of those widths that can hold the value: 127 is `01 7F`, 128 is
`02 00 80`, -128 is `01 80`, -129 is `02 FF 7F`. A decoder must reject any
other width, and an integer written wider than necessary.

### 3.3 Containers

The payload of a LIST or MAP is a sequence of items that fills exactly L
bytes. An item that would extend past the end of its container is invalid
(and so is one that extends past the end of the body).

* **LIST** items all have field number 0; any other field number is invalid.
  Order is significant.
* **MAP** items have field numbers of 1 or more (0 is invalid), and the field
  numbers must be **strictly increasing** within a map. So duplicate fields
  are invalid, and encoders write fields in ascending order.
* The body of the message is the root map: it follows the MAP rules.

### 3.4 Nesting depth

The root map is at depth 0; a LIST or MAP item inside it is at depth 1; an
item inside that one is at depth 2, and so on. Containers deeper than
**16** are invalid, both when encoding and when decoding.

## 4. Canonical encoding

There is exactly one valid encoding of any given value (plus the CRC choice):
minimal varints, short-form tags for fields below 31, the smallest INT
width, and ascending map fields. Decoders reject anything else as described
above.

## 5. CRC-16

The CRC covers every byte of the message before it (magic, version, flags,
body length and body). The algorithm is the CRC-16 with these parameters:

| parameter | value |
|-----------|-------|
| width     | 16 |
| polynomial | 0x1021 |
| initial value | 0xFFFF |
| input reflected | yes |
| output reflected | yes |
| final XOR | 0xFFFF |
| check value (CRC of ASCII `123456789`) | 0x906E |

The 16-bit result is stored **big-endian**. A decoder must reject a message
whose CRC does not match.

## 6. Worked example

The root map `{1: "hi", 2: [1, -1], 40: true}` with a CRC:

```
B7 1E 01 01        magic, version 1, flags = CRC present
0F                 body length 15
81 02 68 69        STRING field 1, length 2, "hi"
A2 06              LIST field 2, length 6
   40 01 01        INT (field 0), length 1, 1
   40 01 FF        INT (field 0), length 1, -1
3F 28 01           BOOL, extended field number 40, true
87 C2              CRC-16
```

## 7. Python binding

The reference binding lives in `tlv.py`:

* `encode(message: dict, *, crc: bool = True) -> bytes`
* `decode(data: bytes) -> dict`
* `class TLVError(ValueError)`: raised for **every** invalid input in
  either direction; no other exception type may escape.

Type mapping:

| TLV-X  | Python |
|--------|--------|
| NULL   | `None` |
| BOOL   | `bool` |
| INT    | `int` (must fit in a signed 64-bit integer) |
| BYTES  | `bytes` (`bytearray` is accepted when encoding) |
| STRING | `str` |
| LIST   | `list` (`tuple` is accepted when encoding) |
| MAP    | `dict` whose keys are `int` field numbers 1 to 2^28 - 1 (not `bool`) |

The root passed to `encode` must be a dict and `decode` returns a dict.
`encode` raises `TLVError` for values it cannot represent: other types,
invalid keys, out-of-range integers, strings that are not valid Unicode
(lone surrogates), or nesting deeper than 16.
