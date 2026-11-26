// Images by key: loaded once, recorded by the key the IR stores, and given back to the renderer and replay by it.
//
// The IR keeps an image as a reference (`ImageRef`: a src, its size, its opaque outline), never its pixels. Something
// has to turn the object a drawing passed to `drawImage` into that reference while recording, and the reference back
// into something `drawImage` takes when the renderer or a replay draws it. Every app with images kept those two maps
// by hand; this is them, with loading by URL done once however many drawings ask, and a listener to redraw when an
// image arrives.
import { type ImageRef, type Point, type RecordingContext, traceImageSource } from "canvas-ir";

export interface ImageRegistryOptions {
  /** Traces each image's opaque pixels, so hit tests, snapping and text wrap follow them. Default true. */
  readonly trace?: boolean;
  /** Loads a URL; default an `Image` element, decoded before it is used. */
  readonly load?: (url: string) => Promise<CanvasImageSource>;
}

const sizeOf = (img: unknown): { width: number; height: number } => {
  const s = img as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: unknown; height?: unknown };
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  return { width: s.naturalWidth || s.videoWidth || n(s.width), height: s.naturalHeight || s.videoHeight || n(s.height) };
};

const loadElement = (url: string): Promise<CanvasImageSource> => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  return img.decode().then(() => img);
};

export class ImageRegistry {
  private readonly byKey = new Map<string, CanvasImageSource>();
  private readonly keys = new Map<unknown, string>();
  private readonly outlines = new Map<unknown, Point[][]>();
  private readonly loading = new Map<string, Promise<CanvasImageSource>>();
  private readonly listeners = new Set<(key: string) => void>();
  private next = 0;

  constructor(private readonly options: ImageRegistryOptions = {}) {}

  /** Puts an image under a key, replacing what was there. */
  add(key: string, image: CanvasImageSource): void {
    const was = this.byKey.get(key);
    if (was && was !== image) this.keys.delete(was);
    this.byKey.set(key, image);
    this.keys.set(image, key);
    for (const l of this.listeners) l(key);
  }

  /** Loads a URL under a key, once: later calls for the key get the same promise, or the image already there. */
  load(key: string, url: string = key): Promise<CanvasImageSource> {
    const there = this.byKey.get(key);
    if (there) return Promise.resolve(there);
    let p = this.loading.get(key);
    if (!p) {
      p = (this.options.load ?? loadElement)(url).then(
        (img) => {
          this.loading.delete(key);
          this.add(key, img);
          return img;
        },
        (error: unknown) => {
          this.loading.delete(key);
          throw error;
        },
      );
      this.loading.set(key, p);
    }
    return p;
  }

  /** The image under a key, if it is here (loaded, or added). */
  get(key: string): CanvasImageSource | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  delete(key: string): void {
    const img = this.byKey.get(key);
    if (!img) return;
    this.byKey.delete(key);
    this.keys.delete(img);
    this.outlines.delete(img);
  }

  /** Called with a key whenever an image arrives or is replaced under it: a host draws again. */
  onChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The reference to record for an image a drawing passed to `drawImage`: its key, or, for an image not added, its
   * `src` or a new key, under which it is kept from then on. As `RecordingContextOptions.describeImage`.
   */
  readonly describe = (img: unknown): ImageRef | null => {
    const { width, height } = sizeOf(img);
    if (!(width > 0 && height > 0)) return null;
    let key = this.keys.get(img);
    if (key === undefined) {
      const src = (img as { src?: unknown }).src;
      key = typeof src === "string" && src !== "" ? src : `image-${this.next++}`;
      this.byKey.set(key, img as CanvasImageSource);
      this.keys.set(img, key);
    }
    if (this.options.trace === false) return { src: key, width, height };
    let outline = this.outlines.get(img);
    if (!outline) {
      outline = traceImageSource(img as CanvasImageSource, width, height);
      this.outlines.set(img, outline);
    }
    return { src: key, width, height, outline };
  };

  /** What the renderer and replay draw for a recorded key. As `RendererOptions.images` and `ReplayOptions.images`. */
  readonly resolve = (src: string): CanvasImageSource | undefined => this.byKey.get(src);

  /**
   * Draws the image under a key into a box, starting to load `url` (default the key) if it isn't here yet; until then
   * nothing is drawn and it returns false, and `onChange` says when to draw again.
   */
  draw(ctx: RecordingContext, key: string, x: number, y: number, width: number, height: number, url?: string): boolean {
    const img = this.byKey.get(key);
    if (!img) {
      void this.load(key, url).catch(() => {});
      return false;
    }
    ctx.drawImage(img, x, y, width, height);
    return true;
  }
}
