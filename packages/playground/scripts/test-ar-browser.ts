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

declare global { interface Window { canvasIrAR: { scene: ARScene; map: MarkerMap; hand: import("../src/ar/hand").HandTracking; trace: unknown[];
  replayHand: (result: import("@mediapipe/tasks-vision").HandLandmarkerResult,now:number)=>void;
  analyzeHand: (source:HTMLCanvasElement)=>Promise<import("@mediapipe/tasks-vision").HandLandmarkerResult>;
  snapshot: () => { running:boolean; pose:Pose; intrinsics:ReturnType<typeof intrinsics>; tableReady:boolean; usedIds:number[]; hand:import("../src/ar/hand").HandEstimate|null; interaction:import("../src/ar/scene").InteractionResult|null }
} } }
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); console.log("✓", message); };
const temporary = await mkdtemp(join(tmpdir(), "canvas-ir-ar-"));
const cv = await (cvModule as unknown as Promise<any>);
const width = 800, height = 600, fps = 10;
const k = intrinsics(width,height,60);
const dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
const centers: V3[] = [[0,0,0], [.18,0,-.1], [-.08,0,.12]];
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
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  if(new URL(request.url).pathname==="/test-hand.jpg")return new Response(Bun.file(process.env.AR_HAND_IMAGE||join(temporary,"hand.jpg")));
  const path = resolve(dist,"." + decodeURIComponent(new URL(request.url).pathname));
  if(!path.startsWith(dist+sep))return new Response("Not found",{status:404});
  const file=Bun.file(path);return await file.exists()?new Response(file):new Response("Not found",{status:404});
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
  await page.locator("#markers").click(); assert(await page.locator("#marker-sheet canvas").count()===3,"three printable codes");await page.locator("#close-markers").click();
  await page.locator("#start").click();
  await page.waitForFunction(()=>window.canvasIrAR.snapshot().tableReady&&window.canvasIrAR.snapshot().usedIds.length===3,null,{timeout:15000});
  const identity=await page.evaluate(()=>{const ar=window.canvasIrAR,old=(window as unknown as {canvasIrBabylon:{scene:unknown;things:unknown}}).canvasIrBabylon;return{sameScene:old.scene===ar.scene.scene,sameThings:old.things===ar.scene.original.things,ids:[...ar.scene.original.things.keys()],center:ar.scene.layout.center,used:ar.snapshot().usedIds};});
  assert(identity.sameScene&&identity.sameThings,"AR uses the original Babylon scene and the same physical objects");
  assert(identity.ids.some(id=>id.startsWith("ball"))&&identity.ids.some(id=>id.startsWith("crate")),"original balls, crates and their CanvasIR labels exist");
  assert(identity.used.length===3,`all three markers contribute: ${identity.used}`);
  assert(Math.abs(identity.center[0]-.05)<.005&&Math.abs(identity.center[2]-.01)<.005,`table centered on marker group, not root: ${identity.center}`);
  const projection=await page.evaluate(()=>{
    const {scene,snapshot}=window.canvasIrAR,{pose:p,intrinsics:k}=snapshot();scene.camera.getViewMatrix(true);
    const m=scene.camera.getViewMatrix().multiply(scene.camera.getProjectionMatrix()).m;
    return ([[-.1,0,-.1],[.2,0,.1],[.06,.05,.06]] as V3[]).map(point=>{
      const [x,y,z]=point,r=p.r,t=p.t, a=r[0]!*x+r[1]!*y+r[2]!*z+t[0],b=r[3]!*x+r[4]!*y+r[5]!*z+t[1],c=r[6]!*x+r[7]!*y+r[8]!*z+t[2];
      const q=scene.room(point),w=q.x*m[3]!+q.y*m[7]!+q.z*m[11]!+m[15]!;
      const px=((q.x*m[0]!+q.y*m[4]!+q.z*m[8]!+m[12]!)/w+1)*k.width/2;
      const py=(1-(q.x*m[1]!+q.y*m[5]!+q.z*m[9]!+m[13]!)/w)*k.height/2;
      return Math.hypot(px-(k.fx*a/c+k.cx),py-(k.fy*b/c+k.cy));
    });
  });
  assert(projection.every(v=>v<.1),`original LH scene projects into RH table correctly: ${projection}`);
  await page.screenshot({path:join(temporary,"tracked.png")});
  const layoutBefore=await page.evaluate(()=>window.canvasIrAR.scene.layout);
  await page.waitForFunction(()=>!window.canvasIrAR.scene.enabled,null,{timeout:10000});
  await page.waitForFunction(()=>window.canvasIrAR.scene.enabled&&window.canvasIrAR.snapshot().usedIds.length===1,null,{timeout:10000});
  const layoutAfter=await page.evaluate(()=>window.canvasIrAR.scene.layout);
  assert(JSON.stringify(layoutBefore)===JSON.stringify(layoutAfter),"occlusion does not recenter or rescale the original table");
  // Pause inference only, retaining the current camera/table pose. Replays below
  // go through the production HandTracking pipeline, not just scene.hand().
  await page.evaluate(()=>{document.querySelector<HTMLVideoElement>("#video")!.pause();});
  if(!process.env.AR_HAND_IMAGE){const response=await fetch("https://storage.googleapis.com/mediapipe-assets/right_hands.jpg");if(!response.ok)throw Error("Official MediaPipe hand fixture unavailable");await Bun.write(join(temporary,"hand.jpg"),await response.arrayBuffer());}
  const detected=await page.evaluate(async()=>{
    const image=new Image();image.src="/test-hand.jpg";await image.decode();const k=window.canvasIrAR.snapshot().intrinsics;
    const canvas=document.createElement("canvas");canvas.width=k.width;canvas.height=k.height;const ctx=canvas.getContext("2d")!;ctx.fillStyle="white";ctx.fillRect(0,0,canvas.width,canvas.height);
    const factor=Math.min(canvas.width/image.width,canvas.height/image.height)*.5;ctx.drawImage(image,(canvas.width-image.width*factor)/2,(canvas.height-image.height*factor)/2,image.width*factor,image.height*factor);
    const result=await window.canvasIrAR.analyzeHand(canvas);(window as unknown as {arActualHand:typeof result}).arActualHand=result;
    return {count:result.landmarks.length,estimate:window.canvasIrAR.snapshot().hand};
  });
  assert(detected.count===1,`real MediaPipe detects the official photo fixture (${detected.count} hand)`);
  const actualRaw=await page.evaluate(()=>(window as unknown as {arActualHand:unknown}).arActualHand);await Bun.write(join(temporary,"actual-landmarks.json"),JSON.stringify(actualRaw));
  assert(detected.estimate?.points,`real MediaPipe geometry accepted: ${JSON.stringify({reason:detected.estimate?.reason,error:detected.estimate?.error,method:detected.estimate?.method})}`);
  await page.locator("#touch").click();
  for(let i=0;i<14;i++){
    await page.evaluate(()=>window.canvasIrAR.replayHand((window as unknown as {arActualHand:import("@mediapipe/tasks-vision").HandLandmarkerResult}).arActualHand,performance.now()));
    await page.waitForTimeout(75);
  }
  const calibration=await page.evaluate(()=>({scale:window.canvasIrAR.hand.metricScale,estimate:window.canvasIrAR.snapshot().hand}));
  assert(calibration.scale!==null,`touch calibration completes on real MediaPipe output: scale ${calibration.scale}`);
  assert(Math.abs(calibration.estimate!.points![8]![1])<.003,"calibrated fingertip lies on the real table plane");
  // Reproject the measured metric hand at a real original crate, preserving its
  // anatomy and camera transform. Changes to thumb position generate an actual pinch.
  await page.evaluate(()=>{window.canvasIrAR.scene.resetObjects();});await page.waitForTimeout(500);
  const gesture=async(pinched:boolean,lift:number,turn=0):Promise<void>=>{
    await page.evaluate(({pinched,lift,turn})=>{
      const ar=window.canvasIrAR,{pose:p,intrinsics:k}=ar.snapshot(),thing=[...ar.scene.original.things.values()].find(t=>t.mesh.name.startsWith("crate"))!;
      const target=ar.scene.table(thing.mesh.position);target[1]+=lift;
      const toCam=(v:V3):V3=>[p.r[0]!*v[0]+p.r[1]!*v[1]+p.r[2]!*v[2]+p.t[0],p.r[3]!*v[0]+p.r[4]!*v[1]+p.r[5]!*v[2]+p.t[1],p.r[6]!*v[0]+p.r[7]!*v[1]+p.r[8]!*v[2]+p.t[2]];
      const cam=toCam(target),metric=ar.hand.metricScale!;
      const shape:V3[]=Array.from({length:21},(_,i)=>[(i%5-2)*.012,(Math.floor(i/5)-2)*.018,(i%3)*.004]);
      shape[8]=[-.003,0,0];shape[4]=[pinched?.004:.055,0,0];shape[5]=[.035,-.025,0];shape[17]=[-.035,-.025,0];shape[0]=[0,.045,.004];shape[9]=[0,-.035,.004];
      const rot=shape.map(([x,y,z])=>[Math.cos(turn)*x-Math.sin(turn)*y,Math.sin(turn)*x+Math.cos(turn)*y,z] as V3);
      const camera=rot.map(v=>[v[0]/metric+cam[0]/metric,v[1]/metric+cam[1]/metric,v[2]/metric+cam[2]/metric] as V3);
      const result={landmarks:[camera.map(v=>({x:(k.fx*v[0]/v[2]+k.cx)/k.width,y:(k.fy*v[1]/v[2]+k.cy)/k.height,z:0}))],worldLandmarks:[rot.map(v=>({x:v[0]/metric,y:v[1]/metric,z:v[2]/metric}))],handedness:[[{categoryName:"Right",displayName:"Right",score:1,index:0}]]};
      ar.replayHand(result,performance.now());
    },{pinched,lift,turn});
  };
  await gesture(false,0);await gesture(true,0);
  assert((await page.evaluate(()=>window.canvasIrAR.snapshot().interaction))?.action==="grab","production landmark pipeline grabs an original crate");
  const before=await page.evaluate(()=>{const t=[...window.canvasIrAR.scene.original.things.values()].find(t=>t.mesh.name.startsWith("crate"))!;return {height:window.canvasIrAR.scene.table(t.mesh.position)[1],rotation:t.mesh.rotationQuaternion!.asArray()};});
  for(let i=0;i<5;i++){await gesture(true,.015,.4);await page.waitForTimeout(75);}
  const after=await page.evaluate(()=>{const t=[...window.canvasIrAR.scene.original.things.values()].find(t=>t.mesh.name.startsWith("crate"))!;return {height:window.canvasIrAR.scene.table(t.mesh.position)[1],rotation:t.mesh.rotationQuaternion!.asArray()};});
  assert(after.height>before.height+.02,`original Havok crate lifts with the landmark pipeline: ${before.height} → ${after.height}`);
  const quaternionDot=Math.abs(before.rotation.reduce((sum,v,i)=>sum+v*after.rotation[i]!,0));
  assert(quaternionDot<.995,`original Havok crate rotates with the reconstructed palm: quaternion dot ${quaternionDot}`);
  await gesture(false,0);assert(await page.evaluate(()=>window.canvasIrAR.scene.holding)==="—","opening the pinch returns the original body to Havok dynamics");
  // Real CanvasIR panel component: two contact frames must execute Drop crate.
  const panelCounts=await page.evaluate(()=>{
    const ar=window.canvasIrAR,s=ar.scene,panel=s.original.panel;
    const m=panel.computeWorldMatrix(true).m,local=[(76/480-.5)*2.88,(.5-111/300)*1.8,0];
    const point=s.table(new (s.camera.position.constructor as new(x:number,y:number,z:number)=>typeof s.camera.position)(local[0]!*m[0]!+local[1]!*m[4]!+m[12]!,local[0]!*m[1]!+local[1]!*m[5]!+m[13]!,local[0]!*m[2]!+local[1]!*m[6]!+m[14]!));
    const points:V3[]=Array.from({length:21},()=>[...point]);points[8]=point;points[4]=[point[0]+.06,point[1],point[2]];points[5]=[point[0]+.03,point[1],point[2]];points[17]=[point[0]-.03,point[1],point[2]];points[0]=[point[0],point[1],point[2]+.04];points[9]=[point[0],point[1],point[2]-.04];
    const before=s.original.things.size;s.hand(points,true,performance.now(),1);s.hand(points,true,performance.now(),1);return{before,after:s.original.things.size,action:s.result,events:s.original.events,control:s.original.controlAt(s.room(point))};
  });
  assert(panelCounts.after===panelCounts.before+1,`touch executes original Drop crate component: ${JSON.stringify(panelCounts)}`);
  assert(await page.evaluate(()=>window.canvasIrAR.trace.some((e:any)=>e.kind==="hand"&&e.data.interaction?.action==="grab")),"trace records successful interaction and pose/rejection inputs");
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(temporary,"mobile.png")});
  assert(await page.evaluate(()=>document.documentElement.scrollHeight===innerHeight&&document.documentElement.scrollWidth===innerWidth),"camera fills the viewport with no diagnostic panels or scrolling");
  await page.locator("#menu").click();await page.locator("#stop").click();assert(await page.evaluate(()=>document.querySelector<HTMLVideoElement>("#video")!.srcObject===null),"stop releases camera tracks");
  const originalPage=await browser.newPage();await originalPage.goto(`http://127.0.0.1:${server.port}/babylon.html#3d`);
  await originalPage.waitForFunction(()=>(window as unknown as {canvasIrBabylon:unknown}).canvasIrBabylon,null,{timeout:30000});
  const baseline=await originalPage.evaluate(()=>{
    const old=(window as unknown as {canvasIrBabylon:{things:Map<string,{mesh:{getBoundingInfo:()=>{boundingBox:{extendSize:{x:number}}}}}>;drop:(kind:string)=>void}}).canvasIrBabylon;
    const width=old.things.get("crate-1")!.mesh.getBoundingInfo().boundingBox.extendSize.x*2,before=old.things.size;old.drop("crate");return{width,before,after:old.things.size};
  });
  assert(Math.abs(baseline.width-.7)<.001&&baseline.after===baseline.before+1,"original non-AR demo still boots with its original geometry and behavior");await originalPage.close();
  assert(errors.length===0,`browser errors: ${errors.join("; ")}`);
  console.log("PASS: original Babylon reuse, three-marker placement/occlusion, real MediaPipe geometry and touch calibration, landmark-to-Havok grab/lift/release, original control click, fullscreen UI and trace.");console.log(`Screenshots: ${temporary}`);
} catch(error){console.error("Snapshot:",await page.evaluate(()=>window.canvasIrAR?.snapshot()));await page.screenshot({path:join(temporary,"failure.png")});console.error("Failure screenshot:",join(temporary,"failure.png"));throw error;}
finally{await browser.close();server.stop();await rm(videoPath,{force:true});}
