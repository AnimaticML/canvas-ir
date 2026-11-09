import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { median, onTable, project, scale, toCamera, toTable, type Intrinsics, type Pixel, type Pose, type V3 } from "./geometry";
import type { Vision } from "./vision";

export const handReprojectionLimit=(k:Intrinsics):number=>Math.max(14,Math.max(k.width,k.height)*.03);

export interface HandEstimate {
  points: V3[] | null; pixels: Pixel[]; pinch: number; calibrated: boolean;
  reason: string; error: number|null; errorLimit?: number; method: string; rawHeightM?: number; scale?: number;
}
// worldLandmarks are already camera-oriented. Estimate translation while keeping
// that orientation; free PnP can flip/rotate a nearly planar palm to fit model noise.
export const translatedHand = (shape: V3[], pixels: Pixel[], k: Intrinsics): { pose: Pose; error: number } | null => {
  const n=Array.from({length:3},()=>[0,0,0]), b=[0,0,0];
  const accumulate=(a:V3,value:number):void=>{for(let i=0;i<3;i++){b[i]!+=a[i]!*value;for(let j=0;j<3;j++)n[i]![j]!+=a[i]!*a[j]!;}};
  for(let i=0;i<shape.length;i++){
    const [x,y,z]=shape[i]!,p=pixels[i]!,u=(p.x-k.cx)/k.fx,v=(p.y-k.cy)/k.fy;
    accumulate([1,0,-u],u*z-x);accumulate([0,1,-v],v*z-y);
  }
  const a=n.map((row,i)=>[...row,b[i]!]);
  for(let col=0;col<3;col++){
    let pivot=col;for(let j=col+1;j<3;j++)if(Math.abs(a[j]![col]!)>Math.abs(a[pivot]![col]!))pivot=j;
    [a[col],a[pivot]]=[a[pivot]!,a[col]!]; const d=a[col]![col]!; if(Math.abs(d)<1e-9)return null;
    for(let j=col;j<4;j++)a[col]![j]!/=d;
    for(let i=0;i<3;i++)if(i!==col){const f=a[i]![col]!;for(let j=col;j<4;j++)a[i]![j]!-=f*a[col]![j]!;}
  }
  const pose:Pose={r:[1,0,0,0,1,0,0,0,1],t:a.map(row=>row[3]!) as V3};
  if(pose.t[2]<.08||pose.t[2]>2.5)return null;
  const errors=shape.map((p,i)=>{const q=project(pose,k,p),v=pixels[i]!;return Math.hypot(q.x-v.x,q.y-v.y);});
  return {pose,error:Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length)};
};

export class HandTracking {
  metricScale: number|null=null;
  private calibration: {start:number;values:number[]}|null=null;
  private calibrationReason="idle";
  private candidateScale:number|null=null;
  status="idle";
  reset():void{this.metricScale=null;this.calibration=null;this.calibrationReason="idle";this.status="idle";}
  calibrate(now:number):void{this.calibration={start:now,values:[]};this.status="collecting";}
  snapshot():unknown{return {scale:this.metricScale,status:this.status,collecting:this.collecting,samples:this.calibration?.values.length??0,reason:this.calibrationReason,candidateScale:this.candidateScale};}
  get collecting():boolean{return this.calibration!==null;}
  update(result:HandLandmarkerResult,table:Pose,k:Intrinsics,vision:Vision,now:number):HandEstimate {
    const landmarks=result.landmarks[0],world=result.worldLandmarks[0];
    const empty=(reason:string,pixels:Pixel[]=[],error:number|null=null,method="none"):HandEstimate=>{if(this.calibration)this.calibrationReason=reason;return {points:null,pixels,pinch:1,calibrated:this.metricScale!==null,reason,error,errorLimit:handReprojectionLimit(k),method};};
    if(this.calibration && now-this.calibration.start>5000){this.calibration=null;this.status="insufficient-stable-samples";}
    if(!landmarks||!world)return empty("no-hand");
    // Handedness can flicker; it is not a tracking ID and does not reset calibration.
    const pixels=landmarks.map(p=>({x:p.x*k.width,y:p.y*k.height}));
    const shape:V3[]=world.map(p=>[p.x,p.y,p.z]);
    const translated=translatedHand(shape,pixels,k);
    const pnp=vision.fit(shape,pixels,k);
    // Prefer the camera-oriented model when both fits have similar residuals.
    const fit=translated && translated.error<(pnp?.error??Infinity)*1.05?translated:pnp;
    const method=fit===translated?"translation":"pnp";
    if(!fit||fit.error>handReprojectionLimit(k))return empty("hand-pose-rejected",pixels,fit?.error??null,method);
    // Preserve the actual measured image position of every joint. The learned
    // metric shape supplies depth, not an alternative screen-space fingertip.
    const cameraPoints=shape.map((p,i)=>{const z=toCamera(fit.pose,p)[2],pixel=pixels[i]!;return [(pixel.x-k.cx)*z/k.fx,(pixel.y-k.cy)*z/k.fy,z] as V3;});
    const rawHeight=toTable(table,cameraPoints[8]!)[1];
    const contact=onTable(table,k,pixels[8]!);
    if(this.calibration && contact) {
      const target=toCamera(table,contact),raw=cameraPoints[8]!,factor=target[2]/raw[2];
      this.candidateScale=factor;this.calibrationReason=factor>.3&&factor<3?"collecting":"scale-out-of-range";
      if(factor>.3&&factor<3)this.calibration.values.push(factor);
      if(this.calibration.values.length>35)this.calibration.values.shift();
      const values=this.calibration.values;
      if(values.length>=8 && now-this.calibration.start>=700){
        const middle=median(values),mad=median(values.map(v=>Math.abs(v-middle)));
        if(mad/middle<.07){this.metricScale=middle;this.calibration=null;this.status="calibrated";this.calibrationReason="accepted";}else this.calibrationReason="unstable-depth";
      }
    }
    const metricScale=this.metricScale??1;
    const points=cameraPoints.map(p=>toTable(table,scale(p,metricScale)));
    const height=points[8]![1];
    if(height<-.3||height>1)return empty("height-outside-workspace",pixels,fit.error,method);
    const dist=(a:Pixel,b:Pixel):number=>Math.hypot(a.x-b.x,a.y-b.y);
    const pinch=dist(pixels[4]!,pixels[8]!)/Math.max(5,dist(pixels[5]!,pixels[17]!));
    return {points,pixels,pinch,calibrated:this.metricScale!==null,reason:this.metricScale===null?"needs-touch-calibration":"tracked",error:fit.error,errorLimit:handReprojectionLimit(k),method,rawHeightM:rawHeight,scale:metricScale};
  }
}
