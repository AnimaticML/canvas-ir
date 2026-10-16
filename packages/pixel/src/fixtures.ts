/**
 * Drawings used by the pixel test. Each one is drawn straight onto a canvas and
 * also recorded, serialized, parsed and replayed onto a second canvas; the two
 * must match pixel for pixel.
 */
/** What a fixture may use besides the context, so the recorder gets its own Path2D. */
export interface FixtureEnv {
  readonly Path2D: new (path?: string) => Path2D;
  /** A small opaque image, 16 by 12. */
  readonly image: OffscreenCanvas;
}

export interface Fixture {
  readonly name: string;
  readonly draw: (ctx: CanvasRenderingContext2D, env: FixtureEnv) => void;
  /**
   * Set where Chromium departs from the spec and the IR follows the spec. Such a
   * fixture may differ from direct drawing in anti-aliased edge pixels only, and
   * its hit tests may disagree with Chromium's on a small share of points.
   */
  readonly engineDeviation?: string;
}

export const WIDTH = 200;
export const HEIGHT = 160;

export const fixtures: readonly Fixture[] = [
  {
    name: "lines and closed polygon",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.lineTo(180, 40);
      ctx.lineTo(120, 140);
      ctx.closePath();
      ctx.lineTo(30, 130);
      ctx.fillStyle = "#3a7";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#124";
      ctx.stroke();
    },
  },
  {
    name: "curves",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(10, 140);
      ctx.quadraticCurveTo(60, 0, 100, 80);
      ctx.bezierCurveTo(130, 160, 170, 0, 190, 120);
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();
    },
  },
  {
    name: "implicit moveTo from curve",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.bezierCurveTo(20, 20, 180, 20, 180, 140);
      ctx.quadraticCurveTo(100, 100, 20, 140);
      ctx.fillStyle = "rgba(200, 40, 40, 0.8)";
      ctx.fill();
    },
  },
  {
    name: "arc under scale and rotation",
    draw: (ctx) => {
      ctx.translate(100, 80);
      ctx.rotate(0.6);
      ctx.scale(2, 0.7);
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0.3, 4.5);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(10, 10, 15, 0, Math.PI * 2, true);
      ctx.fillStyle = "orange";
      ctx.fill();
    },
  },
  {
    name: "arc connecting line and full turns",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(10, 10);
      ctx.arc(60, 60, 30, 0, Math.PI * 5);
      ctx.arc(140, 80, 40, Math.PI, 0, true);
      ctx.lineWidth = 2;
      ctx.stroke();
    },
  },
  {
    name: "ellipses",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.ellipse(60, 80, 50, 25, 0.5, 0, Math.PI * 1.5);
      ctx.closePath();
      ctx.fillStyle = "#58c";
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(150, 80, 30, 60, -0.3, 1, -1, true);
      ctx.lineWidth = 5;
      ctx.lineJoin = "bevel";
      ctx.stroke();
    },
  },
  {
    name: "arcTo corners",
    draw: (ctx) => {
      ctx.translate(10, 5);
      ctx.scale(1.2, 0.9);
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.arcTo(150, 20, 150, 150, 30);
      ctx.arcTo(150, 150, 20, 150, 50);
      ctx.arcTo(20, 150, 20, 20, 0);
      ctx.arcTo(20, 20, 40, 20, 10);
      ctx.lineWidth = 4;
      ctx.stroke();
    },
  },
  {
    name: "transform changes mid-path",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.translate(100, 0);
      ctx.lineTo(0, 60);
      ctx.rotate(0.8);
      ctx.lineTo(60, 0);
      ctx.scale(0.5, 2);
      ctx.arc(40, 40, 20, 0, Math.PI);
      ctx.setTransform(1, 0.2, -0.3, 1, 10, 10);
      ctx.lineTo(30, 130);
      ctx.closePath();
      ctx.fillStyle = "#b5d";
      ctx.fill("evenodd");
      ctx.lineWidth = 2;
      ctx.stroke();
    },
  },
  {
    name: "fill rules with rects",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.rect(20, 20, 160, 120);
      ctx.rect(50, 50, 100, 60);
      ctx.rect(180, 30, -40, 40);
      ctx.fillStyle = "teal";
      ctx.fill("evenodd");
      ctx.translate(30, 0);
      ctx.fill("nonzero");
    },
  },
  {
    name: "dashes, caps and joins",
    draw: (ctx) => {
      ctx.lineWidth = 8;
      ctx.setLineDash([12, 6, 3]);
      ctx.lineDashOffset = 5;
      ctx.lineCap = "square";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(20, 140);
      ctx.lineTo(60, 20);
      ctx.lineTo(120, 120);
      ctx.lineTo(180, 30);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineJoin = "miter";
      ctx.miterLimit = 2;
      ctx.strokeStyle = "crimson";
      ctx.beginPath();
      ctx.moveTo(20, 60);
      ctx.lineTo(100, 70);
      ctx.lineTo(20, 80);
      ctx.stroke();
    },
  },
  {
    name: "stroke width under non-uniform scale",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.lineTo(180, 140);
      ctx.save();
      ctx.scale(4, 1);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    },
  },
  {
    name: "rect helpers and clearRect",
    draw: (ctx) => {
      ctx.fillStyle = "#246";
      ctx.fillRect(0, 0, 200, 160);
      ctx.rotate(0.2);
      ctx.clearRect(40, 20, 80, 60);
      ctx.strokeStyle = "yellow";
      ctx.lineWidth = 3;
      ctx.strokeRect(60, 70, 90, 50);
      ctx.fillRect(150, 10, 0, 50);
    },
  },
  {
    name: "strokeRect with zero height",
    engineDeviation:
      "The spec strokes it as one line; Chromium strokes a closed zero-height rectangle, which differs only in edge coverage.",
    draw: (ctx) => {
      ctx.rotate(0.2);
      ctx.lineWidth = 3;
      ctx.strokeRect(20, 130, 100, 0);
    },
  },
  {
    name: "save and restore",
    draw: (ctx) => {
      ctx.fillStyle = "red";
      ctx.save();
      ctx.translate(50, 40);
      ctx.fillStyle = "blue";
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, 80, 60);
      ctx.restore();
      ctx.fillRect(10, 10, 40, 40);
      ctx.restore();
      ctx.fillRect(140, 100, 40, 40);
    },
  },
  {
    name: "compositing and shadows",
    draw: (ctx) => {
      ctx.fillStyle = "#e33";
      ctx.fillRect(20, 20, 100, 100);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#3e3";
      ctx.globalAlpha = 0.7;
      ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 5;
      ctx.shadowOffsetY = 4;
      ctx.beginPath();
      ctx.arc(110, 90, 50, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    name: "invalid values are ignored",
    draw: (ctx) => {
      ctx.lineWidth = 5;
      ctx.lineWidth = -1;
      ctx.lineWidth = Number.NaN;
      ctx.globalAlpha = 2;
      ctx.lineCap = "bogus" as CanvasLineCap;
      ctx.setLineDash([4, -1]);
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.lineTo(Number.NaN, 50);
      ctx.lineTo(180, Number.POSITIVE_INFINITY);
      ctx.lineTo(180, 140);
      ctx.translate(Number.NaN, 0);
      ctx.lineTo(20, 140);
      ctx.stroke();
    },
  },
  {
    name: "arc sweep edge cases",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.arc(40, 40, 25, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(110, 40, 25, Math.PI * 2, 0);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(40, 115, 25, 1, 0.5, true);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(110, 115, 25, 4, 1);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(170, 80, 20, -7, 3, true);
      ctx.stroke();
    },
  },
  {
    name: "joins and caps on curves",
    draw: (ctx) => {
      ctx.lineWidth = 9;
      const shape = (y: number) => {
        ctx.beginPath();
        ctx.moveTo(10, y + 30);
        ctx.quadraticCurveTo(40, y - 20, 60, y + 30);
        ctx.bezierCurveTo(70, y - 10, 100, y - 10, 110, y + 25);
        ctx.arc(140, y + 25, 30, Math.PI, 1.2, false);
        ctx.lineTo(190, y + 5);
      };
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      shape(10);
      ctx.stroke();
      ctx.lineJoin = "bevel";
      ctx.lineCap = "square";
      shape(60);
      ctx.stroke();
      ctx.lineJoin = "miter";
      ctx.lineCap = "butt";
      ctx.miterLimit = 4;
      shape(110);
      ctx.stroke();
    },
  },
  {
    name: "dashed ellipse",
    engineDeviation:
      "Skia measures dash lengths along its own curve approximation, so its dashes drift from the exact arc length by about 0.2%.",
    draw: (ctx) => {
      ctx.lineWidth = 6;
      ctx.setLineDash([14, 7]);
      ctx.lineDashOffset = 3;
      ctx.beginPath();
      ctx.ellipse(100, 80, 80, 50, 0.4, 0, Math.PI * 2);
      ctx.closePath();
      ctx.stroke();
    },
  },
  {
    name: "dashed closed rect and zero-length subpaths",
    draw: (ctx) => {
      ctx.lineWidth = 6;
      ctx.setLineDash([14, 7]);
      ctx.lineDashOffset = 3;
      ctx.beginPath();
      ctx.rect(120, 20, 60, 40);
      ctx.moveTo(20, 20);
      ctx.lineTo(100, 30);
      ctx.lineTo(60, 90);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(130, 110);
      ctx.lineTo(130, 110);
      ctx.stroke();
      ctx.lineCap = "square";
      ctx.beginPath();
      ctx.moveTo(165, 110);
      ctx.closePath();
      ctx.moveTo(165, 140);
      ctx.lineTo(165, 140);
      ctx.stroke();
    },
  },
  {
    name: "linear and radial gradients under a transform",
    draw: (ctx) => {
      const linear = ctx.createLinearGradient(0, 0, 80, 0);
      linear.addColorStop(0, "red");
      linear.addColorStop(0.5, "rgba(0, 128, 255, 0.6)");
      linear.addColorStop(1, "#fc0");
      ctx.fillStyle = linear;
      ctx.translate(20, 20);
      ctx.rotate(0.3);
      // The gradient is placed by the transform at fill time, not at creation.
      ctx.fillRect(0, 0, 80, 50);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const radial = ctx.createRadialGradient(140, 100, 5, 150, 110, 45);
      radial.addColorStop(0, "white");
      radial.addColorStop(1, "navy");
      ctx.fillStyle = radial;
      ctx.beginPath();
      ctx.arc(150, 110, 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = linear;
      ctx.lineWidth = 6;
      ctx.strokeRect(10, 100, 80, 50);
    },
  },
  {
    name: "conic gradient",
    draw: (ctx) => {
      const g = ctx.createConicGradient(Math.PI / 4, 100, 80);
      g.addColorStop(0, "#f00");
      g.addColorStop(0.33, "#0f0");
      g.addColorStop(0.66, "#00f");
      g.addColorStop(1, "#f00");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(100, 80, 90, 70, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    name: "nested clips with save and restore",
    draw: (ctx) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(20, 20, 140, 110);
      ctx.clip();
      ctx.fillStyle = "#cde";
      ctx.fillRect(0, 0, 200, 160);
      ctx.save();
      ctx.translate(100, 80);
      ctx.rotate(0.4);
      ctx.beginPath();
      ctx.arc(0, 0, 60, 0, Math.PI * 2);
      ctx.arc(0, 0, 30, 0, Math.PI * 2);
      ctx.clip("evenodd");
      ctx.fillStyle = "#a33";
      ctx.fillRect(-100, -100, 200, 200);
      ctx.lineWidth = 8;
      ctx.strokeStyle = "#333";
      ctx.beginPath();
      ctx.moveTo(-90, -10);
      ctx.lineTo(90, 10);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(0, 120, 0, 0.5)";
      ctx.fillRect(120, 0, 80, 160);
      ctx.restore();
      ctx.fillStyle = "#246";
      ctx.fillRect(170, 130, 30, 30);
    },
  },
  {
    name: "clipped clearRect",
    draw: (ctx) => {
      ctx.fillStyle = "#58a";
      ctx.fillRect(0, 0, 200, 160);
      ctx.beginPath();
      ctx.moveTo(100, 10);
      ctx.lineTo(190, 150);
      ctx.lineTo(10, 150);
      ctx.closePath();
      ctx.clip();
      ctx.clearRect(40, 40, 120, 120);
    },
  },
  {
    name: "roundRect",
    draw: (ctx) => {
      ctx.beginPath();
      ctx.roundRect(10, 10, 80, 60, 12);
      ctx.roundRect(110, 10, 80, 60, [4, 30]);
      ctx.roundRect(90, 140, -80, -50, [20, 5, 30, 0]);
      ctx.fillStyle = "#6a4";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#222";
      ctx.beginPath();
      ctx.roundRect(110, 90, 80, 60, [{ x: 30, y: 10 }, 200]);
      ctx.stroke();
    },
  },
  {
    name: "Path2D and SVG path data",
    draw: (ctx, { Path2D }) => {
      const heart = new Path2D("M100 40 c-10-30-60-30-60 10 c0 30 40 50 60 70 c20-20 60-40 60-70 c0-40-50-40-60-10 z");
      const ring = new Path2D("M30 120 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0 Z M40 120 A10 10 0 0 1 60 120 A10 10 0 0 1 40 120Z");
      const both = new Path2D();
      both.addPath(ring, { a: 1, b: 0, c: 0, d: 1, e: 110, f: 0 });
      both.addPath(ring);
      ctx.fillStyle = "#c36";
      ctx.fill(heart);
      ctx.fillStyle = "#36c";
      ctx.fill(both, "evenodd");
      ctx.translate(5, 5);
      ctx.lineWidth = 2;
      ctx.stroke(heart);
      ctx.beginPath();
      ctx.rect(0, 0, 10, 10);
      // Drawing a Path2D leaves the current path alone.
      ctx.fill();
    },
  },
  {
    name: "clip to a Path2D",
    draw: (ctx, { Path2D }) => {
      ctx.clip(new Path2D("M20 20 L180 20 L100 150 Z M60 40 H140 V80 H60 Z"), "evenodd");
      ctx.fillStyle = "#e93";
      ctx.fillRect(0, 0, 200, 160);
    },
  },
  {
    name: "drawImage in all three forms",
    draw: (ctx, { image }) => {
      ctx.drawImage(image, 5, 5);
      ctx.drawImage(image, 30, 5, 64, 48);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 4, 2, 8, 8, 100, 5, 40, 40);
      // Mirrored by a negative size, and a source rect that runs past the image.
      ctx.drawImage(image, 8, 0, 16, 12, 190, 60, -60, 40);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.translate(60, 110);
      ctx.rotate(-0.5);
      ctx.globalAlpha = 0.7;
      ctx.drawImage(image, -24, -18, 48, 36);
    },
  },
  {
    name: "patterns",
    draw: (ctx, { image }) => {
      const repeat = ctx.createPattern(image, "repeat")!;
      ctx.fillStyle = repeat;
      ctx.fillRect(0, 0, 90, 70);
      const x = ctx.createPattern(image, "repeat-x")!;
      x.setTransform({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 10 });
      ctx.fillStyle = x;
      ctx.fillRect(100, 0, 100, 70);
      const once = ctx.createPattern(image, "no-repeat")!;
      ctx.translate(30, 90);
      ctx.scale(3, 3);
      ctx.fillStyle = once;
      ctx.fillRect(0, 0, 20, 20);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = repeat;
      ctx.lineWidth = 10;
      ctx.strokeRect(120, 95, 60, 45);
    },
  },
  {
    name: "fillText and strokeText",
    draw: (ctx) => {
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "#234";
      ctx.fillText("Canvas IR", 10, 30);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "italic 16px serif";
      ctx.fillText("centered, squeezed", 100, 60, 90);
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#a20";
      ctx.font = "28px monospace";
      ctx.strokeText("stroke", 190, 110);
      ctx.save();
      ctx.translate(30, 150);
      ctx.rotate(-0.2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = "14px sans-serif";
      ctx.letterSpacing = "2px";
      ctx.fillText("rotated text", 0, 0);
      ctx.restore();
    },
  },
  {
    name: "many small ops",
    draw: (ctx) => {
      for (let i = 0; i < 60; i++) {
        ctx.save();
        ctx.translate(100, 80);
        ctx.rotate(i * 0.37);
        ctx.scale(1 + (i % 5) * 0.2, 1);
        ctx.fillStyle = `hsl(${i * 13}, 70%, 50%)`;
        ctx.beginPath();
        ctx.ellipse(i, 0, 8, 4, i * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    },
  },
];
