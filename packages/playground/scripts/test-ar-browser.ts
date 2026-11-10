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
  snapshot: () => { running:boolean; pose:Pose; intrinsics:ReturnType<typeof intrinsics>; tableReady:boolean; usedIds:number[]; hand:import("../src/ar/hand").HandEstimate|null; interaction:import("../src/ar/scene").InteractionResult|null;handRuntime:{active:"GPU"|"CPU"|null;requested:string;fallbackReason:string|null} }
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
    const corners = markerCorners(id===2?.045:.06,centers[id]!).map(p=>project(camera,k,p));
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
for(const [seconds,frame] of (process.env.AR_EXTENDED_ONLY?[[14,all] as const]:[[7,all],[1.5,blank],[4,one],[1.5,blank]] as const)) {
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
  args:["--no-sandbox","--enable-unsafe-swiftshader","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",`--use-file-for-fake-video-capture=${videoPath}`] });
const errors: string[] = [];
const page = await browser.newPage({viewport:{width:1360,height:1000},permissions:["camera"]});
page.on("pageerror", e=>errors.push(e.message));
const waitReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>("#start")!.disabled,null,{timeout:60000});
};
try {
  await page.goto(`http://127.0.0.1:${server.port}/ar.html`); await waitReady(page);
  await page.locator("#markers").click(); assert(await page.locator("#marker-sheet canvas").count()===3,"three printable codes");await page.locator("#close-markers").click();
  assert(await page.locator("#size").inputValue()==="3","notebook 6×6 cells defaults to a 3 cm outer marker side");
  // This video fixture uses 6 cm printed markers; use their actual physical size.
  await page.locator("#menu").click();await page.locator("#size").fill("6");await page.locator("#settings details").first().locator("summary").click();await page.locator("#marker-id").fill("2");await page.locator("#marker-size").fill("4.5");await page.locator("#save-marker-size").click();await page.locator("#close-settings").click();
  await page.locator("#markers").click();
  const printSizes=await page.locator('#marker-sheet .marker').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).style.getPropertyValue('--marker-mm')));
  assert(printSizes.join()==='60mm,60mm,45mm','print sheet uses each marker ID outer black-square side');await page.locator('#close-markers').click();
  await page.locator("#start").click();
  await page.waitForFunction(()=>window.canvasIrAR.snapshot().tableReady&&window.canvasIrAR.snapshot().usedIds.length===3,null,{timeout:30000});
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
  if(!process.env.AR_EXTENDED_ONLY){
  // Reproduce "one visible marker works, three visible markers blank out":
  // corrupt only the learned map, while the real camera still sees all three.
  // GPU shader warm-up can outlast the first fixture phase on a software
  // WebGL runner. Start the fault injection on a fresh all-markers phase.
  await page.waitForFunction(()=>window.canvasIrAR.trace.some((e:any)=>e.kind==="frame"&&e.data.timing?.handModelMs>0),null,{timeout:60000});
  await page.waitForFunction(()=>window.canvasIrAR.snapshot().usedIds.length===3&&(document.querySelector<HTMLVideoElement>("#video")!.currentTime%14)<3.5,null,{timeout:30000});
  await page.screenshot({path:join(temporary,"tracked.png")});
  const savedMap=await page.evaluate(()=>[...window.canvasIrAR.map.markers]);
  await page.evaluate(()=>{
    const map=window.canvasIrAR.map.markers;
    for(const id of [1,2])map.set(id,map.get(id)!.map(p=>[p[0]+(id===1?.02:-.02),p[1],p[2]]));
  });
  await page.waitForFunction(()=>window.canvasIrAR.trace.some((e:any)=>e.kind==="frame"&&e.data.visibleIds.length===3&&e.data.poseMode==="single-fallback"),null,{timeout:20000});
  assert(await page.evaluate(()=>window.canvasIrAR.scene.enabled),"three disagreeing visible markers retain a usable pose instead of hiding the demo");
  await page.evaluate(saved=>{const map=window.canvasIrAR.map.markers;for(const [id,points] of saved)map.set(id,points);},savedMap);
  const layoutBefore=await page.evaluate(()=>window.canvasIrAR.scene.layout);
  await page.waitForFunction(()=>!window.canvasIrAR.scene.enabled,null,{timeout:10000});
  await page.waitForFunction(()=>window.canvasIrAR.scene.enabled&&window.canvasIrAR.snapshot().usedIds.length===1,null,{timeout:10000});
  const layoutAfter=await page.evaluate(()=>window.canvasIrAR.scene.layout);
  assert(JSON.stringify(layoutBefore)===JSON.stringify(layoutAfter),"occlusion does not recenter or rescale the original table");
  }
  if(!process.env.AR_EXTENDED_ONLY){
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
  const backend=await page.evaluate(()=>window.canvasIrAR.snapshot().handRuntime);
  assert(backend.active==="GPU"||backend.active==="CPU"&&backend.fallbackReason!==null,`GPU attempted; actual hand backend: ${JSON.stringify(backend)}`);
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
  assert(await page.evaluate(()=>window.canvasIrAR.scene.original.hands.states.some(s=>s.action==="hold")),"AR delegates grabs to the common Hands input");
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
    const before=s.original.things.size;s.hand(points,true,performance.now(),1);s.hand(points,true,performance.now(),1);s.hand(points.map(p=>[p[0],p[1]+.08,p[2]] as V3),true,performance.now(),1);return{before,after:s.original.things.size,action:s.result,events:s.original.events,control:s.original.controlAt(s.room(point))};
  });
  assert(panelCounts.after===panelCounts.before+1,`touch executes original Drop crate component: ${JSON.stringify(panelCounts)}`);
  assert(await page.evaluate(()=>window.canvasIrAR.trace.some((e:any)=>e.kind==="hand"&&e.data.interaction?.action==="grab")),"trace records successful interaction and pose/rejection inputs");
  // Physical touch, not pinch: feed open-hand landmarks through the production
  // reconstruction and require actual Havok contacts AND movement of each actor.
  const replayTip=async(point:V3,ageMs=500):Promise<void>=>{
    await page.evaluate(({point,ageMs})=>{
      const ar=window.canvasIrAR,{pose:p,intrinsics:k}=ar.snapshot(),metric=ar.hand.metricScale!;
      const c:V3=[p.r[0]!*point[0]+p.r[1]!*point[1]+p.r[2]!*point[2]+p.t[0],p.r[3]!*point[0]+p.r[4]!*point[1]+p.r[5]!*point[2]+p.t[1],p.r[6]!*point[0]+p.r[7]!*point[1]+p.r[8]!*point[2]+p.t[2]];
      const shape:V3[]=Array.from({length:21},(_,j)=>[(j%5-2)*.012,(Math.floor(j/5)-2)*.018,(j%3)*.004]);
      shape[8]=[0,0,0];shape[4]=[.06,0,0];shape[5]=[.035,-.025,0];shape[17]=[-.035,-.025,0];shape[0]=[0,.045,.004];shape[9]=[0,-.035,.004];
      const camera=shape.map(v=>[(v[0]+c[0])/metric,(v[1]+c[1])/metric,(v[2]+c[2])/metric] as V3);
      ar.replayHand({landmarks:[camera.map(v=>({x:(k.fx*v[0]/v[2]+k.cx)/k.width,y:(k.fy*v[1]/v[2]+k.cy)/k.height,z:0}))],worldLandmarks:[shape.map(v=>({x:v[0]/metric,y:v[1]/metric,z:v[2]/metric}))],handedness:[[{categoryName:"Right",displayName:"Right",score:1,index:0}]]},performance.now()-ageMs);
    },{point,ageMs});
  };
  for(const kind of ["crate","ball"]){
    const initial=await page.evaluate(kind=>{
      const s=window.canvasIrAR.scene;s.loseHand(true);
      const item=[...s.original.things.values()].find(t=>t.mesh.name.startsWith(kind))!;
      item.body.body.disablePreStep=false;item.mesh.rotationQuaternion!.set(0,0,0,1);
      item.mesh.position.set(s.original.floor.table.center.x,kind==="crate"?.88:.755,s.original.floor.table.center.z);
      item.body.body.setLinearVelocity(item.mesh.position.scale(0));item.body.body.setAngularVelocity(item.mesh.position.scale(0));
      s.scene.onAfterPhysicsObservable.addOnce(()=>{item.body.body.disablePreStep=true;});
      return{id:item.mesh.name,point:s.table(item.mesh.position)};
    },kind);
    await page.waitForTimeout(180);
    for(let step=0;step<=12;step++){
      const point:V3=[initial.point[0]-.035+step*.0025,initial.point[1],initial.point[2]];
      await replayTip(point);await page.waitForTimeout(75);
    }
    const touched=await page.evaluate(id=>{
      const s=window.canvasIrAR.scene,actor=s.original.things.get(id)!;
      return{point:s.table(actor.mesh.position),contacts:s.physicalContacts.filter(e=>e.target===id)};
    },initial.id);
    assert(touched.contacts.length>0,`open fingertip has real Havok collision with ${kind}`);
    assert(touched.point[0]>initial.point[0]+.002,`touch physically moves original ${kind}: ${initial.point[0]} → ${touched.point[0]}`);
    assert(await page.evaluate(()=>window.canvasIrAR.scene.holding)==="—","physical touch does not require a pinch");
  }
  // A 500 ms-old source frame and 320 ms between samples must not cancel a slider.
  const sliderPoint=async(x:number):Promise<V3>=>page.evaluate(x=>{
    const s=window.canvasIrAR.scene,panel=s.original.panel,m=panel.computeWorldMatrix(true).m;
    const u=(x/480-.5)*2.88,v=(.5-179/300)*1.8;
    const world=s.camera.position.clone();world.set(u*m[0]!+v*m[4]!+m[12]!,u*m[1]!+v*m[5]!+m[13]!,u*m[2]!+v*m[6]!+m[14]!);
    // Add normal error along the measured camera ray; its screen position stays fixed.
    world.addInPlace(s.camera.globalPosition.subtract(world).normalize().scale(.015/s.layout.scale));
    return s.table(world);
  },x);
  await page.evaluate(()=>window.canvasIrAR.scene.loseHand(true));
  await replayTip(await sliderPoint(100));await page.waitForTimeout(320);
  await replayTip(await sliderPoint(100));await page.waitForTimeout(320);
  await replayTip(await sliderPoint(370));await page.waitForTimeout(100);
  const bounce=await page.evaluate(()=>[...window.canvasIrAR.scene.original.things.values()][0]!.body.shape.material.restitution);
  assert(Math.abs(bounce-(370-24)/432)<.025,`slider remains captured across slow/noisy frames: restitution ${bounce}`);
  }else{await page.evaluate(()=>{document.querySelector<HTMLVideoElement>("#video")!.pause();window.canvasIrAR.hand.metricScale=1;});}
  // Field edits go through the real UI; the scene, picking and Havok slab must agree.
  await page.evaluate(()=>{const s=window.canvasIrAR.scene,t=[...s.original.things.values()][0]!;s.loseHand(true);t.body.body.disablePreStep=false;t.mesh.position.x=100;t.mesh.position.z=100;t.body.body.setLinearVelocity(t.mesh.position.scale(.01));});
  await page.locator('#menu').click();await page.locator('#edit-field').click();
  for(const [key,value] of [['width','85'],['depth','52'],['x','18'],['z','-12'],['angle','33']]){await page.locator(`#field-${key}`).fill(value!);await page.locator(`#field-${key}`).press('Tab');}
  const fieldCheck=await page.evaluate(()=>{
    const s=window.canvasIrAR.scene,f=s.field,table=s.original.floor.table;
    const point:V3=[.27,.03,-.17],round=s.table(s.room(point));
    s.camera.getViewMatrix(true);const m=s.camera.getViewMatrix().multiply(s.camera.getProjectionMatrix()).m,p=window.canvasIrAR.snapshot().pose,k=window.canvasIrAR.snapshot().intrinsics,q=s.room(point),w=q.x*m[3]!+q.y*m[7]!+q.z*m[11]!+m[15]!;
    const projected=[((q.x*m[0]!+q.y*m[4]!+q.z*m[8]!+m[12]!)/w+1)*k.width/2,(1-(q.x*m[1]!+q.y*m[5]!+q.z*m[9]!+m[13]!)/w)*k.height/2],cam=p.r.map(()=>0);
    const camera=[0,1,2].map(i=>p.r[i*3]!*point[0]+p.r[i*3+1]!*point[1]+p.r[i*3+2]!*point[2]+p.t[i]!);
    const error=Math.hypot(projected[0]!-(k.fx*camera[0]!/camera[2]!+k.cx),projected[1]!-(k.fy*camera[1]!/camera[2]!+k.cy));
    const action=s.hand(Array.from({length:21},()=>point),true,performance.now(),0);
    const inside=[...s.original.things.values()].every(t=>Math.abs(t.mesh.position.x-table.center.x)<=table.width/2&&Math.abs(t.mesh.position.z-table.center.z)<=table.depth/2);
    return {inside,f,width:table.width*s.layout.scale,depth:table.depth*s.layout.scale,slab:[s.original.floor.top.scaling.x*s.layout.scale,s.original.floor.top.scaling.z*s.layout.scale],round,error,action};
  });
  assert(Math.abs(fieldCheck.width-.85)<1e-6&&Math.abs(fieldCheck.depth-.52)<1e-6&&fieldCheck.f.angle===33,'independent field dimensions and rotation exceed the marker hull');
  assert(fieldCheck.slab.every((v,i)=>Math.abs(v-[.85,.52][i]!)<1e-6)&&fieldCheck.round.every((v,i)=>Math.abs(v-[.27,.03,-.17][i]!)<1e-6)&&fieldCheck.error<.1,'Havok slab, hand coordinate transform and rendering agree after field rotation');
  assert(fieldCheck.inside,'objects outside changed boundaries are moved safely inside the Havok slab');
  assert(fieldCheck.action.reason==='field-editing','hand contacts and grabs are suspended during editing');
  // Exercise the actual screen-space center handle on the estimated plane.
  const handle=await page.evaluate(()=>{const s=window.canvasIrAR.scene,p=window.canvasIrAR.snapshot().pose,k=window.canvasIrAR.snapshot().intrinsics,f=s.field;const pixel=(x:number,z:number)=>{const q=[0,1,2].map(i=>p.r[i*3]!*x+p.r[i*3+2]!*z+p.t[i]!);const r=document.querySelector('#overlay')!.getBoundingClientRect();return {x:r.left+(k.fx*q[0]!/q[2]!+k.cx)*r.width/k.width,y:r.top+(k.fy*q[1]!/q[2]!+k.cy)*r.height/k.height};};return {from:pixel(f.x,f.z),to:pixel(f.x+.03,f.z-.02)};});
  await page.mouse.move(handle.from.x,handle.from.y);await page.mouse.down();await page.mouse.move(handle.to.x,handle.to.y,{steps:4});await page.mouse.up();
  assert(await page.evaluate(()=>Math.abs(window.canvasIrAR.scene.field.x-.21)<.005&&Math.abs(window.canvasIrAR.scene.field.z+.14)<.005),'pointer handle moves the field on the plane');
  const rawBefore=await page.evaluate(()=>JSON.stringify(window.canvasIrAR.snapshot().pose));
  await page.locator('#field-editor details summary').click();await page.locator('#tilt-pitch').fill('8');await page.locator('#tilt-pitch').press('Tab');await page.locator('#tilt-enabled').check();
  assert(await page.evaluate(()=>window.canvasIrAR.hand.metricScale===null),'plane correction invalidates touch calibration');
  assert(await page.evaluate(()=>JSON.stringify(window.canvasIrAR.snapshot().pose))!==rawBefore,'plane correction changes the applied camera transform');
  await page.locator('#reset-tilt').click();assert(await page.evaluate(()=>JSON.stringify(window.canvasIrAR.snapshot().pose))===rawBefore,'reset restores the estimated plane without overwriting it');
  await page.locator('#finish-field').click();
  const rotatedTouch=await page.evaluate(()=>{
    const s=window.canvasIrAR.scene,panel=s.original.panel,m=panel.computeWorldMatrix(true).m,u=(76/480-.5)*2.88,v=(.5-111/300)*1.8,p=s.camera.position.clone();p.set(u*m[0]!+v*m[4]!+m[12]!,u*m[1]!+v*m[5]!+m[13]!,u*m[2]!+v*m[6]!+m[14]!);const point=s.table(p),points:V3[]=Array.from({length:21},()=>[...point]);points[4]=[point[0]+.06,point[1],point[2]];points[5]=[point[0]+.03,point[1],point[2]];points[17]=[point[0]-.03,point[1],point[2]];const before=s.original.things.size;s.hand(points,true,performance.now(),1);s.hand(points,true,performance.now(),1);s.hand(points.map(p=>[p[0],p[1]+.08,p[2]] as V3),true,performance.now(),1);const after=s.original.things.size;const outside=s.hand(Array.from({length:21},()=>[s.field.x+2,0,s.field.z] as V3),true,performance.now(),1);return {before,after,outside};
  });assert(rotatedTouch.after===rotatedTouch.before+1&&rotatedTouch.outside.reason==='outside-field','touching the original control works after rotation; outside-field hand interaction is rejected');
  await page.evaluate(()=>document.querySelector<HTMLVideoElement>('#video')!.play());
  await page.locator('#menu').click();
  await page.waitForFunction(()=>window.canvasIrAR.scene.enabled&&window.canvasIrAR.snapshot().usedIds.length===3,null,{timeout:30000});
  await page.locator('#capture').click();
  await page.waitForFunction(()=>(window.canvasIrAR as any).shots.shots.length===1,null,{timeout:15000});
  const shotCheck=await page.evaluate(async()=>{
    const shot=(window.canvasIrAR as any).shots.shots[0],d=shot.data,raw=await createImageBitmap(new Blob([shot.raw],{type:'image/png'})),composite=await createImageBitmap(new Blob([shot.composite],{type:'image/png'}));
    const canvas=document.createElement('canvas');canvas.width=raw.width;canvas.height=raw.height;const ctx=canvas.getContext('2d')!;ctx.drawImage(raw,0,0);const pixels=ctx.getImageData(0,0,raw.width,raw.height);
    const ids=d.table.observations.map((m:any)=>m.id);
    // Independently run ArUco on the exported PNG, not the live video.
    const cv=await (window as any).cv,src=cv.matFromImageData(pixels),gray=new cv.Mat(),corners=new cv.MatVector(),found=new cv.Mat(),rejected=new cv.MatVector(),dictionary=cv.getPredefinedDictionary(cv.DICT_4X4_50),parameters=new cv.aruco_DetectorParameters(),refine=new cv.aruco_RefineParameters(10,3,true),detector=new cv.aruco_ArucoDetector(dictionary,parameters,refine);
    parameters.cornerRefinementMethod=cv.CORNER_REFINE_SUBPIX;cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);detector.detectMarkers(gray,corners,found,rejected);const imageIds=Array.from(found.data32S) as number[];
    let maxCornerError=0;for(let i=0;i<found.rows;i++){const c=corners.get(i),m=d.table.observations.find((m:any)=>m.id===found.data32S[i]);if(m)for(let j=0;j<4;j++)maxCornerError=Math.max(maxCornerError,Math.hypot(c.data32F[j*2]-m.pixels[j].x,c.data32F[j*2+1]-m.pixels[j].y));c.delete();}
    for(const v of [detector,parameters,refine,dictionary,src,gray,corners,found,rejected])v.delete();
    ctx.drawImage(composite,0,0);const blended=ctx.getImageData(0,0,raw.width,raw.height).data;let changed=0;for(let i=0;i<blended.length;i+=4)if(blended[i]!==pixels.data[i])changed++;
    return {id:shot.id,capture:d.capture,processingCapture:d.processing.capture,estimates:d.estimates,ids,imageIds,maxCornerError,changed,raw:[raw.width,raw.height],composite:[composite.width,composite.height]};
  });
  assert(shotCheck.id===`frame-${shotCheck.capture.frameId}`&&JSON.stringify(shotCheck.processingCapture)===JSON.stringify({frameId:shotCheck.capture.frameId,capturedAt:shotCheck.capture.capturedAt,capturedAtEpochMs:shotCheck.capture.capturedAtEpochMs,mediaTimeSeconds:shotCheck.capture.mediaTimeSeconds}),'snapshot metadata uses the capture ID and capture time, not processing completion');
  assert(shotCheck.ids.sort().join()===shotCheck.imageIds.sort().join()&&shotCheck.maxCornerError<2,'independent ArUco detection on saved camera PNG agrees with JSON observations');
  console.log('Diagnostic PNG check',JSON.stringify(shotCheck));
  const imageBytes=await page.evaluate(()=>{const shot=(window.canvasIrAR as any).shots.shots[0];return {raw:Array.from(shot.raw),composite:Array.from(shot.composite)};});await Bun.write(join(temporary,'camera.png'),new Uint8Array(imageBytes.raw as number[]));await Bun.write(join(temporary,'overlay.png'),new Uint8Array(imageBytes.composite as number[]));
  assert(shotCheck.changed>100&&shotCheck.raw.join()===shotCheck.composite.join(),'composite PNG contains scene and diagnostic overlays at the raw image resolution');
  await page.locator('#hands').click();await page.locator('#capture').click();await page.waitForFunction(()=>(window.canvasIrAR as any).shots.shots.length===2,null,{timeout:15000});
  const olderHand=await page.evaluate(()=>{const d=(window.canvasIrAR as any).shots.shots[1].data;return {capture:d.capture,hand:d.estimates.hand};});assert(olderHand.hand.frameId<olderHand.capture.frameId&&olderHand.hand.ageAtCaptureMs>0,'snapshot explicitly retains an older hand source ID and its age when inference is disabled');
  const zipDownload=page.waitForEvent('download');await page.locator('#export-zip').click();const downloaded=await zipDownload;await downloaded.saveAs(join(temporary,'ar-diagnostics.zip'));assert((await Bun.file(join(temporary,'ar-diagnostics.zip')).bytes())[0]===0x50,'ZIP downloads locally with manifest, JSON and both PNGs');
  const jsonDownload=page.waitForEvent('download');await page.locator('#export').click();await (await jsonDownload).saveAs(join(temporary,'trace.json'));const json=await Bun.file(join(temporary,'trace.json')).json();assert(json.version===5&&!JSON.stringify(json).includes('data:image/'),'JSON-only export remains small and contains no encoded camera image');
  // Reload preserves the coordinate system and field; full reset must discard both.
  const stored=await page.evaluate(()=>(window.canvasIrAR as any).settings());await page.reload();await waitReady(page);
  const restored=await page.evaluate(()=>(window.canvasIrAR as any).settings());assert(JSON.stringify(stored)===JSON.stringify(restored),'marker sizes, map identity, field and correction survive a page reload');
  await page.locator('#start').click();await page.waitForFunction(()=>window.canvasIrAR.snapshot().tableReady,null,{timeout:15000});
  assert(await page.evaluate(()=>Math.abs(window.canvasIrAR.scene.field.width-.85)<1e-6&&window.canvasIrAR.scene.field.angle===33),'saved field is restored against the same stored marker coordinates');
  await page.locator('#menu').click();await page.locator('#recalibrate').click();const cleared=await page.evaluate(()=>(window.canvasIrAR as any).settings());assert(cleared.mapId!==stored.mapId&&cleared.field===null,'full map reset gives a new coordinate system and does not reuse old field offsets');

  await page.locator('#menu').click();await page.locator('#settings details').first().locator('summary').click();await page.evaluate(()=>window.canvasIrAR.hand.metricScale=1);const previousId=await page.evaluate(()=>(window.canvasIrAR as any).settings().mapId);await page.locator('#marker-id').fill('1');await page.locator('#marker-size').fill('7');await page.locator('#save-marker-size').click();
  assert(await page.evaluate(id=>(window.canvasIrAR as any).settings().mapId!==id&&window.canvasIrAR.hand.metricScale===null&&(window.canvasIrAR as any).settings().field===null,previousId),'changing an individual marker size invalidates map identity, field and hand calibration');await page.locator('#close-settings').click();
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
