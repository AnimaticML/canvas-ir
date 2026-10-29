// A world map of real data: Natural Earth's countries, lakes, towns' built-up
// areas, state lines, rivers, roads and 7,342 places, packed by
// scripts/build-map.ts into tiles at four levels of detail. Its sea is a
// VirtualGroup that draws the tiles that show at the level that suits the
// zoom, decoding each the first time it is needed, so a view of a region
// reads a few of the eight thousand tiles of the finest level and the whole
// world reads four coarse ones. Places and country names are labeled
// biggest first, leaving out any that would overlap.
import { type ComponentHandle, type ComponentSpec, type Components, type EventRouter, type RecordingContext, type RecordingContextOptions, type Rect, type Scene, VirtualGroup } from "canvas-ir";
import worldUrl from "./map/world.bin" with { type: "file" };
import { WheelGesture } from "./wheel";

export const MAP_ID = "world-map";
export const MAP_AT = { x: -560, y: 3850 };
const W = 1400;
const TITLE = 46;
const H = 840;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Zooms as web maps count them: the world is 256 pixels across at 0. */
const MIN_ZOOM = Math.log2((0.98 * W) / 256);
const MAX_ZOOM = 9.5;

interface Country {
  readonly name: string;
  readonly continent: string;
  readonly population: number;
  readonly color: number;
  readonly label: readonly [number, number];
  readonly labelZoom: readonly [number, number];
}
type Place = readonly [name: string, country: string, population: number, minZoom: number, x: number, y: number, capital: number];
interface World {
  readonly layers: readonly string[];
  readonly countries: readonly Country[];
  /** For each line or area layer: each feature's smallest zoom and its kind, in pairs. */
  readonly kinds: Readonly<Record<string, readonly number[]>>;
  readonly places: readonly Place[];
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
  readonly components: () => Components;
  /** The board's zoom: screen pixels per world unit. */
  readonly zoom: () => number;
  readonly render: () => void;
  readonly log: (line: string) => void;
  readonly recorder: RecordingContextOptions;
}

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

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: W, height: TITLE + H };
  }

  bind(scene: Scene, router: EventRouter): void {
    this.scene = scene;
    this.router = router;
    this.sea.bind(scene);
    this.listen();
  }

  moved(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
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
  private fly(to: { x: number; y: number; zoom: number }): void {
    this.land();
    const from = { ...this.camera };
    const scale = this.clampScale((256 * 2 ** to.zoom) / this.host.zoom());
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

  private redraw(): void {
    const t0 = performance.now();
    this.sea.refresh();
    this.note(performance.now() - t0);
    this.host.render();
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
    this.frame.setState({ note: `Zoom ${zoom.toFixed(1)}: ${this.points.toLocaleString("en-US")} points and ${this.labels} labels drawn in ${ms.toFixed(1)} ms` });
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
    this.points = 0;
    this.labels = 0;
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
      this.targets.set(id, { x: country.label[0], y: country.label[1], zoom: Math.min(7, Math.max(zoom + 1, country.labelZoom[0] + 1.5)) });
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
    // Country names, where the country is big enough on screen for one; a click on one reaches the country.
    ctx.font = `600 ${12 / z}px ${FONT}`;
    ctx.beginGroup({ id: "names", meta: { hit: false } });
    for (const country of world.countries) {
      if (zoom < country.labelZoom[0] - 0.5 || zoom > country.labelZoom[1]) continue;
      const x = lx(country.label[0]);
      const y = ly(country.label[1]);
      if (!inside(x, y)) continue;
      const text = country.name.toUpperCase();
      const w = this.width(ctx, text);
      if (!free({ x: x - w / 2 - 4 / z, y: y - 9 / z, width: w + 8 / z, height: 18 / z })) continue;
      ctx.fillStyle = "rgba(51, 65, 85, 0.75)";
      ctx.fillText(text, x, y);
      this.labels++;
    }
    ctx.endGroup();
    // Places: capitals and the biggest towns first.
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
      this.targets.set(id, { x: p[4], y: p[5], zoom: Math.max(zoom + 1.5, 7.5) });
      this.labels++;
    }
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
        c.fillText("A world map, made with Natural Earth", 14, TITLE / 2);
        c.font = `12px ${FONT}`;
        c.fillStyle = "#64748b";
        c.textAlign = "right";
        c.fillText(`${s.note}. Wheel zooms, drag pans, click a country or place to fly there.`, button.x - 14, TITLE / 2);
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
