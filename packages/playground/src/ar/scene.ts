// AR is an adapter around startBabylon, not a second sandbox. All board content,
// crates, balls, labels, control components and Havok bodies belong to babylon.ts.
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { startBabylon, type BabylonRuntime } from "../babylon";
import { length, sub, rotate, transpose, toCamera, type Intrinsics, type Pose, type V3 } from "./geometry";

import { VolumeDiagnostics } from "./volume";
import { yaw, type Field } from "./settings";

export interface InteractionResult { action: string; reason: string; target: string | null; distanceM?: number; pinch?: number }
export const rotationMatrix = (r: number[]): Matrix => Matrix.FromValues(r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, 0, 0, 0, 1);
export const smoothPose = (previous: Pose | null, next: Pose, dt: number, smoothing: number): Pose => {
  if (!previous || smoothing === 0) return next;
  // Short time constant at rest, fast response to motion. No averaging of screen corners.
  const motion = length(sub(next.t, previous.t));
  const tau = smoothing / (1 + motion * 100);
  const alpha = 1 - Math.exp(-Math.max(0.001, dt) / tau);
  const q = Quaternion.Slerp(Quaternion.FromRotationMatrix(rotationMatrix(previous.r)), Quaternion.FromRotationMatrix(rotationMatrix(next.r)), alpha);
  const m = Matrix.Identity(); q.toRotationMatrix(m);
  return { r: [m.m[0]!, m.m[4]!, m.m[8]!, m.m[1]!, m.m[5]!, m.m[9]!, m.m[2]!, m.m[6]!, m.m[10]!], t: previous.t.map((v, i) => v + alpha * (next.t[i]! - v)) as V3 };
};

