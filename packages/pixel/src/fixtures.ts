/**
 * Drawings used by the pixel test. Each one is drawn straight onto a canvas and
 * also recorded, serialized, parsed and replayed onto a second canvas; the two
 * must match pixel for pixel.
 */
export interface Fixture {
  readonly name: string;
  readonly draw: (ctx: CanvasRenderingContext2D) => void;
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
