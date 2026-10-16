import { allFinite, applyToPoint, ellipsePoint, invert, sameMatrix } from "./math";
import type { ArcSegment, EllipseSegment, Matrix2D, PathGeometry, Point, Segment, Subpath } from "./types";

const TWO_PI = Math.PI * 2;

/** Two world-space points this close are the same point for implicit `arc` connecting lines. */
const SAME_POINT_EPSILON = 1e-9;

interface MutableSubpath {
  m: number;
  start: Point;
  segments: Segment[];
  closed: boolean;
  startImplied: boolean;
}

export const indexSizeError = (message: string): Error =>
  typeof DOMException === "function" ? new DOMException(message, "IndexSizeError") : new RangeError(message);

/** The angle the arc actually ends at, following the spec's rule for sweeps of a full turn or more. */
const effectiveEndAngle = (startAngle: number, endAngle: number, counterclockwise: boolean): number => {
  if (!counterclockwise && endAngle - startAngle >= TWO_PI) return startAngle;
  if (counterclockwise && startAngle - endAngle >= TWO_PI) return startAngle;
  return endAngle;
};

/**
 * Builds a path with the Canvas 2D spec's construction rules ("ensure there is a
 * subpath", the line `arc` adds to its start, `closePath` starting a new subpath
 * at the old start, and so on). Every call takes the current transform `ctm`;
 * coordinates are stored as given, with the matrix they were given under.
 */
export class PathBuilder {
  private matrices: Matrix2D[] = [];
  private subpaths: MutableSubpath[] = [];
  private current: MutableSubpath | null = null;
  /** The last point in world space, for the spec's same-point checks. */
  private lastWorld: Point | null = null;

  reset(): void {
    this.matrices = [];
    this.subpaths = [];
    this.current = null;
    this.lastWorld = null;
  }

  moveTo(ctm: Matrix2D, x: number, y: number): void {
    if (!allFinite(x, y)) return;
    const subpath: MutableSubpath = {
      m: this.matrixIndex(ctm),
      start: { x, y },
      segments: [],
      closed: false,
      startImplied: false,
    };
    this.subpaths.push(subpath);
    this.current = subpath;
    this.setLast(ctm, x, y);
  }

  lineTo(ctm: Matrix2D, x: number, y: number): void {
    if (!allFinite(x, y)) return;
    if (this.current === null) {
      this.moveTo(ctm, x, y);
      return;
    }
    this.push({ kind: "line", m: this.matrixIndex(ctm), to: { x, y } });
    this.setLast(ctm, x, y);
  }

  quadraticCurveTo(ctm: Matrix2D, cpx: number, cpy: number, x: number, y: number): void {
    if (!allFinite(cpx, cpy, x, y)) return;
    this.ensureSubpath(ctm, cpx, cpy);
    this.push({ kind: "quad", m: this.matrixIndex(ctm), cp: { x: cpx, y: cpy }, to: { x, y } });
    this.setLast(ctm, x, y);
  }

  bezierCurveTo(ctm: Matrix2D, cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    if (!allFinite(cp1x, cp1y, cp2x, cp2y, x, y)) return;
    this.ensureSubpath(ctm, cp1x, cp1y);
    this.push({
      kind: "cubic",
      m: this.matrixIndex(ctm),
      cp1: { x: cp1x, y: cp1y },
      cp2: { x: cp2x, y: cp2y },
      to: { x, y },
    });
    this.setLast(ctm, x, y);
  }

  arc(ctm: Matrix2D, x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise: boolean): void {
    if (!allFinite(x, y, radius, startAngle, endAngle)) return;
    if (radius < 0) throw indexSizeError(`The radius provided (${radius}) is negative.`);
    this.addArc(ctm, { kind: "arc", m: 0, center: { x, y }, radius, startAngle, endAngle, counterclockwise });
  }

  ellipse(
    ctm: Matrix2D,
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean,
  ): void {
    if (!allFinite(x, y, radiusX, radiusY, rotation, startAngle, endAngle)) return;
    if (radiusX < 0) throw indexSizeError(`The major-axis radius provided (${radiusX}) is negative.`);
    if (radiusY < 0) throw indexSizeError(`The minor-axis radius provided (${radiusY}) is negative.`);
    this.addArc(ctm, {
      kind: "ellipse",
      m: 0,
      center: { x, y },
      rx: radiusX,
      ry: radiusY,
      rotation,
      startAngle,
      endAngle,
      counterclockwise,
    });
  }

  /** `arcTo`, lowered as the spec describes it: a line to the first tangent point, then a circular arc. */
  arcTo(ctm: Matrix2D, x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!allFinite(x1, y1, x2, y2, radius)) return;
    this.ensureSubpath(ctm, x1, y1);
    if (radius < 0) throw indexSizeError(`The radius provided (${radius}) is negative.`);

    // The spec works in user space: the last point mapped through the inverse of the current transform.
    const inverse = invert(ctm);
    const lastWorld = this.lastWorld;
    if (inverse === null || lastWorld === null) {
      this.lineTo(ctm, x1, y1);
      return;
    }
    const p0 = applyToPoint(inverse, lastWorld.x, lastWorld.y);
    const samePoint = (a: Point, bx: number, by: number) => a.x === bx && a.y === by;
    const cross = (p0.x - x1) * (y2 - y1) - (p0.y - y1) * (x2 - x1);
    if (samePoint(p0, x1, y1) || (x1 === x2 && y1 === y2) || radius === 0 || cross === 0) {
      this.lineTo(ctm, x1, y1);
      return;
    }

