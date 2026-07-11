import { Compression, decompress } from "./compression.js";
import { readVarint, type Cursor } from "./varint.js";

const HEADER_LENGTH = 127;
const INITIAL_READ_LENGTH = 16_384;
const MAGIC = "PMTiles";

interface Header {
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  leafDirectoryOffset: number;
  tileDataOffset: number;
  internalCompression: Compression;
  tileCompression: Compression;
  minZoom: number;
  maxZoom: number;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

export interface RangeFetcher {
  (url: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export class PMTilesReader {
  private header?: Header;
  private rootDirectory?: Entry[];
  private readonly directoryCache = new Map<string, Entry[]>();

  constructor(
    private readonly url: string,
    private readonly rangeFetcher: RangeFetcher = fetchRange
  ) {}

  async getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const header = await this.getHeader(signal);

    if (z < header.minZoom || z > header.maxZoom) {
      return undefined;
    }

    const tileId = zxyToTileId(z, x, y);
    let directoryOffset = header.rootDirectoryOffset;
    let directoryLength = header.rootDirectoryLength;

    for (let depth = 0; depth <= 3; depth++) {
      const directory =
        depth === 0
          ? await this.getRootDirectory(signal)
          : await this.getDirectory(directoryOffset, directoryLength, header, signal);
      const entry = findTile(directory, tileId);

      if (!entry) {
        return undefined;
      }

      if (entry.runLength > 0) {
        const tile = await this.rangeFetcher(this.url, header.tileDataOffset + entry.offset, entry.length, signal);
        return decompress(tile, header.tileCompression);
      }

      directoryOffset = header.leafDirectoryOffset + entry.offset;
      directoryLength = entry.length;
    }

    throw new Error("Maximum PMTiles directory depth exceeded");
  }

  private async getHeader(signal?: AbortSignal): Promise<Header> {
    if (this.header) {
      return this.header;
    }

    const initial = await this.rangeFetcher(this.url, 0, INITIAL_READ_LENGTH, signal);
    const headerBytes = initial.subarray(0, HEADER_LENGTH);
    const header = parseHeader(headerBytes);
    const rootEnd = header.rootDirectoryOffset + header.rootDirectoryLength;
    const rootBytes =
      rootEnd <= initial.length
        ? initial.subarray(header.rootDirectoryOffset, rootEnd)
        : await this.rangeFetcher(this.url, header.rootDirectoryOffset, header.rootDirectoryLength, signal);
    this.rootDirectory = deserializeDirectory(await decompress(rootBytes, header.internalCompression));
    this.header = header;
    return header;
  }

  private async getRootDirectory(signal?: AbortSignal): Promise<Entry[]> {
    if (this.rootDirectory) {
      return this.rootDirectory;
    }

    const header = await this.getHeader(signal);
    return this.getDirectory(header.rootDirectoryOffset, header.rootDirectoryLength, header, signal);
  }

  private async getDirectory(offset: number, length: number, header: Header, signal?: AbortSignal): Promise<Entry[]> {
    const key = `${offset}:${length}`;
    const cached = this.directoryCache.get(key);
    if (cached) {
      return cached;
    }

    const bytes = await this.rangeFetcher(this.url, offset, length, signal);
    const directory = deserializeDirectory(await decompress(bytes, header.internalCompression));
    this.directoryCache.set(key, directory);
    return directory;
  }
}

export async function fetchRange(
  url: string,
  offset: number,
  length: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const headers = new Headers();
  headers.set("Range", `bytes=${offset}-${offset + length - 1}`);

  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch range ${offset}-${offset + length - 1}: HTTP ${response.status}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200 && data.length > length) {
    throw new Error("Server did not honor range request");
  }

  return data;
}

function parseHeader(bytes: Uint8Array): Header {
  if (bytes.length < HEADER_LENGTH) {
    throw new Error("PMTiles header is truncated");
  }

  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (magic !== MAGIC) {
    throw new Error("Invalid PMTiles magic number");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(7);
  if (version !== 3) {
    throw new Error(`Unsupported PMTiles version: ${version}`);
  }

  return {
    rootDirectoryOffset: readUint64(view, 8),
    rootDirectoryLength: readUint64(view, 16),
    leafDirectoryOffset: readUint64(view, 40),
    tileDataOffset: readUint64(view, 56),
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101)
  };
}

function readUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 2 ** 32 + low;
  if (!Number.isSafeInteger(value)) {
    throw new Error("PMTiles offset exceeds JavaScript safe integer range");
  }
  return value;
}

function deserializeDirectory(bytes: Uint8Array): Entry[] {
  const cursor: Cursor = { bytes, offset: 0 };
  const entryCount = readVarint(cursor);
  const entries: Entry[] = [];
  let lastTileId = 0;

  for (let i = 0; i < entryCount; i++) {
    lastTileId += readVarint(cursor);
    entries.push({ tileId: lastTileId, offset: 0, length: 0, runLength: 1 });
  }

  for (const entry of entries) {
    entry.runLength = readVarint(cursor);
  }

  for (const entry of entries) {
    entry.length = readVarint(cursor);
  }

  for (let i = 0; i < entries.length; i++) {
    const value = readVarint(cursor);
    entries[i].offset = value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
  }

  return entries;
}

function findTile(entries: Entry[], tileId: number): Entry | undefined {
  let low = 0;
  let high = entries.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];

    if (tileId < entry.tileId) {
      high = mid - 1;
    } else if (tileId > entry.tileId) {
      low = mid + 1;
    } else {
      return entry;
    }
  }

  const previous = entries[high];
  if (!previous) {
    return undefined;
  }

  if (previous.runLength === 0) {
    return previous;
  }

  return tileId - previous.tileId < previous.runLength ? previous : undefined;
}

function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx !== 0) {
      return [n - 1 - y, n - 1 - x];
    }
    return [y, x];
  }

  return [x, y];
}

export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) {
    throw new Error("Tile zoom level exceeds max safe number limit (26)");
  }
  if (x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) {
    throw new Error("Tile x/y outside zoom level bounds");
  }

  let acc = ((1 << z) * (1 << z) - 1) / 3;
  let a = z - 1;
  let tx = x;
  let ty = y;

  for (let s = 1 << a; s > 0; s >>= 1) {
    const rx = tx & s;
    const ry = ty & s;
    acc += ((3 * rx) ^ ry) * (1 << a);
    [tx, ty] = rotate(s, tx, ty, rx, ry);
    a--;
  }

  return acc;
}
