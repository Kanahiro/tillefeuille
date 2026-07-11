import { concatBytes, readVarint, writeVarint, type Cursor } from "./varint.js";

const WIRE_VARINT = 0;
const WIRE_64_BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32_BIT = 5;
const TILE_LAYER_FIELD = 3;
const LAYER_NAME_FIELD = 1;

export function renameMvtLayers(tile: Uint8Array, prefix: string): Uint8Array {
  const cursor: Cursor = { bytes: tile, offset: 0 };
  const out: Uint8Array[] = [];

  while (cursor.offset < tile.length) {
    const fieldStart = cursor.offset;
    const key = readVarint(cursor);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (fieldNumber === TILE_LAYER_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const layerLength = readVarint(cursor);
      const layerStart = cursor.offset;
      const layerEnd = layerStart + layerLength;
      ensureWithin(tile, layerEnd);

      const renamedLayer = renameLayer(tile.subarray(layerStart, layerEnd), prefix);
      out.push(writeVarint(key), writeVarint(renamedLayer.length), renamedLayer);
      cursor.offset = layerEnd;
      continue;
    }

    skipValue(cursor, wireType);
    out.push(tile.subarray(fieldStart, cursor.offset));
  }

  return concatBytes(out);
}

export function mergeMvtTiles(tiles: Uint8Array[]): Uint8Array {
  return concatBytes(tiles);
}

function renameLayer(layer: Uint8Array, prefix: string): Uint8Array {
  const cursor: Cursor = { bytes: layer, offset: 0 };
  const out: Uint8Array[] = [];
  let renamed = false;

  while (cursor.offset < layer.length) {
    const fieldStart = cursor.offset;
    const key = readVarint(cursor);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (!renamed && fieldNumber === LAYER_NAME_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const nameLength = readVarint(cursor);
      const nameStart = cursor.offset;
      const nameEnd = nameStart + nameLength;
      ensureWithin(layer, nameEnd);

      const originalName = new TextDecoder().decode(layer.subarray(nameStart, nameEnd));
      const renamedName = new TextEncoder().encode(`${prefix}:${originalName}`);
      out.push(writeVarint(key), writeVarint(renamedName.length), renamedName);
      cursor.offset = nameEnd;
      renamed = true;
      continue;
    }

    skipValue(cursor, wireType);
    out.push(layer.subarray(fieldStart, cursor.offset));
  }

  return concatBytes(out);
}

function skipValue(cursor: Cursor, wireType: number): void {
  switch (wireType) {
    case WIRE_VARINT:
      readVarint(cursor);
      return;
    case WIRE_64_BIT:
      cursor.offset += 8;
      ensureWithin(cursor.bytes, cursor.offset);
      return;
    case WIRE_LENGTH_DELIMITED: {
      const length = readVarint(cursor);
      cursor.offset += length;
      ensureWithin(cursor.bytes, cursor.offset);
      return;
    }
    case WIRE_32_BIT:
      cursor.offset += 4;
      ensureWithin(cursor.bytes, cursor.offset);
      return;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function ensureWithin(bytes: Uint8Array, offset: number): void {
  if (offset > bytes.length) {
    throw new Error("Malformed protobuf message");
  }
}
