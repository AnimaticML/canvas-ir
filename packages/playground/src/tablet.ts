// A demo window lifted off the table as a tablet: a thin slab that shows the
// window's part of the board on its face, drawn by renderers of its own, as
// the floor draws the rest. It stands on the table where it was lifted, turned
// to face the camera, and can be carried and turned; laid down again, it
// becomes the window on the board wherever it lies.
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { Scene as BabylonScene } from "@babylonjs/core/scene";
import { type Point, Renderer, type Scene } from "canvas-ir";
import { type FloorPage, type FloorWindow, UNITS } from "./floor";
import { FONT } from "./ui/kit";

/** The slab's thickness, in meters. */
const THICK = 0.06;
/** How far a standing tablet leans back, in radians. */
const LEAN = 0.18;
/** How far a tablet's face can magnify what it shows. */
const MOST = 8;

/** Where a tablet is: on the table at `at` (its center over the table), standing or lying, turned by `yaw`. */
export interface TabletPose {
  readonly at: Vector3;
  /** 0 lying flat, 1 standing. */
  readonly up: number;
  readonly yaw: number;
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Tablet {
  readonly slab: Mesh;
  readonly screen: Mesh;
  /** The window's box on the board, as the page last had it. */
  rect: FloorWindow;
  pose: TabletPose;
  private readonly canvas = document.createElement("canvas");
  private readonly boardCanvas = document.createElement("canvas");
  private readonly cardsCanvas = document.createElement("canvas");
  private readonly texture: DynamicTexture;
  private renderers: { board: Renderer; cards: Renderer; scenes: [Scene, Scene] } | null = null;
  private scale = 1;
  private stale = true;
  private body: PhysicsAggregate | null = null;
  private motion = 0;
  private shown = "";
  /** How far the face magnifies the window below its title bar, and the board point at the middle of what it shows. */
  private magnify = 1;
  private focus: Point;

  constructor(
    private readonly scene: BabylonScene,
    private readonly page: FloorPage,
    window: FloorWindow,
    at: Vector3,
    private readonly background: string,
  ) {
    this.rect = window;
    this.focus = this.middle();
    const w = window.width / UNITS;
    const h = window.height / UNITS;
    this.slab = CreateBox(`tablet/${window.id}`, { width: w, height: THICK, depth: h }, scene);
    const bezel = new StandardMaterial(`tablet/${window.id}`, scene);
    bezel.diffuseColor = Color3.FromHexString("#1e293b");
    bezel.specularColor = new Color3(0.25, 0.25, 0.25);
    this.slab.material = bezel;
    this.screen = CreateGround(`tablet/${window.id}/screen`, { width: w, height: h }, scene);
    this.screen.parent = this.slab;
    this.screen.position.y = THICK / 2 + 0.002;
    // Sharp enough to read up close, within a texture budget.
    this.scale = Math.min(2, 2048 / window.width, 2048 / window.height);
    this.canvas.width = this.boardCanvas.width = this.cardsCanvas.width = Math.max(1, Math.round(window.width * this.scale));
    this.canvas.height = this.boardCanvas.height = this.cardsCanvas.height = Math.max(1, Math.round(window.height * this.scale));
    this.texture = new DynamicTexture(`tablet/${window.id}`, this.canvas, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    this.texture.anisotropicFilteringLevel = 8;
    const glass = new StandardMaterial(`tablet/${window.id}/screen`, scene);
    glass.diffuseTexture = this.texture;
    glass.emissiveTexture = this.texture;
    glass.disableLighting = true;
    this.screen.material = glass;
    this.pose = { at, up: 0, yaw: 0 };
    this.place();
  }

  get id(): string {
    return this.rect.id;
  }

  /** Whether a mesh is this tablet. */
  holds(mesh: unknown): boolean {
    return mesh === this.slab || mesh === this.screen;
  }

  /** Where a point on the face is on the window as it lies on the board, unmagnified. */
  face(point: Vector3): Point {
    const local = Vector3.TransformCoordinates(point, Matrix.Invert(this.screen.computeWorldMatrix(true)));
    const w = this.rect.width / UNITS;
    const h = this.rect.height / UNITS;
    const u = local.x / w + 0.5;
    const v = 0.5 - local.z / h;
    return { x: this.rect.x + u * this.rect.width, y: this.rect.y + v * this.rect.height };
  }

  /** The board point shown at a point on the face: the title bar as it is, the rest as magnified. */
  toBoard(point: Vector3): Point | null {
    return this.shownAt(this.face(point));
  }

  private shownAt(p: Point): Point {
    if (this.magnify === 1 || p.y < this.rect.y + this.rect.bar) return p;
    const m = this.middle();
    return { x: this.focus.x + (p.x - m.x) / this.magnify, y: this.focus.y + (p.y - m.y) / this.magnify };
  }

  /** The middle of the window below its title bar, on the board. */
  private middle(): Point {
    const r = this.rect;
    return { x: r.x + r.width / 2, y: r.y + r.bar + (r.height - r.bar) / 2 };
  }

  /** How far the face magnifies. */
  get zoom(): number {
    return this.magnify;
  }

  /**
   * Magnifies by a factor (below 1 shrinks back), keeping what was shown at face point `from` at face point `to`:
   * a pinch moves and spreads, a wheel spreads in place. The face never shows past the window's edges.
   */
  zoomAt(factor: number, from: Point, to: Point = from): void {
    const q = this.shownAt({ x: from.x, y: Math.max(from.y, this.rect.y + this.rect.bar) });
    const m = this.middle();
    this.magnify = Math.max(1, Math.min(MOST, this.magnify * factor));
    this.focus = { x: q.x - (to.x - m.x) / this.magnify, y: q.y - (to.y - m.y) / this.magnify };
    this.keepInside();
    this.stale = true;
  }

  private keepInside(): void {
    const r = this.rect;
    const m = this.middle();
    const hw = (r.width / 2) * (1 - 1 / this.magnify);
    const hh = ((r.height - r.bar) / 2) * (1 - 1 / this.magnify);
    this.focus = { x: Math.max(m.x - hw, Math.min(m.x + hw, this.focus.x)), y: Math.max(m.y - hh, Math.min(m.y + hh, this.focus.y)) };
  }

  /** The face's plane in the room: a point on it and its normal, to follow a drag past its edge. */
  plane(): { point: Vector3; normal: Vector3 } {
    const m = this.screen.computeWorldMatrix(true);
    return { point: m.getTranslation(), normal: Vector3.TransformNormal(Vector3.Up(), m).normalize() };
  }

  /** Whether a board point is on the window's title bar, past its close button: what a tablet is held by. */
  onBar(p: Point): boolean {
    return p.y >= this.rect.y && p.y <= this.rect.y + this.rect.bar && p.x >= this.rect.x + 46 && p.x <= this.rect.x + this.rect.width;
  }

  /** Moves smoothly to a pose. */
  glide(to: Partial<TabletPose>, ms = 600): Promise<void> {
    const from = this.pose;
    const target = { ...from, ...to };
    let dyaw = (target.yaw - from.yaw) % (2 * Math.PI);
    if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const run = ++this.motion;
    const t0 = performance.now();
    return new Promise((done) => {
      const step = (): void => {
        if (run !== this.motion) return done();
        const t = Math.min(1, (performance.now() - t0) / ms);
        const e = ease(t);
        this.pose = { at: Vector3.Lerp(from.at, target.at, e), up: from.up + (target.up - from.up) * e, yaw: from.yaw + dyaw * e };
        this.place();
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      step();
    });
  }

  /** Sets a pose at once, stopping a glide. */
  set(to: Partial<TabletPose>): void {
    this.motion++;
    this.pose = { ...this.pose, ...to };
    this.place();
  }

  /** Puts the slab where its pose says: lying, its face is where the window is on the board; standing, it rests on its bottom edge, leaning back. */
  private place(): void {
    const { at, up, yaw } = this.pose;
    const h = this.rect.height / UNITS;
    const pitch = -(Math.PI / 2 - LEAN) * up;
    this.slab.rotation.set(pitch, yaw, 0);
    // Lifted by half its height times how far it stands, so its bottom edge stays on the table.
    const lift = THICK / 2 + 0.004 + (h / 2) * Math.sin(-pitch) + 0.02 * up;
    this.slab.position.set(at.x, lift, at.z);
    this.slab.computeWorldMatrix(true);
    this.screen.computeWorldMatrix(true);
  }

  /** Gives the slab a body that follows it, so the crates and balls bounce off it while it stands. */
  solid(on: boolean): void {
    if (on && !this.body) {
      this.body = new PhysicsAggregate(this.slab, PhysicsShapeType.BOX, { mass: 0, restitution: 0.4 }, this.scene);
      this.body.body.setMotionType(PhysicsMotionType.ANIMATED);
      this.body.body.disablePreStep = false;
    } else if (!on && this.body) {
      this.body.dispose();
      this.body = null;
    }
  }

  /** Draws what changed in the window's part of the board onto the face. */
  draw(): void {
    const page = this.page;
    const board = page.scene();
    const cards = page.cards();
    // What is below the title bar, magnified around the focus; at 1 that's just the window's box.
    const k = this.scale * this.magnify;
    const m = this.middle();
    const view = { a: k, b: 0, c: 0, d: k, e: this.scale * (m.x - this.rect.x) - k * this.focus.x, f: this.scale * (m.y - this.rect.y) - k * this.focus.y };
    if (!this.renderers || this.renderers.scenes[0] !== board || this.renderers.scenes[1] !== cards) {
      this.renderers?.board.dispose();
      this.renderers?.cards.dispose();
      this.renderers = {
        board: new Renderer(board, this.boardCanvas.getContext("2d")!, { images: (src) => page.images(src), ...(page.lod() ? {} : { lod: false }) }),
        cards: new Renderer(cards, this.cardsCanvas.getContext("2d")!, { lod: false }),
        scenes: [board, cards],
      };
      this.stale = true;
    }
    const key = `${view.a},${view.e},${view.f}`;
    if (this.stale || key !== this.shown) {
      this.renderers.board.setView(view, this.canvas.width, this.canvas.height);
      this.renderers.cards.setView(view, this.canvas.width, this.canvas.height);
      this.shown = key;
    }
    const a = this.renderers.board.render();
    const b = this.renderers.cards.render();
    if (!this.stale && a.mode === "idle" && b.mode === "idle") return;
    this.stale = false;
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.boardCanvas, 0, 0);
    ctx.drawImage(this.cardsCanvas, 0, 0);
    if (this.magnify > 1) this.drawBar(ctx);
    this.texture.update();
  }

  /** Magnified, the window's own title bar is out of sight, so the face draws one in its place: the title, the close button, how far it magnifies. */
  private drawBar(ctx: CanvasRenderingContext2D): void {
    const s = this.scale;
    const bar = this.rect.bar;
    ctx.save();
    ctx.scale(s, s);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.rect.width, bar);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillRect(0, bar - 1, this.rect.width, 1);
    const cy = bar / 2;
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.arc(24, cy, 12, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(19, cy - 5);
    ctx.lineTo(29, cy + 5);
    ctx.moveTo(29, cy - 5);
    ctx.lineTo(19, cy + 5);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f172a";
    ctx.font = `600 15px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(this.rect.title, 46, cy, this.rect.width - 140);
    ctx.fillStyle = "#64748b";
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(`${this.magnify.toFixed(1)}×`, this.rect.width - 14, cy);
    ctx.restore();
  }

  /** Follows the window when the page moved it, keeping the face the same size. */
  follow(window: FloorWindow): void {
    if (window.x === this.rect.x && window.y === this.rect.y && window.width === this.rect.width && window.height === this.rect.height) return;
    // A window that changed size shows its new box on the face it has; what it magnifies moves with it.
    this.focus = { x: this.focus.x + window.x - this.rect.x, y: this.focus.y + window.y - this.rect.y };
    this.rect = window;
    this.keepInside();
    this.stale = true;
  }

  dispose(): void {
    this.motion++;
    this.solid(false);
    this.renderers?.board.dispose();
    this.renderers?.cards.dispose();
    this.texture.dispose();
    this.screen.material?.dispose();
    this.slab.material?.dispose();
    this.screen.dispose();
    this.slab.dispose();
  }
}