    // Unit vectors from P1 towards P0 and towards P2, and the half angle between them.
    const len0 = Math.hypot(p0.x - x1, p0.y - y1);
    const len2 = Math.hypot(x2 - x1, y2 - y1);
    const u0 = { x: (p0.x - x1) / len0, y: (p0.y - y1) / len0 };
    const u2 = { x: (x2 - x1) / len2, y: (y2 - y1) / len2 };
    const cosTheta = u0.x * u2.x + u0.y * u2.y;
    const halfAngle = Math.acos(Math.max(-1, Math.min(1, cosTheta))) / 2;
    const tangentDistance = radius / Math.tan(halfAngle);
    const t1 = { x: x1 + u0.x * tangentDistance, y: y1 + u0.y * tangentDistance };
    const t2 = { x: x1 + u2.x * tangentDistance, y: y1 + u2.y * tangentDistance };
    const bisector = { x: u0.x + u2.x, y: u0.y + u2.y };
    const bisectorLength = Math.hypot(bisector.x, bisector.y);
    const centerDistance = radius / Math.sin(halfAngle);
    const center = {
      x: x1 + (bisector.x / bisectorLength) * centerDistance,
      y: y1 + (bisector.y / bisectorLength) * centerDistance,
    };
    const startAngle = Math.atan2(t1.y - center.y, t1.x - center.x);
    const endAngle = Math.atan2(t2.y - center.y, t2.x - center.x);
    // Going P0 -> P1 -> P2 turns one way; the arc bends the same way.
    const counterclockwise = cross > 0;
    this.addArc(ctm, { kind: "arc", m: 0, center, radius, startAngle, endAngle, counterclockwise });
  }

  rect(ctm: Matrix2D, x: number, y: number, w: number, h: number): void {
    if (!allFinite(x, y, w, h)) return;
    this.moveTo(ctm, x, y);
    this.lineTo(ctm, x + w, y);
    this.lineTo(ctm, x + w, y + h);
    this.lineTo(ctm, x, y + h);
    this.closePath();
  }

  closePath(): void {
    const current = this.current;
    if (current === null) return;
    current.closed = true;
    // The spec starts a new subpath at the closed subpath's first point.
    const next: MutableSubpath = { m: current.m, start: current.start, segments: [], closed: false, startImplied: false };
    this.subpaths.push(next);
    this.current = next;
    const matrix = this.matrices[current.m]!;
    this.setLast(matrix, current.start.x, current.start.y);
  }

  hasSubpath(): boolean {
    return this.current !== null;
  }

  /**
   * An immutable copy for an op. Open subpaths with no segments draw nothing and are
   * left out; matrices are renumbered in order of first use, so equal paths
   * snapshot to equal data however they were built.
   */
  snapshot(): PathGeometry {
    const matrices: Matrix2D[] = [];
    const remap = new Map<number, number>();
    const use = (m: number): number => {
      let index = remap.get(m);
      if (index === undefined) {
        index = matrices.length;
        matrices.push(this.matrices[m]!);
        remap.set(m, index);
      }
      return index;
    };
    const subpaths: Subpath[] = [];
    for (const subpath of this.subpaths) {
      // A lone point counts only once closed: a stroke draws its caps, as browsers do.
      if (subpath.segments.length === 0 && !subpath.closed) continue;
      const m = use(subpath.m);
      const segments = subpath.segments.map((segment) => ({ ...segment, m: use(segment.m) }));
      subpaths.push(
        subpath.startImplied
          ? { m, start: subpath.start, segments, closed: subpath.closed, startImplied: true }
          : { m, start: subpath.start, segments, closed: subpath.closed },
      );
    }
    return { matrices, subpaths };
  }

  /** Adds an `arc` or `ellipse` segment (its `m` is filled in here) with the spec's connecting line. */
  private addArc(ctm: Matrix2D, segment: ArcSegment | EllipseSegment): void {
    const { center, startAngle, endAngle, counterclockwise } = segment;
    const [rx, ry, rotation] = segment.kind === "arc" ? [segment.radius, segment.radius, 0] : [segment.rx, segment.ry, segment.rotation];
    const start = ellipsePoint(center.x, center.y, rx, ry, rotation, startAngle);
    const startWorld = applyToPoint(ctm, start.x, start.y);
    if (this.current === null) {
      this.moveTo(ctm, start.x, start.y);
      this.current!.startImplied = true;
    } else if (!this.isLastWorld(startWorld)) {
      this.push({ kind: "line", m: this.matrixIndex(ctm), to: start });
    }
    this.push({ ...segment, m: this.matrixIndex(ctm) });
    const end = ellipsePoint(center.x, center.y, rx, ry, rotation, effectiveEndAngle(startAngle, endAngle, counterclockwise));
    this.setLast(ctm, end.x, end.y);
  }

  private ensureSubpath(ctm: Matrix2D, x: number, y: number): void {
    if (this.current === null) this.moveTo(ctm, x, y);
  }

  private push(segment: Segment): void {
    this.current!.segments.push(segment);
  }

  private setLast(ctm: Matrix2D, x: number, y: number): void {
    this.lastWorld = applyToPoint(ctm, x, y);
  }

  private isLastWorld(point: Point): boolean {
    const last = this.lastWorld;
    return (
      last !== null &&
      Math.abs(last.x - point.x) <= SAME_POINT_EPSILON &&
      Math.abs(last.y - point.y) <= SAME_POINT_EPSILON
    );
  }

  private matrixIndex(ctm: Matrix2D): number {
    const existing = this.matrices.findIndex((matrix) => sameMatrix(matrix, ctm));
    if (existing !== -1) return existing;
    this.matrices.push(ctm);
    return this.matrices.length - 1;
  }
}
