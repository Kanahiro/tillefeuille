import { describe, expect, it, vi } from "vitest";
import { mergeMvtTiles } from "./mvt.js";
import { listMvtLayerNames, listMvtLayers, makeLayer, makeMvt } from "./test-helpers.js";
import { concatBytes, writeVarint } from "./varint.js";

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
      version: 2,
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
    const logger = { warn: vi.fn() };
    const merged = mergeMvtTiles([
      { key: "a", tile: tile(makeLayer("roads", { extent: 4096 })) },
      { key: "b", tile: tile(makeLayer("roads", { extent: 8192 })) }
    ], undefined, logger);

    expect(listMvtLayers(merged)).toEqual([
      { name: "roads", extent: 4096, version: 2, keys: [], values: [], features: [] }
    ]);
    expect(logger.warn).toHaveBeenCalledWith({
      code: "incompatible-layer",
      layerName: "roads",
      sourceKey: "b",
      existingSourceKey: "a",
      reasons: ["extent"],
      version: { existing: 2, incoming: 2 },
      extent: { existing: 4096, incoming: 8192 }
    });
  });

  it("ignores duplicate scalar layer fields after the first occurrence", () => {
    const original = makeLayer("roads");
    const duplicateFields = concatBytes([
      writeVarint(10),
      writeVarint(7),
      new TextEncoder().encode("ignored"),
      writeVarint(40),
      writeVarint(8192),
      writeVarint(120),
      writeVarint(3)
    ]);
    const layer = concatBytes([original, duplicateFields]);
    const tile = concatBytes([writeVarint(26), writeVarint(layer.length), layer]);

    const merged = mergeMvtTiles([{ key: "source", tile }], (key, name) => `${key}:${name}`);

    expect(listMvtLayers(merged)).toEqual([
      { name: "source:roads", extent: 4096, version: 2, keys: [], values: [], features: [] }
    ]);
  });
});
