import { describe, expect, it } from "vitest";
import { mergeMvtTiles, renameMvtLayers } from "./mvt.js";
import { listMvtLayerNames, makeMvt } from "./test-helpers.js";

describe("MVT wire operations", () => {
  it("renames layer names without decoding features", () => {
    const tile = makeMvt(["roads", "water"]);

    const renamed = renameMvtLayers(tile, "base");

    expect(listMvtLayerNames(renamed)).toEqual(["base:roads", "base:water"]);
  });

  it("merges vector tiles by concatenating protobuf bytes", () => {
    const merged = mergeMvtTiles([renameMvtLayers(makeMvt(["roads"]), "a"), renameMvtLayers(makeMvt(["roads"]), "b")]);

    expect(listMvtLayerNames(merged)).toEqual(["a:roads", "b:roads"]);
  });
});
