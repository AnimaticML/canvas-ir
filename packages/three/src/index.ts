// CanvasIR drawings on three.js meshes. A Surface is a scene drawn into a
// canvas that a mesh shows as its texture; a World is what one EventRouter
// picks from: it casts the camera's ray into the 3D scene, and where the ray
// lands on a surface it hit-tests that surface's drawing at the texture pixel
// under it. So a click on a button drawn on a tilted panel bubbles from the
// button's op through its groups into the panel mesh and the 3D objects that
// hold it, and a click on a plain mesh goes to the mesh: the same events,
// handlers and components for both.
import { type Op, type Pickable, type Point, Scene, replayDocument, type IRDocument, type ReplayOptions } from "canvas-ir";
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
}

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

  /** Repaints the canvas and uploads it, if anything changed since the last time. Returns whether it did. */
  draw(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.background) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    const r = this.ratio;
    const view = this.replay.view ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    replayDocument(ctx, this.scene.document, { ...this.replay, view: { a: view.a * r, b: view.b * r, c: view.c * r, d: view.d * r, e: view.e * r, f: view.f * r } });
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

  constructor(private readonly options: WorldOptions) {}

  add(surface: Surface): Surface {
    this.surfaces.set(surface.mesh, surface);
    return surface;
  }

  remove(surface: Surface): void {
    this.surfaces.delete(surface.mesh);
  }

  get all(): Surface[] {
    return [...this.surfaces.values()];
  }

  /** Repaints the surfaces that changed. Call it before rendering a frame. */
  draw(): void {
    for (const s of this.surfaces.values()) s.draw();
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
