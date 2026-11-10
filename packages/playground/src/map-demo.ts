// A world map of real data: Natural Earth's countries, lakes, towns' built-up
// areas, state lines, rivers, roads and 7,342 places, packed by
// scripts/build-map.ts into tiles at four levels of detail. Its sea is a
// VirtualGroup that draws the tiles that show at the level that suits the
// zoom, decoding each the first time it is needed, so a view of a region
// reads a few of the eight thousand tiles of the finest level and the whole
// world reads four coarse ones. Places and country names are labeled
// biggest first, leaving out any that would overlap. Zoomed in close, the
// map asks Wikipedia for the articles about places in view, a cell at a
// time, and pins them; a click on a pin reads its article in a panel over
// the map's right side, whose links open more articles and fly to them.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type RecordingContextOptions, type Rect, type Scene, VirtualGroup } from "canvas-ir";
import { TITLE_LEFT, closeBox, drawClose, inBox } from "./ui/window";
import worldUrl from "./map/world.bin" with { type: "file" };
import { fit } from "./ui/kit";
import { WheelGesture } from "./wheel";
import { Reader, type ReaderHost, type ReaderSpec } from "./reader";
import { type Pin, article, articlesIn, titleNear, titleOf } from "./wiki";
import { LAND, PLACE_ZOOM, type Paint, type TileFeature, paint, placeOf, tile, tileZoom } from "./osm";

export const MAP_ID = "world-map";
export const MAP_AT = { x: 3160, y: 776 };
const W = 1400;
const TITLE = 46;
const H = 840;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Zooms as web maps count them: the world is 256 pixels across at 0. */
const MIN_ZOOM = Math.log2((0.98 * W) / 256);
const MAX_ZOOM = 16;
/** Wikipedia's articles show from this zoom, asked for a cell at a time: tiles of zoom 12, about 10 km across at the equator. */
const WIKI_ZOOM = 11.5;
const CELL = 12;
/** Cells asked for at once. */
const ASKING = 4;
/** OpenStreetMap's tiles draw over Natural Earth from this zoom, a few at a time, and this many are kept. */
const OSM_ZOOM = 9;
const OSM_ASKING = 6;
const OSM_KEEP = 300;
/** The article panel's width, and its status line's height. */
const PANEL = 560;
const PANEL_STATUS = 28;
const PIN_COLORS: Readonly<Record<string, string>> = {
  city: "#dc2626",
  landmark: "#7c3aed",
  mountain: "#78716c",
  river: "#0284c7",
  waterbody: "#0284c7",
  airport: "#0f766e",
  railwaystation: "#0f766e",
  edu: "#ca8a04",
  isle: "#16a34a",
  forest: "#16a34a",
};

const mercator = (lat: number, lon: number): [number, number] => {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2];
};
const latitude = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

interface Country {
  readonly name: string;
  readonly continent: string;
  readonly population: number;
  readonly color: number;
  readonly label: readonly [number, number];
  readonly labelZoom: readonly [number, number];
  readonly wikidata: string;
}
type Place = readonly [name: string, country: string, population: number, minZoom: number, x: number, y: number, capital: number, wikidata: string];
/** A sea, a region, a lake or a peak, with the zooms its name shows at. */
type Named = readonly [name: string, kind: string, minZoom: number, maxZoom: number, x: number, y: number, wikidata: string];
interface World {
  readonly layers: readonly string[];
  readonly countries: readonly Country[];
  /** For each line or area layer: each feature's smallest zoom and its kind, in pairs. */
  readonly kinds: Readonly<Record<string, readonly number[]>>;
  readonly places: readonly Place[];
  readonly named: readonly Named[];
  readonly lods: readonly { zoom: number; tiles: number; step: number; offsets: Readonly<Record<string, readonly [number, number]>> }[];
}
interface Piece {
  readonly layer: number;
  readonly feature: number;
  /** In world coordinates, 0 to 1 across, and the box around them. */
  readonly rings: readonly Float64Array[];
  readonly box: readonly [number, number, number, number];
}

const COUNTRY_COLORS = ["#f3e3c3", "#dcebc9", "#f6d6cf", "#d9e4f2", "#efe0f0", "#fbefc1", "#d8eee6"];
const SEA = "#a9d3ea";
const LATER: Readonly<Record<string, number>> = { roads: -0.5, states: -1.5, urban: -0.5, rivers: 0 };
const ROADS = [
  { color: "#d97706", width: 1.6 },
  { color: "#eab308", width: 1.1 },
  { color: "#ffffff", width: 0.8 },
  { color: "#3b82f6", width: 0.8, dash: [4, 3] },
];

/** Reads a tile: its pieces, with points stepped from the tile's corner on its level's grid. */
const decode = (bytes: Uint8Array, start: number, length: number, origin: [number, number], step: number): Piece[] => {
  let at = start;
  const varint = (): number => {
    let z = 0;
    let scale = 1;
    let b: number;
    do {
      b = bytes[at++]!;
      z += (b & 127) * scale;
      scale *= 128;
    } while (b >= 128);
    return z % 2 === 1 ? -(z + 1) / 2 : z / 2;
  };
  const pieces: Piece[] = [];
  const count = varint();
  for (let p = 0; p < count && at < start + length; p++) {
    const layer = varint();
    const feature = varint();
    const ringCount = varint();
    const rings: Float64Array[] = [];
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let r = 0; r < ringCount; r++) {
      const n = varint();
      const ring = new Float64Array(2 * n);
      let x = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        x += varint();
        y += varint();
        const wx = (ring[2 * i] = origin[0] + x * step);
        const wy = (ring[2 * i + 1] = origin[1] + y * step);
        if (wx < box[0]) box[0] = wx;
        if (wy < box[1]) box[1] = wy;
        if (wx > box[2]) box[2] = wx;
        if (wy > box[3]) box[3] = wy;
      }
      rings.push(ring);
    }
    pieces.push({ layer, feature, rings, box });
  }
  return pieces;
};

const people = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : Math.round(n).toLocaleString("en-US"));

interface FrameState {
  readonly note: string;
}

export interface MapHost {
  /** Called once the window was closed. */
  readonly closed?: () => void;
  readonly components: () => Components;
  /** The board's zoom: screen pixels per world unit. */
  readonly zoom: () => number;
  readonly render: () => void;
  readonly log: (line: string) => void;
  readonly recorder: RecordingContextOptions;
  /** What the article panel needs from the board. */
  readonly reader: () => ReaderHost;
}

