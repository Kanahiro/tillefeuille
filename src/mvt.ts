import { concatBytes, readVarint, writeVarint, type Cursor } from "./varint.js";

const WIRE_VARINT = 0;
const WIRE_64_BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32_BIT = 5;
const TILE_LAYER_FIELD = 3;
const LAYER_NAME_FIELD = 1;
const LAYER_FEATURES_FIELD = 2;
const LAYER_KEYS_FIELD = 3;
const LAYER_VALUES_FIELD = 4;
const LAYER_EXTENT_FIELD = 5;
const LAYER_VERSION_FIELD = 15;
const FEATURE_TAGS_FIELD = 2;

interface MvtTile {
  key: string;
  tile: Uint8Array;
}

interface ParsedLayer {
  name?: string;
  extent?: number;
  version?: number;
  keys: Uint8Array[];
  values: Uint8Array[];
  features: ParsedFeature[];
  unknownFields: Uint8Array[];
}

interface ParsedFeature {
  tags: number[];
  otherFields: Uint8Array[];
}

interface LayerGroup {
  layer: ParsedLayer;
  keys: Uint8Array[];
  values: Uint8Array[];
  keyIndexes: Map<string, number>;
  valueIndexes: Map<string, number>;
  features: Array<{ feature: ParsedFeature; keyIndexes: number[]; valueIndexes: number[] }>;
}

export function mergeMvtTiles(
  tiles: MvtTile[],
  getLayerName: (key: string, layerName: string) => string = (_key, layerName) => layerName
): Uint8Array {
  const groups: LayerGroup[] = [];
  const groupsByName = new Map<string, LayerGroup>();
  const tileFields: Uint8Array[] = [];

  for (const { key: sourceKey, tile } of tiles) {
    const cursor: Cursor = { bytes: tile, offset: 0 };

    while (cursor.offset < tile.length) {
      const fieldStart = cursor.offset;
      const fieldKey = readVarint(cursor);
      const fieldNumber = fieldKey >>> 3;
      const wireType = fieldKey & 0x07;

      if (fieldNumber !== TILE_LAYER_FIELD || wireType !== WIRE_LENGTH_DELIMITED) {
        skipValue(cursor, wireType);
        tileFields.push(tile.subarray(fieldStart, cursor.offset));
        continue;
      }

      const layer = parseLayer(readBytes(cursor, readVarint(cursor)), sourceKey, getLayerName);
      if (layer.name === undefined) {
        groups.push(createLayerGroup(layer));
        continue;
      }

      const existing = groupsByName.get(layer.name);
      if (existing && canMergeLayers(existing.layer, layer)) {
        appendLayer(existing, layer);
        continue;
      }
      if (!existing) {
        const group = createLayerGroup(layer);
        groups.push(group);
        groupsByName.set(layer.name, group);
      }
    }
  }

  return concatBytes([
    ...tileFields,
    ...groups.map((group) => wrapLayer(serializeLayer(group)))
  ]);
}

function parseLayer(
  bytes: Uint8Array,
  sourceKey: string,
  getLayerName: (key: string, layerName: string) => string
): ParsedLayer {
  const cursor: Cursor = { bytes, offset: 0 };
  const layer: ParsedLayer = { keys: [], values: [], features: [], unknownFields: [] };

  while (cursor.offset < bytes.length) {
    const fieldStart = cursor.offset;
    const fieldKey = readVarint(cursor);
    const fieldNumber = fieldKey >>> 3;
    const wireType = fieldKey & 0x07;

    if (fieldNumber === LAYER_NAME_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const name = decodeString(readBytes(cursor, readVarint(cursor)));
      if (layer.name === undefined) {
        layer.name = getLayerName(sourceKey, name);
      }
      continue;
    }
    if (fieldNumber === LAYER_FEATURES_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      layer.features.push(parseFeature(readBytes(cursor, readVarint(cursor))));
      continue;
    }
    if (fieldNumber === LAYER_KEYS_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      layer.keys.push(readBytes(cursor, readVarint(cursor)));
      continue;
    }
    if (fieldNumber === LAYER_VALUES_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      layer.values.push(readBytes(cursor, readVarint(cursor)));
      continue;
    }
    if (fieldNumber === LAYER_EXTENT_FIELD && wireType === WIRE_VARINT) {
      const extent = readVarint(cursor);
      if (layer.extent === undefined) {
        layer.extent = extent;
      }
      continue;
    }
    if (fieldNumber === LAYER_VERSION_FIELD && wireType === WIRE_VARINT) {
      const version = readVarint(cursor);
      if (layer.version === undefined) {
        layer.version = version;
      }
      continue;
    }

    skipValue(cursor, wireType);
    layer.unknownFields.push(bytes.subarray(fieldStart, cursor.offset));
  }

  return layer;
}

