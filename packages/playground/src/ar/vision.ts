import { markerCorners, onTable, project, sub, length, median, toTable, type Intrinsics, type Pixel, type Pose, type V3 } from "./geometry";

// OpenCV's npm declarations omit the contrib ArUco bindings. Keep the untyped
// WASM boundary here, and expose typed observations and poses to the application.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;
export interface Marker { id: number; pixels: Pixel[] }
export interface Fit { pose: Pose; error: number; inliers: number; usedPoints?: number[]; markerIds?: number[] }
export const loadCV = async (): Promise<CV> => {
  const w = window as unknown as { cv: CV };
  if (!w.cv) await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./ar-vendor/opencv.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не загрузился OpenCV. Откройте собранный ar.html через HTTP(S)."));
    document.head.append(script);
  });
  const cv = await w.cv;
  if (!cv?.aruco_ArucoDetector || !cv?.solvePnP) throw new Error("В OpenCV отсутствуют ArUco / solvePnP");
  return cv;
};

export class Vision {
  private dictionary: CV;
  private parameters: CV;
  private refine: CV;
  private detector: CV;
  constructor(readonly cv: CV) {
    this.dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    this.parameters = new cv.aruco_DetectorParameters();
    this.parameters.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
    this.refine = new cv.aruco_RefineParameters(10, 3, true);
    this.detector = new cv.aruco_ArucoDetector(this.dictionary, this.parameters, this.refine);
  }
  detect(image: ImageData): Marker[] {
    const cv = this.cv, src = cv.matFromImageData(image), gray = new cv.Mat(), corners = new cv.MatVector(), ids = new cv.Mat(), rejected = new cv.MatVector();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      this.detector.detectMarkers(gray, corners, ids, rejected);
      const found: Marker[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < ids.rows; i++) {
        const m = corners.get(i);
        try {
          const id = ids.data32S[i] as number;
          // Duplicate printed IDs cannot define a unique marker map.
          if (seen.has(id)) { const at = found.findIndex(m => m.id === id); if (at >= 0) found.splice(at, 1); continue; }
          seen.add(id);
          found.push({ id, pixels: Array.from({ length: 4 }, (_, j) => ({ x: m.data32F[j * 2]!, y: m.data32F[j * 2 + 1]! })) });
        } finally { m.delete(); }
      }
      return found;
    } finally { for (const m of [src, gray, corners, ids, rejected]) m.delete(); }
  }
  marker(id: number): HTMLCanvasElement {
    const m = new this.cv.Mat(), canvas = document.createElement("canvas");
    try { this.cv.generateImageMarker(this.dictionary, id, 240, m, 1); this.cv.imshow(canvas, m); return canvas; }
    finally { m.delete(); }
  }
  fit(points: V3[], pixels: Pixel[], k: Intrinsics, robust = false): Fit | null {
    if (points.length < 4 || pixels.length !== points.length) return null;
    if (robust && points.length >= 8) {
      // Marker-level consensus avoids coplanar EPnP degeneracy in OpenCV's
      // RANSAC and rejects entire bad/moved markers before a joint refinement.
      let best: number[] = [];
      for (let offset = 0; offset < points.length; offset += 4) {
        const candidate = this.fit(points.slice(offset, offset + 4), pixels.slice(offset, offset + 4), k);
        if (!candidate || candidate.error > 3) continue;
        const selected: number[] = [];
        for (let m = 0; m < points.length; m += 4) {
          const indices = [m, m + 1, m + 2, m + 3];
          if (indices.every(i => { const q = project(candidate.pose, k, points[i]!); return Math.hypot(q.x - pixels[i]!.x, q.y - pixels[i]!.y) < 4; })) selected.push(...indices);
        }
        if (selected.length > best.length) best = selected;
      }
      if (best.length < Math.max(4, points.length * 0.6)) return null;
      const refined = this.fit(best.map(i => points[i]!), best.map(i => pixels[i]!), k);
      return refined ? { ...refined, inliers: best.length, usedPoints: best } : null;
    }
    const cv = this.cv;
    const objects = cv.matFromArray(points.length, 1, cv.CV_64FC3, points.flat());
    const images = cv.matFromArray(pixels.length, 1, cv.CV_64FC2, pixels.flatMap(p => [p.x, p.y]));
    const camera = cv.matFromArray(3, 3, cv.CV_64F, [k.fx, 0, k.cx, 0, k.fy, k.cy, 0, 0, 1]);
    const distortion = cv.Mat.zeros(5, 1, cv.CV_64F), rv = new cv.Mat(), tv = new cv.Mat(), rotation = new cv.Mat();
    try {
      const ok = cv.solvePnP(objects, images, camera, distortion, rv, tv, false, cv.SOLVEPNP_SQPNP);
      if (!ok) return null;
      cv.Rodrigues(rv, rotation);
      const pose: Pose = { r: Array.from(rotation.data64F), t: Array.from(tv.data64F) as V3 };
      if (![...pose.r, ...pose.t].every(Number.isFinite)) return null;
      const selected = points.map((_, i) => i);
      const errors = selected.map(i => { const q = project(pose, k, points[i]!); return Math.hypot(q.x - pixels[i]!.x, q.y - pixels[i]!.y); });
      const error = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
      if (pose.t[2] <= 0) return null;
      return { pose, error, inliers: selected.length, usedPoints: selected };
    } catch { return null; }
    finally { for (const m of [objects, images, camera, distortion, rv, tv, rotation]) m.delete(); }
  }
  plane(points: V3[], pixels: Pixel[], queries: Pixel[]): V3[] | null {
    const cv=this.cv;
    const src=cv.matFromArray(pixels.length,1,cv.CV_32FC2,pixels.flatMap(p=>[p.x,p.y]));
    const dst=cv.matFromArray(points.length,1,cv.CV_32FC2,points.flatMap(p=>[p[0],p[2]]));
    let h: CV;
    try {
      h=cv.findHomography(src,dst,0);
      if(h.empty())return null;
      const m=Array.from(h.data64F) as number[];
      return queries.map(p=>{const d=m[6]!*p.x+m[7]!*p.y+m[8]!;return [(m[0]!*p.x+m[1]!*p.y+m[2]!)/d,0,(m[3]!*p.x+m[4]!*p.y+m[5]!)/d];});
    } finally {src.delete();dst.delete();h?.delete();}
  }
  dispose(): void { for (const m of [this.detector, this.dictionary, this.parameters, this.refine]) m.delete(); }
}

