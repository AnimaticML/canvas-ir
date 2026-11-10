import { type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { intrinsics, project, onTable, rotate, transpose, type Intrinsics, type Pixel, type Pose, type V3 } from "./ar/geometry";
import { MarkerMap, Vision, loadCV, type Fit, type Marker } from "./ar/vision";
import { ARScene, smoothPose, type InteractionResult } from "./ar/scene";
import { TraceBuffer } from "./ar/trace";
import { HandRuntime } from "./ar/hand-runtime";
import { HandTracking, type HandEstimate } from "./ar/hand";

import { compose, correctionPose, defaultCorrection, defaultSizes, fieldCorners, readSettings, sideM, storageKey, validField, validSizes, yaw, type Field, type MarkerSizes } from "./ar/settings";
import { DiagnosticStore, png } from "./ar/diagnostic";
const saved=(()=>{try{return readSettings(localStorage.getItem(storageKey));}catch{return null;}})();
let sizes:MarkerSizes=saved?.sizes??defaultSizes(),mapId=saved?.mapId??crypto.randomUUID(),fieldSettings:Field|null=saved?.map.length?saved.field:null,correction=saved?.correction??defaultCorrection();
const shots=new DiagnosticStore();
let captureRequested=false,captureBusy=false,frameId=0;
type FrameSource={frameId:number;capturedAt:number};
let poseSource:FrameSource|null=null,handSource:FrameSource|null=null;
let currentCapture:{frameId:number;capturedAt:number;capturedAtEpochMs:number;mediaTimeSeconds:number}|null=null;
let configured=false;
let handPoseSource:FrameSource|null=null,handAppliedPose:Pose|null=null,poseQuality:unknown=null;
let rawPose:Pose|null=null,planePose:Pose|null=null,lastHandResult:HandLandmarkerResult|null=null;
const persist=():void=>{try{localStorage.setItem(storageKey,JSON.stringify({version:1,sizes,mapId,map:[...map.markers],field:map.markers.size?fieldSettings:null,correction}));}catch{notice("Настройки не сохранены: хранилище браузера недоступно.");}};
const el=<T extends HTMLElement=HTMLElement>(id:string):T=>document.getElementById(id) as T;
const button=(id:string):HTMLButtonElement=>el<HTMLButtonElement>(id);
const input=(id:string):HTMLInputElement=>el<HTMLInputElement>(id);
const anchor=():string=>el<HTMLSelectElement>("anchor").value;
const notice=(message:string):void=>{el("notice").textContent=message;};
const video=el<HTMLVideoElement>("video"),overlay=el<HTMLCanvasElement>("overlay"),ctx=overlay.getContext("2d")!;
// Keep the model snapshot off the CPU-readback canvas. Both detectors still
// consume exactly the same camera snapshot, not two independently advancing frames.
const modelFrame=document.createElement("canvas"),modelPixels=modelFrame.getContext("2d")!;
const processing=document.createElement("canvas"),pixels=processing.getContext("2d",{willReadFrequently:true})!;
const map=new MarkerMap(sizes.defaultCm/100,Object.fromEntries(Object.entries(sizes.byId).map(([id,cm])=>[id,cm/100]))),hand=new HandTracking();
if(saved)for(const [id,q] of saved.map)map.markers.set(id,q);
input("size").value=String(sizes.defaultCm);
let vision:Vision|null=null,scene:ARScene|null=null;
let stream:MediaStream|null=null,running=false,starting=false,generation=0,frame=0,handEnabled=true;
let k:Intrinsics|null=null,pose:Pose|null=null,lastFrame=0,lastVideo=-1,lastPose=0,lastHandInference=0;
let manual:Pixel[]=[],manualFit:Fit|null=null,tableReady=false,mapChanged=0,mapSize=0;
let wasTracking=false;
let lastHand:HandEstimate|null=null,lastAction:InteractionResult|null=null,lastStatus="",lastOutcome="";
let found:Marker[]=[],usedIds:number[]=[],trackingError:number|null=null;
const journal=new TraceBuffer(),trace=journal.recent;
const record=(kind:string,data:unknown):void=>journal.append(kind,data);
const hands=new HandRuntime((kind,data)=>{record(kind,data);const state=hands.snapshot();el("hand-backend").textContent=kind==="hands-gpu-fallback"?"GPU недоступен — включаю CPU…":kind==="hands-load-error"?"Руки недоступны":state.active?`Руки: ${state.active}${state.fallbackReason?" · GPU недоступен":""}`:"Загрузка рук…";});
const skeleton=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
const outcome=(message:string):void=>{if(message===lastOutcome)return;lastOutcome=message;el("outcome").textContent=message;el("outcome").hidden=!message;};
const reset=(full=true):void=>{
  if(full){mapId=crypto.randomUUID();fieldSettings=null;correction=defaultCorrection();map.reset(sizes.defaultCm/100);persist();}
  configured=false;poseQuality=null;handPoseSource=null;handAppliedPose=null;poseSource=null;handSource=null;rawPose=null;planePose=null;lastHandResult=null;
  if(scene)scene.editing=false;el("field-editor").hidden=true;
  wasTracking=false;hand.reset();pose=null;manual=[];manualFit=null;tableReady=false;mapSize=0;mapChanged=0;lastPose=0;lastHand=null;lastStatus="";
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
  running=false;starting=false;captureRequested=false;generation++;cancelAnimationFrame(frame);
  stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;scene?.hide();pose=null;lastHand=null;
  ctx.clearRect(0,0,overlay.width,overlay.height);el("welcome").hidden=false;button("touch").hidden=true;
  button("capture").disabled=true;button("start").disabled=!scene||!vision;outcome("");record("camera-stop",{});
};
const loadHands=():Promise<void>=>hands.load().catch(()=>{notice("Не удалось загрузить руки. Повторите включение в настройках.");});
button("start").onclick=async()=>{
  if(running||starting)return;
  if(!navigator.mediaDevices?.getUserMedia){notice("Для камеры откройте страницу через HTTPS.");return;}
  starting=true;const token=++generation;button("start").disabled=true;
  try{
    const incoming=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});
    if(token!==generation){incoming.getTracks().forEach(t=>t.stop());return;}
    stream=incoming;video.srcObject=incoming;await video.play();if(token!==generation)return;
    dimensions();running=true;starting=false;lastFrame=0;lastVideo=-1;lastHandInference=0;reset(false);layout();el("welcome").hidden=true;
    button("capture").disabled=false;frame=requestAnimationFrame(tick);if(handEnabled)void loadHands();
    incoming.getVideoTracks()[0]!.addEventListener("ended",()=>{if(stream===incoming){stop();notice("Камера отключена. Откройте её снова.");}});
    record("camera-start",{width:video.videoWidth,height:video.videoHeight});
  }catch(error){if(token===generation){stop();notice(`Камера не открылась: ${String(error)}`);record("camera-error",String(error));}}
};
const dimensions=():void=>{const factor=Math.min(1,800/video.videoWidth),width=Math.round(video.videoWidth*factor),height=Math.round(video.videoHeight*factor);if(!width||!height)throw Error("Нет кадра камеры");overlay.width=processing.width=modelFrame.width=width;overlay.height=processing.height=modelFrame.height=height;k=intrinsics(width,height,Number(input("fov").value));};
video.addEventListener("resize",()=>{if(!running)return;const ratio=video.videoWidth/video.videoHeight;if(k&&Math.abs(k.width/k.height-ratio)<.005)return;dimensions();reset(false);layout();});
document.addEventListener("visibilitychange",()=>{if(document.hidden&&(running||starting)){stop();notice("Камера остановлена. Откройте её снова.");}});
window.addEventListener("pagehide",()=>{stop();hands.close();vision?.dispose();scene?.dispose();});
button("stop").onclick=()=>{stop();el<HTMLDialogElement>("settings").close();notice("");};
button("menu").onclick=()=>el<HTMLDialogElement>("settings").showModal();
button("close-settings").onclick=()=>el<HTMLDialogElement>("settings").close();
button("recalibrate").onclick=()=>{reset();el<HTMLDialogElement>("settings").close();};
button("reset-objects").onclick=()=>{scene?.resetObjects();el<HTMLDialogElement>("settings").close();};
button("hands").onclick=async()=>{handEnabled=!handEnabled;button("hands").textContent=handEnabled?"Выключить руки":"Включить руки";if(handEnabled)await loadHands();else{scene?.loseHand(true);lastHand=null;}button("touch").hidden=!handEnabled||!running||!tableReady;};
const updateSizes=():void=>{map.sizesById=Object.fromEntries(Object.entries(sizes.byId).map(([id,cm])=>[id,cm/100]));reset();showSizes();record("marker-sizes-changed",{sizes});};
input("marker-id").oninput=()=>{if(input("marker-id").checkValidity())input("marker-size").value=String(sideM(sizes,+input("marker-id").value)*100);};
const showSizes=():void=>{el("marker-sizes").textContent=Object.entries(sizes.byId).map(([id,cm])=>`ID ${id}: ${cm} см`).join(" · ")||"Для всех ID используется общий размер";};showSizes();
input("size").onchange=()=>{const next={...sizes,defaultCm:Number(input("size").value)};if(!validSizes(next)){input("size").value=String(sizes.defaultCm);return;}sizes=next;updateSizes();};
button("save-marker-size").onclick=()=>{if(!input("marker-id").checkValidity()||!input("marker-size").checkValidity())return;const next={...sizes,byId:{...sizes.byId,[input("marker-id").value]:Number(input("marker-size").value)}};if(!validSizes(next))return;sizes=next;updateSizes();};
button("remove-marker-size").onclick=()=>{if(!input("marker-id").checkValidity())return;delete sizes.byId[input("marker-id").value];updateSizes();};
input("fov").onchange=()=>{if(!input("fov").checkValidity())input("fov").value="60";if(k)k=intrinsics(k.width,k.height,Number(input("fov").value));reset(false);};
el<HTMLSelectElement>("anchor").onchange=()=>reset();
const calibrate=():void=>{journal.pinFor(6500);hand.calibrate(performance.now());lastStatus="";button("touch").hidden=false;notice("Держите указательный палец на столе около секунды.");record("calibration-start",{});};
button("touch").onclick=calibrate;
button("recalibrate-hand").onclick=()=>{el<HTMLDialogElement>("settings").close();if(running&&tableReady&&!scene?.editing)calibrate();};
overlay.addEventListener("pointerdown",event=>{
  if(!running||!k||!vision||anchor()!=="manual"||manual.length>=4)return;
  const r=overlay.getBoundingClientRect();manual.push({x:(event.clientX-r.left)*k.width/r.width,y:(event.clientY-r.top)*k.height/r.height});
  if(manual.length===4){
    const corners:V3[]=[[-.3,0,-.2],[.3,0,-.2],[.3,0,.2],[-.3,0,.2]];
    const fit=vision.fit(corners,manual,k);
    if(fit&&fit.error<8){manualFit=fit;scene?.configure(new Map([[0,corners]]));scene?.setField({width:.6,depth:.4,x:0,z:0,angle:0});if(scene){fieldSettings=scene.field;}tableReady=true;configured=true;}
    else{manual=[];notice("Выберите четыре угла прямоугольника по порядку ещё раз.");}
  }
});
const applyHand=(result:HandLandmarkerResult,now:number):void=>{
  if(!pose||!k||!vision||!scene)return;
  handPoseSource=poseSource?{...poseSource}:null;handAppliedPose=structuredClone(pose);lastHandResult=structuredClone(result);handSource=currentCapture?{frameId:currentCapture.frameId,capturedAt:currentCapture.capturedAt}:null;
  const estimate=hand.update(result,pose,k,vision,now);lastHand=estimate;
  drawHand(estimate.pixels);
  button("touch").hidden=!running||!tableReady||!handEnabled||(hand.metricScale!==null&&!hand.collecting);
  // Calibration can start as soon as landmarks exist, even if the current 3D pose is rejected.
  button("touch").disabled=estimate.pixels.length!==21||hand.collecting;
  button("touch").textContent=hand.collecting?"Настройка касания…":hand.metricScale===null?"Настроить касание":"Повторить касание";
  if(scene.editing){scene.loseHand(true);lastAction={action:"idle",reason:"field-editing",target:null};}
  else if(estimate.points)lastAction=scene.hand(estimate.points,estimate.calibrated,performance.now(),estimate.pinch);
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
  record("hand",{landmarks:result.landmarks,worldLandmarks:result.worldLandmarks,handedness:result.handedness,estimate,interaction:lastAction,calibration:hand.snapshot(),pointerEvents:scene.original.events.slice(-6),physicalContacts:scene.physicalContacts.slice(-8),sharedHands:{states:scene.original.hands.states,options:scene.original.hands.options},sourceAgeMs:performance.now()-now,source:handSource,poseSource,pose,intrinsics:k});
};
const drawHand=(points:Pixel[]):void=>{
  if(points.length!==21)return;ctx.strokeStyle="#b5ffe9";ctx.lineWidth=1.6;
  for(const chain of skeleton){ctx.beginPath();chain.forEach((id,i)=>{const p=points[id]!;if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.stroke();}
  ctx.fillStyle="#ebfff7";for(const p of points){ctx.beginPath();ctx.arc(p.x,p.y,2,0,Math.PI*2);ctx.fill();}
};
const drawMarkerStates=():void=>{
  ctx.font="15px system-ui";ctx.lineWidth=2;
  const origin=map.markers.keys().next().value;
  for(const marker of found){
    const used=usedIds.includes(marker.id),known=map.markers.has(marker.id);
    const decision=map.decisions.get(marker.id) as {reason?:string;samples?:number}|undefined;
    const rejected=decision?.reason==="inconsistent-marker-size"||known&&!used;
    const status=used?"в работе":known?(decision?.reason==="pose-outlier"?"не совпадает с картой":"поза не подтверждена"):decision?.reason==="inconsistent-marker-size"?"размер/геометрия не совпали":decision?.reason==="no-known-marker-overlap"?"покажите с привязанным кодом":decision?.reason==="layout-unstable"?"уточняю положение":`добавляю ${Math.min(8,decision?.samples??0)}/8`;
    const label=`ID ${marker.id}${marker.id===origin?" · начало":""} · ${status}`;
    ctx.strokeStyle=used?"#72f2b5":rejected?"#ffae9c":"#ffe298";
    ctx.beginPath();marker.pixels.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();
    const x=Math.max(3,Math.min(overlay.width-ctx.measureText(label).width-9,marker.pixels[0]!.x));
    const y=Math.max(22,marker.pixels[0]!.y-8);
    ctx.fillStyle="#102029e8";ctx.fillRect(x-3,y-18,ctx.measureText(label).width+8,24);
    ctx.fillStyle=ctx.strokeStyle;ctx.fillText(label,x,y);
  }
};
const tick=(now:number):void=>{
  if(!running)return;frame=requestAnimationFrame(tick);
  if(!k||!vision||!scene||video.readyState<2||video.currentTime===lastVideo||now-lastFrame<33)return;
  const started=performance.now(),dt=lastFrame?(started-lastFrame)/1000:1/15;lastFrame=started;lastVideo=video.currentTime;
  currentCapture={frameId:++frameId,capturedAt:performance.now(),capturedAtEpochMs:0,mediaTimeSeconds:video.currentTime};currentCapture.capturedAtEpochMs=performance.timeOrigin+currentCapture.capturedAt;
  const timing={snapshotMs:0,arucoMs:0,poseMs:0,handModelMs:0,handGeometryMs:0};
  const gpuInput=hands.active==="GPU"&&handEnabled;
  if(gpuInput){modelPixels.drawImage(video,0,0,k.width,k.height);pixels.drawImage(modelFrame,0,0,k.width,k.height);}
  else pixels.drawImage(video,0,0,k.width,k.height);
  ctx.clearRect(0,0,k.width,k.height);
  timing.snapshotMs=performance.now()-started;
  try{
    let fit:Fit|null;
    if(anchor()==="aruco"){
      const detectionStart=performance.now();found=vision.detect(pixels.getImageData(0,0,k.width,k.height));timing.arucoMs=performance.now()-detectionStart;
      const poseStart=performance.now();fit=map.update(found,vision,k);timing.poseMs=performance.now()-poseStart;
      usedIds=fit?.markerIds??[];
      if(map.markers.size!==mapSize){mapSize=map.markers.size;mapChanged=started;record("map-marker-added",{ids:[...map.markers.keys()],mapId});persist();}
      if(!tableReady && mapSize>=2){
        if(!configured){scene.configure(map.markers);if(fieldSettings)scene.setField(fieldSettings);configured=true;}
        if(mapSize>=3||started-mapChanged>1800){tableReady=true;fieldSettings=scene.field;persist();record("table-ready",{map:[...map.markers],layout:scene.layout});notice("Стол привязан. Покажите кисть над столом.");}
      }
      drawMarkerStates();
    }else{found=[];usedIds=[];fit=manualFit;manual.forEach(p=>{ctx.fillStyle="#a4f0d7";ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fill();});}
    trackingError=fit?.error??null;
    if(fit && tableReady){
      if(!wasTracking)notice(hand.metricScale===null?"Стол привязан. Покажите кисть над столом.":"");
      wasTracking=true;
      poseQuality={error:fit.error,inliers:fit.inliers,mode:fit.mode,markerIds:fit.markerIds,observations:structuredClone(found)};rawPose=fit.pose;planePose=smoothPose(started-lastPose>300?null:planePose,fit.pose,dt,.045);pose=compose(planePose,correctionPose(correction));poseSource={frameId:currentCapture.frameId,capturedAt:currentCapture.capturedAt};scene.pose(pose,k);
      if(hands.active&&handEnabled&&!scene.editing){
        const interval=hands.active==="GPU"?50:83;
        if(started-lastHandInference>=interval){
          lastHandInference=started;const modelStart=performance.now();const result=hands.detect(gpuInput?modelFrame:processing,started);timing.handModelMs=performance.now()-modelStart;
          const geometryStart=performance.now();if(result)applyHand(result,started);else scene.loseHand();timing.handGeometryMs=performance.now()-geometryStart;
        }else if(lastHand)drawHand(lastHand.pixels);
      }
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
    if(scene.editing)drawPlane();
    const frameData={capture:{...currentCapture},processedAt:performance.now(),rawFit:fit,poseSource,handSource,observations:found,visibleIds:found.map(m=>m.id),mappedIds:[...map.markers.keys()],mapDecisions:[...map.decisions],usedIds,inliers:fit?.inliers??0,poseMode:fit?.mode??null,poseAgeMs:poseSource?performance.now()-poseSource.capturedAt:null,poseError:trackingError,tableReady,trackingState:scene.enabled?(fit?"tracked":"coasting"):tableReady?"lost":"calibrating",processingMs:performance.now()-started,timing,trackingIntervalMs:dt*1000,handRuntime:hands.snapshot(),render:{fps:scene.engine.getFps(),width:scene.engine.getRenderWidth(),height:scene.engine.getRenderHeight()},action:lastAction,sceneInteraction:scene.result};record("frame",frameData);
    if(captureRequested&&!captureBusy){captureRequested=false;void captureDiagnostic(frameData);}
  }catch(error){record("processing-error",String(error));stop();notice("Обработка остановилась. Откройте камеру снова; запись проверки сохранена в настройках.");}
};
const traceData=()=>({version:5,date:new Date().toISOString(),originalDemo:"startBabylon",interactionInput:{implementation:"BabylonRuntime.hands",options:scene?.original.hands.options},visionRuntime:{backend:"WASM/CPU",gpu:false},markerSideCm:map.size*100,markerSizes:sizes,mapId,field:fieldSettings,correction,handRuntime:hands.snapshot(),intrinsics:k,map:[...map.markers],layout:scene?.layout,calibration:hand.snapshot(),diagnosticFrames:shots.shots.map(s=>({id:s.id,...s.data})),events:journal.export()});
const download=(data:BlobPart,type:string,name:string):void=>{const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
button("export").onclick=()=>download(JSON.stringify(traceData()),"application/json","ar-interaction-trace.json");
button("capture").onclick=()=>{if(!running||captureBusy)return;captureRequested=true;el("capture-status").textContent="Захват следующего кадра камеры…";};
button("export-zip").onclick=()=>{const data=shots.export(traceData());download(data.buffer as ArrayBuffer,"application/zip","ar-diagnostics.zip");};
button("clear-shots").onclick=()=>{shots.shots.length=0;button("export-zip").textContent="Скачать ZIP со снимками (0)";el("capture-status").textContent="Снимки удалены из памяти";};
const captureDiagnostic=async(frameData:unknown):Promise<void>=>{
  if(!scene||!k||!currentCapture)return;captureBusy=true;button("capture").disabled=true;
  try{
    const capture={...currentCapture},id=`frame-${capture.frameId}`,composite=document.createElement("canvas");composite.width=k.width;composite.height=k.height;const c=composite.getContext("2d")!;
    // Copy all pixels synchronously, before any await or next camera snapshot.
    const raw=png(processing);c.drawImage(processing,0,0);const renderedAt=performance.now();
    if(scene.enabled)c.drawImage(scene.diagnosticImage(),0,0,k.width,k.height);
    // Diagnostic overlay is always explicit, even outside the field editor.
    ctx.save();drawPlane();drawMarkerStates();if(lastHand)drawHand(lastHand.pixels);ctx.restore();c.drawImage(overlay,0,0);
    const overlays=png(composite),age=(source:typeof poseSource)=>source?{...source,ageAtCaptureMs:capture.capturedAt-source.capturedAt,ageAtRenderMs:renderedAt-source.capturedAt}:null;
    const data=structuredClone({capture:{...capture,timestampMeaning:"sampled immediately before video drawImage; not sensor exposure timestamp",image:{width:k.width,height:k.height},video:{width:video.videoWidth,height:video.videoHeight},cameraSettings:stream?.getVideoTracks()[0]?.getSettings(),intrinsics:k,distortion:{model:"zero-assumed",calibrated:false}},estimates:{table:age(poseSource),hand:age(handSource)},render:{renderedAt,physicsSteppedForSnapshot:false,sceneVisible:scene.enabled,sceneStateAt:performance.now(),things:[...scene.original.things.values()].map(t=>({id:t.mesh.name,position:scene!.table(t.mesh.position),rotation:t.mesh.rotationQuaternion?.asArray(),velocity:t.body.body.getLinearVelocity().asArray()}))},table:{rawPose,smoothedPose:planePose,appliedPose:pose,qualityAtPoseSource:poseQuality,currentFrameError:trackingError,usedIds,observations:found,decisions:[...map.decisions],mapId,map:[...map.markers]},markerSizes:sizes,field:fieldSettings,correction,hand:{source:handSource,model:lastHandResult,estimate:lastHand,projectionOnPlane:lastHand?.pixels[8]&&handAppliedPose?onTable(handAppliedPose,k,lastHand.pixels[8]):null,depthMethod:lastHand?.method??"none",calibration:hand.snapshot(),runtime:hands.snapshot(),poseSource:handPoseSource,appliedPose:handAppliedPose},interaction:{sharedHands:{states:scene.original.hands.states,options:scene.original.hands.options},state:scene.result,handDecision:lastAction,holding:scene.holding,editing:scene.editing,pointerEvents:scene.original.events.slice(-6),physicalContacts:scene.physicalContacts.slice(-8)},processing:frameData});
    const [rawBytes,compositeBytes]=await Promise.all([raw,overlays]);shots.add({id,data,raw:rawBytes,composite:compositeBytes});button("export-zip").textContent=`Скачать ZIP со снимками (${shots.shots.length})`;el("capture-status").textContent=`Кадр ${capture.frameId} сохранён локально. Изображения камеры: ${(shots.bytes/1048576).toFixed(1)} МБ. Скачайте ZIP.`;record("diagnostic-captured",{id,capture});
  }catch(error){el("capture-status").textContent=`Снимок не сохранён: ${String(error)}`;}finally{captureBusy=false;button("capture").disabled=!running;}
};
const syncFieldInputs=():void=>{if(!fieldSettings)return;input("tilt-enabled").checked=correction.enabled;input("tilt-pitch").value=String(correction.pitch);input("tilt-roll").value=String(correction.roll);};
const applyField=(f:Field):void=>{if(!scene||!validField(f))return;fieldSettings={...f};scene.setField(f);syncFieldInputs();if(pose&&k)scene.pose(pose,k);persist();record("field-changed",{mapId,field:f});};
button("edit-field").onclick=()=>{if(!scene||!tableReady){notice("Сначала привяжите плоскость стола.");return;}scene.editing=true;scene.loseHand(true);lastAction={action:"idle",reason:"field-editing",target:null};outcome("");fieldSettings=scene.field;syncFieldInputs();el("field-editor").hidden=false;button("touch").hidden=true;el<HTMLDialogElement>("settings").close();};
button("finish-field").onclick=()=>{if(scene)scene.editing=false;el("field-editor").hidden=true;persist();};

const updateTilt=():void=>{const pitch=+input("tilt-pitch").value,roll=+input("tilt-roll").value;if(![pitch,roll].every(v=>Number.isFinite(v)&&Math.abs(v)<=30))return;correction={enabled:input("tilt-enabled").checked,pitch,roll};hand.reset();lastHand=null;lastHandResult=null;handSource=null;handPoseSource=null;handAppliedPose=null;scene?.loseHand(true);if(planePose&&k){pose=compose(planePose,correctionPose(correction));scene?.pose(pose,k);}persist();record("plane-correction",correction);};
for(const id of ["tilt-enabled","tilt-pitch","tilt-roll"])input(id).onchange=updateTilt;
button("reset-tilt").onclick=()=>{correction=defaultCorrection();syncFieldInputs();updateTilt();};
type Handle="move"|"width"|"depth"|"rotate";
const handles=():{kind:Handle;p:V3}[]=>{if(!fieldSettings)return [];const f=fieldSettings,r=yaw(f.angle),at=(p:V3):V3=>{const q=rotate(r,p);return [q[0]+f.x,0,q[2]+f.z];};return [{kind:"move",p:at([0,0,0])},{kind:"width",p:at([f.width/2,0,0])},{kind:"depth",p:at([0,0,f.depth/2])},{kind:"rotate",p:at([0,0,-f.depth/2-.05])}];};
const drawPlane=():void=>{
  if(!pose||!planePose||!k||!fieldSettings)return;
  const line=(a:V3,b:V3,color:string,p=pose!):void=>{const x=project(p,k!,a),y=project(p,k!,b);if(![x.x,x.y,y.x,y.y].every(Number.isFinite))return;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x.x,x.y);ctx.lineTo(y.x,y.y);ctx.stroke();};
  ctx.save();ctx.lineWidth=1;const f=fieldSettings,reach=Math.min(3,Math.max(f.width,f.depth,Math.abs(f.x)*2,Math.abs(f.z)*2,.5));
  if(correction.enabled){ctx.setLineDash([5,5]);for(let n=-reach;n<=reach;n+=.05){line([n,0,-reach],[n,0,reach],"#ffb5bd60",planePose);line([-reach,0,n],[reach,0,n],"#ffb5bd60",planePose);}ctx.setLineDash([]);}
  for(let n=-reach;n<=reach;n+=.05){line([n,0,-reach],[n,0,reach],"#b5ffe94f");line([-reach,0,n],[reach,0,n],"#b5ffe94f");}
  ctx.lineWidth=3;line([0,0,0],[.15,0,0],"#ff766f");line([0,0,0],[0,0,.15],"#6fbcff");line([0,0,0],[0,.1,0],"#72f2b5");
  const corners=fieldCorners(f);corners.forEach((p,i)=>line(p,corners[(i+1)%4]!,"#ffe17e"));
  // Measured map stays in the uncorrected marker plane.
  for(const [id,q] of map.markers){q.forEach((p,i)=>line(p,q[(i+1)%4]!,"#ffa9ff",planePose!));const p=project(planePose,k,q[0]!);ctx.fillStyle="#ffa9ff";ctx.fillText(`ID ${id}`,p.x,p.y);}
  if(scene?.editing)for(const h of handles()){const p=project(pose,k,h.p);ctx.fillStyle="#ffe17e";ctx.beginPath();ctx.arc(p.x,p.y,12,0,Math.PI*2);ctx.fill();ctx.fillStyle="#102029";ctx.font="13px system-ui";ctx.fillText(({move:"↔",width:"Ш",depth:"Г",rotate:"↻"})[h.kind],p.x-5,p.y+5);}
  ctx.restore();
};
let drag:{id:number;kind:Handle;start:V3;field:Field}|null=null;
const eventPixel=(e:PointerEvent):Pixel=>{const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)*overlay.width/r.width,y:(e.clientY-r.top)*overlay.height/r.height};};
overlay.addEventListener("pointerdown",e=>{if(drag||!scene?.editing||!pose||!k||!fieldSettings)return;const pixel=eventPixel(e),point=onTable(pose,k,pixel);if(!point)return;const best=handles().map(h=>({...h,pixel:project(pose!,k!,h.p)})).sort((a,b)=>Math.hypot(a.pixel.x-pixel.x,a.pixel.y-pixel.y)-Math.hypot(b.pixel.x-pixel.x,b.pixel.y-pixel.y))[0];const radius=32*overlay.width/overlay.getBoundingClientRect().width;if(!best||Math.hypot(best.pixel.x-pixel.x,best.pixel.y-pixel.y)>radius)return;drag={id:e.pointerId,kind:best.kind,start:point,field:{...fieldSettings}};overlay.setPointerCapture(e.pointerId);});
overlay.addEventListener("pointermove",e=>{if(!drag||drag.id!==e.pointerId||!pose||!k)return;const q=onTable(pose,k,eventPixel(e));if(!q)return;const f={...drag.field};if(drag.kind==="move"){f.x+=q[0]-drag.start[0];f.z+=q[2]-drag.start[2];}else if(drag.kind==="rotate"){f.angle+=(Math.atan2(q[2]-f.z,q[0]-f.x)-Math.atan2(drag.start[2]-f.z,drag.start[0]-f.x))*180/Math.PI;f.angle=((f.angle+540)%360)-180;}else{const local=rotate(transpose(yaw(f.angle)),[q[0]-f.x,0,q[2]-f.z]);if(drag.kind==="width")f.width=Math.max(.1,Math.min(3,Math.abs(local[0])*2));else f.depth=Math.max(.1,Math.min(3,Math.abs(local[2])*2));}applyField(f);});
for(const type of ["pointerup","pointercancel","lostpointercapture"])overlay.addEventListener(type,()=>{drag=null;});
const markerDialog=el<HTMLDialogElement>("marker-dialog");
button("markers").onclick=()=>{
  el("marker-sheet").replaceChildren();
  if(vision)for(const id of [...new Set([0,1,2,...Object.keys(sizes.byId).map(Number)])].sort((a,b)=>a-b)){const d=document.createElement("div");d.className="marker";const b=document.createElement("b");b.textContent=`ID ${id} · ${sideM(sizes,id)*100} см`;d.style.setProperty("--marker-mm",`${sideM(sizes,id)*1000}mm`);d.append(vision.marker(id),b);el("marker-sheet").append(d);}
  markerDialog.style.setProperty("--marker-mm",`${Number(input("size").value)*10}mm`);markerDialog.showModal();
};
button("close-markers").onclick=()=>markerDialog.close();button("print").onclick=()=>window.print();
void(async()=>{
  try{
    const [cv,s]=await Promise.all([loadCV(),ARScene.create(el<HTMLCanvasElement>("scene"))]);vision=new Vision(cv);scene=s;layout();
    // Read-only snapshots plus a replay entry point for recorded landmark frames.
    (window as unknown as {canvasIrAR:unknown}).canvasIrAR={scene:s,map,hand,trace,shots,traceData,editField:applyField,settings:()=>({sizes,mapId,field:fieldSettings,correction}),snapshot:()=>({running,pose,intrinsics:k,tableReady,visibleIds:found.map(m=>m.id),usedIds,hand:lastHand,interaction:lastAction,layout:s.layout,handRuntime:hands.snapshot()}),replayHand:(result:HandLandmarkerResult,time:number)=>{ctx.clearRect(0,0,overlay.width,overlay.height);applyHand(result,time);},analyzeHand:async(source:HTMLCanvasElement)=>{await loadHands();if(!hands.active)throw Error("Hand model unavailable");const now=performance.now(),result=hands.detect(source,now);if(!result)throw Error("Hand backend is switching to CPU");ctx.clearRect(0,0,overlay.width,overlay.height);applyHand(result,now);return result;}};
    button("start").disabled=button("markers").disabled=false;notice("");
  }catch(error){record("initialization-error",String(error));notice(`Демо не загрузилось: ${String(error)}`);}
})();
