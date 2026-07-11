export interface Cursor {
  bytes: Uint8Array;
  offset: number;
}

export function readVarint(cursor: Cursor): number {
  let result = 0;
  let shift = 0;

  for (let i = 0; i < 10; i++) {
    if (cursor.offset >= cursor.bytes.length) {
      throw new Error("Unexpected end of varint");
    }

    const byte = cursor.bytes[cursor.offset++];

    if (shift < 28) {
      result += (byte & 0x7f) << shift;
    } else {
      result += (byte & 0x7f) * 2 ** shift;
    }

    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        throw new Error("Varint exceeds JavaScript safe integer range");
      }
      return result;
    }

    shift += 7;
  }

  throw new Error("Varint is longer than 10 bytes");
}

export function writeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid varint value: ${value}`);
  }

  const out: number[] = [];
  let current = value;

  while (current >= 0x80) {
    out.push((current % 0x80) | 0x80);
    current = Math.floor(current / 0x80);
  }

  out.push(current);
  return new Uint8Array(out);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}
