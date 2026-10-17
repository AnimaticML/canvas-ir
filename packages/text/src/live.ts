import { type JsonValue, RecordingContext, type Scene, maxScale, outlineBand, pathRings } from "canvas-ir";
import type { Region } from "./bands";
import { type DrawTextOptions, drawTextLayout } from "./draw";
import { type LayoutOptions, type TextLayout, layoutText } from "./layout";
import type { RichText } from "./model";

export interface LiveTextOptions extends Omit<LayoutOptions, "obstacles"> {
  /** The text block's group id in the scene. */
  readonly id: string;
  /** A group to put the block in when it's first drawn, such as one holding the container's outline. */
  readonly parent?: string;
  readonly text: RichText;
  /** Op and group ids whose shapes the text flows around, read from the scene at each layout. */
  readonly obstacles?: readonly string[];
  /** Extra meta for the block's group. */
  readonly meta?: DrawTextOptions["meta"];
}

/**
 * A text block that stays laid out against the scene: it reads its obstacles'
 * current outlines, lays its text out, and swaps its group's ops in the scene.
 * Call `update` when something it depends on changed (`dependsOn` says
 * whether it does), and `translate` when the block itself moved.
 */
export class LiveText {
  private options: LiveTextOptions;
  private laidOut: TextLayout | null = null;

  constructor(
    private readonly scene: Scene,
    options: LiveTextOptions,
  ) {
    this.options = options;
  }

  get id(): string {
    return this.options.id;
  }

  get layout(): TextLayout | null {
    return this.laidOut;
  }

  get text(): RichText {
    return this.options.text;
  }

  /** The current options, container moves included: what to bind a new `LiveText` to when the scene is rebuilt. */
  get settings(): LiveTextOptions {
    return this.options;
  }

  /** Changes options (text, container, obstacles, theme…) and lays out again. */
  set(options: Partial<Omit<LiveTextOptions, "id">>): TextLayout {
    this.options = { ...this.options, ...options };
    return this.update();
  }

  /** Whether a change to `id` (an op or group) can change this block's layout: it is, or is inside, or holds, an obstacle. */
  dependsOn(id: string): boolean {
    const obstacles = this.options.obstacles ?? [];
    if (obstacles.includes(id)) return true;
    const chain = this.scene.groupChain(id);
    if (obstacles.some((o) => chain.includes(o))) return true;
    return obstacles.some((o) => this.scene.groupChain(o).includes(id));
  }

  /** The obstacles' outlines as they are in the scene now. */
  private obstacleRegions(): Region[] {
    const regions: Region[] = [];
    const ops = (this.options.obstacles ?? []).flatMap((id) => (this.scene.getGroup(id) ? this.scene.groupOps(id) : this.scene.get(id) ? [id] : []));
    for (const id of ops) {
      const op = this.scene.get(id)!;
      if (op.kind === "stroke") {
        // The stroke as a band along its path, half its width (in world units) on each side.
        const half = (op.stroke.lineWidth / 2) * maxScale(op.transform);
        regions.push({ rings: outlineBand(pathRings(op.path), half, 0.25), fillRule: "nonzero" });
        continue;
      }
      // Fills by their outline, images by their silhouette when they have one, text by its box.
      const region = this.scene.region(id);
      if (region) regions.push(region);
    }
    return regions;
  }

  /** Lays the text out against the scene as it is now and replaces the block's ops. */
  update(): TextLayout {
    const { id, parent, text, obstacles: _, meta, ...layoutOptions } = this.options;
    const layout = layoutText(text, { ...layoutOptions, obstacles: this.obstacleRegions() });
    const recorder = new RecordingContext();
    drawTextLayout(recorder, layout, {
      id,
      meta: { ...(meta ?? {}), live: true } as { [key: string]: JsonValue },
      ...(layoutOptions.theme ? { theme: layoutOptions.theme } : {}),
      ...(layoutOptions.measurer ? { measurer: layoutOptions.measurer } : {}),
    });
    this.scene.replaceGroup(id, recorder.getDocument(), parent !== undefined ? { parent } : {});
    this.laidOut = layout;
    return layout;
  }

  /**
   * Records that the container moved by (dx, dy), as when the group holding the
   * block was dragged and its ops moved with it. Nothing is laid out again: call
   * `update` too if obstacles may now overlap differently.
   */
  translate(dx: number, dy: number): void {
    const c = this.options.container;
    const container =
      "rings" in c ? { ...c, rings: c.rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy }))) } : { ...c, x: c.x + dx, y: c.y + dy };
    this.options = { ...this.options, container };
  }
}
