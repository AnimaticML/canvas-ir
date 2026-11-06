// CanvasIR drawings on three.js meshes. A Surface is a scene drawn into a
// canvas that a mesh shows as its texture; a World is what one EventRouter
// picks from: it casts the camera's ray into the 3D scene, and where the ray
// lands on a surface it hit-tests that surface's drawing at the texture pixel
// under it. So a click on a button drawn on a tilted panel bubbles from the
// button's op through its groups into the panel mesh and the 3D objects that
// hold it, and a click on a plain mesh goes to the mesh: the same events,
// handlers and components for both.
import { type Op, type Pickable, type Point, Scene, multiply, replayDocument, type IRDocument, type ReplayOptions } from "canvas-ir";
import * as THREE from "three";

export interface SurfaceOptions {
  /** The mesh that shows the drawing: its material's `map` is set to the surface's texture. A plane is best: drags that leave its edge go on in its plane. */
  readonly mesh: THREE.Mesh;
  /** The drawing's size in its own units; the texture is this times `pixelRatio`. */
  readonly width: number;
  readonly height: number;
  /** Texture pixels per drawing unit. Default 2. */
  readonly pixelRatio?: number;
  /** What to clear to before each drawing; transparent when null. Default white. */
  readonly background?: string | null;
  readonly replay?: ReplayOptions;
  /** The canvas to draw into; a new one by default. */
  readonly canvas?: HTMLCanvasElement;
  /**
   * Whether a plane surface follows the camera: drawn again at the detail the
   * view needs, and only the part of it in view, so it stays sharp up close.
   * Default true for a plane; other shapes always draw whole at `pixelRatio`.
   */
  readonly sharp?: boolean | FocusOptions;
}

/** A part of a drawing, in its units, and how many texture pixels to draw per unit. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Fits a texture holding a region of a `width` by `height` drawing onto a mesh whose uvs span the whole drawing. */
export const fitRegion = (texture: THREE.Texture, region: Region, width: number, height: number): void => {
  const rx = width / region.width;
  const ry = height / region.height;
  texture.repeat.set(rx, ry);
  texture.offset.set(-(region.x / width) * rx, -(1 - (region.y + region.height) / height) * ry);
};

/** A CanvasIR scene drawn to a canvas texture on a mesh. */
export class Surface {
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  readonly width: number;
  readonly height: number;
  scene: Scene;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ratio: number;
  private readonly background: string | null;
  private readonly replay: ReplayOptions;
  private dirty = true;
  /** What the canvas holds: the whole drawing at `pixelRatio` until a focus asks for a part. */
  region: Region;
  readonly sharp: FocusOptions | null;

