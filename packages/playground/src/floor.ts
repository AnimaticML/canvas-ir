// The playground's board laid flat as the floor of the Babylon room. The page
// runs in a frame; the floor draws its scenes (the board and the cards on it)
// with renderers of its own, in two layers: the whole board at a modest
// detail, redrawn now and then as it changes, and the part near the camera at
// the detail the view needs, chosen by a Focus clipped to around where the
// camera stands, so the floor is sharp at your feet and cheap at the horizon.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene as BabylonScene } from "@babylonjs/core/scene";
import type { World } from "@canvas-ir/babylon";
import { Focus, type FocusRegion, type FocusWorld, type Matrix2D, type Point, Renderer, type Scene } from "canvas-ir";

/** The table under the board, in meters. */
export const TABLE = { thickness: 0.12, height: 1.6 };

/** Board units per meter: the board is a big table, and a 0.6 m ball is about the size of a feature's icon. */
export const UNITS = 300;

/** What the playground's page offers a host that lays its board out as a floor (see main.ts). */
export interface FloorPage {
  scene(): Scene;
  cards(): Scene;
  images(src: string): CanvasImageSource | undefined;
  lod(): boolean;
  view(): Matrix2D;
  setView(view: Matrix2D): void;
  bounds(): { x: number; y: number; width: number; height: number } | null;
  background(): string;
  hits(point: Point): boolean;
  footprints(things: readonly FloorThing[] | null): void;
  onFootprint: ((id: string, phase: "start" | "move" | "end", point: Point) => void) | null;
}

export interface FloorThing {
  readonly id: string;
  readonly kind: "ball" | "crate";
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly size: number;
  readonly color: string;
}

type Box = { x: number; y: number; width: number; height: number };

/** Texture pixels on a tile's side: a change re-uploads only the tiles it touches. */
const TILE = 1024;

interface Tile {
  readonly mesh: Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: DynamicTexture;
  /** Where it sits in the layer's canvas, in pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One layer: a part of the board drawn by renderers of its own into a canvas,
 * shown on the floor as tiles, each a ground mesh with a texture of its piece.
 * The renderers redraw only what changed on the board, and only the tiles
 * under those changes are copied and uploaded again, so a counter ticking in
 * a corner costs one small upload, not the whole floor.
 */
class Layer {
  private readonly board = document.createElement("canvas");
  private readonly cards = document.createElement("canvas");
  private readonly tiles: Tile[] = [];
  private boardRenderer: Renderer | null = null;
  private cardsRenderer: Renderer | null = null;
  private scenes: [Scene, Scene] | null = null;
  private region: FocusRegion | null = null;
  private visible = false;
  private stale = true;

  constructor(
    private readonly name: string,
    private readonly scene: BabylonScene,
    private readonly floor: Floor,
    private readonly lift: number,
    private readonly mipmaps: boolean,
  ) {}

  /** The layer's meshes, to tell the floor from what stands on it. */
  holds(mesh: unknown): boolean {
    return this.tiles.some((t) => t.mesh === mesh);
  }

  /** Draws a part of the board at a detail, from now on. */
  show(region: FocusRegion): void {
    const r = this.region;
    this.setVisible(true);
    if (r && r.x === region.x && r.y === region.y && r.width === region.width && r.height === region.height && r.scale === region.scale) return;
    this.region = region;
    const w = Math.max(1, Math.round(region.width * region.scale));
    const h = Math.max(1, Math.round(region.height * region.scale));
    if (this.board.width !== w || this.board.height !== h) {
      for (const c of [this.board, this.cards]) {
        c.width = w;
        c.height = h;
      }
      this.layout(w, h);
    }
    const view = { a: region.scale, b: 0, c: 0, d: region.scale, e: -region.x * region.scale, f: -region.y * region.scale };
    for (const renderer of this.renderers()) renderer.setView(view, w, h);
    // Each tile covers its piece of the region on the floor: board x is the room's x, board y runs toward -z.
    for (const t of this.tiles) {
      const c = this.floor.toRoom({ x: region.x + (t.x + t.width / 2) / region.scale, y: region.y + (t.y + t.height / 2) / region.scale });
      t.mesh.position.set(c.x, this.lift, c.z);
      t.mesh.scaling.set(t.width / region.scale / UNITS, 1, t.height / region.scale / UNITS);
    }
    this.stale = true;
  }

