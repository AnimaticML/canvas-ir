// CanvasIR drawings on Babylon.js meshes, as @canvas-ir/three does for
// three.js. A Surface is a scene drawn into a dynamic texture on a mesh; a
// World is what one EventRouter picks from: it casts the camera's ray into
// the Babylon scene, and where the ray lands on a surface it hit-tests that
// surface's drawing at the texture coordinate under it. So a click on a
// button drawn on a panel bubbles from the button's op through its groups
// into the panel mesh and the nodes that hold it, and a click on a plain mesh
// goes to the mesh, by its name. Objects and Focus come from canvas-ir and
// work the same over either engine.
import "@babylonjs/core/Culling/ray";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Ray } from "@babylonjs/core/Culling/ray";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Node } from "@babylonjs/core/node";
import type { Scene as BabylonScene } from "@babylonjs/core/scene";
import {
  Focus,
  type FocusOptions,
  type FocusRegion as Region,
  type FocusWorld,
  type IRDocument,
  type ObjectHandle as AnyObjectHandle,
  type ObjectHandler as AnyObjectHandler,
  type ObjectSpec as AnyObjectSpec,
  type Op,
  type Pickable,
  type Point,
  type ReplayOptions,
  Scene,
  multiply,
  replayDocument,
} from "canvas-ir";

export { Focus, Objects, type FocusOptions, type FocusRegion as Region, type ObjectUi } from "canvas-ir";
/** An interactive object over a Babylon node; see `Objects` in canvas-ir. */
export type ObjectHandle<S> = AnyObjectHandle<S, Node>;
export type ObjectSpec<S> = AnyObjectSpec<S, Node>;
export type ObjectHandler<S> = AnyObjectHandler<S, Node>;

export interface SurfaceOptions {
  /** The mesh that shows the drawing: its material gets the surface's texture (see `unlit`). A flat mesh, such as a plane, is best: drags that leave its edge go on in its plane. */
  readonly mesh: AbstractMesh;
  /** The drawing's size in its own units; the texture is this times `pixelRatio`. */
  readonly width: number;
  readonly height: number;
  /** Texture pixels per drawing unit. Default 2. */
  readonly pixelRatio?: number;
  /** What to clear to before each drawing; transparent when null. Default white. */
  readonly background?: string | null;
  readonly replay?: ReplayOptions;
  /**
   * Whether the drawing glows as a screen does, the same in any light: a
   * standard material shows it as its emissive texture with lighting off, a
   * PBR material as an unlit albedo. False shows it as the diffuse or albedo
   * texture, lit. Default true.
   */
  readonly unlit?: boolean;
  /**
   * Whether a flat surface follows the camera: drawn again at the detail the
   * view needs, and only the part of it in view, so it stays sharp up close.
   * Default true for a flat mesh; other shapes always draw whole at `pixelRatio`.
   */
  readonly sharp?: boolean | FocusOptions;
  /** The canvas to draw into: a new one by default. */
  readonly canvas?: HTMLCanvasElement;
}

/** Fits a texture holding a region of a `width` by `height` drawing onto a mesh whose uvs span the whole drawing (v up, as Babylon's planes have it). */
export const fitRegion = (texture: Texture, region: Region, width: number, height: number): void => {
  const rx = width / region.width;
  const ry = height / region.height;
  texture.uRotationCenter = 0;
  texture.vRotationCenter = 0;
  texture.uScale = rx;
  texture.vScale = ry;
  texture.uOffset = -(region.x / width) * rx;
  texture.vOffset = -(1 - (region.y + region.height) / height) * ry;
};

/**
 * A flat mesh's shape, read from its vertices: its plane in its own space
 * (a point and the front's normal) and how a point there maps to a uv, so
 * any plane works however it was built, turned or mapped.
 */
