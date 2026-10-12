# PAK1 archives

All numbers are little-endian, no padding anywhere.

## Header (10 bytes)

| bytes | what |
|---|---|
| 4 | the letters `PAK1` |
| 2 | format version, 2 |
| 4 | number of entries |

## Entry table

Directly after the header, one record per entry, in order:

| bytes | what |
|---|---|
| 1 | length of the name in bytes |
| n | the name, UTF-8, with `/` between folders |
| 4 | offset of the entry's stored bytes, from the start of the file |
| 4 | number of stored bytes |
| 4 | CRC-32 (the zlib/PNG one) of the entry's ORIGINAL content |
| 1 | flags |

## Flags

- bit 0 (value 1): the stored bytes are masked. Every byte is XORed with one key byte: `(index * 31 + 7) & 0xFF`, where index is the entry's position in the table, counting from 0.
- bit 1 (value 2): the content is zlib-compressed.

When both are set, the content was compressed first and masked after, so undo the mask first.

An entry whose content does not match its CRC is corrupt. Tools write what they could recover anyway and report the name.