function parseFeature(bytes: Uint8Array): ParsedFeature {
  const cursor: Cursor = { bytes, offset: 0 };
  const tags: number[] = [];
  const otherFields: Uint8Array[] = [];

  while (cursor.offset < bytes.length) {
    const fieldStart = cursor.offset;
    const fieldKey = readVarint(cursor);
    const fieldNumber = fieldKey >>> 3;
    const wireType = fieldKey & 0x07;

    if (fieldNumber === FEATURE_TAGS_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const tagCursor: Cursor = { bytes: readBytes(cursor, readVarint(cursor)), offset: 0 };
      while (tagCursor.offset < tagCursor.bytes.length) {
        tags.push(readVarint(tagCursor));
      }
      continue;
    }

    skipValue(cursor, wireType);
    otherFields.push(bytes.subarray(fieldStart, cursor.offset));
  }

  if (tags.length % 2 !== 0) {
    throw new Error("Feature tags must contain key-value pairs");
  }
  return { tags, otherFields };
}

function createLayerGroup(layer: ParsedLayer): LayerGroup {
  const group: LayerGroup = {
    layer,
    keys: [],
    values: [],
    keyIndexes: new Map(),
    valueIndexes: new Map(),
    features: []
  };
  appendLayer(group, layer);
  return group;
}

function appendLayer(group: LayerGroup, layer: ParsedLayer): void {
  const keyIndexes = layer.keys.map((key) => addDictionaryEntry(group.keys, group.keyIndexes, key));
  const valueIndexes = layer.values.map((value) => addDictionaryEntry(group.values, group.valueIndexes, value));
  for (const feature of layer.features) {
    group.features.push({ feature, keyIndexes, valueIndexes });
  }
}

function addDictionaryEntry(entries: Uint8Array[], indexes: Map<string, number>, entry: Uint8Array): number {
  const encoded = encodeBytes(entry);
  const existing = indexes.get(encoded);
  if (existing !== undefined) {
    return existing;
  }
  const index = entries.length;
  entries.push(entry);
  indexes.set(encoded, index);
  return index;
}

function canMergeLayers(first: ParsedLayer, next: ParsedLayer): boolean {
  // Geometry command coordinates are meaningful only within a shared extent;
  // different MVT versions may also use an incompatible wire contract.
  return first.version !== undefined && first.version === next.version && first.extent !== undefined && first.extent === next.extent;
}

function serializeLayer(group: LayerGroup): Uint8Array {
  const { layer } = group;
  const out: Uint8Array[] = [];

  if (layer.version !== undefined) {
    out.push(writeFieldVarint(LAYER_VERSION_FIELD, layer.version));
  }
  if (layer.name !== undefined) {
    out.push(writeFieldBytes(LAYER_NAME_FIELD, new TextEncoder().encode(layer.name)));
  }
  for (const { feature, keyIndexes, valueIndexes } of group.features) {
    out.push(writeFieldBytes(LAYER_FEATURES_FIELD, serializeFeature(feature, keyIndexes, valueIndexes)));
  }
  for (const key of group.keys) {
    out.push(writeFieldBytes(LAYER_KEYS_FIELD, key));
  }
  for (const value of group.values) {
    out.push(writeFieldBytes(LAYER_VALUES_FIELD, value));
  }
  if (layer.extent !== undefined) {
    out.push(writeFieldVarint(LAYER_EXTENT_FIELD, layer.extent));
  }
  // Extensions have no generic merge rule, so retain those of the first layer.
  out.push(...layer.unknownFields);
  return concatBytes(out);
}

function serializeFeature(feature: ParsedFeature, keyIndexes: number[], valueIndexes: number[]): Uint8Array {
  const remappedTags: Uint8Array[] = [];

  for (let i = 0; i < feature.tags.length; i += 2) {
    const keyIndex = keyIndexes[feature.tags[i]];
    const valueIndex = valueIndexes[feature.tags[i + 1]];
    if (keyIndex === undefined || valueIndex === undefined) {
      throw new Error("Feature tag references a missing layer dictionary entry");
    }
    remappedTags.push(writeVarint(keyIndex), writeVarint(valueIndex));
  }

  if (remappedTags.length === 0) {
    return concatBytes(feature.otherFields);
  }
  return concatBytes([
    ...feature.otherFields,
    writeFieldBytes(FEATURE_TAGS_FIELD, concatBytes(remappedTags))
  ]);
}

function wrapLayer(layer: Uint8Array): Uint8Array {
  return writeFieldBytes(TILE_LAYER_FIELD, layer);
}

function writeFieldVarint(fieldNumber: number, value: number): Uint8Array {
  return concatBytes([writeVarint((fieldNumber << 3) | WIRE_VARINT), writeVarint(value)]);
}

function writeFieldBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes([writeVarint((fieldNumber << 3) | WIRE_LENGTH_DELIMITED), writeVarint(value.length), value]);
}

function readBytes(cursor: Cursor, length: number): Uint8Array {
  const end = cursor.offset + length;
  ensureWithin(cursor.bytes, end);
  const value = cursor.bytes.subarray(cursor.offset, end);
  cursor.offset = end;
  return value;
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeBytes(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += byte.toString(16).padStart(2, "0");
  }
  return encoded;
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
    case WIRE_LENGTH_DELIMITED:
      readBytes(cursor, readVarint(cursor));
      return;
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
