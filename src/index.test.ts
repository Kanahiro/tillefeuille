import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decompressIfGzip } from "./compression.js";
import { mergeVectorTiles } from "./index.js";
import { listMvtLayerNames, makeMvt, makePMTilesArchive, makeRangeFetch } from "./test-helpers.js";

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body;
  if (!stream) {
    throw new Error("Unable to create compression stream");
  }
  const compressed = stream.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

describe("mergeVectorTiles", () => {
  it("fetches HTTP URL templates and prefixes layer names", async () => {
    const files = {
      "https://tiles.example/roads/14/1/2.mvt": makeMvt(["transportation"]),
      "https://tiles.example/water/14/1/2.mvt": makeMvt(["water"])
    };

    const tile = await mergeVectorTiles({
      z: 14,
      x: 1,
      y: 2,
      sources: {
        roads: "https://tiles.example/roads/{z}/{x}/{y}.mvt",
        water: "https://tiles.example/water/{z}/{x}/{y}.mvt"
      },
      fetch: makeRangeFetch(files)
    });

    expect(listMvtLayerNames(tile)).toEqual(["roads:transportation", "water:water"]);
  });

  it("fetches sources in parallel", async () => {
    let releaseFirstFetch!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("roads")) {
        await firstFetch;
        return new Response(makeMvt(["transportation"]));
      }
      return new Response(makeMvt(["water"]));
    }) as typeof globalThis.fetch;

    const merging = mergeVectorTiles({
      z: 0,
      x: 0,
      y: 0,
      sources: {
        roads: "https://tiles.example/roads/{z}/{x}/{y}.mvt",
        water: "https://tiles.example/water/{z}/{x}/{y}.mvt"
      },
      fetch
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    releaseFirstFetch();

    expect(listMvtLayerNames(await merging)).toEqual(["roads:transportation", "water:water"]);
  });

  it("reads PMTiles archives through range requests", async () => {
    const archive = makePMTilesArchive(3, 4, 2, makeMvt(["boundary"]));

    const tile = await mergeVectorTiles({
      z: 3,
      x: 4,
      y: 2,
      sources: {
        admin: "pmtiles://https://tiles.example/admin.pmtiles"
      },
      fetch: makeRangeFetch({ "https://tiles.example/admin.pmtiles": archive })
    });

    expect(listMvtLayerNames(tile)).toEqual(["admin:boundary"]);
  });

  it("reads local PMTiles archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tillefeuille-"));
    const path = join(directory, "admin.pmtiles");
    await writeFile(path, makePMTilesArchive(3, 4, 2, makeMvt(["boundary"])));

    try {
      const tile = await mergeVectorTiles({
        z: 3,
        x: 4,
        y: 2,
        sources: { admin: `pmtiles://${pathToFileURL(path).href}` }
      });
      expect(listMvtLayerNames(tile)).toEqual(["admin:boundary"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads local MBTiles archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tillefeuille-"));
    const path = join(directory, "admin.mbtiles");
    const source = await gzip(makeMvt(["boundary"]));
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)");
    database
      .prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)")
      .run(3, 4, 2 ** 3 - 1 - 2, source);
    database.close();

    try {
      const tile = await mergeVectorTiles({
        z: 3,
        x: 4,
        y: 2,
        sources: { admin: `mbtiles://${pathToFileURL(path).href}` }
      });
      expect(listMvtLayerNames(tile)).toEqual(["admin:boundary"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-file MBTiles archives", async () => {
    await expect(
      mergeVectorTiles({
        z: 0,
        x: 0,
        y: 0,
        sources: { admin: "mbtiles://https://tiles.example/admin.mbtiles" }
      })
    ).rejects.toThrow("Only file:// URLs are supported");
  });

  it("accepts gzip-compressed source tiles", async () => {
    const source = await gzip(makeMvt(["poi"]));

    const tile = await mergeVectorTiles({
      z: 0,
      x: 0,
      y: 0,
      sources: {
        poi: "https://tiles.example/poi/{z}/{x}/{y}.mvt"
      },
      fetch: makeRangeFetch({ "https://tiles.example/poi/0/0/0.mvt": source })
    });

    expect(listMvtLayerNames(tile)).toEqual(["poi:poi"]);
  });
});