interface Candidate { centers: V3[]; angles: number[] }
/** Session-only map. New IDs require overlap with an existing marker; loss never re-anchors it. */
export class MarkerMap {
  readonly markers = new Map<number, V3[]>();
  private candidates = new Map<number, Candidate>();
  readonly decisions=new Map<number,unknown>();
  learning = true;
  constructor(public size: number) {}
  reset(size = this.size): void { this.size = size; this.markers.clear(); this.candidates.clear(); this.decisions.clear(); this.learning = true; }
  update(found: Marker[], vision: Vision, k: Intrinsics): Fit | null {
    if (!this.markers.size && found.length && this.learning) this.markers.set([...found].sort((a, b) => a.id - b.id)[0]!.id, markerCorners(this.size));
    const known = found.filter(m => this.markers.has(m.id));
    if (!known.length) {for(const m of found)this.decisions.set(m.id,{reason:"no-known-marker-overlap"});return null; }
    const fit = vision.fit(known.flatMap(m => this.markers.get(m.id)!), known.flatMap(m => m.pixels), k, true);
    if (!fit || fit.error > 3 || toTable(fit.pose, [0, 0, 0])[1] < 0.03) {
      for(const m of known)this.decisions.set(m.id,{reason:"pose-rejected",error:fit?.error??null});return null;
    }
    const agreement=known.filter((_,i)=>[0,1,2,3].every(j=>fit.usedPoints?.includes(i*4+j)));
    fit.markerIds=agreement.map(m=>m.id);
    for(const m of known)this.decisions.set(m.id,{reason:fit.markerIds.includes(m.id)?"used-in-pose":"pose-outlier"});
    if (this.learning) for (const marker of found) {
      if (this.markers.has(marker.id)) continue;
      // Relative layout is a planar homography problem: unlike ray/PnP it does
      // not depend on an approximate smartphone focal length.
      const p = vision.plane(agreement.flatMap(m=>this.markers.get(m.id)!),agreement.flatMap(m=>m.pixels),marker.pixels);
      if (!p || p.some(v=>!v.every(Number.isFinite))) continue;
      const sides=p.map((v,i)=>length(sub(v,p[(i+1)%4]!)));
      if(sides.some(side=>Math.abs(side-this.size)>this.size*.25)){this.decisions.set(marker.id,{reason:"inconsistent-marker-size",expectedM:this.size,sidesM:sides});continue;}
      const center: V3 = [p.reduce((s, v) => s + v[0], 0) / 4, 0, p.reduce((s, v) => s + v[2], 0) / 4];
      const edge = sub(p[1]!, p[0]!);
      const angle = Math.atan2(edge[2], edge[0]);
      let c = this.candidates.get(marker.id);
      if (!c) {c={centers:[],angles:[]};this.candidates.set(marker.id,c);}
      c.centers.push(center); c.angles.push(angle);this.decisions.set(marker.id,{reason:"collecting-layout",samples:c.centers.length});
      if(c.centers.length>20){c.centers.shift();c.angles.shift();}
      if (c.centers.length >= 8) {
        const mx=median(c.centers.map(v=>v[0])),mz=median(c.centers.map(v=>v[2]));
        const spread=median(c.centers.map(v=>Math.hypot(v[0]-mx,v[2]-mz)));
        if(spread>this.size*.15){this.decisions.set(marker.id,{reason:"layout-unstable",spreadM:spread,samples:c.centers.length});continue;}
        const stable: V3 = [median(c.centers.map(v => v[0])), 0, median(c.centers.map(v => v[2]))];
        const a = Math.atan2(c.angles.reduce((s, v) => s + Math.sin(v), 0), c.angles.reduce((s, v) => s + Math.cos(v), 0));
        this.markers.set(marker.id, markerCorners(this.size, stable, a));
        this.candidates.delete(marker.id);this.decisions.set(marker.id,{reason:"mapped",center:stable});
      }
    }
    // Keep partial calibration through brief hand occlusion / dropped detections.
    return fit;
  }
}
