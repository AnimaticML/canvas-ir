// Packs Natural Earth's GeoJSON into the playground's world map: tiles at four
// levels of detail, each simplified for its zoom, with coordinates as 16-bit
// numbers within their tile, gzipped into src/map/world.bin.
//
//   bun scripts/build-map.ts <folder of Natural Earth .geojson files>
//
// The files are those of github.com/nvkelso/natural-earth-vector/tree/master/geojson
// named in SOURCES below. Natural Earth is in the public domain.
import { gzipSync } from "node:zlib";

const folder = process.argv[2];
if (!folder) throw new Error("usage: bun scripts/build-map.ts <folder of Natural Earth .geojson files>");

type Ring = number[]; // x0, y0, x1, y1, ... in Web Mercator, 0 to 1 across the world
interface Feature {
  readonly rings: Ring[];
  readonly minZoom: number;
  readonly index: number;
}

/** The map's layers, in drawing order; the renderer keeps the same list. */
// No coastlines: the land's fill against the sea draws them.
const LAYERS = ["countries", "urban", "lakes", "states", "borders", "rivers", "roads"] as const;
type Layer = (typeof LAYERS)[number];
const FILLS = new Set<Layer>(["countries", "urban", "lakes"]);

/** Levels of detail: the zoom each is made for (256-pixel world at zoom 0), and its tiles' zoom. */
const LODS = [2, 4, 6, 8].map((zoom) => ({ zoom, tiles: zoom }));
/** The deepest zoom the map goes to, for the finest level's simplification. */
const MAX_ZOOM = 9;
/** The finest states and towns are left out, to keep the file small: they show only past MAX_ZOOM. */
const SKIP: Partial<Record<Layer, number>> = { states: 8, urban: 7 };

const mercator = (lon: number, lat: number): [number, number] => {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
};

const read = async (name: string): Promise<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null }[]> =>
  (await Bun.file(`${folder}/${name}.geojson`).json()).features;

/**
 * A polygon's rings, the outer one wound one way and the holes the other, so
 * the map fills them nonzero: tiles overlap a little at their edges, and an
 * even-odd fill would leave a gap where they do.
 */
const polygon = (rings: number[][][], line: (points: number[][]) => Ring): Ring[] =>
  rings.map((points, i) => {
    const ring = line(points);
    let area = 0;
    for (let j = 0, k = ring.length - 2; j < ring.length; k = j, j += 2) area += ring[k]! * ring[j + 1]! - ring[j]! * ring[k + 1]!;
    return (area > 0) === (i === 0) ? ring : reverse(ring);
  });

const reverse = (ring: Ring): Ring => {
  const out: Ring = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
};

/** A feature's rings (polygons) or lines, projected. */
const rings = (geometry: { type: string; coordinates: unknown } | null): Ring[] => {
  if (!geometry) return [];
  const line = (points: number[][]): Ring => points.flatMap(([lon, lat]) => mercator(lon!, lat!));
  const c = geometry.coordinates as never;
  switch (geometry.type) {
    case "LineString":
      return [line(c)];
    case "MultiLineString":
      return (c as number[][][]).map(line);
    case "Polygon":
      return polygon(c, line);
    case "MultiPolygon":
      return (c as number[][][][]).flatMap((p) => polygon(p, line));
    default:
      return [];
  }
};

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const prop = (p: Record<string, unknown>, ...keys: string[]): unknown => keys.map((k) => p[k] ?? p[k.toUpperCase()] ?? p[k.toLowerCase()]).find((v) => v !== undefined && v !== null);

/** Douglas-Peucker: drops points within `tolerance` of the line through their neighbors. */
const simplify = (ring: Ring, tolerance: number, closed: boolean): Ring => {
  const n = ring.length / 2;
  if (n <= (closed ? 4 : 2)) return ring;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ax = ring[2 * a]!;
    const ay = ring[2 * a + 1]!;
    const dx = ring[2 * b]! - ax;
    const dy = ring[2 * b + 1]! - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = ring[2 * i]! - ax;
      const py = ring[2 * i + 1]! - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > t2) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[2 * i]!, ring[2 * i + 1]!);
  return out;
};

