import { deflateRaw } from "node:zlib";
import { promisify } from "node:util";

const deflate = promisify(deflateRaw);

/**
 * Minimal ZIP writer.
 *
 * Written by hand rather than pulling in a dependency: the format's stored
 * and deflated entries are a few dozen lines, and a workspace download is not
 * worth another package in the tree.
 */

export interface ZipEntry {
  path: string;
  content: Buffer;
  modified: Date;
}

/** CRC-32, which ZIP requires per entry. Table built once on first use. */
let crcTable: Uint32Array | null = null;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[i] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP stores timestamps in the MS-DOS format, which starts at 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds a ZIP archive in memory.
 *
 * In memory is fine here: the workspace is capped at 2MB per file and 500
 * files, so the worst case is bounded and a stream would add complexity for
 * no benefit at this size.
 */
export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Forward slashes regardless of platform — a backslash in a ZIP path
    // produces a file literally named "src\app.js" on extraction.
    const nameBuf = Buffer.from(entry.path.split("\\").join("/"), "utf8");
    const crc = crc32(entry.content);

    let data: Buffer = Buffer.from(await deflate(entry.content));
    let method = 8; // deflate

    // Deflate can grow already-compressed data. Store it raw when that
    // happens, or the archive would be larger than the files.
    if (data.length >= entry.content.length) {
      data = entry.content;
      method = 0;
    }

    const { time, date } = dosDateTime(entry.modified);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, end]);
}
