import { expect,test } from 'bun:test';
import cvModule from '@techstark/opencv-js';
import { MarkerMap,Vision } from '../src/ar/vision';
import { intrinsics,markerCorners,project,toCamera,toTable,type Pose } from '../src/ar/geometry';
import { compose,correctionPose,defaultCorrection,fieldCorners,readSettings,sideM,validSizes,yaw } from '../src/ar/settings';
import { crc32,DiagnosticStore,zip } from '../src/ar/diagnostic';
test('mixed marker sides learn metric layout and recover from each ID alone',async()=>{
 const cv=await cvModule,vision=new Vision(cv),k=intrinsics(800,600,60),pose:Pose={r:[1,0,0,0,-.4,Math.sqrt(.84),0,-Math.sqrt(.84),-.4],t:[.01,.02,.6]};
 const map=new MarkerMap(.03,{'1':.06,'2':.045}),quads=[markerCorners(.03),markerCorners(.06,[.12,0,-.08],.6),markerCorners(.045,[-.1,0,.09],-.3)];
 try{for(let n=0;n<12;n++)map.update(quads.map((q,id)=>({id,pixels:q.map(p=>project(pose,k,p))})),vision,k);expect(map.markers.size).toBe(3);for(let id=0;id<3;id++){map.markers.get(id)!.forEach((p,i)=>p.forEach((v,j)=>expect(v).toBeCloseTo(quads[id]![i]![j]!,4)));const fit=map.update([{id,pixels:quads[id]!.map(p=>project(pose,k,p))}],vision,k)!;expect(fit.error).toBeLessThan(.01);fit.pose.t.forEach((v,j)=>expect(v).toBeCloseTo(pose.t[j]!,4));}}finally{vision.dispose();}
});
test('field extends beyond markers; correction is rigid and does not mutate estimated pose',()=>{
 const field={width:1.2,depth:.7,x:.3,z:-.2,angle:37},corners=fieldCorners(field);expect(Math.hypot(corners[1]![0]-corners[0]![0],corners[1]![2]-corners[0]![2])).toBeCloseTo(1.2,8);
 const raw:Pose={r:yaw(12),t:[.1,.2,.7]},copy=JSON.stringify(raw),applied=compose(raw,correctionPose({enabled:true,pitch:13,roll:-9}));const p:[number,number,number]=[.4,.05,-.2];toTable(applied,toCamera(applied,p)).forEach((v,i)=>expect(v).toBeCloseTo(p[i]!,8));expect(JSON.stringify(raw)).toBe(copy);expect(compose(raw,correctionPose(defaultCorrection()))).toEqual(raw);
});
test('settings round trip with per ID sizes, map and associated field; reject corrupt settings',()=>{
 const value={version:1,sizes:{defaultCm:3,byId:{'2':6}},mapId:'system-a',map:[[0,markerCorners(.03)]],field:{width:.8,depth:.5,x:.1,z:-.1,angle:31},correction:defaultCorrection()};
 expect(readSettings(JSON.stringify(value))).toEqual(value);expect(sideM(value.sizes,2)).toBe(.06);expect(sideM(value.sizes,1)).toBe(.03);expect(validSizes({defaultCm:3,byId:{'50':4}})).toBe(false);expect(readSettings(JSON.stringify({...value,field:{...value.field,width:-1}}))).toBeNull();expect(readSettings('{')).toBeNull();
});
test('ZIP links images, capture times and frame metadata; bounds retained snapshots',()=>{
 const store=new DiagnosticStore();for(let n=1;n<=7;n++)store.add({id:`frame-${n}`,raw:new Uint8Array([n]),composite:new Uint8Array([n+1]),data:{capture:{frameId:n,capturedAt:n*10},estimates:{hand:{frameId:n-1,ageAtCaptureMs:10}}}});
 expect(store.shots.length).toBe(5);expect(store.shots[0]!.id).toBe('frame-3');const bytes=store.export({version:5}),files=new Map<string,Uint8Array>();let offset=0;const view=new DataView(bytes.buffer);while(view.getUint32(offset,true)===0x04034b50){const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameLength)),start=offset+30+nameLength;const data=bytes.slice(start,start+size);expect(crc32(data)).toBe(view.getUint32(offset+14,true));files.set(name,data);offset=start+size;}
 const manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json')));expect(manifest.containsCameraImages).toBe(true);for(const entry of manifest.entries){const metadata=JSON.parse(new TextDecoder().decode(files.get(entry.metadata)));expect(entry.capture.frameId).toBe(metadata.capture.frameId);expect(files.get(entry.camera)![0]).toBe(metadata.capture.frameId);expect(files.get(entry.overlay)![0]).toBe(metadata.capture.frameId+1);}expect(zip([]).length).toBe(22);
});
