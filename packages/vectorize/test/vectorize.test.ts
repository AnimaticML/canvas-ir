import { describe, expect, test } from "bun:test";
import { type FillOp, Scene } from "canvas-ir";
import { vectorize } from "../src";

/** A 120×80 card: white background, a blue button with a white label bar, a red dot, with blended edge pixels. */
const card = () => {
  const width = 120;
  const height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, [r, g, b]: number[]) => data.set([r!, g!, b!, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = [255, 255, 255];
      if (x >= 10 && x < 90 && y >= 20 && y < 50) c = [37, 99, 235];
      if (x >= 30 && x < 70 && y >= 32 && y < 38) c = [255, 255, 255];
      const d = Math.hypot(x + 0.5 - 104, y + 0.5 - 64);
      if (d < 9) c = [220, 38, 38];
      // Anti-aliased rim: red blended into white by how far out the pixel is, so each shade is rare.
      else if (d < 10) c = [220, 38, 38].map((v) => Math.round(v + (255 - v) * (d - 9)));
      set(x, y, c);
    }
  }
  return { width, height, data };
};

describe("vectorize", () => {
  test("flat art becomes one fill per color, largest first, covering what each color covers", () => {
    const image = card();
    const result = vectorize(image, { tolerance: 0.5 });
    expect(result.palette).toEqual(["#ffffff", "#2563eb", "#dc2626"]);
    const ops = result.document.ops as FillOp[];
    expect(ops.map((op) => op.paint)).toEqual(["#ffffff", "#2563eb", "#dc2626"]);
    // The background has no holes where the button and dot sit: they are drawn over it.
    const scene = new Scene(result.document);
    expect(scene.hitTest({ x: 50, y: 25 }).map((h) => (h.op as FillOp).paint)).toEqual(["#2563eb", "#ffffff"]);
    // The label bar inside the button is a hole in the button (the white drawn earlier shows through), not a fourth fill.
    expect(scene.hitTest({ x: 50, y: 35 }).map((h) => (h.op as FillOp).paint)).toEqual(["#ffffff"]);
    expect((scene.hitTest({ x: 104, y: 64 })[0]!.op as FillOp).paint).toBe("#dc2626");
    // Blended rim pixels fold into the nearer palette color.
    expect(result.rings).toBeLessThan(8);
  });

  test("curves fit the outlines, keeping the button's corners", () => {
    const polygons = vectorize(card(), { tolerance: 0.5 });
    const curved = vectorize(card(), { tolerance: 0.5, curves: true });
    const scene = new Scene(curved.document);
    expect((scene.hitTest({ x: 104, y: 64 })[0]!.op as FillOp).paint).toBe("#dc2626");
    expect((scene.hitTest({ x: 11, y: 21 })[0]!.op as FillOp).paint).toBe("#2563eb");
    expect(scene.hitTest({ x: 9.5, y: 19.5 }).map((h) => (h.op as FillOp).paint)).toEqual(["#ffffff"]);
    const dot = (curved.document.ops[2] as FillOp).path;
    expect(dot.subpaths.some((s) => s.segments.some((seg) => seg.kind === "cubic"))).toBe(true);
    expect(curved.points).toBeLessThanOrEqual(polygons.points);
  });

  test("transparent pixels are left out", () => {
    const image = card();
    for (let i = 3; i < image.data.length; i += 4) {
      const x = ((i - 3) / 4) % 120;
      if (x < 60) image.data[i] = 0;
    }
    const scene = new Scene(vectorize(image).document);
    expect(scene.hitTest({ x: 20, y: 10 })).toEqual([]);
    expect(scene.hitTest({ x: 80, y: 10 })).toHaveLength(1);
  });
});
