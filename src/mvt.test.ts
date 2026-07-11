import { describe, expect, it } from "vitest";
import { listMvtLayerNames, listMvtLayers, mergeMvtTiles, renameMvtLayers } from "./mvt.js";
import { makeMvt, makeMvtWithGeometry } from "./test-helpers.js";

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

  it("lists feature geometry types per layer", () => {
    const tile = makeMvtWithGeometry([
      { name: "roads", geometryTypes: ["LineString"] },
      { name: "places", geometryTypes: ["Point"] },
      { name: "mixed", geometryTypes: ["LineString", "Polygon", "LineString"] }
    ]);

    expect(listMvtLayers(tile)).toEqual([
      { name: "roads", geometryTypes: ["LineString"] },
      { name: "places", geometryTypes: ["Point"] },
      { name: "mixed", geometryTypes: ["LineString", "Polygon"] }
    ]);
  });
});
