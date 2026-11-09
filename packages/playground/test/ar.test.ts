import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import cvModule from "@techstark/opencv-js";
import { intrinsics, markerCorners, onTable, project, toTable, toCamera, type Pose, type V3 } from "../src/ar/geometry";
import { MarkerMap, Vision, type Marker } from "../src/ar/vision";
import { HandTracking } from "../src/ar/hand";
import realHand from "./fixtures/mediapipe-hand.json";
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

describe("production hand-to-table pipeline",()=>{
  const synthetic=(camera:Pose,height:number,metricScale=1.5):import("@mediapipe/tasks-vision").HandLandmarkerResult=>{
    const shape:V3[]=Array.from({length:21},(_,i)=>[(i%5-2)*.009,(i%3)*.003,Math.floor(i/5)*.014]);
    shape[8]=[0,0,0];shape[4]=[.012,0,.002];
    const positions=shape.map(p=>[p[0],p[1]+height,p[2]] as V3);
    const cameraPoints=positions.map(p=>toCamera(camera,p));
    const origin=toCamera(camera,[0,height,0]);
    const world=cameraPoints.map(p=>({x:(p[0]-origin[0])/metricScale,y:(p[1]-origin[1])/metricScale,z:(p[2]-origin[2])/metricScale}));
    return {landmarks:[positions.map(p=>{const v=project(camera,k,p);return{x:v.x/k.width,y:v.y/k.height,z:0};})],worldLandmarks:[world],handedness:[[{categoryName:"Right",displayName:"Right",index:0,score:.9}]]};
  };
  test("touch calibrates scale, survives missed frames/handedness flicker and camera movement",()=>{
    const tracking=new HandTracking();tracking.calibrate(0);
    for(let i=0;i<14;i++){
      const result=i===4?{landmarks:[],worldLandmarks:[],handedness:[]}:synthetic(overhead,0);
      if(i===8&&result.handedness[0])result.handedness[0][0]!.categoryName="Left";
      tracking.update(result,overhead,k,vision,i*90);
    }
    expect(tracking.status).toBe("calibrated");expect(tracking.metricScale!).toBeCloseTo(1.5,4);
    for(const camera of [overhead,tilted])for(const height of [0,.02,.05,.1]){
      const estimate=tracking.update(synthetic(camera,height),camera,k,vision,1500+height*1000);
      expect(estimate.points).not.toBeNull();expect(estimate.points![8]![1]).toBeCloseTo(height,4);
    }
  });
  test("a real MediaPipe frame keeps measured fingertip pixels despite model residuals",()=>{
    const tracking=new HandTracking();
    const raw=realHand as import("@mediapipe/tasks-vision").HandLandmarkerResult;
    const estimate=tracking.update(raw,overhead,k,vision,0);
    expect(estimate.points).not.toBeNull();expect(estimate.error!).toBeGreaterThan(8);
    for(let i=0;i<21;i++){
      const pixel=project(overhead,k,estimate.points![i]!);
      expect(pixel.x).toBeCloseTo(raw.landmarks[0]![i]!.x*k.width,4);
      expect(pixel.y).toBeCloseTo(raw.landmarks[0]![i]!.y*k.height,4);
    }
  });
  test("failed calibration reports a concrete reason and can be retried",()=>{
    const tracking=new HandTracking();tracking.calibrate(0);
    tracking.update({landmarks:[],worldLandmarks:[],handedness:[]},overhead,k,vision,100);
    expect(tracking.collecting).toBe(true);
    tracking.update({landmarks:[],worldLandmarks:[],handedness:[]},overhead,k,vision,6000);
    expect(tracking.status).toBe("insufficient-stable-samples");
    tracking.calibrate(7000);expect(tracking.collecting).toBe(true);
  });
});
