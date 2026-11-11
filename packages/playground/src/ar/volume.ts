import "@babylonjs/core/Rendering/edgesRenderer";
import {Vector3,Quaternion} from '@babylonjs/core/Maths/math.vector';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color';
import {Constants} from '@babylonjs/core/Engines/constants';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial';
import {CreateBox} from '@babylonjs/core/Meshes/Builders/boxBuilder';
import {CreateCylinder} from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import {CreateSphere} from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import {CreateLines} from '@babylonjs/core/Meshes/Builders/linesBuilder';
import type {LinesMesh} from '@babylonjs/core/Meshes/linesMesh';
import {Mesh} from '@babylonjs/core/Meshes/mesh';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData';
import type {ARScene} from './scene';
import {capsulePrism,FINGER_BONES,referencePolygon,volumeDefaults,type Reference,type VolumeOptions,type DistanceWitness} from './reference-geometry';
import {type V3} from './geometry';
export class VolumeDiagnostics {
 references:Reference[]=[];options:VolumeOptions=volumeDefaults();selected='';
 private refs:Mesh[]=[];private bones:Mesh[]=[];private ends:Mesh[]=[];private palm:Mesh;private skeleton:LinesMesh|null=null;private witnesses:Mesh[]=[];
 private witnessMaterial:StandardMaterial;private hitMaterial:StandardMaterial;private handMaterial:StandardMaterial;private ghost:StandardMaterial;private referenceMaterials:StandardMaterial[]=[];
 joints:V3[]|null=null;source:unknown=null;reliable=false;lastUpdate=0;reason='no-hand';measurement:(DistanceWitness&{target:string;bone:number[];state:string;reliable:boolean;gapIntervalM:number[];objectGeometry:Reference;computedAt:number})|null=null;
 constructor(private ar:ARScene){const scene=ar.scene;scene.setRenderingAutoClearDepthStencil(1,false);scene.setRenderingAutoClearDepthStencil(2,false);
  this.handMaterial=new StandardMaterial('diagnostic-hand-volume',scene);this.handMaterial.diffuseColor=Color3.FromHexString('#55d6bd');this.handMaterial.backFaceCulling=false;this.handMaterial.needDepthPrePass=true;
  this.witnessMaterial=new StandardMaterial('diagnostic-witness-markers',scene);this.witnessMaterial.depthFunction=Constants.ALWAYS;this.witnessMaterial.disableDepthWrite=true;
  this.hitMaterial=new StandardMaterial('diagnostic-contact-state',scene);this.hitMaterial.backFaceCulling=false;this.hitMaterial.needDepthPrePass=true;
  this.ghost=new StandardMaterial('hidden-hand-contour',scene);this.ghost.emissiveColor=Color3.FromHexString('#ff7cce');this.ghost.wireframe=true;this.ghost.depthFunction=Constants.GREATER;this.ghost.disableDepthWrite=true;
  const make=(mesh:Mesh):Mesh=>{mesh.material=this.handMaterial;mesh.isPickable=false;mesh.renderingGroupId=1;mesh.setEnabled(false);const hidden=mesh.clone(mesh.name+'/hidden',mesh)!;hidden.position.setAll(0);hidden.scaling.setAll(1);hidden.rotationQuaternion=Quaternion.Identity();hidden.material=this.ghost;hidden.renderingGroupId=2;hidden.isPickable=false;return mesh;};
  for(let i=0;i<FINGER_BONES.length;i++){this.bones.push(make(CreateCylinder(`volume-finger-${i}`,{height:1,diameter:1,tessellation:10},scene)));this.ends.push(make(CreateSphere(`volume-joint-${i}-a`,{diameter:1,segments:8},scene)),make(CreateSphere(`volume-joint-${i}-b`,{diameter:1,segments:8},scene)));}
  this.palm=make(CreateBox('volume-palm',{size:1},scene));
  scene.onBeforeRenderObservable.add(()=>{if(this.joints&&performance.now()-this.lastUpdate>700)this.setQuality(false,'stale-hand');});
 }
 setReferences(refs:Reference[]):void{this.references=refs;this.rebuild();}
 rebuild():void{for(const m of this.refs)m.dispose();for(const m of this.referenceMaterials)m.dispose();this.refs=[];this.referenceMaterials=[];
  for(const r of this.references){const poly=referencePolygon(r),vertices:V3[]=[...poly.map(([x,z])=>[r.x+x,r.base,r.z+z] as V3),...poly.map(([x,z])=>[r.x+x,r.base+r.height,r.z+z] as V3)];const a=r.angle*Math.PI/180;const positions=vertices.flatMap(p=>{const x=p[0]-r.x,z=p[2]-r.z;const q=this.ar.room([r.x+Math.cos(a)*x-Math.sin(a)*z,p[1],r.z+Math.sin(a)*x+Math.cos(a)*z]);return [q.x,q.y,q.z];}),indices:number[]=[],n=poly.length;
   for(let i=1;i<n-1;i++)indices.push(0,i+1,i,n,n+i,n+i+1);for(let i=0;i<n;i++){const j=(i+1)%n;indices.push(i,j,n+j,i,n+j,n+i);}const mesh=new Mesh(`reference/${r.id}`,this.ar.scene),data=new VertexData();data.positions=positions;data.indices=indices;const normals:number[]=[];VertexData.ComputeNormals(positions,indices,normals);data.normals=normals;data.applyToMesh(mesh);
   const mat=new StandardMaterial(`reference/${r.id}/material`,this.ar.scene);mat.diffuseColor=Color3.FromHexString('#e9b65b');mat.backFaceCulling=false;
   if(r.mode==='occluder'){mat.disableColorWrite=true;mat.forceDepthWrite=true;}else if(r.mode==='outline'){mat.alpha=.18;mat.disableDepthWrite=true;mesh.enableEdgesRendering();mesh.edgesWidth=2;mesh.edgesColor=new Color4(1,.75,.2,1);}
   mesh.material=mat;mesh.isPickable=false;this.refs.push(mesh);this.referenceMaterials.push(mat);
  }
  if(this.joints)this.update(this.joints,this.reliable,this.source,this.reason,false);
 }
 setQuality(reliable:boolean,reason:string):void{if(reliable&&this.source&&typeof this.source==='object'&&'capturedAt' in this.source&&performance.now()-Number(this.source.capturedAt)>700){reliable=false;reason='stale-source';}this.reliable=reliable;this.reason=reason;this.handMaterial.diffuseColor=Color3.FromHexString(reliable?'#55d6bd':'#f0a65b');if(this.measurement)this.measurement.reliable=reliable;if(!reliable)this.hitMaterial.diffuseColor=new Color3(1,.65,.2);if(!reliable)for(const m of this.witnesses)if("color" in m)(m as LinesMesh).color=new Color3(1,.65,.2);}
 update(points:V3[],reliable:boolean,source:unknown,reason:string,refresh=true):void{
  this.joints=points.map(p=>[...p]);this.source=source;if(refresh)this.lastUpdate=performance.now();this.setQuality(reliable,reason);
  const enabled=this.options.enabled,radius=this.options.fingerMm/2000,s=this.ar.layout.scale;this.handMaterial.alpha=this.options.mode==='solid'?1:.38;
  const orient=(mesh:Mesh,a:Vector3,b:Vector3,width:number,depth=width):void=>{mesh.position.copyFrom(a.add(b).scale(.5));if(Vector3.Distance(a,b)<1e-8){mesh.scaling.set(width,.0001,depth);mesh.rotationQuaternion=Quaternion.Identity();return;}const y=b.subtract(a).normalize();let x=Vector3.Cross(y,Vector3.Forward());if(x.length()<.01)x=Vector3.Cross(y,Vector3.Right());x.normalize();const z=Vector3.Cross(x,y).normalize();mesh.rotationQuaternion=Quaternion.RotationQuaternionFromAxis(x,y,z);mesh.scaling.set(width,Vector3.Distance(a,b),depth);};
  FINGER_BONES.forEach(([a,b],i)=>{const x=this.ar.room(points[a]!),y=this.ar.room(points[b]!);orient(this.bones[i]!,x,y,2*radius/s);for(const [j,p] of [x,y].entries()){const m=this.ends[i*2+j]!;m.position.copyFrom(p);m.scaling.setAll(2*radius/s);}});
  const wrist=this.ar.room(points[0]!),knuckles=this.ar.room(points[5]!).add(this.ar.room(points[17]!)).scale(.5);orient(this.palm,wrist,knuckles,Vector3.Distance(this.ar.room(points[5]!),this.ar.room(points[17]!)),this.options.palmMm/1000/s);
  for(const mesh of [...this.bones,...this.ends,this.palm]){mesh.setEnabled(enabled);for(const child of mesh.getChildMeshes())child.setEnabled(this.options.hidden);}
  const py=knuckles.subtract(wrist).normalize(),px=this.ar.room(points[5]!).subtract(this.ar.room(points[17]!));px.subtractInPlace(py.scale(Vector3.Dot(px,py)));if(px.lengthSquared()>1e-8){px.normalize();this.palm.rotationQuaternion=Quaternion.RotationQuaternionFromAxis(px,py,Vector3.Cross(px,py).normalize());}
  this.skeleton?.dispose();this.skeleton=null;if(enabled&&this.options.mode==='transparent'){this.skeleton=CreateLines('volume-hand-skeleton',{points:[0,1,2,3,4,3,2,1,0,5,6,7,8,7,6,5,9,10,11,12,11,10,9,13,14,15,16,15,14,13,17,18,19,20].map(i=>this.ar.room(points[i]!))},this.ar.scene);this.skeleton.color=Color3.White();this.skeleton.isPickable=false;this.skeleton.renderingGroupId=1;}
  this.measure();
 }
 measure():void{
  for(const m of [...this.bones,...this.ends])m.material=this.handMaterial;
  this.measurement=null;for(const m of this.witnesses)m.dispose();this.witnesses=[];if(!this.joints||!this.options.enabled)return;
  let ref=this.references.find(r=>r.id===this.selected),approx='';
  if(!ref){const t=this.ar.original.things.get(this.selected);if(t){t.mesh.computeWorldMatrix(true);const box=t.mesh.getBoundingInfo().boundingBox,min=this.ar.table(box.minimumWorld),max=this.ar.table(box.maximumWorld);ref={id:this.selected,kind:'box',x:(min[0]+max[0])/2,z:(min[2]+max[2])/2,base:Math.min(min[1],max[1]),width:box.extendSizeWorld.x*2*this.ar.layout.scale,depth:box.extendSizeWorld.z*2*this.ar.layout.scale,height:box.extendSizeWorld.y*2*this.ar.layout.scale,angle:this.ar.field.angle,locked:true,mode:'solid'};approx='interactive object approximated by room-axis bounding box; ';}}
  if(!ref)return;
  for(const bone of FINGER_BONES){const hit=capsulePrism(this.joints[bone[0]]!,this.joints[bone[1]]!,this.options.fingerMm/2000,ref);if(!this.measurement||hit.gapM<this.measurement.gapM)this.measurement={...hit,approximation:approx+hit.approximation,target:ref.id,bone,objectGeometry:{...ref},computedAt:performance.now(),gapIntervalM:[hit.gapM-hit.samplingBoundM,hit.gapM],state:hit.gapM<-.002?'penetration':hit.gapM<=.002?'contact':'gap',reliable:this.reliable&&hit.samplingBoundM<=.002};}
  const m=this.measurement!;const color=!m.reliable?new Color3(1,.65,.2):m.state==='penetration'?Color3.Red():m.state==='contact'?Color3.Green():Color3.FromHexString('#55bfff');this.witnessMaterial.emissiveColor=color;this.hitMaterial.diffuseColor=color;this.hitMaterial.emissiveColor=color.scale(.2);this.hitMaterial.alpha=this.handMaterial.alpha;const index=FINGER_BONES.findIndex(b=>b[0]===m.bone[0]&&b[1]===m.bone[1]);if(index>=0){this.bones[index]!.material=this.hitMaterial;this.ends[index*2]!.material=this.hitMaterial;this.ends[index*2+1]!.material=this.hitMaterial;}const targetMesh=this.refs.find(v=>v.name===`reference/${m.target}`);if(targetMesh)targetMesh.edgesColor=new Color4(color.r,color.g,color.b,1);const line=CreateLines('surface-distance',{points:[this.ar.room(m.fingerPoint),this.ar.room(m.objectPoint)]},this.ar.scene);line.color=color;if(line.material){line.material.depthFunction=Constants.ALWAYS;line.material.disableDepthWrite=true;}line.isPickable=false;line.renderingGroupId=2;this.witnesses.push(line);
  for(const p of [m.fingerPoint,m.objectPoint]){const dot=CreateSphere('distance-witness',{diameter:.003/this.ar.layout.scale,segments:8},this.ar.scene);dot.position.copyFrom(this.ar.room(p));dot.material=this.witnessMaterial;dot.isPickable=false;dot.renderingGroupId=2;this.witnesses.push(dot);}
 }
 clearHand():void{this.hide();this.joints=null;this.source=null;this.measurement=null;}
 hide():void{for(const mesh of [...this.bones,...this.ends,this.palm])mesh.setEnabled(false);this.skeleton?.setEnabled(false);for(const m of this.witnesses)m.setEnabled(false);this.setQuality(false,'hand-lost');}
 get candidate():{id:string;gapM:number;inReach:boolean}|null{if(!this.joints)return null;const p=this.ar.room(this.joints[4]!).add(this.ar.room(this.joints[8]!)).scale(.5),nearest=[...this.ar.original.things.values()].map(t=>{t.mesh.computeWorldMatrix(true);const b=t.mesh.getBoundingInfo().boundingBox;return {id:t.mesh.name,gapM:Vector3.Distance(p,Vector3.Clamp(p,b.minimumWorld,b.maximumWorld))*this.ar.layout.scale};}).sort((a,b)=>a.gapM-b.gapM)[0];return nearest?{...nearest,inReach:nearest.gapM<=this.ar.original.hands.options.reach}:null;}
 snapshot():unknown{return structuredClone({evaluatedAt:performance.now(),references:this.references,options:this.options,visible:this.options.enabled&&this.bones.some(m=>m.isEnabled()),selected:this.selected,joints:this.joints,source:this.source,ageMs:this.joints?performance.now()-this.lastUpdate:null,sourceAgeMs:this.source&&typeof this.source==='object'&&'capturedAt' in this.source?performance.now()-Number(this.source.capturedAt):null,reliable:this.reliable,reason:this.reason,measurement:this.measurement,candidate:this.candidate,held:this.ar.holding,physics:'diagnostic geometry has no physics bodies; existing shared Hands unchanged',palmApproximation:'oriented box between wrist and knuckles; distance queries use finger capsules only',contactToleranceMm:2,witnessRendering:'always-visible diagnostic markers; depth occlusion is not contact'});}
}
