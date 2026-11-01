// OpenStreetMap's vector tiles, from OpenFreeMap: free, without a key, and
// open to any page. Each tile is a Mapbox Vector Tile, a protocol buffer of
// layers of features in tile coordinates, read here without a library. The
// map draws them over Natural Earth when close in, where Natural Earth's
// coastlines, drawn for a 1:10 million map, are off by hundreds of meters.

const TILEJSON = "https://tiles.openfreemap.org/planet";

/** A feature: its layer, kind, the properties a style needs, and its geometry as rings or lines of x, y pairs, 0 to 1 across the tile. */
export interface TileFeature {
  readonly layer: string;
  /** 1 point, 2 line, 3 polygon. */
  readonly type: number;
  readonly props: Readonly<Record<string, string | number | boolean>>;
  readonly parts: readonly Float32Array[];
}

/** Reads a tile's protocol buffer. */
export const decodeTile = (bytes: Uint8Array): TileFeature[] => {
  const out: TileFeature[] = [];
  let at = 0;
  const varint = (): number => {
    let v = 0;
    let scale = 1;
    let b: number;
    do {
      b = bytes[at++]!;
      v += (b & 127) * scale;
      scale *= 128;
    } while (b >= 128);
    return v;
  };
  const skip = (wire: number): void => {
    if (wire === 0) varint();
    else if (wire === 1) at += 8;
    else if (wire === 2) {
      const n = varint();
      at += n;
    }
    else if (wire === 5) at += 4;
    else throw new Error(`a vector tile can't hold wire type ${wire}`);
  };
  const text = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = (end: number): string | number | boolean => {
    let v: string | number | boolean = "";
    while (at < end) {
      const key = varint();
      const field = key >> 3;
      if (field === 1) {
        const n = varint();
        v = text.decode(bytes.subarray(at, at + n));
        at += n;
      } else if (field === 2) {
        v = view.getFloat32(at, true);
        at += 4;
      } else if (field === 3) {
        v = view.getFloat64(at, true);
        at += 8;
      } else if (field === 4 || field === 5) v = varint();
      else if (field === 6) {
        const z = varint();
        v = z % 2 === 1 ? -(z + 1) / 2 : z / 2;
      } else if (field === 7) v = varint() !== 0;
      else skip(key & 7);
    }
    return v;
  };
  while (at < bytes.length) {
    const key = varint();
    if (key >> 3 !== 3 || (key & 7) !== 2) {
      skip(key & 7);
      continue;
    }
    // A length first, then where it ends: reading the length moves `at` past it.
    const layerEnd = varint() + at;
    let name = "";
    let extent = 4096;
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const raw: { type: number; tags: number[]; geometry: number[] }[] = [];
    while (at < layerEnd) {
      const k = varint();
      const field = k >> 3;
      if (field === 1) {
        const n = varint();
        name = text.decode(bytes.subarray(at, at + n));
        at += n;
      } else if (field === 2) {
        const end = varint() + at;
        const f = { type: 0, tags: [] as number[], geometry: [] as number[] };
        while (at < end) {
          const fk = varint();
          const ff = fk >> 3;
          if (ff === 2 || ff === 4) {
            const stop = varint() + at;
            const into = ff === 2 ? f.tags : f.geometry;
            while (at < stop) into.push(varint());
          } else if (ff === 3) f.type = varint();
          else skip(fk & 7);
        }
        raw.push(f);
      } else if (field === 3) {
        const n = varint();
        keys.push(text.decode(bytes.subarray(at, at + n)));
        at += n;
      } else if (field === 4) {
        const end = varint() + at;
        values.push(value(end));
      } else if (field === 5) extent = varint();
      else skip(k & 7);
    }
    at = layerEnd;
    for (const f of raw) {
      const props: Record<string, string | number | boolean> = {};
      for (let i = 0; i + 1 < f.tags.length; i += 2) props[keys[f.tags[i]!]!] = values[f.tags[i + 1]!]!;
      // Commands: move to, line to, each with a count of zigzag x, y steps; close path.
      const parts: Float32Array[] = [];
      let part: number[] = [];
      let x = 0;
      let y = 0;
      const g = f.geometry;
      for (let i = 0; i < g.length; ) {
        const command = g[i]! & 7;
        const count = g[i++]! >> 3;
        if (command === 7) {
          if (part.length > 0) part.push(part[0]!, part[1]!);
          continue;
        }
        for (let c = 0; c < count; c++) {
          const dx = g[i++]!;
          const dy = g[i++]!;
          x += dx % 2 === 1 ? -(dx + 1) / 2 : dx / 2;
          y += dy % 2 === 1 ? -(dy + 1) / 2 : dy / 2;
          if (command === 1 && part.length > 0) {
            parts.push(Float32Array.from(part));
            part = [];
          }
          part.push(x / extent, y / extent);
        }
      }
      if (part.length > 0) parts.push(Float32Array.from(part));
      out.push({ layer: name, type: f.type, props, parts });
    }
  }
  return out;
};

/** Where the tiles are: OpenFreeMap names its current build in its TileJSON. */
let template: Promise<{ url: string; maxzoom: number }> | null = null;
const tiles = (): Promise<{ url: string; maxzoom: number }> =>
  (template ??= fetch(TILEJSON)
    .then((r) => {
      if (!r.ok) throw new Error(`OpenFreeMap answered ${r.status}`);
      return r.json() as Promise<{ tiles: string[]; maxzoom?: number }>;
    })
    .then((j) => ({ url: j.tiles[0]!, maxzoom: j.maxzoom ?? 14 }))
    .catch((error: unknown) => {
      template = null;
      throw error;
    }));