  constructor(document: IRDocument | Scene, options: SurfaceOptions) {
    this.mesh = options.mesh;
    this.width = options.width;
    this.height = options.height;
    this.ratio = options.pixelRatio ?? 2;
    this.background = options.background === undefined ? "#ffffff" : options.background;
    this.replay = options.replay ?? {};
    this.scene = document instanceof Scene ? document : new Scene(document);
    this.canvas = options.canvas ?? window.document.createElement("canvas");
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.ctx = this.canvas.getContext("2d")!;
    this.region = { x: 0, y: 0, width: this.width, height: this.height, scale: this.ratio };
    const sharp = options.sharp ?? this.mesh.geometry instanceof THREE.PlaneGeometry;
    this.sharp = sharp === false ? null : sharp === true ? {} : sharp;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = this.mesh.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
    material.map = this.texture;
    material.needsUpdate = true;
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

  /** Repaints the canvas and uploads it, if anything changed since the last time. Returns whether it did. */
  draw(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const ctx = this.ctx;
    const region = this.region;
    const w = Math.max(1, Math.round(region.width * region.scale));
    const h = Math.max(1, Math.round(region.height * region.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // three.js allocates a texture's storage once: a new size needs a new texture on the GPU.
      this.texture.dispose();
    }
    fitRegion(this.texture, region, this.width, this.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    const k = region.scale;
    const place = { a: k, b: 0, c: 0, d: k, e: -region.x * k, f: -region.y * k };
    replayDocument(ctx, this.scene.document, { ...this.replay, view: multiply(place, this.replay.view ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    this.texture.needsUpdate = true;
    return true;
  }

  /** The drawing's point at a texture coordinate (three.js's uv: 0,0 is the bottom left). */
  pointAtUv(uv: THREE.Vector2): Point {
    return { x: uv.x * this.width, y: (1 - uv.y) * this.height };
  }
}

export interface WorldOptions {
  /** What the ray is cast into: usually the three.js scene. */
  readonly root: THREE.Object3D;
  readonly camera: THREE.Camera;
  /** The host element's size in CSS pixels, which the router's positions are in. */
  readonly size: () => { width: number; height: number };
}

/**
 * The 3D world as an EventRouter sees it. Meshes are hit by their `name`,
 * which must be unique; unnamed objects are hit but bubble straight to their
 * nearest named ancestor. Op and group ids must be unique across surfaces.
 * An object with `userData.hit === false` lets the ray through.
 */
export class World implements Pickable {
  private readonly raycaster = new THREE.Raycaster();
  private readonly surfaces = new Map<THREE.Object3D, Surface>();
  private readonly focuses = new Map<Surface, Focus>();

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

  /** Repaints the surfaces that changed, or whose view needs another region or more detail. Call it before rendering a frame, after the camera moved. */
  draw(): void {
    for (const [s, focus] of this.focuses) {
      const region = focus.update();
      if (region) s.show(region);
    }
    for (const s of this.surfaces.values()) s.draw();
  }

  /**
   * What of a plane mesh's content (`width` by `height`, from the top left)
   * the camera sees, and how many CSS pixels of the host one unit of it
   * covers where it is closest; null when none of its front is in view.
   */
  inView(mesh: THREE.Mesh, width: number, height: number): { x0: number; y0: number; x1: number; y1: number; density: number } | null {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.PlaneGeometry)) return null;
    const camera = this.options.camera;
    const { width: sw, height: sh } = this.options.size();
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    const toCamera = camera.getWorldPosition(new THREE.Vector3()).sub(mesh.getWorldPosition(new THREE.Vector3()));
    if (normal.dot(toCamera) <= 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, density = 0;
    const take = (u: number, v: number): void => {
      const x = Math.min(1, Math.max(0, u)) * width;
      const y = (1 - Math.min(1, Math.max(0, v))) * height;
      x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y);
    };
    const inside = (uv: THREE.Vector2 | null | undefined): uv is THREE.Vector2 => uv != null && uv.x >= -0.001 && uv.x <= 1.001 && uv.y >= -0.001 && uv.y <= 1.001;
    // Rays on a grid over the host: where they meet the plane, and how far apart they land there.
    const N = 12;
    const grid: (THREE.Vector2 | null)[][] = [];
    for (let i = 0; i <= N; i++) {
      grid.push([]);
      for (let j = 0; j <= N; j++) {
        this.aim({ x: (i / N) * sw, y: (j / N) * sh });
        const uv = this.uvOnPlane(mesh);
        grid[i]!.push(uv);
        if (inside(uv)) take(uv.x, uv.y);
      }
    }
    const spread = (a: THREE.Vector2 | null | undefined, b: THREE.Vector2 | null | undefined, pixels: number): void => {
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
    const { width: gw, height: gh } = geometry.parameters;
    const corners = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]].map(([a, b]) => {
      const p = new THREE.Vector3(a! * gw, b! * gh, 0).applyMatrix4(mesh.matrixWorld).project(camera);
      return { u: a! + 0.5, v: b! + 0.5, x: ((p.x + 1) / 2) * sw, y: ((1 - p.y) / 2) * sh, front: p.z > -1 && p.z < 1 };
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

  /** The camera's ray through a host pixel. */
  ray(screen: Point): THREE.Ray {
    this.aim(screen);
    return this.raycaster.ray.clone();
  }

  /** The nearest hit under a host pixel, skipping what doesn't take hits. */
  intersect(screen: Point, objects: THREE.Object3D[] = [this.options.root]): THREE.Intersection | null {
    this.aim(screen);
    for (const hit of this.raycaster.intersectObjects(objects, true)) if (this.takesHits(hit.object)) return hit;
    return null;
  }

  /**
   * Where a host pixel lands on a mesh that shows something other than a
   * surface, such as another page's canvas, in that content's units (`width`
   * by `height`, from the top left): on the mesh, or in a plane mesh's plane
   * past its edges, as a drag that left it. Null when the ray misses.
   */
  pointOn(mesh: THREE.Mesh, screen: Point, width: number, height: number): Point | null {
    const hit = this.intersect(screen, [mesh]);
    const uv = hit?.object === mesh && hit.uv ? hit.uv : this.uvOnPlane(mesh);
    return uv ? { x: uv.x * width, y: (1 - uv.y) * height } : null;
  }

  /** The surface whose drawing holds an op or group id. */
  surfaceOf(id: string): Surface | null {
    for (const s of this.surfaces.values()) if (s.scene.get(id) || s.scene.getGroup(id)) return s;
    return null;
  }

  /** The named object with an id. */
  object(id: string): THREE.Object3D | null {
    return this.options.root.getObjectByName(id) ?? null;
  }

  // Pickable: the router's world is the host's pixels (its view is left as the identity).

  hitTest(point: Point): { id: string; groups: string[] }[] {
    const hit = this.intersect(point);
    if (!hit) return [];
    const named = this.named(hit.object);
    const surface = this.surfaces.get(hit.object);
    if (surface && hit.uv) {
      const [inner] = surface.scene.hitTest(surface.pointAtUv(hit.uv));
      if (inner) return [{ id: inner.id, groups: [...inner.groups, ...this.chain(hit.object)] }];
    }
    if (!named) return [];
    return [{ id: named.name, groups: this.chain(named.parent) }];
  }

  get(id: string): Op | undefined {
    return this.surfaceOf(id)?.scene.get(id);
  }

  getGroup(id: string): unknown {
    return this.surfaceOf(id)?.scene.getGroup(id) ?? this.object(id) ?? undefined;
  }

  groupChain(id: string): string[] {
    const surface = this.surfaceOf(id);
    if (surface) return [...surface.scene.groupChain(id), ...this.chain(surface.mesh)];
    return this.chain(this.object(id)?.parent ?? null);
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
    const hit = this.intersect(screen, [surface.mesh]);
    if (hit?.object === surface.mesh && hit.uv) return surface.pointAtUv(hit.uv);
    return this.onPlane(surface);
  }

  private aim(screen: Point): void {
    const { width, height } = this.options.size();
    this.raycaster.setFromCamera(new THREE.Vector2((screen.x / width) * 2 - 1, -(screen.y / height) * 2 + 1), this.options.camera);
  }

  private takesHits(object: THREE.Object3D): boolean {
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      if (o.userData["hit"] === false || !o.visible) return false;
    }
    return true;
  }

  private named(object: THREE.Object3D | null): THREE.Object3D | null {
    for (let o = object; o; o = o.parent) if (o.name) return o;
    return null;
  }

  /** An object's name, then its named ancestors': the 3D part of an event's path. */
  private chain(object: THREE.Object3D | null): string[] {
    const out: string[] = [];
    for (let o = object; o; o = o.parent) if (o.name) out.push(o.name);
    return out;
  }

  /** Where the last aimed ray meets a plane surface's plane, in drawing units; null for other shapes. */
  private onPlane(surface: Surface): Point | null {
    const uv = this.uvOnPlane(surface.mesh);
    return uv ? surface.pointAtUv(uv) : null;
  }

  /** Where the last aimed ray meets a plane mesh's plane, as a uv beyond 0 to 1 off its edges; null for other shapes or a ray along the plane. */
  private uvOnPlane(mesh: THREE.Mesh): THREE.Vector2 | null {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.PlaneGeometry)) return null;
    const { width, height } = geometry.parameters;
    const ray = this.raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const at = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return at ? new THREE.Vector2(at.x / width + 0.5, at.y / height + 0.5) : null;
  }
}

export interface FocusOptions {
  /** The longest side of the texture, in pixels. Default 4096, which every WebGL 2 device has. */
  readonly maxSide?: number;
  /** The most pixels in the texture: memory is four bytes each. Default 8 million, 32 MB. */
  readonly maxPixels?: number;
  /** Texture pixels per unit of the drawing, at the least and at the most. Default 0.5 and 16. */
  readonly minScale?: number;
  readonly maxScale?: number;
  /** Device pixels per CSS pixel of the host. Default `devicePixelRatio`. */
  readonly pixelRatio?: () => number;
}

/**
 * Which part of a plane's content to draw, and at what detail, so it stays as
 * sharp as the screen up close and costs little far away. The detail goes in
 * steps of two, so walking about doesn't draw it again every frame; the region
 * is the part in view with a margin, snapped to a grid, and is asked for again
 * only when the view leaves it or needs another step of detail.
 */
export class Focus {
  private region: Region | null = null;
  private level = 0;

  constructor(
    private readonly world: World,
    private readonly mesh: THREE.Mesh,
    private readonly content: () => { readonly width: number; readonly height: number },
    private readonly options: FocusOptions = {},
  ) {}

  /** What it holds now. */
  get current(): Region | null {
    return this.region;
  }

  /** A new region to draw when the view needs one, or null to keep the last. */
  update(): Region | null {
    const { width, height } = this.content();
    const seen = this.world.inView(this.mesh, width, height);
    if (!seen) return null;
    const ratio = this.options.pixelRatio?.() ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    const min = this.options.minScale ?? 0.5;
    const max = this.options.maxScale ?? 16;
    const want = Math.log2(Math.min(max, Math.max(min, seen.density * ratio)));
    // A step of detail is taken once the view is most of a step past the one held.
    const level = this.level > 0 && Math.abs(want - Math.log2(this.level)) < 0.75 ? this.level : 2 ** Math.round(want);
    const r = this.region;
    if (r && level === this.level && seen.x0 >= r.x - 1e-6 && seen.y0 >= r.y - 1e-6 && seen.x1 <= r.x + r.width + 1e-6 && seen.y1 <= r.y + r.height + 1e-6) return null;
    // The part in view, a quarter again on each side, snapped outward to a 64th of the content.
    const padX = (seen.x1 - seen.x0) * 0.25;
    const padY = (seen.y1 - seen.y0) * 0.25;
    const g = Math.max(width, height) / 64;
    const x0 = Math.max(0, Math.floor((seen.x0 - padX) / g) * g);
    const y0 = Math.max(0, Math.floor((seen.y0 - padY) / g) * g);
    const x1 = Math.min(width, Math.ceil((seen.x1 + padX) / g) * g);
    const y1 = Math.min(height, Math.ceil((seen.y1 + padY) / g) * g);
    const w = x1 - x0;
    const h = y1 - y0;
    const side = this.options.maxSide ?? 4096;
    const scale = Math.min(level, side / w, side / h, Math.sqrt((this.options.maxPixels ?? 8_388_608) / (w * h)));
    this.level = level;
    this.region = { x: x0, y: y0, width: w, height: h, scale };
    return this.region;
  }
}