  hide(): void {
    this.setVisible(false);
  }

  /** Draws what changed on the board since the last time, if the layer is showing. Returns whether it did. */
  draw(): boolean {
    if (!this.region || !this.visible) return false;
    const [board, cards] = this.renderers();
    const a = board.render();
    const b = cards.render();
    const all = this.stale || a.mode === "full" || a.mode === "layers" || b.mode === "full" || b.mode === "layers";
    if (!all && a.mode === "idle" && b.mode === "idle") return false;
    this.stale = false;
    const rects = all ? [] : [...a.rects, ...b.rects];
    for (const t of this.tiles) {
      if (!all && !rects.some((r) => r.x < t.x + t.width && r.x + r.width > t.x && r.y < t.y + t.height && r.y + r.height > t.y)) continue;
      const ctx = t.texture.getContext() as unknown as CanvasRenderingContext2D;
      ctx.fillStyle = this.floor.background;
      ctx.fillRect(0, 0, t.width, t.height);
      ctx.drawImage(this.board, t.x, t.y, t.width, t.height, 0, 0, t.width, t.height);
      ctx.drawImage(this.cards, t.x, t.y, t.width, t.height, 0, 0, t.width, t.height);
      t.texture.update();
    }
    return true;
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    for (const t of this.tiles) t.mesh.isVisible = visible;
  }

  /** Cuts a w by h canvas into tiles, reusing the meshes and textures there are. */
  private layout(w: number, h: number): void {
    const cols = Math.ceil(w / TILE);
    const rows = Math.ceil(h / TILE);
    while (this.tiles.length > cols * rows) {
      const t = this.tiles.pop()!;
      t.texture.dispose();
      t.mesh.material?.dispose();
      t.mesh.dispose();
    }
    for (let i = 0; i < cols * rows; i++) {
      const x = (i % cols) * TILE;
      const y = Math.floor(i / cols) * TILE;
      const width = Math.min(TILE, w - x);
      const height = Math.min(TILE, h - y);
      let t = this.tiles[i];
      if (!t) {
        const mesh = CreateGround(`${this.name}/${i}`, { width: 1, height: 1 }, this.scene);
        mesh.receiveShadows = true;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const texture = new DynamicTexture(`${this.name}/${i}`, canvas, this.scene, this.mipmaps, this.mipmaps ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE);
        texture.anisotropicFilteringLevel = 4;
        const material = new StandardMaterial(`${this.name}/${i}`, this.scene);
        material.diffuseTexture = texture;
        material.specularColor = Color3.Black();
        // A little of its own light, so white paper stays white in the room's light, and shadows still fall on it.
        material.emissiveColor = new Color3(0.32, 0.32, 0.32);
        mesh.material = material;
        t = { mesh, canvas, texture, x, y, width, height };
        this.tiles.push(t);
      } else if (t.width !== width || t.height !== height) t.texture.scaleTo(width, height);
      Object.assign(t, { x, y, width, height });
      t.mesh.isVisible = this.visible;
    }
  }

