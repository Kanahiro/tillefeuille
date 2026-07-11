const WIRE_VARINT = 0;
const WIRE_64_BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32_BIT = 5;
const TILE_LAYER_FIELD = 3;
const LAYER_NAME_FIELD = 1;
const LAYER_FEATURE_FIELD = 2;
const FEATURE_TYPE_FIELD = 3;

export function listMvtLayers(tile) {
  const cursor = { bytes: tile, offset: 0 };
  const layers = [];

  while (cursor.offset < tile.length) {
    const key = readVarint(cursor);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (fieldNumber === TILE_LAYER_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const layer = readBytes(cursor, readVarint(cursor));
      const layerInfo = readLayerInfo(layer);
      if (layerInfo) layers.push(layerInfo);
      continue;
    }

    skipValue(cursor, wireType);
  }

  return layers;
}

function readLayerInfo(layer) {
  const cursor = { bytes: layer, offset: 0 };
  let name;
  const geometryTypes = new Set();

  while (cursor.offset < layer.length) {
    const key = readVarint(cursor);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (fieldNumber === LAYER_NAME_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      name = new TextDecoder().decode(readBytes(cursor, readVarint(cursor)));
      continue;
    }

    if (fieldNumber === LAYER_FEATURE_FIELD && wireType === WIRE_LENGTH_DELIMITED) {
      const geometryType = readFeatureGeometryType(readBytes(cursor, readVarint(cursor)));
      if (geometryType) geometryTypes.add(geometryType);
      continue;
    }

    skipValue(cursor, wireType);
  }

  return name ? { name, geometryTypes: [...geometryTypes] } : undefined;
}

function readFeatureGeometryType(feature) {
  const cursor = { bytes: feature, offset: 0 };

  while (cursor.offset < feature.length) {
    const key = readVarint(cursor);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;
    if (fieldNumber === FEATURE_TYPE_FIELD && wireType === WIRE_VARINT) return toGeometryType(readVarint(cursor));
    skipValue(cursor, wireType);
  }
}

function toGeometryType(value) {
  return ({ 1: "Point", 2: "LineString", 3: "Polygon" })[value];
}

function readVarint(cursor) {
  let value = 0;
  let shift = 0;
  while (true) {
    const byte = cursor.bytes[cursor.offset++];
    if (byte === undefined) throw new Error("Malformed protobuf message");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
}

function readBytes(cursor, length) {
  const end = cursor.offset + length;
  if (end > cursor.bytes.length) throw new Error("Malformed protobuf message");
  const bytes = cursor.bytes.subarray(cursor.offset, end);
  cursor.offset = end;
  return bytes;
}

function skipValue(cursor, wireType) {
  switch (wireType) {
    case WIRE_VARINT:
      readVarint(cursor);
      return;
    case WIRE_64_BIT:
      cursor.offset += 8;
      break;
    case WIRE_LENGTH_DELIMITED:
      readBytes(cursor, readVarint(cursor));
      return;
    case WIRE_32_BIT:
      cursor.offset += 4;
      break;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
  if (cursor.offset > cursor.bytes.length) throw new Error("Malformed protobuf message");
}