/** Sutherland-Hodgman: a ring cut to a rectangle (a fill only, as it walks along the edges). */
const clipRing = (ring: Ring, x0: number, y0: number, x1: number, y1: number): Ring => {
  let points = ring;
  const edges: [(x: number, y: number) => boolean, (ax: number, ay: number, bx: number, by: number) => [number, number]][] = [
    [(x) => x >= x0, (ax, ay, bx, by) => [x0, ay + ((by - ay) * (x0 - ax)) / (bx - ax)]],
    [(x) => x <= x1, (ax, ay, bx, by) => [x1, ay + ((by - ay) * (x1 - ax)) / (bx - ax)]],
    [(_, y) => y >= y0, (ax, ay, bx, by) => [ax + ((bx - ax) * (y0 - ay)) / (by - ay), y0]],
    [(_, y) => y <= y1, (ax, ay, bx, by) => [ax + ((bx - ax) * (y1 - ay)) / (by - ay), y1]],
  ];
  for (const [inside, cross] of edges) {
    const out: Ring = [];
    const n = points.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = points[2 * ((i + n - 1) % n)]!;
      const ay = points[2 * ((i + n - 1) % n) + 1]!;
      const bx = points[2 * i]!;
      const by = points[2 * i + 1]!;
      const a = inside(ax, ay);
      const b = inside(bx, by);
      if (b) {
        if (!a) out.push(...cross(ax, ay, bx, by));
        out.push(bx, by);
      } else if (a) out.push(...cross(ax, ay, bx, by));
    }
    points = out;
    if (points.length === 0) break;
  }
  return points;
};

/** A tile's pieces: for each, its layer, feature and rings, in world coordinates. */
type Piece = { layer: number; feature: number; rings: Ring[] };

const bytes: number[] = [];
/** A signed integer in as few bytes as it needs: zigzag, then seven bits a byte. */
const varint = (v: number) => {
  let z = v < 0 ? -2 * v - 1 : 2 * v;
  while (z >= 128) {
    bytes.push((z % 128) | 128);
    z = Math.floor(z / 128);
  }
  bytes.push(z);
};

/** Layers with coarser files for the coarser levels. */
const sources: Partial<Record<Layer, readonly string[]>> = {
  countries: ["ne_110m_admin_0_countries", "ne_50m_admin_0_countries", "ne_10m_admin_0_countries", "ne_10m_admin_0_countries"],
  borders: ["ne_110m_admin_0_boundary_lines_land", "ne_50m_admin_0_boundary_lines_land", "ne_10m_admin_0_boundary_lines_land", "ne_10m_admin_0_boundary_lines_land"],
};

// Countries' facts, from the finest file; the coarser ones are matched to them by their code.
const countryFeatures = await read("ne_10m_admin_0_countries");
const countryKey = (p: Record<string, unknown>) => String(prop(p, "ADM0_A3") ?? prop(p, "NAME"));
const countryIndex = new Map(countryFeatures.map((f, i) => [countryKey(f.properties), i]));
const countries = countryFeatures.map((f) => {
  const p = f.properties;
  const [lx, ly] = mercator(num(prop(p, "LABEL_X"), 0), num(prop(p, "LABEL_Y"), 0));
  return {
    name: String(prop(p, "NAME_EN", "NAME")),
    continent: String(prop(p, "CONTINENT") ?? ""),
    population: num(prop(p, "POP_EST"), 0),
    color: num(prop(p, "MAPCOLOR7"), 1),
    label: [+lx.toFixed(6), +ly.toFixed(6)],
    labelZoom: [num(prop(p, "MIN_LABEL"), 3), num(prop(p, "MAX_LABEL"), 10)],
  };
});

// Every other layer: its features' smallest zoom, and a kind for its style.
const ROAD_KINDS = ["Major Highway", "Secondary Highway", "Road", "Ferry Route"];
const layerFiles: Record<Exclude<Layer, "countries">, string> = {
  urban: "ne_10m_urban_areas",
  lakes: "ne_10m_lakes",
  states: "ne_10m_admin_1_states_provinces_lines",
  borders: "ne_10m_admin_0_boundary_lines_land",
  rivers: "ne_10m_rivers_lake_centerlines",
  roads: "ne_10m_roads",
};
const loaded = new Map<string, Awaited<ReturnType<typeof read>>>();
const load = async (name: string) => loaded.get(name) ?? (loaded.set(name, await read(name)), loaded.get(name)!);
const kinds: Record<string, number[]> = {};

