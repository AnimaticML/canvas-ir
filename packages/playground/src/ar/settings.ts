import { rotate, add, type Pose, type V3 } from './geometry';
export interface MarkerSizes { defaultCm:number; byId:Record<string,number> }
export interface Field { width:number; depth:number; x:number; z:number; angle:number }
export interface Correction { enabled:boolean; pitch:number; roll:number }
export const defaultSizes=():MarkerSizes=>({defaultCm:3,byId:{}});
export const defaultCorrection=():Correction=>({enabled:false,pitch:0,roll:0});
export const sideM=(sizes:MarkerSizes,id:number):number=>(sizes.byId[id]??sizes.defaultCm)/100;
export const validSizes=(s:MarkerSizes):boolean=>Number.isFinite(s.defaultCm)&&s.defaultCm>=.5&&s.defaultCm<=50&&Object.entries(s.byId).every(([id,v])=>/^\d+$/.test(id)&&+id<50&&Number.isFinite(v)&&v>=.5&&v<=50);
export const validField=(f:Field):boolean=>[f.width,f.depth,f.x,f.z,f.angle].every(Number.isFinite)&&f.width>=.1&&f.width<=3&&f.depth>=.1&&f.depth<=3&&Math.abs(f.x)<=5&&Math.abs(f.z)<=5&&Math.abs(f.angle)<=360;
export const yaw=(angle:number):number[]=>{const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [c,0,-s,0,1,0,s,0,c];};
export const multiply=(a:number[],b:number[]):number[]=>Array.from({length:9},(_,i)=>[0,1,2].reduce((s,j)=>s+a[Math.floor(i/3)*3+j]!*b[j*3+i%3]!,0));
export const correctionPose=(c:Correction):Pose=>{const p=(c.enabled?c.pitch:0)*Math.PI/180,r=(c.enabled?c.roll:0)*Math.PI/180;return {r:multiply([1,0,0,0,Math.cos(p),-Math.sin(p),0,Math.sin(p),Math.cos(p)],[Math.cos(r),-Math.sin(r),0,Math.sin(r),Math.cos(r),0,0,0,1]),t:[0,0,0]};};
export const compose=(a:Pose,b:Pose):Pose=>({r:multiply(a.r,b.r),t:add(rotate(a.r,b.t),a.t)});
export const fieldCorners=(f:Field):V3[]=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>add(rotate(yaw(f.angle),[x!*f.width/2,0,z!*f.depth/2]),[f.x,0,f.z]));
export interface SavedAR { version:1; sizes:MarkerSizes; mapId:string; map:[number,V3[]][]; field:Field|null; correction:Correction }
export const storageKey='canvas-ir-ar-v1';
export const readSettings=(text:string|null):SavedAR|null=>{try{const v=JSON.parse(text??'null') as SavedAR;if(!v||v.version!==1||!validSizes(v.sizes)||typeof v.mapId!=='string'||!Array.isArray(v.map)||v.map.length>50||v.field&&!validField(v.field)||!v.correction||typeof v.correction.enabled!=='boolean'||![v.correction.pitch,v.correction.roll].every(n=>Number.isFinite(n)&&Math.abs(n)<=30))return null;const ids=new Set<number>();for(const [id,q] of v.map){if(!Number.isInteger(id)||id<0||id>=50||ids.has(id)||!Array.isArray(q)||q.length!==4||q.some(p=>p.length!==3||!p.every(Number.isFinite)||Math.abs(p[1])>1e-6))return null;ids.add(id);}return v;}catch{return null;}};
