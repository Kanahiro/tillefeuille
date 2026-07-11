import { decompressIfGzip, gzip } from "./compression.js";
import { mergeMvtTiles, renameMvtLayers } from "./mvt.js";
import { PMTilesReader, type RangeFetcher } from "./pmtiles.js";

export interface MergeVectorTilesOptions {
  z: number;
  x: number;
  y: number;
  sources: Record<string, string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  outputCompression?: "none" | "gzip";
  skipMissing?: boolean;
}

interface ResolveSourceOptions {
  z: number;
  x: number;
  y: number;
  url: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const defaultPMTilesReaders = new Map<string, PMTilesReader>();
const customPMTilesReaders = new WeakMap<typeof fetch, Map<string, PMTilesReader>>();

export async function mergeVectorTiles(options: MergeVectorTilesOptions): Promise<Uint8Array> {
  const skipMissing = options.skipMissing ?? true;
  const renamedTiles: Uint8Array[] = [];

  for (const [id, sourceUrl] of Object.entries(options.sources)) {
    const tile = await fetchSourceTile({
      z: options.z,
      x: options.x,
      y: options.y,
      url: sourceUrl,
      fetch: options.fetch,
      signal: options.signal
    });

    if (!tile) {
      if (skipMissing) {
        continue;
      }
      throw new Error(`Source tile not found: ${id}`);
    }

    renamedTiles.push(renameMvtLayers(tile, id));
  }

  const merged = mergeMvtTiles(renamedTiles);
  return options.outputCompression === "gzip" ? gzip(merged) : merged;
}

async function fetchSourceTile(options: ResolveSourceOptions): Promise<Uint8Array | undefined> {
  if (options.url.startsWith("pmtiles://")) {
    const archiveUrl = options.url.slice("pmtiles://".length);
    const reader = getPMTilesReader(archiveUrl, options.fetch);
    return reader.getZxy(options.z, options.x, options.y, options.signal);
  }

  const url = expandTileUrlTemplate(options.url, options.z, options.x, options.y);
  const response = await (options.fetch ?? fetch)(url, { signal: options.signal });

  if (response.status === 404 || response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch tile: HTTP ${response.status}`);
  }

  return decompressIfGzip(new Uint8Array(await response.arrayBuffer()));
}

function expandTileUrlTemplate(template: string, z: number, x: number, y: number): string {
  if (!template.startsWith("http://") && !template.startsWith("https://")) {
    throw new Error(`Unsupported source URL: ${template}`);
  }

  for (const token of ["{z}", "{x}", "{y}"]) {
    if (!template.includes(token)) {
      throw new Error(`HTTP source URL template must include ${token}`);
    }
  }

  return template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
}

function getPMTilesReader(url: string, fetchImpl: typeof fetch | undefined): PMTilesReader {
  if (!fetchImpl) {
    let reader = defaultPMTilesReaders.get(url);
    if (!reader) {
      reader = new PMTilesReader(url);
      defaultPMTilesReaders.set(url, reader);
    }
    return reader;
  }

  let readers = customPMTilesReaders.get(fetchImpl);
  if (!readers) {
    readers = new Map();
    customPMTilesReaders.set(fetchImpl, readers);
  }

  let reader = readers.get(url);
  if (!reader) {
    reader = new PMTilesReader(url, makeRangeFetcher(fetchImpl));
    readers.set(url, reader);
  }
  return reader;
}

function makeRangeFetcher(fetchImpl: typeof fetch = fetch): RangeFetcher {
  return async (url, offset, length, signal) => {
    const headers = new Headers();
    headers.set("Range", `bytes=${offset}-${offset + length - 1}`);

    const response = await fetchImpl(url, { headers, signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch range ${offset}-${offset + length - 1}: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200 && bytes.length > length) {
      throw new Error("Server did not honor range request");
    }
    return bytes;
  };
}