const index: { lods: { zoom: number; tiles: number; step: number; offsets: Record<string, [number, number]> }[] } = { lods: [] };
let total = 0;
for (const [k, lod] of LODS.entries()) {
  const upper = k === LODS.length - 1 ? MAX_ZOOM : lod.zoom + 1;
  const tolerance = 1 / (256 * 2 ** upper);
  const size = 1 / 2 ** lod.tiles;
  const tiles = new Map<string, Piece[]>();
  const add = (key: string, piece: Piece) => (tiles.get(key) ?? (tiles.set(key, []), tiles.get(key)!)).push(piece);
  for (const [layerIndex, layer] of LAYERS.entries()) {
    const file = sources[layer]?.[k] ?? layerFiles[layer as Exclude<Layer, "countries">];
    const features = await load(file);
    const fill = FILLS.has(layer);
    const kindList: number[] = [];
    for (const [i, f] of features.entries()) {
      const p = f.properties;
      const minZoom = num(prop(p, "min_zoom"), 0);
      const feature = layer === "countries" ? (countryIndex.get(countryKey(p)) ?? -1) : i;
      if (layer !== "countries" && k === LODS.length - 1) {
        kindList.push(minZoom, layer === "roads" ? Math.max(0, ROAD_KINDS.indexOf(String(prop(p, "type")))) : layer === "rivers" ? num(prop(p, "scalerank"), 6) : 0);
      }
      if (feature < 0 || (layer !== "countries" && minZoom > upper) || minZoom >= (SKIP[layer] ?? Infinity)) continue;
      for (const raw of rings(f.geometry)) {
        const ring = simplify(raw, tolerance, fill);
        if (ring.length < (fill ? 8 : 4)) continue;
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let j = 0; j < ring.length; j += 2) {
          x0 = Math.min(x0, ring[j]!);
          x1 = Math.max(x1, ring[j]!);
          y0 = Math.min(y0, ring[j + 1]!);
          y1 = Math.max(y1, ring[j + 1]!);
        }
        // Too small to see at this level's deepest zoom.
        if (fill && (x1 - x0) * (y1 - y0) < tolerance * tolerance * 16) continue;
        const last = 2 ** lod.tiles - 1;
        const tx0 = Math.max(0, Math.floor(x0 / size));
        const tx1 = Math.min(last, Math.floor(x1 / size));
        const ty0 = Math.max(0, Math.floor(y0 / size));
        const ty1 = Math.min(last, Math.floor(y1 / size));
        if (fill) {
          for (let tx = tx0; tx <= tx1; tx++) {
            for (let ty = ty0; ty <= ty1; ty++) {
              // A little past the tile's edges, so neighbors overlap rather than leave a hairline.
              const m = size * 0.002;
              const cut = tx0 === tx1 && ty0 === ty1 ? ring : clipRing(ring, tx * size - m, ty * size - m, (tx + 1) * size + m, (ty + 1) * size + m);
              if (cut.length >= 6) add(`${tx}/${ty}`, { layer: layerIndex, feature, rings: [cut] });
            }
          }
        } else {
          // A line goes into each tile its segments meet, in runs of consecutive segments; long segments are split first.
          const points: Ring = [ring[0]!, ring[1]!];
          for (let j = 2; j < ring.length; j += 2) {
            const ax = ring[j - 2]!;
            const ay = ring[j - 1]!;
            const steps = Math.ceil(Math.hypot(ring[j]! - ax, ring[j + 1]! - ay) / (size * 0.4));
            for (let s = 1; s <= steps; s++) points.push(ax + ((ring[j]! - ax) * s) / steps, ay + ((ring[j + 1]! - ay) * s) / steps);
          }
          const runs = new Map<string, Ring>();
          const open = new Map<string, number>();
          for (let j = 2; j < points.length; j += 2) {
            const ax = points[j - 2]!;
            const ay = points[j - 1]!;
            const bx = points[j]!;
            const by = points[j + 1]!;
            for (let tx = Math.max(0, Math.floor(Math.min(ax, bx) / size)); tx <= Math.min(last, Math.floor(Math.max(ax, bx) / size)); tx++) {
              for (let ty = Math.max(0, Math.floor(Math.min(ay, by) / size)); ty <= Math.min(last, Math.floor(Math.max(ay, by) / size)); ty++) {
                const key = `${tx}/${ty}`;
                let run = runs.get(key);
                if (!run || open.get(key) !== j - 2) {
                  if (run && run.length >= 4) add(key, { layer: layerIndex, feature, rings: [run] });
                  run = [ax, ay];
                  runs.set(key, run);
                }
                run.push(bx, by);
                open.set(key, j);
              }
            }
          }
          for (const [key, run] of runs) if (run.length >= 4) add(key, { layer: layerIndex, feature, rings: [run] });
        }
      }
    }
    if (k === LODS.length - 1 && layer !== "countries") kinds[layer] = kindList;
  }
  // Each tile: its pieces, with points on a grid of half the tolerance from the tile's corner, each as its step from the one before.
  const step = tolerance / 2;
  const offsets: Record<string, [number, number]> = {};
  for (const [key, pieces] of tiles) {
    const [tx, ty] = key.split("/").map(Number) as [number, number];
    const ox = tx * size;
    const oy = ty * size;
    const start = bytes.length;
    varint(pieces.length);
    for (const piece of pieces) {
      varint(piece.layer);
      varint(piece.feature);
      varint(piece.rings.length);
      for (const ring of piece.rings) {
        varint(ring.length / 2);
        let px = 0;
        let py = 0;
        for (let j = 0; j < ring.length; j += 2) {
          const x = Math.round((ring[j]! - ox) / step);
          const y = Math.round((ring[j + 1]! - oy) / step);
          varint(x - px);
          varint(y - py);
          px = x;
          py = y;
        }
        total += ring.length / 2;
      }
    }
    offsets[key] = [start, bytes.length - start];
  }
  index.lods.push({ zoom: lod.zoom, tiles: lod.tiles, step, offsets });
  const perLayer = LAYERS.map(() => 0);
  for (const pieces of tiles.values()) for (const piece of pieces) for (const r of piece.rings) perLayer[piece.layer]! += r.length / 2;
  console.log(LAYERS.map((l, i) => `${l} ${perLayer[i]}`).join(", "));
  console.log(`level ${k} (zoom ${lod.zoom}): ${tiles.size} tiles, ${(bytes.length / 1e6).toFixed(1)} MB so far`);
}

