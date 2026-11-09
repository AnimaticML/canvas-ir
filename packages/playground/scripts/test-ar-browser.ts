// End-to-end test with a real Chromium camera pipeline fed standard ArUco frames.
// Build first. CHROMIUM_PATH=/usr/bin/chromium bun run scripts/test-ar-browser.ts
import { chromium, type Page } from "playwright-core";
import cvModule from "@techstark/opencv-js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { intrinsics, markerCorners, project, type Pose, type V3 } from "../src/ar/geometry";
import type { ARScene } from "../src/ar/scene";
import type { MarkerMap } from "../src/ar/vision";

declare global { interface Window { canvasIrAR: { scene: ARScene; map: MarkerMap; snapshot: () => { running: boolean; pose: Pose; intrinsics: ReturnType<typeof intrinsics>; handEnabled: boolean } } } }
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); console.log("✓", message); };
const temporary = await mkdtemp(join(tmpdir(), "canvas-ir-ar-"));
const cv = await (cvModule as unknown as Promise<any>);
const width = 800, height = 600, fps = 10;
const k = intrinsics(width,height,60);
const dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
const centers: V3[] = [[0,0,0], [.16,0,-.1], [-.16,0,.1]];
const theta = 0.35;
const pose: Pose = { r: [1,0,0, 0,-Math.sin(theta),Math.cos(theta), 0,-Math.cos(theta),-Math.sin(theta)], t:[0,0,.6] };
const cameraFrame = (ids: number[], camera = pose): Uint8Array => {
  const image = new cv.Mat(height,width,cv.CV_8UC1,new cv.Scalar(235));
  for (const id of ids) {
    const marker = new cv.Mat(), warped = new cv.Mat(); cv.generateImageMarker(dictionary,id,120,marker,1);
    const corners = markerCorners(.06,centers[id]!).map(p=>project(camera,k,p));
    const source = cv.matFromArray(4,1,cv.CV_32FC2,[0,0,119,0,119,119,0,119]);
    const dest = cv.matFromArray(4,1,cv.CV_32FC2,corners.flatMap(p=>[p.x,p.y]));
    const transform = cv.getPerspectiveTransform(source,dest);
    cv.warpPerspective(marker,warped,transform,new cv.Size(width,height),cv.INTER_NEAREST,cv.BORDER_CONSTANT,new cv.Scalar(255));
    cv.min(image,warped,image);
    for(const m of [marker,warped,source,dest,transform])m.delete();
  }
  const frame = new Uint8Array(width*height*3/2).fill(128);
  frame.set(image.data,0); image.delete(); return frame;
};
const all = cameraFrame([0,1,2]), blank = cameraFrame([]), one = cameraFrame([2],{...pose,t:[.025,.01,.65]});
dictionary.delete();
const videoPath = join(temporary,"markers.y4m");
const file = Bun.file(videoPath).writer();
file.write(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
for(const [seconds,frame] of [[5,all],[1.5,blank],[4,one],[1.5,blank]] as const) {
  for(let i=0;i<seconds*fps;i++){file.write("FRAME\n");file.write(frame);}
}
await file.end();
const dist = resolve(import.meta.dir,"../dist");
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
  const path = resolve(dist,"." + decodeURIComponent(new URL(request.url).pathname));
  if(!path.startsWith(dist+sep))return new Response("Not found",{status:404});
  return new Response(Bun.file(path));
}});
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH}:{}), headless:true,
  args:["--no-sandbox","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",`--use-file-for-fake-video-capture=${videoPath}`] });
