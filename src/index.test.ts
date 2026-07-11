import { describe, expect, it } from "vitest";
import { decompressIfGzip, gzip } from "./compression.js";
import { mergeVectorTiles } from "./index.js";
import { listMvtLayerNames } from "./mvt.js";
import { makeMvt, makePMTilesArchive, makeRangeFetch } from "./test-helpers.js";

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

  it("accepts gzip source tiles and can gzip output", async () => {
    const source = await gzip(makeMvt(["poi"]));

    const tile = await mergeVectorTiles({
      z: 0,
      x: 0,
      y: 0,
      sources: {
        poi: "https://tiles.example/poi/{z}/{x}/{y}.mvt"
      },
      fetch: makeRangeFetch({ "https://tiles.example/poi/0/0/0.mvt": source }),
      outputCompression: "gzip"
    });

    expect(listMvtLayerNames(await decompressIfGzip(tile))).toEqual(["poi:poi"]);
  });
});