export class ARScene {
  readonly camera: FreeCamera;
  readonly engine;
  readonly scene;
  readonly original: BabylonRuntime;
  readonly volume:VolumeDiagnostics;
  private scale = 0.025;
  private center: V3 = [0,0,0];
  private angle=0;
  editing=false;
  get field():Field { const t=this.original.floor.table;return {x:this.center[0],z:this.center[2],width:t.width*this.scale,depth:t.depth*this.scale,angle:this.angle}; }
  setField(f:Field):void {
    this.loseHand(true);this.original.hands.contacts.length=0;this.center=[f.x,0,f.z];this.angle=f.angle;
    this.original.floor.setFieldSize(f.width/this.scale,f.depth/this.scale);
    this.roomCenter.copyFrom(this.original.floor.table.center);
    this.original.panel.scaling.setAll(Math.min(.14,f.width*.8,f.depth*.8)/(2.88*this.scale));
    this.original.panel.position.set(this.roomCenter.x,.035,this.roomCenter.z-f.depth/this.scale*.25);
    this.volume.rebuild();
    for(const thing of this.original.things.values()){
      const p=thing.mesh.position;thing.mesh.computeWorldMatrix(true);
      const half=thing.mesh.getBoundingInfo().boundingBox.extendSizeWorld;
      const hx=Math.max(0,f.width/this.scale/2-half.x),hz=Math.max(0,f.depth/this.scale/2-half.z);
      if(Math.abs(p.x-this.roomCenter.x)>hx||Math.abs(p.z-this.roomCenter.z)>hz){
        thing.body.body.disablePreStep=false;p.x=this.roomCenter.x+Math.max(-hx,Math.min(hx,p.x-this.roomCenter.x));p.z=this.roomCenter.z+Math.max(-hz,Math.min(hz,p.z-this.roomCenter.z));p.y=Math.max(half.y+.05,p.y);
        thing.body.body.setLinearVelocity(Vector3.Zero());thing.body.body.setAngularVelocity(Vector3.Zero());
        this.scene.onAfterPhysicsObservable.addOnce(()=>{thing.body.body.disablePreStep=true;});
      }
    }
  }
  private roomCenter: Vector3;
  private fingertip;
  private cursorMaterial: StandardMaterial;
  private handInterval=100;
  private lastHand=0;
  /** Diagnostics adapt the common Hands contacts; AR creates no physics hand. */
  get physicalContacts():{handId:string;part:string;time:number;target:string;impulse:number;position:V3;velocity:V3;point:V3|null}[] {
    return this.original.hands.contacts.map(c=>({handId:c.handId,part:c.part,time:c.time,target:c.target,impulse:c.impulse,position:this.table(c.position),
      velocity:rotate(yaw(this.angle),[c.velocity.x*this.scale,c.velocity.y*this.scale,-c.velocity.z*this.scale]),point:c.point?this.table(c.point):null}));
  }
  result: InteractionResult = { action: "idle", reason: "no-hand", target: null };
  constructor(original: BabylonRuntime) {
    this.original = original; this.engine = original.engine; this.scene = original.scene;
    this.roomCenter = original.floor.table.center.clone();
    this.camera = new FreeCamera("ar-camera", Vector3.Zero(), this.scene);
    this.scene.activeCamera = this.camera;
    this.fingertip = CreateSphere("ar-finger-cursor", { diameter: 1 }, this.scene);
    this.fingertip.isPickable = false; this.fingertip.isVisible = false;
    this.cursorMaterial = new StandardMaterial("ar-finger", this.scene);
    this.cursorMaterial.emissiveColor = Color3.FromHexString("#91ffe0"); this.fingertip.material = this.cursorMaterial;
    this.volume=new VolumeDiagnostics(this);
    this.scene.onBeforeRenderObservable.add(() => { if (performance.now() - this.lastHand > this.handTimeout) this.loseHand(); });
  }
  static async create(canvas: HTMLCanvasElement): Promise<ARScene> {
    const original = await startBabylon({ canvas, frame: document.getElementById("original-board") as HTMLIFrameElement,
      toggle: document.createElement("button"), fly: document.createElement("button"), start: "3d", ar: true });
    return new ARScene(original);
  }
  get enabled(): boolean { return this.original.visible; }
  get holding(): string { return this.original.hands.states.find(s=>s.action==="hold")?.target ?? "—"; }
  get layout(): { center: V3; scale: number; width: number; depth: number } {
    const t = this.original.floor.table; return { center: [...this.center], scale: this.scale, width: t.width * this.scale, depth: t.depth * this.scale };
  }
  configure(markers: Map<number,V3[]>): void {
    const points = [...markers.values()].flat(); if (!points.length) return;
    this.angle=0;
    // Physical object scale is independent of marker coverage and survives map growth/reload.
    this.scale=.02;this.original.floor.setFieldSize(.4/this.scale,.4/this.scale);
    const xs = points.map(p=>p[0]), zs = points.map(p=>p[2]);
    const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs);
    this.center = [(x0+x1)/2,0,(z0+z1)/2];
    const room=this.original.floor.table;
    this.roomCenter.copyFrom(room.center);
    // Reuse the original components at a finger-sized physical scale.
    this.original.panel.scaling.setAll(.14/(2.88*this.scale));
    this.fingertip.scaling.setAll(.006/this.scale);
    this.original.hands.clear();this.original.hands.contacts.length=0;
    this.original.hands.configure({metersPerUnit:this.scale,route:"ray",pressAt:.022,releaseAt:.045});
    this.volume.rebuild();
  }

  room(p: V3): Vector3 { const q=rotate(transpose(yaw(this.angle)),sub(p,this.center));return new Vector3(q[0]/this.scale+this.roomCenter.x,q[1]/this.scale,-q[2]/this.scale+this.roomCenter.z); }
  table(p: Vector3): V3 { const q=rotate(yaw(this.angle),[(p.x-this.roomCenter.x)*this.scale,p.y*this.scale,-(p.z-this.roomCenter.z)*this.scale]);return [q[0]+this.center[0],q[1],q[2]+this.center[2]]; }
  resize(): void { this.original.resize(); }
  pose(p: Pose, k: Intrinsics): void {
    const s=this.scale;
    const origin=toCamera(p,this.table(Vector3.Zero())).map(v=>v/s) as V3;
    const basis=[Vector3.Right(),Vector3.Up(),Vector3.Forward()].map(v=>sub(toCamera(p,this.table(v)).map(n=>n/s) as V3,origin));
    const view=Matrix.FromValues(basis[0]![0],-basis[0]![1],basis[0]![2],0,basis[1]![0],-basis[1]![1],basis[1]![2],0,basis[2]![0],-basis[2]![1],basis[2]![2],0,origin[0],-origin[1],origin[2],1);
    const world=view.clone().invert();
    this.camera.position.copyFrom(world.getTranslation()); this.camera.rotationQuaternion=Quaternion.FromRotationMatrix(world);
    const near=.005/s,far=20/s;
    this.camera.minZ=near; this.camera.maxZ=far;
    this.camera.freezeProjectionMatrix(Matrix.FromValues(2*k.fx/k.width,0,0,0,0,2*k.fy/k.height,0,0,
      2*k.cx/k.width-1,1-2*k.cy/k.height,(far+near)/(far-near),1,0,0,-2*far*near/(far-near),0));
    this.original.visible=true;
  }
  diagnosticImage():HTMLCanvasElement { const enabled=this.scene.physicsEnabled;this.scene.physicsEnabled=false;try{this.scene.render(false,true);const c=document.createElement("canvas");c.width=this.engine.getRenderWidth();c.height=this.engine.getRenderHeight();c.getContext("2d")!.drawImage(this.engine.getRenderingCanvas()!,0,0);return c;}finally{this.scene.physicsEnabled=enabled;} }
  hide(): void { this.original.visible=false; this.loseHand(true); this.engine.clear(new Color4(0,0,0,0),true,true,true); }
  hand(points: V3[], allow3D: boolean, now: number, pinchRatio?: number): InteractionResult {
    if(this.editing){this.loseHand(true);return this.result={action:"idle",reason:"field-editing",target:null};}
    const arrival=performance.now();
    if(this.lastHand)this.handInterval=this.handInterval*.8+Math.min(1500,arrival-this.lastHand)*.2;
    this.lastHand=arrival;
    const tip=points[8]!, at=this.room(tip), previouslyHeld=this.holding;
    this.fingertip.position.copyFrom(at);this.fingertip.isVisible=true;
    if(!allow3D){this.original.hands.clear();return this.result={action:"idle",reason:"calibrate-touch",target:null};}
    const area=this.original.floor.table;
    if(Math.abs(at.x-area.center.x)>area.width/2||Math.abs(at.z-area.center.z)>area.depth/2){
      this.original.hands.clear();return this.result={action:"idle",reason:"outside-field",target:null};
    }
    // One tracked hand today. Handedness is not a stable ID; the tracker retains
    // this ID through brief missed observations and only clears after its timeout.
    const state=this.original.hands.update([{id:"ar-hand-0",joints:points.map(p=>this.room(p)),...(pinchRatio===undefined?{}:{pinch:pinchRatio})}],now)[0]!;
    this.cursorMaterial.emissiveColor=Color3.FromHexString(state.action==="hold"?"#ffc676":"#91ffe0");
    if(previouslyHeld!=="—" && state.action!=="hold")return this.result={action:"release",reason:"pinch-opened",target:previouslyHeld};
    return this.result={action:state.action==="hold"?"grab":state.action,reason:`shared-hands:${state.action}`,target:state.target,...(state.gap===null?{}:{distanceM:state.gap}),pinch:state.pinch};
  }
  private get handTimeout():number{return Math.max(700,Math.min(1800,this.handInterval*2.5));}
  loseHand(immediate=false): void {
    // An omitted inference pass is not an empty tracked frame. Keep the common
    // hand untouched for brief misses; explicit loss/edit/stop clears it at once.
    if(!immediate&&performance.now()-this.lastHand<=this.handTimeout)return;
    this.volume.hide();this.fingertip.isVisible=false;this.original.hands.clear();
    this.result={action:"idle",reason:"hand-lost",target:null};
  }
  resetObjects(): void {
    this.loseHand(true);this.original.hands.contacts.length=0; let n=0;
    for(const thing of this.original.things.values()) {
      const area=this.original.floor.table,i=n++;
      thing.body.body.disablePreStep=false;
      thing.mesh.position.set(area.center.x+(i%3-1)*area.width*.22,1.5,area.center.z+(i<3?-.08:.12)*area.depth);
      thing.body.body.setLinearVelocity(Vector3.Zero());thing.body.body.setAngularVelocity(Vector3.Zero());
      this.scene.onAfterPhysicsObservable.addOnce(()=>{thing.body.body.disablePreStep=true;});
    }
  }
  dispose(): void { this.original.hands.clear();this.scene.dispose(); this.engine.dispose(); }
}