/** A cell's articles, placed on the map. */
type Placed = Pin & { readonly x: number; readonly y: number };

/** What a click reads: an article by its title, or by a map feature's Wikidata id; and where to fly, if not to the article's own place. */
interface Subject {
  readonly name: string;
  readonly title?: string;
  readonly wikidata?: string;
  /** Where a place known only by its name is, to find its article among those near it. */
  readonly near?: { x: number; y: number };
  readonly fly?: { x: number; y: number; zoom: number };
}

/** A place OpenStreetMap names, on the map. */
interface Town {
  readonly name: string;
  readonly kind: string;
  readonly rank: number;
  readonly x: number;
  readonly y: number;
}

const MARINE = new Set(["ocean", "sea", "gulf", "bay", "strait", "sound", "channel", "generic", "lagoon", "fjord", "inlet", "river", "reef"]);

export class WorldMap {
  private x = MAP_AT.x;
  private y = MAP_AT.y;
  /** The view's center, in world coordinates, and content units per world. */
  private camera = { x: 0.5, y: 0.42, scale: 256 * 2 ** MIN_ZOOM };
  private world: World | null = null;
  private bytes = new Uint8Array(0);
  private readonly tiles = new Map<string, Piece[]>();
  private readonly datums = new Map<string, string>();
  private readonly widths = new Map<string, number>();
  private readonly sea: VirtualGroup;
  private readonly frame: ComponentHandle<FrameState>;
  private readonly gesture = new WheelGesture();
  private unlisten: (() => void)[] = [];
  /** What a click on a drawn place or country flies to. */
  private targets = new Map<string, { x: number; y: number; zoom: number }>();
  private points = 0;
  private labels = 0;
  private flight = 0;
  /** Each cell's articles, by `x/y` at zoom CELL, once Wikipedia answers; "asking" until then. */
  private readonly cells = new Map<string, Placed[] | "asking" | "failed">();
  private queue: string[] = [];
  private asking = 0;
  /** The last thing Wikipedia said went wrong, until it answers again. */
  private trouble = "";
  private pins = 0;
  /** What a click on a drawn pin reads. */
  private subjects = new Map<string, Subject>();
  /** Towns on the map by name, to leave out Wikipedia's pins for the same towns. */
  private towns = new Map<string, Place[]>();
  private panel: Reader | null = null;
  /** The article read now, and the request for it. */
  private reading: { title: string; at: [number, number] | null } | null = null;
  private request = 0;
  private stale = false;
  /** OpenStreetMap's tiles by `z/x/y`, once they come. */
  private readonly osm = new Map<string, TileFeature[] | "asking" | "failed">();
  private osmQueue: string[] = [];
  private osmAsking = 0;
  private osmTrouble = "";
  private osmMax = 14;
  private osmDrawn = 0;
  /** OpenStreetMap's places in the tiles drawn, and those named this frame by name, to leave out Wikipedia's pins for them. */
  private osmPlaces: Town[] = [];
  private named = new Map<string, Town[]>();
  /** The wait for the view to settle before asking for anything. */
  private settle = 0;
  /** Where the view was when the wait began. */
  private settledAt = "";

  constructor(
    private scene: Scene,
    private router: EventRouter,
    private readonly host: MapHost,
  ) {
    scene.addGroup({ id: MAP_ID, meta: { role: "figure", label: "A world map", source: "world map" } });
    this.frame = host.components().mount(this.frameSpec());
    this.frame.setState({ note: "Loading the world" });
    this.sea = new VirtualGroup(
      scene,
      {
        id: `${MAP_ID}:sea`,
        parent: MAP_ID,
        meta: { role: "img", label: "A map of the world" },
        extent: { x: 0, y: 0, width: W, height: H },
        draw: (ctx, window) => this.draw(ctx, window),
      },
      { recorder: host.recorder },
    );
    this.show();
    this.listen();
    void this.load();
  }

  get alive(): boolean {
    return this.scene.getGroup(MAP_ID) !== undefined;
  }