// Places: name, country, population, smallest zoom, where, and whether a capital.
const places = (await read("ne_10m_populated_places_simple")).map((f) => {
  const p = f.properties;
  const [lon, lat] = (f.geometry!.coordinates as number[]) ?? [0, 0];
  const [x, y] = mercator(lon!, lat!);
  return [String(prop(p, "name")), String(prop(p, "adm0name") ?? ""), num(prop(p, "pop_max"), 0), num(prop(p, "min_zoom"), 10), +x.toFixed(7), +y.toFixed(7), String(prop(p, "featurecla")).includes("Admin-0 capital") ? 1 : 0];
});

const json = new TextEncoder().encode(JSON.stringify({ layers: LAYERS, roadKinds: ROAD_KINDS, countries, kinds, places, ...index }));
const head = new Uint8Array(4);
new DataView(head.buffer).setUint32(0, json.length, true);
const file = new Uint8Array(4 + json.length + bytes.length);
file.set(head, 0);
file.set(json, 4);
file.set(bytes, 4 + json.length);
const packed = gzipSync(file, { level: 9 });
await Bun.write(new URL("../src/map/world.bin", import.meta.url), packed);
console.log(`${total.toLocaleString("en-US")} points; index ${(json.length / 1e6).toFixed(2)} MB, tiles ${(bytes.length / 1e6).toFixed(1)} MB, gzipped ${(packed.length / 1e6).toFixed(1)} MB`);