  /** The renderers, made again when the page's scenes are replaced (as when a board is opened). */
  private renderers(): [Renderer, Renderer] {
    const page = this.floor.page;
    const board = page.scene();
    const cards = page.cards();
    if (!this.scenes || this.scenes[0] !== board || this.scenes[1] !== cards || !this.boardRenderer || !this.cardsRenderer) {
      this.boardRenderer?.dispose();
      this.cardsRenderer?.dispose();
      this.boardRenderer = new Renderer(board, this.board.getContext("2d")!, { images: (src) => page.images(src), ...(page.lod() ? {} : { lod: false }) });
      this.cardsRenderer = new Renderer(cards, this.cards.getContext("2d")!, { lod: false });
      this.scenes = [board, cards];
      const r = this.region;
      if (r) {
        const view = { a: r.scale, b: 0, c: 0, d: r.scale, e: -r.x * r.scale, f: -r.y * r.scale };
        this.boardRenderer.setView(view, this.board.width, this.board.height);
        this.cardsRenderer.setView(view, this.cards.width, this.cards.height);
      }
      this.stale = true;
    }
    return [this.boardRenderer, this.cardsRenderer];
  }
}

/** The board as the room's floor. */
export class Floor {
  /** The board point at the room's origin. */
  readonly origin: Point;
  background = "#f8fafc";
  private readonly base: Layer;
  private readonly detail: Layer;
  private readonly focus: Focus<Mesh>;
  /** A plane under the board's area that the near focus measures the view on. */
  private readonly measure: Mesh;
  /** The board's extent drawn as the base layer, with a margin. */
  private area: Box;
  private lastBase = 0;
  /** The table the board lies on: its top is the board's area, and what rolls past its edge falls to the room's floor. */
  readonly top: Mesh;
  private readonly legs: Mesh[] = [];
  /** The room's floor, below the table. */
  readonly ground: Mesh;
  /** Called when the table changes size, as the board grows: the host gives it a body again. */
  onResize: ((top: Mesh) => void) | null = null;

  constructor(
    readonly page: FloorPage,
    scene: BabylonScene,
    private readonly world: World,
  ) {
    const b = page.bounds() ?? { x: 0, y: 0, width: 2000, height: 1500 };
    this.origin = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    this.area = this.extent();
    this.background = page.background() || this.background;
    // The table: a slab as thick as a tabletop under the board's area, on four legs, over the room's floor.
    this.top = CreateBox("table", { width: 1, height: TABLE.thickness, depth: 1 }, scene);
    this.top.receiveShadows = true;
    const paper = new StandardMaterial("table", scene);
    paper.diffuseColor = Color3.FromHexString(toHex(this.background));
    paper.emissiveColor = new Color3(0.3, 0.3, 0.3);
    paper.specularColor = Color3.Black();
    this.top.material = paper;
    const wood = new StandardMaterial("table/legs", scene);
    wood.diffuseColor = Color3.FromHexString("#94a3b8");
    wood.specularColor = new Color3(0.1, 0.1, 0.1);
    for (let i = 0; i < 4; i++) {
      const leg = CreateCylinder(`table/leg-${i}`, { height: TABLE.height - TABLE.thickness, diameter: 0.35 }, scene);
      leg.material = wood;
      leg.isPickable = false;
      this.legs.push(leg);
    }
    this.ground = CreateGround("room", { width: 600, height: 600 }, scene);
    this.ground.position.y = -TABLE.height;
    this.ground.receiveShadows = true;
    const floorMaterial = new StandardMaterial("room", scene);
    floorMaterial.diffuseColor = Color3.FromHexString("#8796ab");
    floorMaterial.specularColor = Color3.Black();
    this.ground.material = floorMaterial;
    this.base = new Layer("floor/board", scene, this, 0, true);
    this.detail = new Layer("floor/near", scene, this, 0.002, false);
    this.measure = CreateGround("", { width: 1, height: 1 }, scene);
    this.measure.isVisible = false;
    this.measure.isPickable = false;
    // Near detail: what the camera sees of the board, clipped to around where it stands, at the detail the nearest part needs.
    const near: FocusWorld<Mesh> = {
      inView: (mesh, width, height) => {
        const seen = world.inView(mesh, width, height);
        if (!seen) return null;
        const camera = world.camera.globalPosition;
        const foot = this.toBoard(camera);
        const reach = Math.max(2.5, camera.y * 2.5) * UNITS;
        const fx = foot.x - this.area.x;
        const fy = foot.y - this.area.y;
        const x0 = Math.max(seen.x0, fx - reach);
        const y0 = Math.max(seen.y0, fy - reach);
        const x1 = Math.min(seen.x1, fx + reach);
        const y1 = Math.min(seen.y1, fy + reach);
        return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1, density: seen.density } : null;
      },
      get viewSize() {
        return world.viewSize;
      },
      pose: (mesh) => world.pose(mesh),
    };
    this.focus = new Focus(near, this.measure, () => this.area, { maxPixels: 4_194_304, maxScale: 8 });
    this.showBase();
  }