interface Flat {
  readonly origin: Vector3;
  readonly normal: Vector3;
  /** uv = (a·p + b, c·p + d) for a point p in the mesh's space. */
  readonly u: { readonly a: Vector3; readonly b: number };
  readonly v: { readonly a: Vector3; readonly b: number };
  /** Its corners in its own space, with their uvs. */
  readonly corners: readonly { readonly p: Vector3; readonly uv: Vector2 }[];
}

const flatOf = (mesh: AbstractMesh): Flat | null => {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !uvs || !normals || positions.length < 9) return null;
  const n = positions.length / 3;
  const p = (i: number) => new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
  const normal = new Vector3(normals[0]!, normals[1]!, normals[2]!).normalize();
  const origin = p(0);
  // Every vertex in one plane, with one normal: a flat mesh (a double-sided plane's back is the other normal, and is left out).
  for (let i = 0; i < n; i++) {
    if (Math.abs(Vector3.Dot(p(i).subtract(origin), normal)) > 1e-6) return null;
    const ni = new Vector3(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
    if (Vector3.Dot(ni, normal) < 0.999 && Vector3.Dot(ni, normal) > -0.999) return null;
  }
  // Two edges from the first vertex that span the plane, to solve the uv mapping from.
  let i1 = -1;
  let i2 = -1;
  for (let i = 1; i < n && i2 < 0; i++) {
    const e = p(i).subtract(origin);
    if (e.length() < 1e-9) continue;
    if (i1 < 0) i1 = i;
    else if (Vector3.Cross(p(i1).subtract(origin), e).length() > 1e-9) i2 = i;
  }
  if (i2 < 0) return null;
  const e1 = p(i1).subtract(origin);
  const e2 = p(i2).subtract(origin);
  // Dual basis: g1·e1 = 1, g1·e2 = 0, and the same for g2, so a point origin + s e1 + t e2 has s = g1·(p - origin).
  const n12 = Vector3.Cross(e1, e2);
  const g1 = Vector3.Cross(e2, n12).scale(1 / Vector3.Dot(e1, Vector3.Cross(e2, n12)));
  const g2 = Vector3.Cross(n12, e1).scale(1 / Vector3.Dot(e2, Vector3.Cross(n12, e1)));
  const uvAt = (i: number) => new Vector2(uvs[i * 2]!, uvs[i * 2 + 1]!);
  const [uv0, uv1, uv2] = [uvAt(0), uvAt(i1), uvAt(i2)];
  const axis = (k: "x" | "y") => {
    const a = g1.scale(uv1[k] - uv0[k]).add(g2.scale(uv2[k] - uv0[k]));
    return { a, b: uv0[k] - Vector3.Dot(a, origin) };
  };
  const u = axis("x");
  const v = axis("y");
  // The corners: the points whose uvs are 0 and 1, back through the mapping.
  const toPoint = (s: number, t: number): Vector3 => {
    // Solve a_u·q = s - b_u, a_v·q = t - b_v for q in the plane: q = origin + x e1 + y e2.
    const m11 = Vector3.Dot(u.a, e1), m12 = Vector3.Dot(u.a, e2), m21 = Vector3.Dot(v.a, e1), m22 = Vector3.Dot(v.a, e2);
    const r1 = s - u.b - Vector3.Dot(u.a, origin), r2 = t - v.b - Vector3.Dot(v.a, origin);
    const det = m11 * m22 - m12 * m21;
    return origin.add(e1.scale((r1 * m22 - m12 * r2) / det)).add(e2.scale((m11 * r2 - m21 * r1) / det));
  };
  const corners = [[0, 1], [1, 1], [1, 0], [0, 0]].map(([s, t]) => ({ p: toPoint(s!, t!), uv: new Vector2(s!, t!) }));
  return { origin, normal, u, v, corners };
};

