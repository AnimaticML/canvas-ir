import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { intrinsics, type Intrinsics, type Pixel, type Pose, type V3 } from "./ar/geometry";
import { MarkerMap, Vision, loadCV, type Fit, type Marker } from "./ar/vision";
import { ARScene, smoothPose, type InteractionResult } from "./ar/scene";
import { HandTracking, type HandEstimate } from "./ar/hand";

const el=<T extends HTMLElement=HTMLElement>(id:string):T=>document.getElementById(id) as T;
const button=(id:string):HTMLButtonElement=>el<HTMLButtonElement>(id);
const input=(id:string):HTMLInputElement=>el<HTMLInputElement>(id);
const anchor=():string=>el<HTMLSelectElement>("anchor").value;
const notice=(message:string):void=>{el("notice").textContent=message;};
const video=el<HTMLVideoElement>("video"),overlay=el<HTMLCanvasElement>("overlay"),ctx=overlay.getContext("2d")!;
const processing=document.createElement("canvas"),pixels=processing.getContext("2d",{willReadFrequently:true})!;
const map=new MarkerMap(.06),hand=new HandTracking();
let vision:Vision|null=null,scene:ARScene|null=null,hands:HandLandmarker|null=null,handLoading:Promise<void>|null=null;
let stream:MediaStream|null=null,running=false,starting=false,generation=0,frame=0,handEnabled=true;
let k:Intrinsics|null=null,pose:Pose|null=null,lastFrame=0,lastVideo=-1,lastPose=0;
let manual:Pixel[]=[],manualFit:Fit|null=null,tableReady=false,mapChanged=0,mapSize=0;
let wasTracking=false;
let lastHand:HandEstimate|null=null,lastAction:InteractionResult|null=null,lastStatus="",lastOutcome="";
let found:Marker[]=[],usedIds:number[]=[],trackingError:number|null=null;
const trace:{time:number;kind:string;data:unknown}[]=[];
const record=(kind:string,data:unknown):void=>{trace.push({time:performance.now(),kind,data});if(trace.length>400)trace.shift();};
const skeleton=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
const outcome=(message:string):void=>{if(message===lastOutcome)return;lastOutcome=message;el("outcome").textContent=message;el("outcome").hidden=!message;};
const reset=():void=>{
  wasTracking=false;map.reset(Number(input("size").value)/100);hand.reset();pose=null;manual=[];manualFit=null;tableReady=false;mapSize=0;mapChanged=0;lastPose=0;lastHand=null;lastStatus="";
  scene?.hide();scene?.resetObjects();button("touch").hidden=true;outcome("");
  notice(anchor()==="manual"?"Выберите углы 60×40 см: дальний левый → дальний правый → ближний правый → ближний левый.":"Покажите вместе 2–3 разных маркера.");
  record("anchor-reset",{sizeM:map.size,mode:anchor()});
};
const layout=():void=>{
  const w=k?.width??640,h=k?.height??480,stage=el("stage"),factor=Math.max(stage.clientWidth/w,stage.clientHeight/h);
  const image=el("image");image.style.width=`${w*factor}px`;image.style.height=`${h*factor}px`;scene?.resize();
};
new ResizeObserver(layout).observe(el("stage"));
const stop=():void=>{
  running=false;starting=false;generation++;cancelAnimationFrame(frame);
  stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;scene?.hide();pose=null;lastHand=null;
  ctx.clearRect(0,0,overlay.width,overlay.height);el("welcome").hidden=false;button("touch").hidden=true;
  button("start").disabled=!scene||!vision;outcome("");record("camera-stop",{});
};
const loadHands=():Promise<void>=>{
  if(hands)return Promise.resolve();if(handLoading)return handLoading;
  handLoading=(async()=>{
    try {
      const files=await FilesetResolver.forVisionTasks("./ar-vendor/mediapipe");
      hands=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:"./ar-vendor/hand_landmarker.task",delegate:"CPU"},runningMode:"VIDEO",numHands:1,minHandDetectionConfidence:.55,minHandPresenceConfidence:.55,minTrackingConfidence:.55});
      record("hands-ready",{});
    } catch(error){record("hands-load-error",String(error));notice("Не удалось загрузить руки. Повторите включение в настройках.");}
    finally{handLoading=null;}
  })();return handLoading;
};
button("start").onclick=async()=>{
  if(running||starting)return;
  if(!navigator.mediaDevices?.getUserMedia){notice("Для камеры откройте страницу через HTTPS.");return;}
  starting=true;const token=++generation;button("start").disabled=true;
  try{
    const incoming=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});
    if(token!==generation){incoming.getTracks().forEach(t=>t.stop());return;}
    stream=incoming;video.srcObject=incoming;await video.play();if(token!==generation)return;
    dimensions();running=true;starting=false;lastFrame=0;lastVideo=-1;reset();layout();el("welcome").hidden=true;
    frame=requestAnimationFrame(tick);if(handEnabled)void loadHands();
    incoming.getVideoTracks()[0]!.addEventListener("ended",()=>{if(stream===incoming){stop();notice("Камера отключена. Откройте её снова.");}});
    record("camera-start",{width:video.videoWidth,height:video.videoHeight});
  }catch(error){if(token===generation){stop();notice(`Камера не открылась: ${String(error)}`);record("camera-error",String(error));}}
};
const dimensions=():void=>{const factor=Math.min(1,800/video.videoWidth),width=Math.round(video.videoWidth*factor),height=Math.round(video.videoHeight*factor);if(!width||!height)throw Error("Нет кадра камеры");overlay.width=processing.width=width;overlay.height=processing.height=height;k=intrinsics(width,height,Number(input("fov").value));};
video.addEventListener("resize",()=>{if(!running)return;const ratio=video.videoWidth/video.videoHeight;if(k&&Math.abs(k.width/k.height-ratio)<.005)return;dimensions();reset();layout();});
document.addEventListener("visibilitychange",()=>{if(document.hidden&&(running||starting)){stop();notice("Камера остановлена. Откройте её снова.");}});
window.addEventListener("pagehide",()=>{stop();hands?.close();vision?.dispose();scene?.dispose();});
button("stop").onclick=()=>{stop();el<HTMLDialogElement>("settings").close();notice("");};
button("menu").onclick=()=>el<HTMLDialogElement>("settings").showModal();
button("close-settings").onclick=()=>el<HTMLDialogElement>("settings").close();
button("recalibrate").onclick=()=>{reset();el<HTMLDialogElement>("settings").close();};
button("reset-objects").onclick=()=>{scene?.resetObjects();el<HTMLDialogElement>("settings").close();};
button("hands").onclick=async()=>{handEnabled=!handEnabled;button("hands").textContent=handEnabled?"Выключить руки":"Включить руки";if(handEnabled)await loadHands();else{scene?.loseHand(true);lastHand=null;}button("touch").hidden=!handEnabled||!running||!tableReady;};
input("size").onchange=()=>{if(!input("size").checkValidity())input("size").value="6";reset();};
input("fov").onchange=()=>{if(!input("fov").checkValidity())input("fov").value="60";if(k)k=intrinsics(k.width,k.height,Number(input("fov").value));reset();};
el<HTMLSelectElement>("anchor").onchange=reset;
const calibrate=():void=>{hand.calibrate(performance.now());lastStatus="";button("touch").hidden=false;notice("Держите указательный палец на столе около секунды.");record("calibration-start",{});};
button("touch").onclick=calibrate;
button("recalibrate-hand").onclick=()=>{el<HTMLDialogElement>("settings").close();if(running&&tableReady)calibrate();};
overlay.addEventListener("pointerdown",event=>{
  if(!running||!k||!vision||anchor()!=="manual"||manual.length>=4)return;
  const r=overlay.getBoundingClientRect();manual.push({x:(event.clientX-r.left)*k.width/r.width,y:(event.clientY-r.top)*k.height/r.height});
  if(manual.length===4){
    const corners:V3[]=[[-.3,0,-.2],[.3,0,-.2],[.3,0,.2],[-.3,0,.2]];
    const fit=vision.fit(corners,manual,k);
    if(fit&&fit.error<8){manualFit=fit;scene?.configure(new Map([[0,corners]]));tableReady=true;}
    else{manual=[];notice("Выберите четыре угла прямоугольника по порядку ещё раз.");}
  }
});
const applyHand=(result:HandLandmarkerResult,now:number):void=>{
  if(!pose||!k||!vision||!scene)return;
  const estimate=hand.update(result,pose,k,vision,now);lastHand=estimate;
  drawHand(estimate.pixels);
  button("touch").hidden=!running||!tableReady||!handEnabled||(hand.metricScale!==null&&!hand.collecting);
  // Calibration can start as soon as landmarks exist, even if the current 3D pose is rejected.
  button("touch").disabled=estimate.pixels.length!==21||hand.collecting;
  button("touch").textContent=hand.collecting?"Настройка касания…":hand.metricScale===null?"Настроить касание":"Повторить касание";
  if(estimate.points)lastAction=scene.hand(estimate.points,estimate.calibrated,performance.now(),estimate.pinch);
  else{scene.loseHand();lastAction={action:"idle",reason:estimate.reason,target:null};}
  const state=hand.status;
  if(state!==lastStatus){
    lastStatus=state;record("calibration-state",{state,scale:hand.metricScale});
    if(state==="calibrated"){
      const prompt="Касание настроено. Коснитесь кубика или мяча.";notice(prompt);
      setTimeout(()=>{if(el("notice").textContent===prompt)notice("");},3000);
    }
    if(state==="insufficient-stable-samples")notice("Касание не сохранено. Покажите кисть целиком и повторите, удерживая палец на столе.");
  }
  if(estimate.calibrated){
    if(lastAction?.action==="grab")outcome(`Захвачен ${lastAction.target?.startsWith("ball")?"мяч":"кубик"}`);
    else if(lastAction?.action==="release")outcome("Отпущено");
    else if(lastAction?.action==="touch")outcome("Касание");
    else outcome("");
  }else if(!hand.collecting&&tableReady)notice(estimate.pixels.length?"Коснитесь стола указательным пальцем и нажмите «Настроить касание».":"Покажите кисть целиком над столом.");
  record("hand",{landmarks:result.landmarks,worldLandmarks:result.worldLandmarks,handedness:result.handedness,estimate,interaction:lastAction,calibration:hand.snapshot(),pointerEvents:scene.original.events.slice(-6),physicalContacts:scene.physicalContacts.slice(-8),sourceAgeMs:performance.now()-now,pose,intrinsics:k});
};
const drawHand=(points:Pixel[]):void=>{
  if(points.length!==21)return;ctx.strokeStyle="#b5ffe9";ctx.lineWidth=1.6;
  for(const chain of skeleton){ctx.beginPath();chain.forEach((id,i)=>{const p=points[id]!;if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.stroke();}
  ctx.fillStyle="#ebfff7";for(const p of points){ctx.beginPath();ctx.arc(p.x,p.y,2,0,Math.PI*2);ctx.fill();}
};
const tick=(now:number):void=>{
  if(!running)return;frame=requestAnimationFrame(tick);
  if(!k||!vision||!scene||video.readyState<2||video.currentTime===lastVideo||now-lastFrame<66)return;
  const started=performance.now(),dt=lastFrame?(started-lastFrame)/1000:1/15;lastFrame=started;lastVideo=video.currentTime;
  pixels.drawImage(video,0,0,k.width,k.height);ctx.clearRect(0,0,k.width,k.height);
  try{
    let fit:Fit|null;
    if(anchor()==="aruco"){
      found=vision.detect(pixels.getImageData(0,0,k.width,k.height));fit=map.update(found,vision,k);
      usedIds=fit?.markerIds??[];
      if(map.markers.size!==mapSize){mapSize=map.markers.size;mapChanged=started;record("map-marker-added",{ids:[...map.markers.keys()]});}
      if(!tableReady && mapSize>=2){
        scene.configure(map.markers);
        if(mapSize>=3||started-mapChanged>1800){tableReady=true;map.learning=false;record("table-ready",{map:[...map.markers],layout:scene.layout});notice("Стол привязан. Покажите кисть над столом.");}
      }
      // Before confirmation these outlines communicate only placement, not diagnostics.
      if(!tableReady)for(const m of found){ctx.strokeStyle=map.markers.has(m.id)?"#a4f0d7":"#ffdb9b";ctx.lineWidth=2;ctx.beginPath();m.pixels.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();}
    }else{found=[];usedIds=[];fit=manualFit;manual.forEach(p=>{ctx.fillStyle="#a4f0d7";ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fill();});}
    trackingError=fit?.error??null;
    if(fit && tableReady){
      if(!wasTracking)notice(hand.metricScale===null?"Стол привязан. Покажите кисть над столом.":"");
      wasTracking=true;
      pose=smoothPose(started-lastPose>300?null:pose,fit.pose,dt,.045);scene.pose(pose,k);
      if(hands&&handEnabled)applyHand(hands.detectForVideo(processing,started),started);
      else{scene.loseHand();button("touch").hidden=true;}
      lastPose=performance.now();
    }else if(tableReady && pose && started-lastPose<Math.max(400,Math.min(1000,dt*2200))){
      // A missed detection is not a new table or an immediate screen flash.
      scene.loseHand();
    }else{
      wasTracking=false;pose=null;scene.hide();button("touch").hidden=true;lastAction={action:"idle",reason:tableReady?"table-tracking-lost":"table-calibration-pending",target:null};
      if(tableReady){notice(found.some(m=>map.markers.has(m.id))?"Маркеры видны. Уточняю привязку стола…":"Верните хотя бы один из привязанных маркеров в кадр.");outcome("");}
      else if(anchor()==="aruco")notice(mapSize<2?"Покажите вместе 2–3 разных маркера.":"Подержите телефон спокойно — привязываем стол.");
    }
    record("frame",{observations:found,visibleIds:found.map(m=>m.id),mappedIds:[...map.markers.keys()],mapDecisions:[...map.decisions],usedIds,inliers:fit?.inliers??0,poseMode:fit?.mode??null,poseAgeMs:performance.now()-lastPose,poseError:trackingError,tableReady,trackingState:scene.enabled?(fit?"tracked":"coasting"):tableReady?"lost":"calibrating",processingMs:performance.now()-started,action:lastAction});
  }catch(error){record("processing-error",String(error));stop();notice("Обработка остановилась. Откройте камеру снова; запись проверки сохранена в настройках.");}
};
button("export").onclick=()=>{
  const data={version:3,date:new Date().toISOString(),originalDemo:"startBabylon",intrinsics:k,map:[...map.markers],layout:scene?.layout,calibration:hand.snapshot(),events:trace};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="ar-interaction-trace.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
const markerDialog=el<HTMLDialogElement>("marker-dialog");
button("markers").onclick=()=>{
  if(vision&&!el("marker-sheet").children.length)for(const id of [0,1,2]){const d=document.createElement("div");d.className="marker";const b=document.createElement("b");b.textContent=`ID ${id}`;d.append(vision.marker(id),b);el("marker-sheet").append(d);}
  markerDialog.style.setProperty("--marker-mm",`${Number(input("size").value)*10}mm`);markerDialog.showModal();
};
button("close-markers").onclick=()=>markerDialog.close();button("print").onclick=()=>window.print();
void(async()=>{
  try{
    const [cv,s]=await Promise.all([loadCV(),ARScene.create(el<HTMLCanvasElement>("scene"))]);vision=new Vision(cv);scene=s;layout();
    // Read-only snapshots plus a replay entry point for recorded landmark frames.
    (window as unknown as {canvasIrAR:unknown}).canvasIrAR={scene:s,map,hand,trace,snapshot:()=>({running,pose,intrinsics:k,tableReady,visibleIds:found.map(m=>m.id),usedIds,hand:lastHand,interaction:lastAction,layout:s.layout}),replayHand:(result:HandLandmarkerResult,time:number)=>{ctx.clearRect(0,0,overlay.width,overlay.height);applyHand(result,time);},analyzeHand:async(source:HTMLCanvasElement)=>{await loadHands();if(!hands)throw Error("Hand model unavailable");const now=performance.now(),result=hands.detectForVideo(source,now);ctx.clearRect(0,0,overlay.width,overlay.height);applyHand(result,now);return result;}};
    button("start").disabled=button("markers").disabled=false;notice("");
  }catch(error){record("initialization-error",String(error));notice(`Демо не загрузилось: ${String(error)}`);}
})();