  /** The room's point on the floor (y = 0) under a board point. */
  toRoom(p: Point): Vector3 {
    return new Vector3((p.x - this.origin.x) / UNITS, 0, -(p.y - this.origin.y) / UNITS);
  }

  /** The board point under a point in the room. */
  toBoard(v: Vector3): Point {
    return { x: this.origin.x + v.x * UNITS, y: this.origin.y - v.z * UNITS };
  }

  /** Whether a mesh is part of the floor. */
  holds(mesh: unknown): boolean {
    return mesh === this.top || this.base.holds(mesh) || this.detail.holds(mesh);
  }

  /** Draws the floor for this frame: the near part when the view needs it, and the whole board at most a few times a second as it changes. */
  draw(): void {
    const area = this.extent();
    if (area.x < this.area.x || area.y < this.area.y || area.x + area.width > this.area.x + this.area.width || area.y + area.height > this.area.y + this.area.height) {
      this.area = area;
      this.showBase();
    }
    const now = performance.now();
    if (now - this.lastBase > 400 && this.base.draw()) this.lastBase = now;
    const region = this.focus.update();
    if (region) {
      // A region no finer than the base needs no layer of its own.
      if (region.scale <= this.baseScale() * 1.5) this.detail.hide();
      else this.detail.show({ ...region, x: region.x + this.area.x, y: region.y + this.area.y });
    }
    this.detail.draw();
  }

  /** Draws the whole floor at once, before it is first seen. */
  drawNow(): void {
    this.base.draw();
    this.lastBase = performance.now();
    this.draw();
  }

  private baseScale(): number {
    return Math.min(4096 / this.area.width, 4096 / this.area.height, 2);
  }

  /** The table's top, in the room: its center and size in meters. */
  get table(): { center: Vector3; width: number; depth: number } {
    const c = this.toRoom({ x: this.area.x + this.area.width / 2, y: this.area.y + this.area.height / 2 });
    return { center: c, width: this.area.width / UNITS, depth: this.area.height / UNITS };
  }

  private showBase(): void {
    this.base.show({ ...this.area, scale: this.baseScale() });
    const { center: c, width, depth } = this.table;
    this.measure.position.set(c.x, 0, c.z);
    this.measure.scaling.set(width, 1, depth);
    this.measure.computeWorldMatrix(true);
    this.top.position.set(c.x, -TABLE.thickness / 2 - 0.003, c.z);
    this.top.scaling.set(width, 1, depth);
    this.top.computeWorldMatrix(true);
    this.legs.forEach((leg, i) => {
      leg.position.set(c.x + (i % 2 ? 1 : -1) * (width / 2 - 0.6), -TABLE.thickness - (TABLE.height - TABLE.thickness) / 2, c.z + (i < 2 ? 1 : -1) * (depth / 2 - 0.6));
    });
    this.onResize?.(this.top);
  }

  /** The board's extent with a margin, at least the room's size around its origin. */
  private extent(): Box {
    const b = this.page.bounds() ?? { x: this.origin.x, y: this.origin.y, width: 0, height: 0 };
    const pad = 2 * UNITS;
    const x0 = Math.min(b.x, this.origin.x - 6 * UNITS) - pad;
    const y0 = Math.min(b.y, this.origin.y - 6 * UNITS) - pad;
    const x1 = Math.max(b.x + b.width, this.origin.x + 6 * UNITS) + pad;
    const y1 = Math.max(b.y + b.height, this.origin.y + 6 * UNITS) + pad;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
}

/** A CSS color as #rrggbb. */
const toHex = (css: string): string => {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return css.startsWith("#") ? css : "#f8fafc";
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
};