/** The deepest zoom OpenFreeMap has tiles for. */
export const tileZoom = async (): Promise<number> => (await tiles()).maxzoom;

/** A tile's features; none where the tile has nothing, as at sea. */
export const tile = async (z: number, x: number, y: number): Promise<TileFeature[]> => {
  const { url } = await tiles();
  const response = await fetch(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  if (response.status === 204 || response.status === 404) return [];
  if (!response.ok) throw new Error(`OpenFreeMap answered ${response.status}`);
  return decodeTile(new Uint8Array(await response.arrayBuffer()));
};

/**
 * How a feature is drawn: a fill or a line, in a style that names its color
 * and width, in drawing order. Both OpenMapTiles' layer names (OpenFreeMap's)
 * and Mapbox Streets' are read.
 */
export interface Paint {
  readonly order: number;
  readonly fill?: string;
  readonly stroke?: string;
  /** In screen pixels at zoom 14. */
  readonly width?: number;
  readonly dash?: readonly number[];
  /** Drawn from this zoom. */
  readonly from?: number;
}

export const LAND = "#f2efe9";
const WATER = "#a9d3ea";
const FILLS: Readonly<Record<string, Paint>> = {
  wood: { order: 1, fill: "#d6e6c3" },
  forest: { order: 1, fill: "#d6e6c3" },
  grass: { order: 1, fill: "#e2eecf" },
  farmland: { order: 0, fill: "#eef0d9" },
  sand: { order: 1, fill: "#f3e7c4" },
  beach: { order: 1, fill: "#f3e7c4" },
  ice: { order: 1, fill: "#eef6f8" },
  glacier: { order: 1, fill: "#eef6f8" },
  wetland: { order: 1, fill: "#dbe8e0" },
  park: { order: 2, fill: "#cfe8bf" },
  pitch: { order: 2, fill: "#cfe8bf" },
  cemetery: { order: 2, fill: "#dde7d4" },
  residential: { order: 0, fill: "#ebe6df" },
  industrial: { order: 0, fill: "#e8e2ea" },
  commercial: { order: 0, fill: "#efe2df" },
  hospital: { order: 2, fill: "#f6dede" },
  school: { order: 2, fill: "#f3ecd2" },
  university: { order: 2, fill: "#f3ecd2" },
  college: { order: 2, fill: "#f3ecd2" },
};
const ROADS: Readonly<Record<string, Paint>> = {
  motorway: { order: 30, stroke: "#e9a35f", width: 3 },
  trunk: { order: 29, stroke: "#f2c36b", width: 2.6 },
  primary: { order: 28, stroke: "#f7d98b", width: 2.4 },
  secondary: { order: 27, stroke: "#fdf0b8", width: 2 },
  tertiary: { order: 26, stroke: "#ffffff", width: 1.8 },
  minor: { order: 25, stroke: "#ffffff", width: 1.4, from: 12.5 },
  street: { order: 25, stroke: "#ffffff", width: 1.4, from: 12.5 },
  street_limited: { order: 25, stroke: "#ffffff", width: 1.2, from: 13 },
  service: { order: 24, stroke: "#ffffff", width: 0.9, from: 14 },
  track: { order: 23, stroke: "#c8b79f", width: 0.8, dash: [3, 2], from: 13.5 },
  path: { order: 23, stroke: "#c8b79f", width: 0.7, dash: [2, 2], from: 14 },
  pedestrian: { order: 24, stroke: "#f5f1f8", width: 1.2, from: 13.5 },
  rail: { order: 31, stroke: "#9ca3af", width: 1, dash: [5, 3] },
  major_rail: { order: 31, stroke: "#9ca3af", width: 1, dash: [5, 3] },
  minor_rail: { order: 31, stroke: "#b6bcc5", width: 0.8, dash: [4, 3], from: 13 },
  transit: { order: 31, stroke: "#b6bcc5", width: 0.8, dash: [4, 3], from: 13 },
  ferry: { order: 22, stroke: "#5a9fd6", width: 1, dash: [4, 4] },
};

/** A feature's paint, or null to leave it out. */
export const paint = (f: TileFeature): Paint | null => {
  const cls = String(f.props.class ?? f.props.type ?? "");
  switch (f.layer) {
    case "water":
      return f.type === 3 ? { order: 5, fill: WATER } : null;
    case "landcover":
    case "landuse":
    case "landuse_overlay":
    case "park":
      return f.type === 3 ? (FILLS[f.layer === "park" ? "park" : cls] ?? null) : null;
    case "waterway":
      return f.type === 2 ? { order: 6, stroke: "#8cc4e6", width: cls === "river" ? 1.6 : 0.8, ...(cls === "river" ? {} : { from: 12.5 }) } : null;
    case "building":
      return f.type === 3 ? { order: 10, fill: "#ddd6cd", from: 13.5 } : null;
    case "transportation":
    case "road":
      // Ramps draw as the road they join.
      return f.type === 2 ? (ROADS[cls.replace(/_link$/, "")] ?? null) : null;
    case "aeroway":
      return f.type === 3 ? { order: 3, fill: "#e5e2ec" } : f.type === 2 ? { order: 21, stroke: "#d4d0de", width: 3, from: 12 } : null;
    case "boundary":
    case "admin": {
      const level = Number(f.props.admin_level ?? 9);
      return f.type === 2 && level <= 4 && !f.props.maritime ? { order: 40, stroke: level <= 2 ? "#7c8799" : "#a3a9b8", width: level <= 2 ? 1.2 : 0.8, dash: level <= 2 ? [] : [4, 3] } : null;
    }
    default:
      return null;
  }
};