  /** Takes the window off the board. */
  close(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.land();
    this.panel?.close();
    this.panel = null;
    this.host.components().unmount(`${MAP_ID}:frame`);
    if (this.alive) this.scene.remove(MAP_ID);
    this.host.render();
    this.host.closed?.();
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: W, height: TITLE + H };
  }

  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.sea.bind(scene);
    this.panel?.bind(scene, router);
    this.listen();
  }

  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.panel?.moved(dx, dy);
    this.show();
  }

  /** The board zoomed: lines and labels are sized in screen pixels, so the map draws again. */
  zoomed(): void {
    if (this.alive) this.show();
  }

  /** Fetches the packed world, which ships beside the page, and unzips it. */
  private async load(): Promise<void> {
    const t0 = performance.now();
    const response = await fetch(worldUrl);
    const packed = response.body!.pipeThrough(new DecompressionStream("gzip"));
    const file = new Uint8Array(await new Response(packed).arrayBuffer());
    const length = new DataView(file.buffer).getUint32(0, true);
    this.world = JSON.parse(new TextDecoder().decode(file.subarray(4, 4 + length))) as World;
    this.bytes = file.subarray(4 + length);
    for (const p of this.world.places) (this.towns.get(p[0].toLowerCase()) ?? (this.towns.set(p[0].toLowerCase(), []), this.towns.get(p[0].toLowerCase())!)).push(p);
    this.host.log(`world map: ${(file.length / 1e6).toFixed(1)} MB of Natural Earth unpacked in ${(performance.now() - t0).toFixed(0)} ms`);
    this.redraw();
  }

  private listen(): void {
    for (const off of this.unlisten) off();
    const sea = `${MAP_ID}:sea`;
    let moved = false;
    this.unlisten = [
      this.router.on(MAP_ID, "wheel", (e) => {
        const input = e.input as { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
        if (input.ctrlKey || input.metaKey) return;
        e.stopPropagation();
        this.land();
        const { zoom, pan } = this.gesture.read(input);
        const c = this.camera;
        if (pan !== 0) c.x += pan / (this.host.zoom() * c.scale);
        else {
          const scale = this.clampScale(c.scale * Math.exp(-zoom * 0.0025));
          const px = (e.point.x - this.x - W / 2) / c.scale;
          const py = (e.point.y - this.y - TITLE - H / 2) / c.scale;
          const k = 1 - c.scale / scale;
          c.x += px * k;
          c.y += py * k;
          c.scale = scale;
        }
        this.clampCamera();
        this.redraw();
      }),
      this.router.on(sea, "down", (e) => {
        e.stopPropagation();
        moved = false;
        this.land();
      }),
      this.router.on(sea, "dragstart", (e) => e.stopPropagation()),
      this.router.on(sea, "drag", (e) => {
        e.stopPropagation();
        moved = true;
        this.camera.x -= e.delta!.x / this.camera.scale;
        this.camera.y -= e.delta!.y / this.camera.scale;
        this.clampCamera();
        this.redraw();
      }),
      // A click on a place or a country flies there.
      this.router.on(sea, "click", (e) => {
        e.stopPropagation();
        if (moved) return;
        // The scene names groups drawn in the sea after it: `world-map:sea/<id>`.
        const subject = e.path.map((id) => this.subjects.get(id.slice(sea.length + 1))).find((t) => t !== undefined);
        if (subject) return void this.read(subject);
        const target = e.path.map((id) => this.targets.get(id.slice(sea.length + 1))).find((t) => t !== undefined);
        if (target) this.fly(target);
      }),
    ];
  }

  private clampScale(scale: number): number {
    const z = this.host.zoom();
    return Math.max((256 * 2 ** MIN_ZOOM) / z, Math.min((256 * 2 ** MAX_ZOOM) / z, scale));
  }

  /** Keeps the world in view: its middle can't leave the window. */
  private clampCamera(): void {
    const c = this.camera;
    const halfW = Math.max(0, 0.5 - W / 2 / c.scale);
    const halfH = Math.max(0, 0.5 - H / 2 / c.scale);
    c.x = Math.max(0.5 - halfW, Math.min(0.5 + halfW, c.x));
    c.y = Math.max(0.5 - halfH, Math.min(0.5 + halfH, c.y));
  }

  private land(): void {
    if (this.flight) cancelAnimationFrame(this.flight);
    this.flight = 0;
  }

  /** Flies to a point and zoom, zooming at a steady rate. */
  private fly(target: { x: number; y: number; zoom: number }): void {
    this.land();
    const from = { ...this.camera };
    const scale = this.clampScale((256 * 2 ** target.zoom) / this.host.zoom());
    // With an article open, the middle of what the panel leaves showing.
    const to = { x: target.x + (this.panel ? PANEL / 2 / scale : 0), y: target.y };
    const start = performance.now();
    const ms = 700 + 120 * Math.abs(Math.log2(scale / from.scale));
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const s = from.scale * (scale / from.scale) ** e;
      // On a zoom in, the share of the way still to go shrinks with the zoom, so the target nears the center evenly on screen.
      const rest = scale > from.scale ? (1 - e) * (from.scale / s) : 1 - e;
      this.camera = { x: to.x + (from.x - to.x) * rest, y: to.y + (from.y - to.y) * rest, scale: s };
      this.clampCamera();
      this.redraw();
      this.flight = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.flight = requestAnimationFrame(step);
  }

  /** Back to the whole world. */
  home(): void {
    this.fly({ x: 0.5, y: 0.42, zoom: MIN_ZOOM });
  }

  /** Draws the map again at the board's next frame. */
  private redraw(): void {
    this.stale = true;
    this.host.render();
  }

  /** Records the map if it changed since the board last drew, just before the board draws it. */
  flush(): void {
    if (!this.stale || !this.alive) return;
    this.stale = false;
    const t0 = performance.now();
    this.sea.refresh();
    this.note(performance.now() - t0);
  }

  private show(): void {
    const t0 = performance.now();
    const redrew = this.sea.show({
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y + TITLE },
      // A pixel short of the frame's bottom, so the sea leaves its border showing.
      visible: { x: this.x, y: this.y + TITLE, width: W, height: H - 1 },
      clip: true,
      detail: Math.round(Math.log2(this.host.zoom()) * 3),
    });
    if (redrew) this.note(performance.now() - t0);
    this.host.render();
  }

  private note(ms: number): void {
    if (!this.world) return;
    const zoom = Math.log2((this.camera.scale * this.host.zoom()) / 256);
    const wiki =
      zoom < WIKI_ZOOM
        ? `; Wikipedia shows from zoom ${WIKI_ZOOM}, click a town twice`
        : this.trouble
          ? `; Wikipedia: ${this.trouble}`
          : `; ${this.pins.toLocaleString("en-US")} Wikipedia articles${this.asking > 0 ? ", asking for more" : ""}`;
    const streets = zoom < OSM_ZOOM ? "" : this.osmTrouble ? `; OpenStreetMap: ${this.osmTrouble}` : `; ${this.osmDrawn} OpenStreetMap tiles${this.osmAsking > 0 ? ", asking for more" : ""}`;
    // What to do about Wikipedia first: a narrow header cuts the end.
    this.frame.setState({ note: `Zoom ${zoom.toFixed(1)}${wiki}${streets}; ${this.points.toLocaleString("en-US")} points and ${this.labels} labels drawn in ${ms.toFixed(1)} ms` });
  }

  /** A tooltip's text, made once: formatting numbers on every redraw costs more than drawing the countries. */
  private datum(id: string, make: () => string): string {
    let text = this.datums.get(id);
    if (text === undefined) this.datums.set(id, (text = make()));
    return text;
  }

  /** A label's width in the current font, measured once: measuring hundreds of labels a frame costs more than drawing them. */
  private width(ctx: RecordingContext, text: string): number {
    const key = `${ctx.font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) this.widths.set(key, (w = ctx.measureText(text).width));
    return w;
  }

  /** A tile's pieces, decoded the first time they're needed. */
  private tile(lod: number, tx: number, ty: number): Piece[] {
    const key = `${lod}:${tx}/${ty}`;
    let pieces = this.tiles.get(key);
    if (!pieces) {
      const level = this.world!.lods[lod]!;
      const at = level.offsets[`${tx}/${ty}`];
      const size = 1 / 2 ** level.tiles;
      pieces = at ? decode(this.bytes, at[0], at[1], [tx * size, ty * size], level.step) : [];
      this.tiles.set(key, pieces);
    }
    return pieces;
  }

  private draw(ctx: RecordingContext, window: Rect): void {
    ctx.fillStyle = SEA;
    ctx.fillRect(window.x, window.y, window.width, window.height);
    this.targets = new Map();
    this.subjects = new Map();
    this.points = 0;
    this.labels = 0;
    this.pins = 0;
    const world = this.world;
    if (!world) return;
    const c = this.camera;
    const z = this.host.zoom();
    const s = c.scale;
    const zoom = Math.log2((s * z) / 256);
    const lx = (x: number): number => W / 2 + (x - c.x) * s;
    const ly = (y: number): number => H / 2 + (y - c.y) * s;
    // The level for this zoom, and its tiles that show.
    // Each level serves from its own zoom to two past it, a little coarse at the far end: drawing costs by the point.
    const lod = zoom < 4 ? 0 : zoom < 6 ? 1 : zoom < 8 ? 2 : 3;
    const level = world.lods[lod]!;
    const n = 2 ** level.tiles;
    const size = 1 / n;
    const wx0 = c.x + (window.x - W / 2) / s;
    const wx1 = c.x + (window.x + window.width - W / 2) / s;
    const wy0 = c.y + (window.y - H / 2) / s;
    const wy1 = c.y + (window.y + window.height - H / 2) / s;
    // Natural Earth's smallest zooms suit a map that fills a screen; this one is smaller, so the finer layers wait a little longer.
    const shows = (layer: string, feature: number): boolean => (world.kinds[layer]?.[2 * feature] ?? 0) <= zoom + (LATER[layer] ?? 0.5);
    // Each layer's pieces that show and reach the window.
    const byLayer: Piece[][] = world.layers.map(() => []);
    for (let tx = Math.max(0, Math.floor(wx0 / size)); tx <= Math.min(n - 1, Math.floor(wx1 / size)); tx++) {
      for (let ty = Math.max(0, Math.floor(wy0 / size)); ty <= Math.min(n - 1, Math.floor(wy1 / size)); ty++) {
        for (const piece of this.tile(lod, tx, ty)) {
          const [x0, y0, x1, y1] = piece.box;
          if (x1 >= wx0 && x0 <= wx1 && y1 >= wy0 && y0 <= wy1 && shows(world.layers[piece.layer]!, piece.feature)) byLayer[piece.layer]!.push(piece);
        }
      }
    }
    // Points closer than a screen pixel to the last one drawn are skipped: a level's detail suits the deepest zoom it serves.
    const near = 0.8 / z;
    const trace = (piece: Piece, close: boolean): void => {
      for (const ring of piece.rings) {
        let px = lx(ring[0]!);
        let py = ly(ring[1]!);
        ctx.moveTo(px, py);
        const last = ring.length - 2;
        for (let i = 2; i <= last; i += 2) {
          const x = lx(ring[i]!);
          const y = ly(ring[i + 1]!);
          if (i < last && Math.abs(x - px) < near && Math.abs(y - py) < near) continue;
          ctx.lineTo(x, y);
          px = x;
          py = y;
          this.points++;
        }
        if (close) ctx.closePath();
      }
    };
    const layer = (name: string): Piece[] => byLayer[world.layers.indexOf(name)] ?? [];

    // Countries: each a group with its facts for the board's tooltip, and a click that flies to it.
    const byCountry = new Map<number, Piece[]>();
    for (const piece of layer("countries")) (byCountry.get(piece.feature) ?? (byCountry.set(piece.feature, []), byCountry.get(piece.feature)!)).push(piece);
    for (const [feature, pieces] of byCountry) {
      const country = world.countries[feature]!;
      const id = `country-${feature}`;
      ctx.beginGroup({ id, meta: { datum: this.datum(id, () => `${country.name}\n${country.continent}\npopulation ${people(country.population)}`) } });
      ctx.beginPath();
      for (const piece of pieces) trace(piece, true);
      ctx.fillStyle = COUNTRY_COLORS[(country.color - 1) % COUNTRY_COLORS.length]!;
      ctx.fill();
      ctx.endGroup();
      // Close in, a click on the land is for what's on it, not a flight out to the whole country.
      if (zoom < 7) this.targets.set(id, { x: country.label[0], y: country.label[1], zoom: Math.min(7, Math.max(zoom + 1, country.labelZoom[0] + 1.5)) });
    }
    const fillLayer = (name: string, color: string): void => {
      ctx.beginPath();
      for (const piece of layer(name)) trace(piece, true);
      ctx.fillStyle = color;
      ctx.fill();
    };
    // Cities, lakes, borders, rivers and roads are only looked at: out of hit tests, which would build every long stroke's outline.
    ctx.beginGroup({ id: "detail", meta: { hit: false } });
    fillLayer("urban", "rgba(180, 150, 120, 0.35)");
    fillLayer("lakes", SEA);
    const strokeLayer = (name: string, color: string, width: number, dash: number[] = [], pick: (kind: number) => boolean = () => true): void => {
      ctx.beginPath();
      const kinds = world.kinds[name] ?? [];
      for (const piece of layer(name)) if (pick(kinds[2 * piece.feature + 1] ?? 0)) trace(piece, false);
      ctx.strokeStyle = color;
      ctx.lineWidth = width / z;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash(dash.map((d) => d / z));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    strokeLayer("states", "rgba(100, 116, 139, 0.55)", 0.7, [3, 2]);
    strokeLayer("borders", "#64748b", 1.1);
    // Rivers: the bigger (lower rank), the wider.
    for (const [above, upTo, width] of [[-1, 3, 1.6], [3, 6, 1.1], [6, Infinity, 0.7]] as const) {
      strokeLayer("rivers", "#4f9fd1", width, [], (k) => k > above && k <= upTo);
    }
    // Roads, the smallest first, under the bigger.
    for (let kind = ROADS.length - 1; kind >= 0; kind--) {
      const road = ROADS[kind]!;
      const width = road.width * Math.min(1.6, Math.max(0.7, (zoom - 3) / 3));
      strokeLayer("roads", road.color, width, road.dash ?? [], (k) => k === kind);
    }
    ctx.endGroup();
    if (zoom >= OSM_ZOOM) this.drawStreets(ctx, zoom, { wx0, wy0, wx1, wy1 }, lx, ly, z);
    else this.osmDrawn = 0;

    // Labels, biggest first, each kept only where it overlaps none before it.
    const taken: Rect[] = [];
    const free = (r: Rect): boolean => {
      for (const t of taken) if (r.x < t.x + t.width && t.x < r.x + r.width && r.y < t.y + t.height && t.y < r.y + r.height) return false;
      taken.push(r);
      return true;
    };
    const inside = (x: number, y: number) => x >= window.x - 50 && x <= window.x + window.width + 50 && y >= window.y - 20 && y <= window.y + window.height + 20;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    // Country names, where the country is big enough on screen for one; a click on one reads about the country.
    ctx.font = `600 ${12 / z}px ${FONT}`;
    for (const [i, country] of world.countries.entries()) {
      if (zoom < country.labelZoom[0] - 0.5 || zoom > country.labelZoom[1]) continue;
      const x = lx(country.label[0]);
      const y = ly(country.label[1]);
      if (!inside(x, y)) continue;
      const text = country.name.toUpperCase();
      const w = this.width(ctx, text);
      const box = { x: x - w / 2 - 4 / z, y: y - 9 / z, width: w + 8 / z, height: 18 / z };
      if (!free(box)) continue;
      const id = `name-${i}`;
      this.label(ctx, id, box, () => `${country.name}\nClick to read about it`);
      ctx.fillStyle = "rgba(51, 65, 85, 0.75)";
      ctx.fillText(text, x, y);
      ctx.endGroup();
      const fly = zoom < 7 ? this.targets.get(`country-${i}`) : undefined;
      if (country.wikidata) this.subjects.set(id, { name: country.name, wikidata: country.wikidata, ...(fly ? { fly } : {}) });
      this.labels++;
    }
    // Seas, regions, lakes and peaks, by the zooms that suit their size; a click reads about them.
    for (const [i, f] of world.named.entries()) {
      const [name, kind, min, max, fx, fy, wikidata] = f;
      if (zoom < min - 0.5 || zoom > max + 1) continue;
      const x = lx(fx);
      const y = ly(fy);
      if (!inside(x, y)) continue;
      const marine = MARINE.has(kind);
      const peak = kind === "mountain" || kind === "volcano";
      const point = !marine && min >= 6 && !peak && kind !== "lake" && !/^[A-Z]/.test(kind);
      const size = kind === "ocean" ? 15 : kind === "sea" ? 13 : 11;
      ctx.font = `italic ${marine || kind === "lake" ? "" : "600 "}${size / z}px ${FONT}`;
      const text = peak ? `▲ ${name}` : name;
      const w = this.width(ctx, text);
      const box = { x: x - w / 2 - 3 / z, y: y - (size * 0.75) / z, width: w + 6 / z, height: (size * 1.5) / z };
      if (!free(box)) continue;
      const id = `named-${i}`;
      this.label(ctx, id, box, () => `${name}\n${kind.toLowerCase()}\nClick to read about it`);
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = marine || kind === "lake" ? "rgba(169, 211, 234, 0.8)" : "rgba(255, 255, 255, 0.7)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = marine || kind === "lake" ? "#1e5a8a" : point ? "#57534e" : "#78350f";
      ctx.fillText(text, x, y);
      ctx.endGroup();
      this.subjects.set(id, { name, wikidata, fly: { x: fx, y: fy, zoom: Math.max(zoom, Math.min(max, min + 1.5)) } });
      this.labels++;
    }
    this.named = new Map();
    if (zoom >= OSM_ZOOM && this.osmDrawn > 0) this.drawTowns(ctx, zoom, lx, ly, inside, free, z);
    else {
      // Natural Earth's places, farther out: capitals and the biggest towns first.
      const places = world.places
        .filter((p) => p[3] <= zoom + 1 && inside(lx(p[4]), ly(p[5])))
        .sort((a, b) => b[6] - a[6] || b[2] - a[2])
        .slice(0, 400);
      ctx.textAlign = "left";
      for (const [i, p] of places.entries()) {
        const x = lx(p[4]);
        const y = ly(p[5]);
        const big = p[6] === 1 || p[2] > 2e6;
        ctx.font = `${big ? "600 " : ""}${(big ? 12 : 11) / z}px ${FONT}`;
        const w = this.width(ctx, p[0]);
        if (!free({ x: x - 4 / z, y: y - 8 / z, width: w + 12 / z, height: 16 / z })) continue;
        const id = `place-${i}-${p[0]}`;
        ctx.beginGroup({ id, meta: { datum: this.datum(id, () => `${p[0]}\n${p[1]}${p[2] > 0 ? `\npopulation ${people(p[2])}` : ""}`) } });
        ctx.beginPath();
        if (p[6] === 1) ctx.rect(x - 3.5 / z, y - 3.5 / z, 7 / z, 7 / z);
        else ctx.arc(x, y, (big ? 3.2 : 2.4) / z, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.4 / z;
        ctx.strokeStyle = "#1f2937";
        ctx.stroke();
        // A halo keeps the name readable over roads and borders.
        ctx.lineWidth = 3 / z;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.strokeText(p[0], x + 6 / z, y);
        ctx.fillStyle = "#111827";
        ctx.fillText(p[0], x + 6 / z, y);
        ctx.endGroup();
        // A town reads about itself and flies close; clicked again, close enough for Wikipedia's articles.
        const fly = { x: p[4], y: p[5], zoom: zoom < 7 ? Math.max(zoom + 1.5, 7.5) : Math.max(zoom + 1.5, 13) };
        if (p[7]) this.subjects.set(id, { name: p[0], wikidata: p[7], fly });
        else this.targets.set(id, fly);
        this.labels++;
      }
    }
    if (zoom >= WIKI_ZOOM) this.drawPins(ctx, { wx0, wy0, wx1, wy1 }, lx, ly, free, z);
    if (this.osmDrawn > 0) {
      // OpenFreeMap's terms: credit OpenMapTiles and OpenStreetMap's contributors.
      const credit = "© OpenMapTiles © OpenStreetMap contributors";
      ctx.font = `${10 / z}px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const w = this.width(ctx, credit);
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      ctx.fillRect(window.x, window.y + window.height - 15 / z, w + 10 / z, 15 / z);
      ctx.fillStyle = "#475569";
      ctx.fillText(credit, window.x + 5 / z, window.y + window.height - 2 / z);
      ctx.textBaseline = "middle";
    }
  }

  /**
   * OpenStreetMap over Natural Earth: each tile in view, or the nearest tile
   * above it that has come while it hasn't, filled with land and then drawn
   * style by style across all of them, so a road crossing tiles is one path.
   */
  private drawStreets(ctx: RecordingContext, zoom: number, view: { wx0: number; wy0: number; wx1: number; wy1: number }, lx: (x: number) => number, ly: (y: number) => number, z: number): void {
    // Tiles about 512 pixels across, as OpenFreeMap makes them.
    const tz = Math.max(0, Math.min(this.osmMax, Math.floor(zoom) - 1));
    const n = 2 ** tz;
    const wanted: string[] = [];
    const drawn = new Set<string>();
    for (let tx = Math.max(0, Math.floor(view.wx0 * n)); tx <= Math.min(n - 1, Math.floor(view.wx1 * n)); tx++) {
      for (let ty = Math.max(0, Math.floor(view.wy0 * n)); ty <= Math.min(n - 1, Math.floor(view.wy1 * n)); ty++) {
        const key = `${tz}/${tx}/${ty}`;
        const got = this.osm.get(key);
        if (Array.isArray(got)) {
          drawn.add(key);
          continue;
        }
        if (got === undefined) wanted.push(key);
        for (let up = 1; up <= 4 && tz - up >= 0; up++) {
          const above = `${tz - up}/${tx >> up}/${ty >> up}`;
          if (Array.isArray(this.osm.get(above))) {
            drawn.add(above);
            break;
          }
        }
      }
    }
    const cx = this.camera.x * n;
    const cy = this.camera.y * n;
    const distance = (key: string): number => {
      const [, x, y] = key.split("/").map(Number) as [number, number, number];
      return Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    };
    this.wantStreets(wanted.sort((a, b) => distance(a) - distance(b)));
    // Coarser tiles first, standing in where finer ones haven't come.
    const tiles = [...drawn].map((key) => {
      const [tz2, x, y] = key.split("/").map(Number) as [number, number, number];
      return { key, z: tz2, x, y, features: this.osm.get(key) as TileFeature[] };
    });
    tiles.sort((a, b) => a.z - b.z);
    this.osmDrawn = tiles.filter((t) => t.features.length > 0).length;
    // Their places, once each: a tile repeats those near its edges.
    const seen = new Set<string>();
    this.osmPlaces = [];
    for (const t of tiles) {
      const size = 1 / 2 ** t.z;
      for (const f of t.features) {
        const p = placeOf(f);
        if (!p || p.x < 0 || p.x >= 1 || p.y < 0 || p.y >= 1) continue;
        const x = (t.x + p.x) * size;
        const y = (t.y + p.y) * size;
        const key = `${p.name}|${Math.round(x * 2e4)}|${Math.round(y * 2e4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.osmPlaces.push({ name: p.name, kind: p.kind, rank: p.rank, x, y });
      }
    }
    if (this.osmDrawn === 0) return;
    const scale = Math.max(0.35, Math.min(2.2, 2 ** ((zoom - 14) / 2)));
    const near = 0.8 / z;
    const styles = new Map<string, { paint: Paint; parts: { parts: readonly Float32Array[]; t: (typeof tiles)[number] }[] }>();
    ctx.beginGroup({ id: "streets", meta: { hit: false } });
    for (const t of tiles) {
      // A tile with nothing in it is open sea, or not drawn by OpenFreeMap: Natural Earth shows there.
      if (t.features.length === 0) continue;
      const size = 1 / 2 ** t.z;
      const x0 = lx(t.x * size);
      const y0 = ly(t.y * size);
      ctx.fillStyle = LAND;
      ctx.fillRect(x0, y0, lx((t.x + 1) * size) - x0, ly((t.y + 1) * size) - y0);
      for (const f of t.features) {
        const p = paint(f);
        if (!p || (p.from !== undefined && zoom < p.from)) continue;
        const key = `${p.order}|${p.fill ?? ""}|${p.stroke ?? ""}|${p.width ?? 0}|${p.dash?.join(",") ?? ""}`;
        let style = styles.get(key);
        if (!style) styles.set(key, (style = { paint: p, parts: [] }));
        style.parts.push({ parts: f.parts, t });
      }
    }
    for (const { paint: p, parts } of [...styles.values()].sort((a, b) => a.paint.order - b.paint.order)) {
      ctx.beginPath();
      for (const { parts: rings, t } of parts) {
        const size = 1 / 2 ** t.z;
        for (const ring of rings) {
          let px = lx((t.x + ring[0]!) * size);
          let py = ly((t.y + ring[1]!) * size);
          ctx.moveTo(px, py);
          const last = ring.length - 2;
          for (let i = 2; i <= last; i += 2) {
            const x = lx((t.x + ring[i]!) * size);
            const y = ly((t.y + ring[i + 1]!) * size);
            if (i < last && Math.abs(x - px) < near && Math.abs(y - py) < near) continue;
            ctx.lineTo(x, y);
            px = x;
            py = y;
            this.points++;
          }
        }
      }
      if (p.fill) {
        ctx.fillStyle = p.fill;
        ctx.fill();
      } else {
        ctx.strokeStyle = p.stroke!;
        ctx.lineWidth = ((p.width ?? 1) * scale) / z;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash((p.dash ?? []).map((d) => (d * scale) / z));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.endGroup();
  }

  /**
   * OpenStreetMap's places, the most important first: cities from zoom 9,
   * towns from 10, villages and districts closer in. A click reads about
   * one, finding its article among those near it, and flies close.
   */
  private drawTowns(ctx: RecordingContext, zoom: number, lx: (x: number) => number, ly: (y: number) => number, inside: (x: number, y: number) => boolean, free: (r: Rect) => boolean, z: number): void {
    const towns = this.osmPlaces
      .filter((t) => (PLACE_ZOOM[t.kind] ?? 99) <= zoom && inside(lx(t.x), ly(t.y)))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 400);
    ctx.textAlign = "left";
    for (const [i, t] of towns.entries()) {
      const x = lx(t.x);
      const y = ly(t.y);
      const big = t.kind === "city";
      const small = t.kind !== "city" && t.kind !== "town";
      ctx.font = `${big ? "600 " : ""}${(big ? 12.5 : small ? 10.5 : 11.5) / z}px ${FONT}`;
      const w = this.width(ctx, t.name);
      if (!free({ x: x - 4 / z, y: y - 8 / z, width: w + 12 / z, height: 16 / z })) continue;
      const id = `town-${i}-${t.name}`;
      ctx.beginGroup({ id, meta: { datum: this.datum(id, () => `${t.name}\n${t.kind}\nClick to read about it`) } });
      if (!small) {
        ctx.beginPath();
        ctx.arc(x, y, (big ? 3.2 : 2.6) / z, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.4 / z;
        ctx.strokeStyle = "#1f2937";
        ctx.stroke();
      }
      const at = small ? x - w / 2 : x + 6 / z;
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.strokeText(t.name, at, y);
      ctx.fillStyle = small ? "#4b5563" : "#111827";
      ctx.fillText(t.name, at, y);
      ctx.endGroup();
      this.subjects.set(id, { name: t.name, near: { x: t.x, y: t.y }, fly: { x: t.x, y: t.y, zoom: Math.max(zoom, 13) } });
      const key = t.name.toLowerCase();
      (this.named.get(key) ?? (this.named.set(key, []), this.named.get(key)!)).push(t);
      this.labels++;
    }
  }

  /** Asks for anything wanted once the view has rested a moment: a flight or a fast zoom passes over cells and tiles it needn't. */
  private quiet(): void {
    const send = (): void => {
      this.settle = 0;
      while (this.asking < ASKING && this.queue.length > 0) void this.ask(this.queue.shift()!);
      while (this.osmAsking < OSM_ASKING && this.osmQueue.length > 0) void this.askStreets(this.osmQueue.shift()!);
    };
    // Only a move starts the wait over: a redraw for an answer that came leaves it running.
    const at = `${this.camera.x}|${this.camera.y}|${this.camera.scale}`;
    if (at === this.settledAt) {
      if (this.settle === 0) send();
      return;
    }
    this.settledAt = at;
    window.clearTimeout(this.settle);
    this.settle = window.setTimeout(send, 150);
  }

  /** Asks for tiles, in order, dropping those asked for before that are out of view now. */
  private wantStreets(keys: string[]): void {
    this.osmQueue = keys;
    if (keys.length > 0) this.quiet();
  }

  private async askStreets(key: string): Promise<void> {
    this.osm.set(key, "asking");
    this.osmAsking++;
    const [z, x, y] = key.split("/").map(Number) as [number, number, number];
    try {
      this.osmMax = await tileZoom();
      this.osm.set(key, await tile(z, x, y));
      this.osmTrouble = "";
    } catch (error) {
      this.osm.set(key, "failed");
      this.osmTrouble = String(error instanceof Error ? error.message : error);
      this.host.log(`world map: OpenFreeMap didn't answer for tile ${key}: ${this.osmTrouble}`);
      window.setTimeout(() => this.osm.get(key) === "failed" && this.osm.delete(key), 15000);
    }
    // The oldest tiles go first when there are too many.
    if (this.osm.size > OSM_KEEP) {
      for (const [k, v] of this.osm) {
        if (this.osm.size <= OSM_KEEP - 50) break;
        if (v !== "asking") this.osm.delete(k);
      }
    }
    this.osmAsking--;
    if (this.osmQueue.length > 0) void this.askStreets(this.osmQueue.shift()!);
    this.redraw();
  }

  /** Wikipedia's articles in view, asking for the cells not yet asked; each a pin, named where there's room. */
  private drawPins(ctx: RecordingContext, view: { wx0: number; wy0: number; wx1: number; wy1: number }, lx: (x: number) => number, ly: (y: number) => number, free: (r: Rect) => boolean, z: number): void {
    const n = 2 ** CELL;
    const wanted: string[] = [];
    const shown: Placed[] = [];
    const cx = Math.floor(this.camera.x * n);
    const cy = Math.floor(this.camera.y * n);
    for (let tx = Math.max(0, Math.floor(view.wx0 * n)); tx <= Math.min(n - 1, Math.floor(view.wx1 * n)); tx++) {
      for (let ty = Math.max(0, Math.floor(view.wy0 * n)); ty <= Math.min(n - 1, Math.floor(view.wy1 * n)); ty++) {
        const key = `${tx}/${ty}`;
        const cell = this.cells.get(key);
        if (cell === undefined) wanted.push(key);
        else if (Array.isArray(cell)) for (const pin of cell) if (pin.x >= view.wx0 && pin.x <= view.wx1 && pin.y >= view.wy0 && pin.y <= view.wy1 && !this.onMap(pin)) shown.push(pin);
      }
    }
    // The cells nearest the middle first.
    const distance = (key: string): number => {
      const [x, y] = key.split("/").map(Number) as [number, number];
      return Math.hypot(x - cx, y - cy);
    };
    this.want(wanted.sort((a, b) => distance(a) - distance(b)));
    ctx.textAlign = "left";
    ctx.font = `${11 / z}px ${FONT}`;
    const chosen = this.reading?.title;
    // The article read now last, over the rest.
    shown.sort((a, b) => Number(a.title === chosen) - Number(b.title === chosen));
    const done = new Set<number>();
    for (const pin of shown.slice(-3000)) {
      // An article Wikipedia places in two cells is pinned once.
      if (done.has(pin.id)) continue;
      done.add(pin.id);
      const x = lx(pin.x);
      const y = ly(pin.y);
      const on = pin.title === chosen;
      const id = `wiki-${pin.id}`;
      ctx.beginGroup({ id, meta: { datum: `${pin.title}${pin.type ? `\n${pin.type}` : ""}\nClick to read it` } });
      ctx.beginPath();
      ctx.arc(x, y, (on ? 7 : 4.5) / z, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#f97316" : (PIN_COLORS[pin.type] ?? "#2563eb");
      ctx.fill();
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      const w = this.width(ctx, pin.title);
      if (on || free({ x: x - 5 / z, y: y - 8 / z, width: w + 14 / z, height: 16 / z })) {
        ctx.lineWidth = 3 / z;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.strokeText(pin.title, x + 7 / z, y);
        ctx.fillStyle = on ? "#9a3412" : "#1e3a8a";
        ctx.fillText(pin.title, x + 7 / z, y);
      }
      ctx.endGroup();
      this.subjects.set(id, { name: pin.title, title: pin.title });
      this.pins++;
    }
  }

  /** Whether a pin is a town the map already shows: one of its places of the same name, close by. */
  private onMap(pin: Placed): boolean {
    const name = pin.title.split(",")[0]!.toLowerCase();
    if ((this.named.get(name) ?? []).some((t) => Math.abs(t.x - pin.x) < 3e-4 && Math.abs(t.y - pin.y) < 3e-4)) return true;
    return this.osmDrawn === 0 && (this.towns.get(name) ?? []).some((p) => Math.abs(p[4] - pin.x) < 3e-4 && Math.abs(p[5] - pin.y) < 3e-4);
  }

  /** Starts a label's group, with a box that takes clicks and its tooltip; the caller draws it and ends the group. */
  private label(ctx: RecordingContext, id: string, box: Rect, datum: () => string): void {
    ctx.beginGroup({ id, meta: { datum: this.datum(id, datum) } });
    ctx.fillStyle = "transparent";
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  /** Asks for cells, in order, dropping those asked for before that are out of view now. */
  private want(keys: string[]): void {
    this.queue = keys;
    if (keys.length > 0) this.quiet();
  }

  private async ask(key: string): Promise<void> {
    this.cells.set(key, "asking");
    this.asking++;
    const [tx, ty] = key.split("/").map(Number) as [number, number];
    const n = 2 ** CELL;
    const box = { north: latitude(ty / n), south: latitude((ty + 1) / n), west: (tx / n) * 360 - 180, east: ((tx + 1) / n) * 360 - 180 };
    try {
      const pins = await articlesIn(box);
      this.cells.set(
        key,
        pins.map((p) => {
          const [x, y] = mercator(p.lat, p.lon);
          return { ...p, x, y };
        }),
      );
      this.trouble = "";
    } catch (error) {
      this.cells.set(key, "failed");
      this.trouble = String(error instanceof Error ? error.message : error);
      this.host.log(`world map: Wikipedia didn't answer for cell ${key}: ${this.trouble}`);
      // A failed cell is asked again when it next comes into view, a while from now.
      window.setTimeout(() => this.cells.get(key) === "failed" && this.cells.delete(key), 15000);
    }
    this.asking--;
    if (this.queue.length > 0) void this.ask(this.queue.shift()!);
    this.redraw();
  }

  /**
   * Reads an article in the panel, opening it first, and flies to the
   * subject: where the click said, or to the article's place at a zoom
   * that suits its size, a sea farther out than a statue.
   */
  private read(subject: Subject): void {
    const request = ++this.request;
    if (!this.panel?.alive) {
      this.panel = new Reader(this.scene, this.router, this.host.reader(), this.panelSpec());
    }
    this.panel.wait(subject.name, "Asking Wikipedia for the article");
    this.reading = { title: subject.title ?? subject.name, at: null };
    if (subject.fly) this.fly(subject.fly);
    this.redraw();
    const title =
      subject.title !== undefined
        ? Promise.resolve(subject.title)
        : subject.wikidata
          ? titleOf(subject.wikidata)
          : titleNear(subject.name, latitude(subject.near!.y), subject.near!.x * 360 - 180);
    title
      .then((t) => {
        if (t === null) throw new Error(`the English Wikipedia has no article on ${subject.name}`);
        return article(t);
      })
      .then(
        (a) => {
          if (request !== this.request || !this.panel?.alive) return;
          this.panel.open(a.title, "from Wikipedia", a.doc);
          this.reading = { title: a.title, at: a.at ? mercator(a.at.lat, a.at.lon) : null };
          if (a.at && !subject.fly) {
            // Half the view across the subject; 13 when Wikipedia doesn't say how big it is.
            const meters = 40075016 * Math.cos((a.at.lat * Math.PI) / 180);
            const zoom = a.at.dim ? Math.log2((W * meters) / (256 * 2 * a.at.dim)) : 13;
            this.fly({ x: this.reading.at![0], y: this.reading.at![1], zoom: Math.max(2, Math.min(15, zoom)) });
          } else this.redraw();
        },
        (error: unknown) => {
          if (request !== this.request || !this.panel?.alive) return;
          this.panel.wait(subject.name, `Wikipedia couldn't be reached from this page: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
  }

  private panelSpec(): ReaderSpec {
    return {
      id: `${MAP_ID}:article`,
      parent: MAP_ID,
      at: { x: this.x + W - PANEL, y: this.y + TITLE },
      size: { width: PANEL, body: H - TITLE - PANEL_STATUS, side: 0 },
      title: "",
      subtitle: "",
      sections: "sections",
      font: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
      hint: "Click a link to read on",
      parse: () => ({ paragraphs: [], sections: [], entries: [] }),
      onLink: (title) => this.read({ name: title, title }),
      // Closed after the click that asked for it has finished going through the panel.
      onClose: () =>
        window.setTimeout(() => {
          this.request++;
          this.panel?.close();
          this.panel = null;
          this.reading = null;
          this.redraw();
        }),
    };
  }

  private frameSpec(): ComponentSpec<FrameState> {
    const button = { x: W - 14 - 120, y: 10, width: 120, height: 26 };
    return {
      id: `${MAP_ID}:frame`,
      parent: MAP_ID,
      state: { note: "" },
      transform: { a: 1, b: 0, c: 0, d: 1, e: this.x, f: this.y },
      cursor: () => "default",
      draw: (c, s) => {
        c.shadowColor = "rgba(15, 23, 42, 0.16)";
        c.shadowBlur = 18;
        c.shadowOffsetY = 4;
        c.beginPath();
        c.roundRect(0, 0, W, TITLE + H, 10);
        c.fillStyle = "#ffffff";
        c.fill();
        c.shadowColor = "transparent";
        c.strokeStyle = "#cbd5e1";
        c.lineWidth = 1;
        c.stroke();
        c.textBaseline = "middle";
        c.font = `600 15px ${FONT}`;
        c.fillStyle = "#0f172a";
        const title = "A world map, made with Natural Earth and Wikipedia";
        c.fillText(title, TITLE_LEFT, TITLE / 2);
        drawClose(c, closeBox(TITLE), false);
        const room = button.x - 14 - (TITLE_LEFT + c.measureText(title).width + 24);
        c.font = `12px ${FONT}`;
        c.fillStyle = "#64748b";
        c.textAlign = "right";
        c.fillText(fit(c, `${s.note}. Wheel zooms, drag pans, click a place to fly there or a pin to read it.`, room), button.x - 14, TITLE / 2);
        c.beginPath();
        c.roundRect(button.x, button.y, button.width, button.height, 6);
        c.fillStyle = "#f1f5f9";
        c.fill();
        c.fillStyle = "#0f172a";
        c.textAlign = "center";
        c.fillText("Whole world", button.x + button.width / 2, button.y + button.height / 2);
        c.textAlign = "left";
      },
      on: {
        click: (e) => {
          if (inBox({ x: e.point.x - this.x, y: e.point.y - this.y }, closeBox(TITLE))) {
            e.stopPropagation();
            this.close();
            return;
          }
          const px = e.point.x - this.x;
          const py = e.point.y - this.y;
          if (px < button.x || px > button.x + button.width || py < button.y || py > button.y + button.height) return;
          e.stopPropagation();
          this.home();
        },
      },
    };
  }
}
