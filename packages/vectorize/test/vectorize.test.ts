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

  test("a fixed palette keeps its ids and order, adds no colors and may leave some unused", () => {
    const palette = [
      { id: "green", color: "#16a34a" },
      { id: "ivory", color: "#fffff0" },
      { id: "navy", color: "rgb(30, 64, 175)" },
      { id: "crimson", color: "crimson" },
    ];
    const result = vectorize(card(), { palette });
    expect(result.colors.map((c) => c.id)).toEqual(["green", "ivory", "navy", "crimson"]);
    expect(result.colors.map((c) => c.color)).toEqual(["#16a34a", "#fffff0", "#1e40af", "#dc143c"]);
    expect(result.colors[0]!.pixels).toBe(0);
    expect(result.colors.reduce((n, c) => n + c.pixels, 0)).toBe(120 * 80);
    const paints = (result.document.ops as FillOp[]).map((op) => op.paint);
    expect(paints).toEqual(["#fffff0", "#1e40af", "#dc143c"]);
    const at = (x: number, y: number): string => result.colors[result.indices[y * 120 + x]!]!.id;
    expect([at(0, 0), at(50, 25), at(50, 35), at(104, 64)]).toEqual(["ivory", "navy", "ivory", "crimson"]);
    expect(() => vectorize(card(), { palette: [palette[0]!, palette[0]!] })).toThrow();
  });

  test("the index map is what the fills trace, with -1 for left-out pixels", () => {
    const image = card();
    for (let x = 0; x < 120; x++) image.data[x * 4 + 3] = 0;
    const result = vectorize(image);
    expect(result.indices).toHaveLength(120 * 80);
    expect(result.indices[5]).toBe(-1);
    expect(result.colors.map((c) => c.id)).toEqual(result.colors.map((c) => c.color));
    const scene = new Scene(result.document);
    for (const [x, y] of [[50, 25], [50, 35], [104, 64], [3, 70]] as const) {
      const top = (scene.hitTest({ x: x + 0.5, y: y + 0.5 })[0]!.op as FillOp).paint;
      expect(top).toBe(result.colors[result.indices[y * 120 + x]!]!.color);
    }
  });

  test("regions: one fill per connected area, tiling the picture with no gap or overlap", () => {
    const result = vectorize(card(), { layout: "regions", tolerance: 0.4 });
    // Background, button, label bar (a white area of its own: it touches no other white) and dot.
    expect(result.regions!.regions.map((r) => result.colors[r.value]!.color)).toEqual(["#ffffff", "#2563eb", "#ffffff", "#dc2626"]);
    const groups = result.document.ops.map((op) => op.group);
    expect(new Set(groups).size).toBe(4);
    const scene = new Scene(result.document);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 120; x++) {
        const hits = scene.hitTest({ x: x + 0.5, y: y + 0.5 });
        expect(hits).toHaveLength(1);
        expect((hits[0]!.op as FillOp).paint).toBe(result.colors[result.indices[y * 120 + x]!]!.color);
      }
    }
    const meta = result.document.groups?.map((g) => g.meta);
    expect(meta?.[2]).toMatchObject({ region: 2, color: "#ffffff", colorId: "#ffffff" });
  });

  test("regions: minArea folds specks into the neighbour they share most border with, in the index map too", () => {
    const image = card();
    // Two-pixel specks of red on the background and on the button.
    for (const [x, y] of [[4, 4], [5, 4], [40, 24], [40, 25]] as const) image.data.set([220, 38, 38, 255], (y * 120 + x) * 4);
    expect(vectorize(image, { layout: "regions" }).regions!.regions).toHaveLength(6);
    const result = vectorize(image, { layout: "regions", minArea: 5 });
    expect(result.regions!.regions).toHaveLength(4);
    expect(result.colors[result.indices[4 * 120 + 4]!]!.color).toBe("#ffffff");
    expect(result.colors[result.indices[24 * 120 + 40]!]!.color).toBe("#2563eb");
  });

  test("photos: kmeans finds the colors under the noise, and smoothing settles it into few regions", () => {
    const image = card();
    let seed = 5;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < image.data.length; i += 4) for (let c = 0; c < 3; c++) image.data[i + c] = image.data[i + c]! + Math.round((random() - 0.5) * 50);
    // Frequency picks among thousands of rare noisy shades; clusters average them back.
    const result = vectorize(image, { quantize: "kmeans", maxColors: 3, layout: "regions", smooth: 2, minArea: 12 });
    const rgb = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const near = (hex: string, target: number[]): boolean => rgb(hex).every((v, i) => Math.abs(v - target[i]!) < 12);
    expect(result.colors).toHaveLength(3);
    expect(near(result.colors[0]!.color, [255, 255, 255]) || near(result.colors[0]!.color, [242, 242, 242])).toBe(true);
    expect(result.colors.some((c) => near(c.color, [37, 99, 235]))).toBe(true);
    expect(result.colors.some((c) => near(c.color, [220, 38, 38]))).toBe(true);
    // Background, button, label bar, dot.
    expect(result.regions!.regions).toHaveLength(4);
    const rough = vectorize(image, { quantize: "kmeans", maxColors: 3, layout: "regions" });
    expect(rough.regions!.regions.length).toBeGreaterThanOrEqual(4);
    expect(vectorize(image, { quantize: "kmeans", maxColors: 3 }).colors.map((c) => c.color)).toEqual(result.colors.map((c) => c.color));
  });
});
