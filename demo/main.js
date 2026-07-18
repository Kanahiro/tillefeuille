import "maplibre-gl/dist/maplibre-gl.css";
import { mergeVectorTiles } from "../src/index.ts";
import { listMvtLayers } from "./mvt.js";

const maplibreglModule = await import("maplibre-gl");
const maplibregl = maplibreglModule.default ?? maplibreglModule;

const defaultSources = {
  osm: {
    url: "pmtiles://https://tile.openstreetmap.jp/static/planet.pmtiles",
    layers: { include: ["poi"] }
  },
  gsi: {
    url: "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf",
    layers: { exclude: ["label"] }
  }
};

let sources = { ...defaultSources };
let map;

const layerGeometryTypes = new Map();
const inspectLayerIds = new Set();

const sourceInput = document.querySelector("#sources");
const inspect = document.querySelector("#inspect");
const apply = document.querySelector("#apply");
const reset = document.querySelector("#reset");

sourceInput.value = JSON.stringify(defaultSources, null, 2);
apply.addEventListener("click", applySources);
reset.addEventListener("click", resetSources);

installProtocol();
createMap();

function installProtocol() {
  try {
    maplibregl.removeProtocol("tillefeuille");
  } catch {
    // Protocol may not have been registered yet.
  }

  maplibregl.addProtocol("tillefeuille", async (params, abortController) => {
    const { z, x, y } = parseTileUrl(params.url);
    const tile = await mergeVectorTiles({
      z,
      x,
      y,
      sources,
      fetch,
      signal: abortController.signal
    });

    ensureInspectLayers(listMvtLayers(tile));

    const data = tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength);
    return { data };
  });
}

function createMap() {
  map = new maplibregl.Map({
    container: "map",
    center: [139.76, 35.68],
    zoom: 12,
    maxZoom: 16,
    style: makeStyle(),
    attributionControl: false
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "PMTiles from tile.openstreetmap.jp / GSI"
    }),
    "bottom-right"
  );

  map.on("load", () => {
    seedInspectLayersForView();
  });

  map.on("moveend", () => {
    seedInspectLayersForView();
  });

  map.on("click", (event) => {
    const layerIds = [...inspectLayerIds].filter((id) => map.getLayer(id));
    const features = map.queryRenderedFeatures(event.point, { layers: layerIds });
    showFeatureInspect(features);
  });

  map.on("mousemove", (event) => {
    const layerIds = [...inspectLayerIds].filter((id) => map.getLayer(id));
    map.getCanvas().style.cursor = map.queryRenderedFeatures(event.point, { layers: layerIds }).length > 0 ? "pointer" : "";
  });

  map.on("error", (event) => {
    inspect.textContent = event?.error?.message ?? String(event?.error ?? "Unknown map error");
  });
}

async function seedInspectLayersForView() {
  if (!map?.getSource("merged")) {
    return;
  }

  try {
    const { z, x, y } = centerTile();
    const tile = await mergeVectorTiles({ z, x, y, sources, fetch });
    ensureInspectLayers(listMvtLayers(tile));
  } catch (error) {
    inspect.textContent = error instanceof Error ? error.message : String(error);
  }
}

function makeStyle() {
  return {
    version: 8,
    sources: {
      merged: {
        type: "vector",
        tiles: ["tillefeuille://tiles/{z}/{x}/{y}.mvt"],
        minzoom: 0,
        maxzoom: 14
      }
    },
    layers: [{ id: "background", type: "background", paint: { "background-color": "#eef2f6" } }]
  };
}

function ensureInspectLayers(layerInfos) {
  if (!map?.getSource("merged")) {
    return;
  }

  for (const layerInfo of layerInfos) {
    const layerName = layerInfo.name;
    const existingTypes = layerGeometryTypes.get(layerName) ?? new Set();
    const nextTypes = new Set([...existingTypes, ...layerInfo.geometryTypes]);
    layerGeometryTypes.set(layerName, nextTypes);

    const color = colorForLayer(layerName);
    const safeName = encodeURIComponent(layerName);

    if (nextTypes.has("Polygon")) {
      addInspectLayer({
        id: `inspect-fill-${safeName}`,
        type: "fill",
        source: "merged",
        "source-layer": layerName,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": color,
          "fill-opacity": 0.28,
          "fill-outline-color": color
        }
      });
    }

    if (nextTypes.has("LineString")) {
      addInspectLayer({
        id: `inspect-line-${safeName}`,
        type: "line",
        source: "merged",
        "source-layer": layerName,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.3, 16, 4.5],
          "line-opacity": 0.9
        }
      });
    }

    if (nextTypes.has("Point")) {
      addInspectLayer({
        id: `inspect-circle-${safeName}`,
        type: "circle",
        source: "merged",
        "source-layer": layerName,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": color,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.8, 12, 3, 16, 6],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1
        }
      });
    }
  }

}

function addInspectLayer(layer) {
  if (map.getLayer(layer.id)) {
    return;
  }

  map.addLayer(layer);
  inspectLayerIds.add(layer.id);
}

function applySources() {
  try {
    const nextSources = JSON.parse(sourceInput.value);
    if (!nextSources || typeof nextSources !== "object" || Array.isArray(nextSources)) {
      throw new Error("Sources must be an object");
    }
    sources = nextSources;
    resetInspectState();
    map.getSource("merged").setTiles(["tillefeuille://tiles/{z}/{x}/{y}.mvt?rev=" + Date.now()]);
    seedInspectLayersForView();
    map.triggerRepaint();
  } catch (error) {
    inspect.textContent = error instanceof Error ? error.message : String(error);
  }
}

function resetSources() {
  sourceInput.value = JSON.stringify(defaultSources, null, 2);
  applySources();
}

function resetInspectState() {
  for (const layerId of inspectLayerIds) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  }

  inspectLayerIds.clear();
  layerGeometryTypes.clear();
  inspect.textContent = "Click a feature on the map.";
}

function parseTileUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/^\//, "").replace(/\.mvt$/, "").split("/");
  if (parts.length !== 3) {
    throw new Error(`Invalid tillefeuille tile URL: ${url}`);
  }
  return {
    z: Number(parts[0]),
    x: Number(parts[1]),
    y: Number(parts[2])
  };
}

function centerTile() {
  const center = map.getCenter();
  const z = Math.max(0, Math.min(14, Math.floor(map.getZoom())));
  const n = 2 ** z;
  const x = Math.floor(((center.lng + 180) / 360) * n);
  const latRad = (center.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    z,
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y))
  };
}

function showFeatureInspect(features) {
  if (features.length === 0) {
    inspect.textContent = "No rendered features at this point.";
    return;
  }

  const summary = features.slice(0, 12).map((feature) => ({
    layer: feature.sourceLayer,
    geometry: feature.geometry?.type,
    properties: feature.properties
  }));
  inspect.textContent = JSON.stringify(summary, null, 2);
}

function colorForLayer(layerName) {
  let hash = 0;
  for (let i = 0; i < layerName.length; i++) {
    hash = (hash * 31 + layerName.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 62% 45%)`;
}
