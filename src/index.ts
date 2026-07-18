import { decompressIfGzip } from "./compression.js";
import { mergeMvtTiles, type MergeLogger } from "./mvt.js";
import { EtagMismatch, PMTiles, ResolvedValueCache } from "pmtiles";

export type { IncompatibleLayerWarning, MergeLogger } from "./mvt.js";

export interface MergeVectorTilesOptions {
  z: number;
  x: number;
  y: number;
  sources: Record<string, VectorTileSource>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  skipMissing?: boolean;
  getLayerName?: (key: string, layerName: string) => string;
  logger?: MergeLogger;
}

export interface VectorTileSource {
  url: string;
  minzoom?: number;
  maxzoom?: number;
  layers?: LayerFilter;
}

export interface LayerFilter {
  include?: readonly string[];
  exclude?: readonly string[];
}

interface ResolveSourceOptions {
  z: number;
  x: number;
  y: number;
  url: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

const resourcesByFetch = new WeakMap<typeof fetch, FetchResources>();

interface FetchResources {
  pmtilesReaders: Map<string, PMTiles>;
  inFlightTiles: Map<string, InFlightTile>;
}

interface InFlightTile {
  promise: Promise<Uint8Array | undefined>;
}

export async function mergeVectorTiles(options: MergeVectorTilesOptions): Promise<Uint8Array> {
  const skipMissing = options.skipMissing ?? true;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const tiles: Array<{
    key: string;
    tile: Uint8Array;
    includedLayerNames?: ReadonlySet<string>;
    excludedLayerNames: ReadonlySet<string>;
  }> = [];
  const sourceTiles = await Promise.all(
    Object.entries(options.sources)
      .filter(([, source]) => isSourceAvailableAtZoom(source, options.z))
      .map(async ([id, { url, layers }]) => ({
        id,
        includedLayerNames: layers?.include ? new Set(layers.include) : undefined,
        excludedLayerNames: new Set(layers?.exclude),
        tile: await fetchSourceTileSingleFlight({
          z: options.z,
          x: options.x,
          y: options.y,
          url,
          fetch: fetchImpl,
          signal: options.signal
        })
      }))
  );

  for (const { id, tile, includedLayerNames, excludedLayerNames } of sourceTiles) {
    if (!tile) {
      if (skipMissing) {
        continue;
      }
      throw new Error(`Source tile not found: ${id}`);
    }

    tiles.push({ key: id, tile, includedLayerNames, excludedLayerNames });
  }

  return mergeMvtTiles(tiles, options.getLayerName, options.logger);
}

function isSourceAvailableAtZoom(source: VectorTileSource, z: number): boolean {
  return (source.minzoom === undefined || z >= source.minzoom) && (source.maxzoom === undefined || z <= source.maxzoom);
}

async function fetchSourceTile(options: ResolveSourceOptions): Promise<Uint8Array | undefined> {
  if (options.url.startsWith("pmtiles://")) {
    const archiveUrl = options.url.slice("pmtiles://".length);
    const reader = getPMTilesReader(archiveUrl, options.fetch);
    const tile = await reader.getZxy(options.z, options.x, options.y, options.signal);
    return tile ? new Uint8Array(tile.data) : undefined;
  }

  const url = expandTileUrlTemplate(options.url, options.z, options.x, options.y);
  const response = await options.fetch(url, { signal: options.signal });

  if (response.status === 404 || response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch tile: HTTP ${response.status}`);
  }

  return decompressIfGzip(new Uint8Array(await response.arrayBuffer()));
}

function fetchSourceTileSingleFlight(options: ResolveSourceOptions): Promise<Uint8Array | undefined> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }

  const key = getTileRequestKey(options);
  const inFlightTiles = getFetchResources(options.fetch).inFlightTiles;
  let inFlight = inFlightTiles.get(key);

  if (!inFlight) {
    inFlight = {
      promise: Promise.resolve(undefined)
    };
    inFlight.promise = fetchSourceTile({ ...options, signal: undefined }).finally(() => {
      if (inFlightTiles.get(key) === inFlight) {
        inFlightTiles.delete(key);
      }
    });
    inFlightTiles.set(key, inFlight);
  }

  return waitForInFlightTile(inFlight.promise, options.signal);
}

function getTileRequestKey(options: ResolveSourceOptions): string {
  if (options.url.startsWith("pmtiles://")) {
    return `${options.url}|${options.z}|${options.x}|${options.y}`;
  }
  return expandTileUrlTemplate(options.url, options.z, options.x, options.y);
}

function getFetchResources(fetchImpl: typeof fetch): FetchResources {
  let resources = resourcesByFetch.get(fetchImpl);
  if (!resources) {
    resources = { pmtilesReaders: new Map(), inFlightTiles: new Map() };
    resourcesByFetch.set(fetchImpl, resources);
  }
  return resources;
}

function waitForInFlightTile(
  promise: Promise<Uint8Array | undefined>,
  signal: AbortSignal | undefined
): Promise<Uint8Array | undefined> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
}
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (tile) => {
        finish();
        resolve(tile);
      },
      (error) => {
        finish();
        reject(error);
      }
    );
  });
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

function getPMTilesReader(url: string, fetchImpl: typeof fetch): PMTiles {
  const readers = getFetchResources(fetchImpl).pmtilesReaders;
  let reader = readers.get(url);
  if (!reader) {
    reader = new PMTiles(makeFetchSource(url, fetchImpl), new ResolvedValueCache());
    readers.set(url, reader);
  }
  return reader;
}

function makeFetchSource(url: string, fetchImpl: typeof fetch) {
  return {
    getKey: () => url,
    getBytes: async (offset: number, length: number, signal?: AbortSignal, etag?: string) => {
      const headers = new Headers();
      headers.set("Range", `bytes=${offset}-${offset + length - 1}`);

      const response = await fetchImpl(url, { headers, signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch range ${offset}-${offset + length - 1}: HTTP ${response.status}`);
      }

      const data = await response.arrayBuffer();
      const responseEtag = response.headers.get("ETag") ?? undefined;
      if (etag && responseEtag && responseEtag !== etag) {
        throw new EtagMismatch(`PMTiles archive changed while reading: ${url}`);
      }

      const bytes = new Uint8Array(data);
      if (response.status === 200 && bytes.length > length) {
        throw new Error("Server did not honor range request");
      }
      return {
        data,
        etag: responseEtag,
        cacheControl: response.headers.get("Cache-Control") ?? undefined,
        expires: response.headers.get("Expires") ?? undefined
      };
    }
  };
}
