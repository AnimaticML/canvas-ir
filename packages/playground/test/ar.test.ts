import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import cvModule from "@techstark/opencv-js";
import { intrinsics, markerCorners, onTable, project, toTable, toCamera, type Pose, type V3 } from "../src/ar/geometry";
import { MarkerMap, Vision, type Marker } from "../src/ar/vision";
import { smoothPose } from "../src/ar/scene";

let vision: Vision;
const k = intrinsics(800, 600, 60);
// Camera at Y=0.6 m, looking down. Tilted version exercises perspective, not just affine projection.
const overhead: Pose = { r: [1,0,0, 0,0,1, 0,-1,0], t: [0,0,0.6] };
const angle = 0.45;
const tilted: Pose = { r: [1,0,0, 0,-Math.sin(angle),Math.cos(angle), 0,-Math.cos(angle),-Math.sin(angle)], t: [0.03,0.02,0.7] };
const observed = (id: number, corners: V3[], pose = tilted): Marker => ({ id, pixels: corners.map(p => project(pose, k, p)) });
beforeAll(async () => { vision = new Vision(await (cvModule as unknown)); });
afterAll(() => vision.dispose());

describe("AR coordinate system and monocular reconstruction", () => {
  test("camera and table transforms round-trip under tilt", () => {
    const point: V3 = [0.12,0.05,-0.08];
    toTable(tilted, toCamera(tilted, point)).forEach((v,i) => expect(v).toBeCloseTo(point[i]!, 8));
  });
  test("ray-plane projection cannot measure height", () => {
    for (const pose of [overhead, tilted]) {
      const floor: V3 = [0.1,0,-0.08], p = onTable(pose, k, project(pose,k,floor))!;
      p.forEach((v,i) => expect(v).toBeCloseTo(floor[i]!, 8));
      const elevated: V3 = [0.1,0.1,-0.08];
      expect(onTable(pose,k,project(pose,k,elevated))![1]).toBeCloseTo(0);
    }
  });
  test("PnP recovers the table pose and positive camera height", () => {
    const points = markerCorners(0.06);
    for (const pose of [overhead, tilted]) {
      const fit = vision.fit(points, observed(0,points,pose).pixels, k)!;
      expect(fit.error).toBeLessThan(0.01);
      expect(toTable(fit.pose,[0,0,0])[1]).toBeGreaterThan(0.5);
      fit.pose.t.forEach((v,i) => expect(v).toBeCloseTo(pose.t[i]!, 5));
    }
  });
  test("smooth poses remain rigid rotations", () => {
    const p = smoothPose(overhead,tilted,1/15,0.055);
    const point: V3 = [0.12,0.05,-0.08];
    toTable(p,toCamera(p,point)).forEach((v,i)=>expect(v).toBeCloseTo(point[i]!,6));
  });
  test("PnP hand reconstruction separates 0, 2, 5 and 10 cm under camera motion", () => {
    // An asymmetric nonplanar metric hand-like landmark cloud, independent of MediaPipe inference.
    const shape: V3[] = Array.from({length:21},(_,i)=>[(i%5)*0.015,(i%3)*0.007,Math.floor(i/5)*0.025]);
    for (const pose of [overhead,tilted]) for (const height of [0,0.02,0.05,0.1]) {
      const placed = shape.map(p => [p[0],p[1]+height,p[2]] as V3);
      const images = placed.map(p=>project(pose,k,p));
      const fit = vision.fit(shape,images,k)!;
      const reconstructed = toTable(pose,toCamera(fit.pose,shape[0]!));
      expect(reconstructed[1]).toBeCloseTo(height,4);
    }
  });
});

describe("arbitrary coplanar marker map", () => {
  test("learns rotated markers and relocalizes from another marker alone", () => {
    const map = new MarkerMap(0.06);
    const root = markerCorners(0.06), other = markerCorners(0.06,[0.15,0,-0.08],0.7);
    for (let i=0;i<14;i++) expect(map.update([observed(0,root),observed(2,other)],vision,k)).not.toBeNull();
    expect(map.markers.size).toBe(2);
    map.markers.get(2)!.forEach((p,i)=>p.forEach((v,j)=>expect(v).toBeCloseTo(other[i]![j]!,4)));
    map.learning = false;
    expect(map.update([],vision,k)).toBeNull();
    const restored = map.update([observed(2,other,overhead)],vision,k)!;
    expect(restored.error).toBeLessThan(0.01);
    restored.pose.t.forEach((v,i)=>expect(v).toBeCloseTo(overhead.t[i]!,4));
  });
  test("uses agreeing markers when one known marker is moved", () => {
    const a = markerCorners(.06), b = markerCorners(.06,[.15,0,-.08],.4), c = markerCorners(.06,[-.15,0,.08],-.3);
    const images = [observed(0,a),observed(1,b),observed(2,markerCorners(.06,[-.1,0,.15],-.3))].flatMap(m=>m.pixels);
    const fit = vision.fit([...a,...b,...c],images,k,true)!;
    expect(fit).not.toBeNull(); expect(fit.inliers).toBe(8); expect(fit.error).toBeLessThan(.01);
    fit.pose.t.forEach((v,i)=>expect(v).toBeCloseTo(tilted.t[i]!,5));
  });
  test("does not anchor to an unknown ID after loss or mutate a frozen map", () => {
    const map = new MarkerMap(0.06), root = markerCorners(0.06);
    map.update([observed(0,root)],vision,k); map.learning = false;
    expect(map.update([observed(7,root)],vision,k)).toBeNull();
    for(let i=0;i<20;i++)map.update([observed(0,root),observed(7,markerCorners(0.06,[0.1,0,0]))],vision,k);
    expect([...map.markers.keys()]).toEqual([0]);
  });
  test("rejects moved or noncoplanar marker geometry during calibration", () => {
    const map = new MarkerMap(0.06), root = markerCorners(0.06);
    for (let i=0;i<30;i++) {
      const size = 0.09; // Different physical size, inconsistent with the calibrated plane/size.
      map.update([observed(0,root),observed(3,markerCorners(size,[0.15,0,0]))],vision,k);
    }
    expect(map.markers.size).toBe(1);
  });
  test("the exact printable DICT_4X4_50 codes are detected with their IDs", () => {
    const cv = vision.cv;
    const width = 600, height = 240, data = new Uint8ClampedArray(width*height*4).fill(255);
    const dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    for (const id of [0,1,2]) {
      const marker = new cv.Mat(); cv.generateImageMarker(dictionary,id,120,marker,1);
      for(let y=0;y<120;y++)for(let x=0;x<120;x++) {
        const at=((y+60)*width+x+40+id*190)*4, v=marker.data[y*120+x];
        data[at]=data[at+1]=data[at+2]=v;
      }
      marker.delete();
    }
    dictionary.delete();
    const found = vision.detect({data,width,height,colorSpace:"srgb"} as ImageData);
    expect(found.map(m=>m.id).sort()).toEqual([0,1,2]);
    found.forEach(m=>expect(m.pixels.length).toBe(4));
  });
});
