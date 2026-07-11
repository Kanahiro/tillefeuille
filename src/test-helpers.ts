import { zxyToTileId } from "./pmtiles.js";
import { concatBytes, writeVarint } from "./varint.js";

const TILE_LAYER_KEY = (3 << 3) | 2;
const LAYER_NAME_KEY = (1 << 3) | 2;
const LAYER_FEATURE_KEY = (2 << 3) | 2;
const LAYER_VERSION_KEY = (15 << 3) | 0;
const LAYER_EXTENT_KEY = (5 << 3) | 0;
const FEATURE_TYPE_KEY = (3 << 3) | 0;

export type TestGeometryType = "Point" | "LineString" | "Polygon";

export function makeMvt(layerNames: string[]): Uint8Array {
  return concatBytes(
    layerNames.flatMap((name) => {
      const layer = makeLayer(name);
      return [writeVarint(TILE_LAYER_KEY), writeVarint(layer.length), layer];
    })
  );
}

export function makeMvtWithGeometry(layers: Array<{ name: string; geometryTypes: TestGeometryType[] }>): Uint8Array {
  return concatBytes(
    layers.flatMap((spec) => {
      const layer = makeLayer(spec.name, spec.geometryTypes);
      return [writeVarint(TILE_LAYER_KEY), writeVarint(layer.length), layer];
    })
  );
}

export function makeLayer(name: string, geometryTypes: TestGeometryType[] = []): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const parts = [
    writeVarint(LAYER_NAME_KEY),
    writeVarint(nameBytes.length),
    nameBytes
  ];

  for (const geometryType of geometryTypes) {
    const feature = makeFeature(geometryType);
    parts.push(writeVarint(LAYER_FEATURE_KEY), writeVarint(feature.length), feature);
  }

  parts.push(
    writeVarint(LAYER_VERSION_KEY),
    writeVarint(2),
    writeVarint(LAYER_EXTENT_KEY),
    writeVarint(4096)
  );

  return concatBytes(parts);
}

function makeFeature(geometryType: TestGeometryType): Uint8Array {
  return concatBytes([writeVarint(FEATURE_TYPE_KEY), writeVarint(toFeatureType(geometryType))]);
}

function toFeatureType(geometryType: TestGeometryType): number {
  switch (geometryType) {
    case "Point":
      return 1;
    case "LineString":
      return 2;
    case "Polygon":
      return 3;
  }
}

export function makePMTilesArchive(z: number, x: number, y: number, tile: Uint8Array, metadata: unknown = {}): Uint8Array {
  const tileId = zxyToTileId(z, x, y);
  const rootDirectory = serializeDirectory([{ tileId, offset: 0, length: tile.length, runLength: 1 }]);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);

  header.set(new TextEncoder().encode("PMTiles"), 0);
  view.setUint8(7, 3);
  setUint64(view, 8, 127);
  setUint64(view, 16, rootDirectory.length);
  setUint64(view, 24, 127 + rootDirectory.length);
  setUint64(view, 32, metadataBytes.length);
  setUint64(view, 40, 127 + rootDirectory.length + metadataBytes.length);
  setUint64(view, 48, 0);
  setUint64(view, 56, 127 + rootDirectory.length + metadataBytes.length);
  setUint64(view, 64, tile.length);
  setUint64(view, 72, 1);
  setUint64(view, 80, 1);
  setUint64(view, 88, 1);
  view.setUint8(96, 1);
  view.setUint8(97, 1);
  view.setUint8(98, 1);
  view.setUint8(99, 1);
  view.setUint8(100, z);
  view.setUint8(101, z);

  return concatBytes([header, rootDirectory, metadataBytes, tile]);
}

export function makeRangeFetch(files: Record<string, Uint8Array>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const file = files[url];
    if (!file) {
      return new Response(undefined, { status: 404 });
    }

    const range = new Headers(init?.headers).get("Range");
    if (!range) {
      return new Response(file);
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) {
      return new Response(undefined, { status: 400 });
    }

    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    return new Response(file.subarray(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Content-Length": String(end - start + 1)
      }
    });
  };
}

function serializeDirectory(entries: Array<{ tileId: number; offset: number; length: number; runLength: number }>): Uint8Array {
  const parts: Uint8Array[] = [writeVarint(entries.length)];
  let lastTileId = 0;

  for (const entry of entries) {
    parts.push(writeVarint(entry.tileId - lastTileId));
    lastTileId = entry.tileId;
  }

  for (const entry of entries) {
    parts.push(writeVarint(entry.runLength));
  }

  for (const entry of entries) {
    parts.push(writeVarint(entry.length));
  }

  let nextOffset = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    parts.push(writeVarint(i > 0 && entry.offset === nextOffset ? 0 : entry.offset + 1));
    nextOffset = entry.offset + entry.length;
  }

  return concatBytes(parts);
}

function setUint64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
}