/** A CanvasIR scene drawn to a dynamic texture on a mesh. */
export class Surface {
  readonly mesh: AbstractMesh;
  readonly texture: DynamicTexture;
  readonly width: number;
  readonly height: number;
  scene: Scene;
  /** What the texture holds: the whole drawing at `pixelRatio` until a focus asks for a part. */
  region: Region;
  readonly sharp: FocusOptions | null;
  /** The mesh's plane, when it is flat. */
  readonly flat: Flat | null;
  private readonly ratio: number;
  private readonly background: string | null;
  private readonly replay: ReplayOptions;
  private dirty = true;

  constructor(document: IRDocument | Scene, options: SurfaceOptions) {
    this.mesh = options.mesh;
    this.width = options.width;
    this.height = options.height;
    this.ratio = options.pixelRatio ?? 2;
    this.background = options.background === undefined ? "#ffffff" : options.background;
    this.replay = options.replay ?? {};
    this.scene = document instanceof Scene ? document : new Scene(document);
    this.flat = flatOf(this.mesh);
    const sharp = options.sharp ?? this.flat !== null;
    this.sharp = sharp === false || !this.flat ? null : sharp === true ? {} : sharp;
    this.region = { x: 0, y: 0, width: this.width, height: this.height, scale: this.ratio };
    const size = { width: Math.round(this.width * this.ratio), height: Math.round(this.height * this.ratio) };
    if (options.canvas) Object.assign(options.canvas, size);
    // Drawn at the detail the view needs, it is never shown much smaller than drawn: mipmaps would only cost an extra pass per upload.
    this.texture = new DynamicTexture(`${this.mesh.name}/surface`, options.canvas ?? size, this.mesh.getScene(), !this.sharp, Texture.BILINEAR_SAMPLINGMODE);
    this.texture.hasAlpha = this.background === null;
    const material = this.mesh.material as unknown as Record<string, unknown> | null;
    if (material) {
      const unlit = options.unlit ?? true;
      if ("albedoTexture" in material) {
        material["albedoTexture"] = this.texture;
        if (unlit) material["unlit"] = true;
      } else if (unlit) {
        material["emissiveTexture"] = this.texture;
        material["disableLighting"] = true;
      } else material["diffuseTexture"] = this.texture;
    }
  }

  /** Marks the drawing changed; `draw()` repaints it once, on the next frame that asks. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Draws a region of the drawing from now on, at its scale; the texture is fitted so the mesh shows the drawing where it was. */
  show(region: Region): void {
    this.region = region;
    this.dirty = true;
  }

