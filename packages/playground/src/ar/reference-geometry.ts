import {add,sub,scale,length,rotate,transpose,type V3} from './geometry';
import {yaw} from './settings';
export interface Reference {id:string;kind:'rectangle'|'box'|'hex';width:number;depth:number;height:number;x:number;z:number;base:number;angle:number;locked:boolean;mode:'outline'|'solid'|'occluder'}
export interface VolumeOptions {enabled:boolean;mode:'solid'|'transparent';fingerMm:number;palmMm:number;hidden:boolean;boardHidden:boolean}
export const volumeDefaults=():VolumeOptions=>({enabled:false,mode:'transparent',fingerMm:14,palmMm:24,hidden:false,boardHidden:false});
export const validReference=(r:Reference):boolean=>!!r&&typeof r.id==='string'&&['rectangle','box','hex'].includes(r.kind)&&['outline','solid','occluder'].includes(r.mode)&&typeof r.locked==='boolean'&&[r.width,r.depth,r.height,r.x,r.z,r.base,r.angle].every(Number.isFinite)&&r.width>=.001&&r.width<=3&&r.depth>=.001&&r.depth<=3&&r.height>=.0001&&r.height<=1&&Math.abs(r.x)<=5&&Math.abs(r.z)<=5&&Math.abs(r.base)<=1&&Math.abs(r.angle)<=360;
export const referencePolygon=(r:Reference):[number,number][]=>r.kind==='hex'?Array.from({length:6},(_,i)=>{const a=i*Math.PI/3,rad=r.width/Math.sqrt(3);return [Math.cos(a)*rad,Math.sin(a)*rad];}):[[-r.width/2,-r.depth/2],[r.width/2,-r.depth/2],[r.width/2,r.depth/2],[-r.width/2,r.depth/2]];
/** Exact point signed distance to an upright convex prism (hex width = across flats). */
export const pointPrism=(p:V3,r:Reference):{distance:number;point:V3;normal:V3}=>{
 const rotation=yaw(r.angle),q=rotate(transpose(rotation),sub(p,[r.x,r.base,r.z])),polygon=referencePolygon(r);let inside=true,best=Infinity,nearest:[number,number]=[0,0],edgeNormal:[number,number]=[1,0];
 for(let i=0;i<polygon.length;i++){const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!,dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[2]-a[1])*dz)/(dx*dx+dz*dz))),v:[number,number]=[a[0]+t*dx,a[1]+t*dz],d=Math.hypot(q[0]-v[0],q[2]-v[1]);if(d<best){best=d;nearest=v;const edgeLength=Math.hypot(dx,dz);edgeNormal=[dz/edgeLength,-dx/edgeLength];}if(dx*(q[2]-a[1])-dz*(q[0]-a[0])<0)inside=false;}
 const horizontal=inside?-best:best,vertical=Math.max(-q[1],q[1]-r.height);let closest:V3;
 if(horizontal<=0&&vertical<=0){closest=horizontal>vertical?[nearest[0],q[1],nearest[1]]:[q[0],q[1]<r.height/2?0:r.height,q[2]];}
 else closest=[inside?q[0]:nearest[0],Math.max(0,Math.min(r.height,q[1])),inside?q[2]:nearest[1]];
 const distance=Math.hypot(Math.max(horizontal,0),Math.max(vertical,0))+Math.min(Math.max(horizontal,vertical),0),world=add(rotate(rotation,closest),[r.x,r.base,r.z]);let normal=sub(p,world);if(distance<0)normal=scale(normal,-1);const n=length(normal);normal=n>1e-10?scale(normal,1/n):rotate(rotation,Math.abs(q[1])<1e-10?[0,-1,0]:Math.abs(q[1]-r.height)<1e-10?[0,1,0]:[edgeNormal[0],0,edgeNormal[1]]);return {distance,point:world,normal};
};
export interface DistanceWitness {gapM:number;penetrationM:number;fingerPoint:V3;objectPoint:V3;axisPoint:V3;samplingBoundM:number;approximation:string}
/** Surface of a finger capsule, not the joint center. Sampling bound follows the 1-Lipschitz point SDF. */
export const capsulePrism=(a:V3,b:V3,radius:number,r:Reference,samples=64):DistanceWitness=>{
 let best=Infinity,axis=a,hit=pointPrism(a,r);for(let i=0;i<=samples;i++){const p=add(a,scale(sub(b,a),i/samples)),h=pointPrism(p,r);if(h.distance<best){best=h.distance;axis=p;hit=h;}}
 const gapM=best-radius;return {gapM,penetrationM:Math.max(0,-gapM),fingerPoint:sub(axis,scale(hit.normal,radius)),objectPoint:hit.point,axisPoint:axis,samplingBoundM:length(sub(b,a))/(2*samples),approximation:'analytic capsule/prism signed-distance witness; displayed mesh is tessellated; penetration is deepest sampled sphere, not whole-hand minimum translation'};
};
export const FINGER_BONES=[...[1,5,9,13,17].flatMap(start=>[[start,start+1],[start+1,start+2],[start+2,start+3]])] as [number,number][];
