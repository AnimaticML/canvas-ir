import { describe, expect, test } from "bun:test";
import { RecordingContext } from "../src/context";
import { ellipseAxes, svgPathData, toSVG } from "../src/svg";
import type { FillOp } from "../src/types";

describe("ellipse axes", () => {
  test("recover the radii and rotation of a rotated ellipse", () => {
    const t = 0.4;
    const { rx, ry, rotation } = ellipseAxes(
      { x: 30 * Math.cos(t), y: 30 * Math.sin(t) },
      { x: -10 * Math.sin(t), y: 10 * Math.cos(t) },
    );
    expect(rx).toBeCloseTo(30, 9);
    expect(ry).toBeCloseTo(10, 9);
    expect(rotation).toBeCloseTo(t, 9);
  });

  test("describe the same curve when a shear makes the frame skewed", () => {
    // A circle of radius 10 under the shear [[1, 0.8], [0, 1]].
    const u = { x: 10, y: 0 };
    const v = { x: 8, y: 10 };
    const { rx, ry, rotation } = ellipseAxes(u, v);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      const x = u.x * Math.cos(a) + v.x * Math.sin(a);
      const y = u.y * Math.cos(a) + v.y * Math.sin(a);
      // Into the ellipse's axes: (x', y') must satisfy (x'/rx)² + (y'/ry)² = 1.
      const xr = x * Math.cos(rotation) + y * Math.sin(rotation);
      const yr = -x * Math.sin(rotation) + y * Math.cos(rotation);
      expect((xr / rx) ** 2 + (yr / ry) ** 2).toBeCloseTo(1, 9);
    }
  });
});

describe("path data", () => {
  test("keeps lines, curves and arcs, with a line to each arc's start", () => {
    const ctx = new RecordingContext();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(10, 0, 10, 10);
    ctx.bezierCurveTo(10, 20, 0, 20, 0, 10);
    ctx.arc(50, 50, 10, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    const op = ctx.getDocument().ops[0] as FillOp;
    expect(svgPathData(op.path)).toBe("M0 0Q10 0 10 10C10 20 0 20 0 10L60 50A10 10 0 0 1 50 60A10 10 0 0 1 40 50Z");
  });

  test("a counterclockwise arc sweeps the other way", () => {
    const ctx = new RecordingContext();
    ctx.arc(0, 0, 10, 0, Math.PI / 2, true);
    ctx.stroke();
    const d = svgPathData((ctx.getDocument().ops[0] as FillOp).path);
    // Three quarters of a turn, counterclockwise, in three pieces with sweep flag 0.
    expect(d.match(/A/g)).toHaveLength(3);
    expect(d).toMatch(/A10 10 0 0 0 [-\d.e]+ 10$/);
  });
});

describe("toSVG", () => {
  test("nests groups, references paints and clips, and escapes text", () => {
    const ctx = new RecordingContext({
      measureText: (text) => ({
        width: text.length * 5,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 5,
        actualBoundingBoxAscent: 7,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
      }),
    });
    ctx.beginGroup({ id: "card", meta: { title: 'a "b" <c>' } });
    const g = ctx.createLinearGradient(0, 0, 100, 0);
    g.addColorStop(0, "red");
    g.addColorStop(1, "blue");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.rect(0, 0, 50, 50);
    ctx.clip();
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = "black";
    ctx.fillText("x < y & z", 5, 20);
    ctx.endGroup();
    const svg = toSVG(ctx.getDocument(), { width: 100, height: 100 });
    expect(svg).toContain('<linearGradient id="p0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">');
    expect(svg).toContain('<g data-group="card" data-meta="{&quot;title&quot;:&quot;a \\&quot;b\\&quot; &lt;c&gt;&quot;}">');
    expect(svg).toContain(">x &lt; y &amp; z</text>");
    expect(svg.match(/clip-path="url\(#c\d+\)"/g)).toHaveLength(2);
    expect(svg.indexOf("data-group")).toBeLessThan(svg.indexOf('data-op="o0"'));
  });

  test("clearRect masks out what was drawn before it", () => {
    const ctx = new RecordingContext();
    ctx.fillRect(0, 0, 10, 10);
    ctx.clearRect(2, 2, 4, 4);
    ctx.fillRect(20, 0, 10, 10);
    const svg = toSVG(ctx.getDocument());
    expect(svg).toMatch(/<g mask="url\(#m0\)"><path data-op="o0"[^]*<\/g><path data-op="o2"/);
  });
});