const errors: string[] = [];
const page = await browser.newPage({viewport:{width:1360,height:1000},permissions:["camera"]});
page.on("pageerror", e=>errors.push(e.message));
const waitReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>("#start")!.disabled,null,{timeout:60000});
};
try {
  await page.goto(`http://127.0.0.1:${server.port}/ar.html`); await waitReady(page);
  await page.locator("#markers").click(); assert(await page.locator("#marker-sheet canvas").count()===3,"three printable codes");
  await page.locator("#close-markers").click();
  await page.locator("#start").click();
  await page.waitForFunction(()=>window.canvasIrAR.map.markers.size===3,null,{timeout:15000});
  assert(await page.locator("#state").getAttribute("data-state")==="tracked","real camera detection and table pose");
  const projection = await page.evaluate(()=>{
    const {scene,snapshot}=window.canvasIrAR, {pose:p,intrinsics:k}=snapshot();
    const points: V3[]=[[-.2,0,-.1],[.2,0,.1],[.06,.05,.06]];
    scene.camera.getViewMatrix(true); const view=scene.camera.getViewMatrix(), projection=scene.camera.getProjectionMatrix();
    // Matrix projection without importing application classes into the test page.
    const m=view.multiply(projection).m;
    return points.map(([x,y,z])=>{
      const r=p.r,t=p.t, a=r[0]!*x+r[1]!*y+r[2]!*z+t[0],b=r[3]!*x+r[4]!*y+r[5]!*z+t[1],c=r[6]!*x+r[7]!*y+r[8]!*z+t[2];
      const w=x*m[3]!+y*m[7]!+z*m[11]!+m[15]!;
      const px=((x*m[0]!+y*m[4]!+z*m[8]!+m[12]!)/w+1)*k.width/2;
      const py=(1-(x*m[1]!+y*m[5]!+z*m[9]!+m[13]!)/w)*k.height/2;
      return Math.hypot(px-(k.fx*a/c+k.cx),py-(k.fy*b/c+k.cy));
    });
  });
  assert(projection.every(error=>error<.1),`Babylon projection agrees with OpenCV: ${projection}`);
  await page.screenshot({path:join(temporary,"tracked.png")});
  await page.locator("#freeze").click();
  await page.waitForFunction(()=>document.querySelector("#state")!.getAttribute("data-state")==="lost",null,{timeout:10000});
  await page.waitForFunction(()=>document.querySelector("#state")!.getAttribute("data-state")==="tracked",null,{timeout:10000});
  assert(await page.evaluate(()=>window.canvasIrAR.map.markers.size)===3,"map survives total loss and relocalizes with ID 2 alone");
  await page.locator("#stop").click();
  const stopped = await page.evaluate(()=>!window.canvasIrAR.snapshot().running && document.querySelector<HTMLVideoElement>("#video")!.srcObject===null);
  assert(stopped,"stop releases the camera");
  // Exercise manual calibration against the same scene, then physical button/grab/release behavior.
  await page.locator("#anchor").selectOption("manual"); await page.locator("#start").click();
  await page.waitForFunction(()=>window.canvasIrAR.snapshot().running);
  const rect=await page.locator("#overlay").boundingBox(); assert(rect,"camera image bounds");
  const manual = await page.evaluate(()=>{
    const k=window.canvasIrAR.snapshot().intrinsics;
    return [[-.3,-.2],[.3,-.2],[.3,.2],[-.3,.2]].map(([x,z])=>[(k.fx*x!/.9+k.cx)/k.width,(k.fy*z!/.9+k.cy)/k.height]);
  });
  for(const [x,y] of manual)await page.mouse.click(rect!.x+rect!.width*x!,rect!.y+rect!.height*y!);
  await page.waitForFunction(()=>window.canvasIrAR.scene.enabled);
  await page.evaluate(()=>{
    const {scene}=window.canvasIrAR;
    const points: V3[]=Array.from({length:21},()=>[0,.1,0]);
    points[0]=[0,.1,.12];points[9]=[0,.1,.04];points[5]=[.03,.1,.07];points[17]=[-.03,.1,.07];
    points[8]=[-.13,.008,.06];points[4]=[-.19,.008,.06];
    scene.hand(points,true,performance.now());scene.hand(points,true,performance.now());
  });
  assert(await page.evaluate(()=>window.canvasIrAR.scene.presses)===1,"index finger triggers the button");
  await page.evaluate(()=>{
    const {scene}=window.canvasIrAR; scene.resetObjects();
    const points: V3[]=Array.from({length:21},()=>[0,.1,0]);
    points[0]=[0,.1,.12];points[9]=[0,.1,.04];points[5]=[.03,.1,.07];points[17]=[-.03,.1,.07];
    points[8]=[.055,.03,.06];points[4]=[.115,.03,.06]; scene.hand(points,true,performance.now());
    points[4]=[.07,.03,.06];scene.hand(points,true,performance.now());
    (window as unknown as {arTestPoints:V3[]}).arTestPoints=points;
  });
  assert(await page.evaluate(()=>window.canvasIrAR.scene.holding)==="cube","pinch captures a nearby cube");
  for(let i=0;i<5;i++) {
    await page.evaluate(()=>{
      const p=(window as unknown as {arTestPoints:V3[]}).arTestPoints;
      p[8]=[.13,.14,.06];p[4]=[.145,.14,.06];
      // Turn the palm while moving it.
      p[5]=[.02,.12,.07];p[17]=[-.02,.08,.07];
      window.canvasIrAR.scene.hand(p,true,performance.now());
    });
    await page.waitForTimeout(80);
  }
  const heldPosition=await page.evaluate(()=>{
    const cube=window.canvasIrAR.scene.scene.getMeshByName("cube")!;
    return {x:cube.position.x,y:cube.position.y,rotation:cube.rotationQuaternion!.asArray()};
  });
  assert(heldPosition.y>.09 && heldPosition.y<.25 && heldPosition.x>.09 && heldPosition.x<.25,`animated Havok body follows 3D hand: ${JSON.stringify(heldPosition)}`);
  assert(heldPosition.rotation.slice(0,3).some(v=>Math.abs(v)>.1),"wrist rotates the held cube");
  await page.evaluate(()=>{
    const p=(window as unknown as {arTestPoints:V3[]}).arTestPoints;p[4]=[.21,.14,.06];window.canvasIrAR.scene.hand(p,true,performance.now());
  });
  assert(await page.evaluate(()=>window.canvasIrAR.scene.holding)==="—","opening pinch releases the cube");
  await page.waitForTimeout(400);
  const landed=await page.evaluate(()=>window.canvasIrAR.scene.scene.getMeshByName("cube")!.position.y);
  assert(landed<.06 && landed>0,`released cube falls onto physical table: ${landed}`);
  await page.locator("#stop").click();
  // Real MediaPipe WASM/model initialization and inference on the synthetic empty scene.
  await page.locator("#hands").click();
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>("#hands")!.disabled,null,{timeout:90000});
  assert(await page.evaluate(()=>window.canvasIrAR.snapshot().handEnabled),`MediaPipe loads: ${await page.locator("#notice").innerText()}`);
  await page.locator("#start").click(); await page.waitForFunction(()=>document.querySelector("#hand-state")!.textContent==="не видна");
  await page.locator("#stop").click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(temporary,"mobile.png"),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"mobile layout has no horizontal overflow");
  assert(errors.length===0,`browser errors: ${errors.join("; ")}`);
  console.log("PASS: ArUco camera pipeline, arbitrary map, total loss/relocalization, OpenCV/Babylon projection, manual mode, Havok touch/grab/rotation/release, MediaPipe initialization/inference, mobile layout, camera cleanup.");
  console.log(`Screenshots: ${temporary}`);
} catch (error) {
  console.error("Browser state:", await page.locator("#notice").innerText(), await page.locator("#state").innerText(), errors);
  await page.screenshot({path:join(temporary,"failure.png"),fullPage:true}); console.error("Failure screenshot:",join(temporary,"failure.png")); throw error;
} finally { await browser.close(); server.stop(); await rm(videoPath,{force:true}); }
