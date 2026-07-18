import { describe, expect, it } from "vitest";
import { mergeMvtTiles } from "./mvt.js";
import { listMvtLayerNames, listMvtLayers, makeLayer, makeMvt } from "./test-helpers.js";

describe("MVT wire operations", () => {
  it("keeps layer names unchanged by default", () => {
    const merged = mergeMvtTiles([{ key: "base", tile: makeMvt(["roads", "water"]) }]);

    expect(listMvtLayerNames(merged)).toEqual(["roads", "water"]);
  });

  it("renames layers and keeps the first layer when output names collide", () => {
    const merged = mergeMvtTiles(
      [
        { key: "a", tile: makeMvt(["roads", "water"]) },
        { key: "b", tile: makeMvt(["roads"]) }
      ],
      (key, layerName) => `${key}:${layerName}`
    );

    expect(listMvtLayerNames(merged)).toEqual(["a:roads", "a:water", "b:roads"]);
  });

  it("merges same-named layers, including features with different geometry types", () => {
    const roads = makeLayer("roads");
    const water = makeLayer("water");
    const tile = (layers: Uint8Array[]) => new Uint8Array(layers.flatMap((layer) => [26, layer.length, ...layer]));
    const merged = mergeMvtTiles([
      {
        key: "a",
        tile: tile([
          makeLayer("transport", {
            keys: ["kind"],
            values: ["road"],
            features: [{ tags: [0, 0], type: 2, geometry: [9, 0, 0, 10, 2, 0] }]
          }),
          roads
        ])
      },
      {
        key: "b",
        tile: tile([
          makeLayer("transport", {
            keys: ["kind"],
            values: ["river"],
            features: [{ tags: [0, 0], type: 3, geometry: [9, 0, 0, 18, 2, 0, 0, 2, 15] }]
          }),
          water
        ])
      }
    ]);

    expect(listMvtLayerNames(merged)).toEqual(["transport", "roads", "water"]);
    expect(listMvtLayers(merged)[0]).toEqual({
      name: "transport",
      extent: 4096,
      keys: ["kind"],
      values: ["road", "river"],
      features: [
        { tags: [0, 0], type: 2 },
        { tags: [0, 1], type: 3 }
      ]
    });
  });

  it("keeps the first layer when same-named layers use different extents", () => {
    const tile = (layer: Uint8Array) => new Uint8Array([26, layer.length, ...layer]);
    const merged = mergeMvtTiles([
      { key: "a", tile: tile(makeLayer("roads", { extent: 4096 })) },
      { key: "b", tile: tile(makeLayer("roads", { extent: 8192 })) }
    ]);

    expect(listMvtLayers(merged)).toEqual([
      { name: "roads", extent: 4096, keys: [], values: [], features: [] }
    ]);
  });
});