  /** Repaints the texture and uploads it, if anything changed since the last time. Returns whether it did. */
  draw(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const region = this.region;
    const w = Math.max(1, Math.round(region.width * region.scale));
    const h = Math.max(1, Math.round(region.height * region.scale));
    const now = this.texture.getSize();
    if (now.width !== w || now.height !== h) this.texture.scaleTo(w, h);
    fitRegion(this.texture, region, this.width, this.height);
    const ctx = this.texture.getContext() as unknown as CanvasRenderingContext2D;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, w, h);
    }
    const k = region.scale;
    const place = { a: k, b: 0, c: 0, d: k, e: -region.x * k, f: -region.y * k };
    replayDocument(ctx, this.scene.document, { ...this.replay, view: multiply(place, this.replay.view ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    this.texture.update();
    return true;
  }

  /** The drawing's point at a texture coordinate (Babylon's uv: 0,0 is the bottom left). */
  pointAtUv(uv: { x: number; y: number }): Point {
    return { x: uv.x * this.width, y: (1 - uv.y) * this.height };
  }
}

export interface WorldOptions {
  readonly scene: BabylonScene;
  /** The camera the rays come from. Default the scene's active camera. */
  readonly camera?: () => Camera | null;
  /** The host element's size in CSS pixels, which the router's positions are in. */
  readonly size: () => { width: number; height: number };
}

/** What a host pixel shows in 3D. */
export interface WorldHit {
  readonly mesh: AbstractMesh;
  /** The nearest node holding it, itself included, whose name is on event paths. */
  readonly named: Node | null;
  readonly point: Vector3;
  readonly normal: Vector3 | null;
  readonly distance: number;
  readonly uv: Vector2 | null;
}

/**
 * The 3D world as an EventRouter sees it. Meshes are hit by their `name`,
 * which should be unique among the nodes events go to; a mesh named "" is hit
 * but bubbles straight to its nearest named parent. Op and group ids must be
 * unique across surfaces. A mesh that isn't pickable, enabled and visible, or
 * whose `metadata.hit` is false, lets the ray through.
 */
export class World implements Pickable, FocusWorld<AbstractMesh> {
  private readonly surfaces = new Map<AbstractMesh, Surface>();
  private readonly focuses = new Map<Surface, Focus<AbstractMesh>>();
  private lastRay: Ray | null = null;

  constructor(private readonly options: WorldOptions) {}

  add(surface: Surface): Surface {
    this.surfaces.set(surface.mesh, surface);
    if (surface.sharp) this.focuses.set(surface, new Focus(this, surface.mesh, () => surface, surface.sharp));
    return surface;
  }

  remove(surface: Surface): void {
    this.surfaces.delete(surface.mesh);
    this.focuses.delete(surface);
  }

  get all(): Surface[] {
    return [...this.surfaces.values()];
  }

  /** Repaints the surfaces that changed, or whose view needs another region or more detail. Call it before each render, as in `scene.onBeforeRenderObservable`. */
  draw(): void {
    for (const [s, focus] of this.focuses) {
      const region = focus.update();
      if (region) s.show(region);
    }
    for (const s of this.surfaces.values()) s.draw();
  }

  get camera(): Camera {
    const camera = this.options.camera?.() ?? this.options.scene.activeCamera;
    if (!camera) throw new Error("the world has no camera: the scene has no active camera");
    return camera;
  }

  get viewSize(): { width: number; height: number } {
    return this.options.size();
  }

  /** The camera's ray through a host pixel. */
  ray(screen: Point): Ray {
    const { width, height } = this.options.size();
    const camera = this.camera;
    const ray = Ray.CreateNew(screen.x, screen.y, width, height, Matrix.Identity(), camera.getViewMatrix(), camera.getProjectionMatrix());
    // From the eye, as three.js casts it, not the near plane: a panel nearer than the near plane still takes a drag's points in its plane.
    if (camera.mode === 0) ray.origin = camera.globalPosition.clone();
    this.lastRay = ray;
    return ray;
  }

  /** The nearest pick under a host pixel, skipping what doesn't take hits; among `meshes` only, when given. */
  intersect(screen: Point, meshes?: readonly AbstractMesh[]): PickingInfo | null {
    const ray = this.ray(screen);
    const pick = this.options.scene.pickWithRay(ray, (m) => (meshes ? meshes.includes(m) : true) && this.takesHits(m));
    return pick?.hit && pick.pickedMesh ? pick : null;
  }

  /** What a host pixel shows, for handlers that need more than ids. */
  hit(screen: Point, meshes?: readonly AbstractMesh[]): WorldHit | null {
    const pick = this.intersect(screen, meshes);
    if (!pick?.pickedMesh || !pick.pickedPoint) return null;
    return { mesh: pick.pickedMesh, named: this.named(pick.pickedMesh), point: pick.pickedPoint.clone(), normal: pick.getNormal(true), distance: pick.distance, uv: pick.getTextureCoordinates() };
  }

  /** Where the camera's ray through a host pixel meets a plane through `point` with `normal`, or null when it runs along it or away. */
  onPlane(screen: Point, point: Vector3, normal: Vector3): Vector3 | null {
    const ray = this.ray(screen);
    const t = ray.intersectsPlane(Plane.FromPositionAndNormal(point, normal));
    return t === null ? null : ray.origin.add(ray.direction.scale(t));
  }

  /**
   * Where a host pixel lands on a mesh that shows something other than a
   * surface, in that content's units (`width` by `height`, from the top
   * left): on the mesh, or in a flat mesh's plane past its edges. Null when
   * the ray misses.
   */
  pointOn(mesh: AbstractMesh, screen: Point, width: number, height: number): Point | null {
    const pick = this.intersect(screen, [mesh]);
    const uv = pick?.getTextureCoordinates() ?? this.uvOnPlane(mesh, flatOf(mesh));
    return uv ? { x: uv.x * width, y: (1 - uv.y) * height } : null;
  }

  /** The surface whose drawing holds an op or group id. */
  surfaceOf(id: string): Surface | null {
    for (const s of this.surfaces.values()) if (s.scene.get(id) || s.scene.getGroup(id)) return s;
    return null;
  }

  /** The node with a name. */
  node(id: string): Node | null {
    return this.options.scene.getNodeByName(id);
  }

  pose(mesh: AbstractMesh): string {
    const camera = this.camera;
    return [...camera.getViewMatrix().m, ...camera.getProjectionMatrix().m, ...mesh.getWorldMatrix().m].join(",");
  }

  /**
   * What of a flat mesh's content (`width` by `height`, from the top left)
   * the camera sees, and how many CSS pixels of the host one unit of it
   * covers where it is closest; null when none of its front is in view.
   */
  inView(mesh: AbstractMesh, width: number, height: number): { x0: number; y0: number; x1: number; y1: number; density: number } | null {
    const flat = this.surfaces.get(mesh)?.flat ?? flatOf(mesh);
    if (!flat) return null;
    const camera = this.camera;
    const { width: sw, height: sh } = this.options.size();
    const world = mesh.computeWorldMatrix();
    const normal = Vector3.TransformNormal(flat.normal, world).normalize();
    const toCamera = camera.globalPosition.subtract(Vector3.TransformCoordinates(flat.origin, world));
    if (Vector3.Dot(normal, toCamera) <= 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, density = 0;
    const take = (u: number, v: number): void => {
      const x = Math.min(1, Math.max(0, u)) * width;
      const y = (1 - Math.min(1, Math.max(0, v))) * height;
      x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y);
    };
    const inside = (uv: Vector2 | null | undefined): uv is Vector2 => uv != null && uv.x >= -0.001 && uv.x <= 1.001 && uv.y >= -0.001 && uv.y <= 1.001;
    // Rays on a grid over the host: where they meet the plane, and how far apart they land there.
    const N = 12;
    const grid: (Vector2 | null)[][] = [];
    for (let i = 0; i <= N; i++) {
      grid.push([]);
      for (let j = 0; j <= N; j++) {
        this.ray({ x: (i / N) * sw, y: (j / N) * sh });
        const uv = this.uvOnPlane(mesh, flat);
        grid[i]!.push(uv);
        if (inside(uv)) take(uv.x, uv.y);
      }
    }
    const spread = (a: Vector2 | null | undefined, b: Vector2 | null | undefined, pixels: number): void => {
      if (!inside(a) || !inside(b)) return;
      const units = Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
      if (units > 0) density = Math.max(density, pixels / units);
    };
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        spread(grid[i]![j], grid[i + 1]?.[j], sw / N);
        spread(grid[i]![j], grid[i]![j + 1], sh / N);
      }
    }
    // Its corners on the host: all of a mesh small enough to fall between the rays, and its size there.
    const viewProjection = camera.getViewMatrix().multiply(camera.getProjectionMatrix());
    const m = viewProjection.m;
    const corners = flat.corners.map(({ p, uv }) => {
      const q = Vector3.TransformCoordinates(p, world);
      const w = q.x * m[3]! + q.y * m[7]! + q.z * m[11]! + m[15]!;
      const ndc = Vector3.TransformCoordinates(q, viewProjection);
      return { u: uv.x, v: uv.y, x: ((ndc.x + 1) / 2) * sw, y: ((1 - ndc.y) / 2) * sh, front: w > 0 };
    });
    for (const c of corners) if (c.front && c.x >= 0 && c.x <= sw && c.y >= 0 && c.y <= sh) take(c.u, c.v);
    if (corners.every((c) => c.front)) {
      for (let k = 0; k < 4; k++) {
        const a = corners[k]!;
        const b = corners[(k + 1) % 4]!;
        density = Math.max(density, Math.hypot(a.x - b.x, a.y - b.y) / (k % 2 === 0 ? width : height));
      }
    }
    if (!(x1 > x0 && y1 > y0) || density === 0) return null;
    return { x0, y0, x1, y1, density };
  }

  // Pickable: the router's world is the host's pixels (its view is left as the identity).

  hitTest(point: Point): { id: string; groups: string[] }[] {
    const pick = this.intersect(point);
    if (!pick?.pickedMesh) return [];
    const mesh = pick.pickedMesh;
    const surface = this.surfaces.get(mesh);
    const uv = surface ? pick.getTextureCoordinates() : null;
    if (surface && uv) {
      const [inner] = surface.scene.hitTest(surface.pointAtUv(uv));
      if (inner) return [{ id: inner.id, groups: [...inner.groups, ...this.chain(mesh)] }];
    }
    const named = this.named(mesh);
    if (!named) return [];
    return [{ id: named.name, groups: this.chain(named.parent) }];
  }

  get(id: string): Op | undefined {
    return this.surfaceOf(id)?.scene.get(id);
  }

  getGroup(id: string): unknown {
    return this.surfaceOf(id)?.scene.getGroup(id) ?? this.node(id) ?? undefined;
  }

  groupChain(id: string): string[] {
    const surface = this.surfaceOf(id);
    if (surface) return [...surface.scene.groupChain(id), ...this.chain(surface.mesh)];
    return this.chain(this.node(id)?.parent ?? null);
  }

  /**
   * A drawing's ids get points in the drawing's own units: where the ray meets
   * the surface, or, once a drag has left a flat surface, where it meets the
   * surface's plane. Meshes get null: the host's pixels.
   */
  pointAt(screen: Point, target: string | null): Point | null {
    if (target === null) return null;
    const surface = this.surfaceOf(target);
    if (!surface) return null;
    const uv = this.intersect(screen, [surface.mesh])?.getTextureCoordinates() ?? this.uvOnPlane(surface.mesh, surface.flat);
    return uv ? surface.pointAtUv(uv) : null;
  }

  private takesHits(mesh: AbstractMesh): boolean {
    if (!mesh.isPickable || !mesh.isEnabled() || !mesh.isVisible) return false;
    for (let n: Node | null = mesh; n; n = n.parent) if ((n.metadata as { hit?: boolean } | null)?.hit === false) return false;
    return true;
  }

  private named(node: Node | null): Node | null {
    for (let n = node; n; n = n.parent) if (n.name) return n;
    return null;
  }

  /** A node's name, then its named parents': the 3D part of an event's path. */
  private chain(node: Node | null): string[] {
    const out: string[] = [];
    for (let n = node; n; n = n.parent) if (n.name) out.push(n.name);
    return out;
  }

  /** Where the last cast ray meets a flat mesh's plane, as a uv beyond 0 to 1 off its edges; null for other shapes or a ray along the plane. */
  private uvOnPlane(mesh: AbstractMesh, flat: Flat | null): Vector2 | null {
    if (!flat || !this.lastRay) return null;
    const inverse = mesh.computeWorldMatrix().clone().invert();
    const origin = Vector3.TransformCoordinates(this.lastRay.origin, inverse);
    const direction = Vector3.TransformNormal(this.lastRay.direction, inverse);
    const along = Vector3.Dot(direction, flat.normal);
    if (Math.abs(along) < 1e-12) return null;
    const t = Vector3.Dot(flat.origin.subtract(origin), flat.normal) / along;
    if (t < 0) return null;
    const p = origin.add(direction.scale(t));
    return new Vector2(Vector3.Dot(flat.u.a, p) + flat.u.b, Vector3.Dot(flat.v.a, p) + flat.v.b);
  }
}
