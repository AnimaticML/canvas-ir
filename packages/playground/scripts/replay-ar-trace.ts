// Reconstruct recorded hand/calibration decisions locally, without camera images.
// bun packages/playground/scripts/replay-ar-trace.ts trace.json --marker-cm=3
// User recordings are inputs, never bundled into the app or committed as fixtures.
import cv from "@techstark/opencv-js";
import { Vision, MarkerMap } from "../src/ar/vision";
import { HandTracking } from "../src/ar/hand";
import { length, sub, median, type Pose, type V3 } from "../src/ar/geometry";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
const path=process.argv[2];if(!path)throw Error("Supply a local ar-interaction-trace.json path");
const data=await Bun.file(path).json();
const cmArg=process.argv.find(s=>s.startsWith("--marker-cm="));
const root=data.map?.[0]?.[1] as V3[]|undefined;
const recordedCm=data.markerSideCm??(root?length(sub(root[1]!,root[0]!))*100:null);
if(!recordedCm)throw Error("Trace has no marker size");
const markerCm=cmArg?Number(cmArg.split("=")[1]):recordedCm;
if(!Number.isFinite(markerCm)||markerCm<=0)throw Error("Invalid marker size");
const ratio=markerCm/recordedCm,vision=new Vision(await (cv as unknown)),hand=new HandTracking();
const reasons:Record<string,number>={},attempts:{start:number;frames:number;status:string;scale:number|null;completedAt:number|null}[]=[];
let current:typeof attempts[number]|null=null,detected=0,accepted=0;
const errors:number[]=[],ages:number[]=[];
const rebuild=process.argv.includes("--rebuild-map"),replayedMap=new MarkerMap(markerCm/100);
const poses:{time:number;pose:Pose|null}[]=[];
if(rebuild){
  for(const [id,corners] of data.map as [number,V3[]][])replayedMap.markers.set(id,corners.map(p=>p.map(v=>v*ratio) as V3));
  for(const event of data.events)if(event.kind==="frame"){
    const fit=replayedMap.update(event.data.observations??[],vision,data.intrinsics);poses.push({time:event.time,pose:fit?.pose??null});
  }
}
try{
  for(const event of data.events){
    if(event.kind==="calibration-start"){
      current={start:event.time,frames:0,status:"collecting",scale:null,completedAt:null};attempts.push(current);hand.calibrate(event.time);
    }
    if(event.kind!=="hand")continue;
    const d=event.data;
    const pose:Pose|null=rebuild?poses.find(p=>p.time>=event.time&&p.time-event.time<30)?.pose??null:{r:d.pose.r,t:d.pose.t.map((v:number)=>v*ratio) as V3};
    if(!pose){reasons["no-table-pose"]=(reasons["no-table-pose"]??0)+1;continue;}
    const sourceTime=event.time-(d.sourceAgeMs??0);
    const estimate=hand.update(d as HandLandmarkerResult,pose,d.intrinsics,vision,sourceTime);
    reasons[estimate.reason]=(reasons[estimate.reason]??0)+1;
    if(d.landmarks[0])detected++;if(estimate.points)accepted++;if(estimate.error!==null)errors.push(estimate.error);ages.push(d.sourceAgeMs??0);
    if(current){current.frames++;current.status=hand.status;current.scale=hand.metricScale;if(hand.status==="calibrated"&&current.completedAt===null)current.completedAt=sourceTime;}
  }
  console.log(JSON.stringify({recordedMarkerCm:recordedCm,replayedMarkerCm:markerCm,rebuildMap:rebuild,replayedMapIds:rebuild?[...replayedMap.markers.keys()]:undefined,mapDecisions:rebuild?[...replayedMap.decisions]:undefined,detectedHandFrames:detected,acceptedGeometryFrames:accepted,reasons,medianReprojectionPx:median(errors),medianSourceAgeMs:median(ages),attempts:attempts.map(a=>({...a,durationToSuccessMs:a.completedAt===null?null:Math.round(a.completedAt-a.start)}))},null,2));
}finally{vision.dispose();}
