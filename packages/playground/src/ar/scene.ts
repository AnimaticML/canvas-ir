// AR is an adapter around startBabylon, not a second sandbox. All board content,
// crates, balls, labels, control components and Havok bodies belong to babylon.ts.
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { startBabylon, type BabylonRuntime, type BabylonThing } from "../babylon";
import { cross, length, sub, unit, type Intrinsics, type Pose, type V3 } from "./geometry";

const vector = (p: V3): Vector3 => new Vector3(...p);
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
  private scale = 0.025;
  private center: V3 = [0,0,0];
  private roomCenter: Vector3;
  private fingertip;
  private fingerProxy;
  private cursorMaterial: StandardMaterial;
  private fingerBody:PhysicsAggregate|null=null;
  private fingerTarget:Vector3|null=null;
  private fingerEnabled=false;
  private handInterval=100;
  readonly physicalContacts:{time:number;target:string;impulse:number;position:V3;velocity:V3;point:V3|null}[]=[];
  physicsTouches=0;
  private held: { thing: BabylonThing; offset: Vector3; relative: Quaternion; target: Vector3; rotation: Quaternion } | null = null;
  private pinched = false;
  private contact: { kind: "board" | "panel"; point: Vector3; frames: number; down: boolean; lastValid: number; clickOnly?: boolean } | null = null;
  private lastHand = 0;
  presses = 0;
  grabs = 0;
  releases = 0;
  result: InteractionResult = { action: "idle", reason: "no-hand", target: null };
  constructor(original: BabylonRuntime) {
    this.original = original; this.engine = original.engine; this.scene = original.scene;
    this.roomCenter = original.floor.table.center.clone();
    this.camera = new FreeCamera("ar-camera", Vector3.Zero(), this.scene);
    this.scene.activeCamera = this.camera;
    this.fingertip = CreateSphere("ar-finger-cursor", { diameter: 1 }, this.scene);
    this.fingertip.isPickable = false; this.fingertip.isVisible = false;
    this.fingerProxy=CreateSphere("ar-finger-physics",{diameter:1},this.scene);
    this.fingerProxy.isPickable=false;this.fingerProxy.isVisible=false;
    this.cursorMaterial = new StandardMaterial("ar-finger", this.scene);
    this.cursorMaterial.emissiveColor = Color3.FromHexString("#91ffe0"); this.fingertip.material = this.cursorMaterial;
    this.scene.onBeforePhysicsObservable.add(() => {
      if (this.held) this.held.thing.body.body.setTargetTransform(this.held.target, this.held.rotation);
      if(this.fingerEnabled && this.fingerBody && this.fingerTarget){
        const from=this.fingerProxy.position,delta=this.fingerTarget.subtract(from),max=.025/this.scale;
        const target=delta.length()>max?from.add(delta.normalize().scale(max)):this.fingerTarget;
        this.fingerBody.body.setTargetTransform(target,Quaternion.Identity());
      }
    });
    this.scene.onBeforeRenderObservable.add(() => { if (performance.now() - this.lastHand > this.handTimeout) this.loseHand(); });
  }
  static async create(canvas: HTMLCanvasElement): Promise<ARScene> {
    const original = await startBabylon({ canvas, frame: document.getElementById("original-board") as HTMLIFrameElement,
      toggle: document.createElement("button"), fly: document.createElement("button"), start: "3d", ar: true });
    return new ARScene(original);
  }
  get enabled(): boolean { return this.original.visible; }
  get holding(): string { return this.held?.thing.mesh.name ?? "—"; }
  get layout(): { center: V3; scale: number; width: number; depth: number } {
    const t = this.original.floor.table; return { center: [...this.center], scale: this.scale, width: t.width * this.scale, depth: t.depth * this.scale };
  }
  configure(markers: Map<number,V3[]>): void {
    const points = [...markers.values()].flat(); if (!points.length) return;
    const xs = points.map(p=>p[0]), zs = points.map(p=>p[2]);
    const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs);
    this.center = [(x0+x1)/2,0,(z0+z1)/2];
    const width = Math.max(.32,x1-x0+.04), depth = Math.max(.3,z1-z0+.04), room=this.original.floor.table;
    this.scale = Math.min(width/room.width,depth/room.depth);
    this.roomCenter.copyFrom(room.center);
    // Reuse the original components at a finger-sized physical scale.
    this.original.panel.scaling.setAll(.14/(2.88*this.scale));
    this.fingerBody?.dispose();
    this.fingertip.scaling.setAll(.006/this.scale);
    this.fingerBody=new PhysicsAggregate(this.fingerProxy,PhysicsShapeType.SPHERE,{mass:0,radius:.009/this.scale,restitution:0,friction:.5},this.scene);
    this.fingerBody.body.setMotionType(PhysicsMotionType.ANIMATED);
    this.fingerBody.body.disableSync=false;
    this.fingerBody.shape.filterCollideMask=0;
    this.fingerEnabled=false;
    this.fingerBody.body.setCollisionCallbackEnabled(true);
    this.fingerBody.body.getCollisionObservable().add(event=>{
      const other=event.collider===this.fingerBody?.body?event.collidedAgainst:event.collider;
      const id=other.transformNode.name;
      if(!this.original.things.has(id))return;
      const item=this.original.things.get(id)!,velocity=item.body.body.getLinearVelocity();
      this.physicalContacts.push({time:performance.now(),target:id,impulse:event.impulse,position:this.table(item.mesh.position),velocity:[velocity.x*this.scale,velocity.y*this.scale,-velocity.z*this.scale],point:event.point?this.table(event.point):null});
      if(this.physicalContacts.length>60)this.physicalContacts.shift();
      if(event.type==="COLLISION_STARTED")this.physicsTouches++;
      this.result={action:"touch",reason:"havok-contact",target:id};
    });
  }
  room(p: V3): Vector3 { return new Vector3((p[0]-this.center[0])/this.scale+this.roomCenter.x, p[1]/this.scale, -(p[2]-this.center[2])/this.scale+this.roomCenter.z); }
  table(p: Vector3): V3 { return [(p.x-this.roomCenter.x)*this.scale+this.center[0],p.y*this.scale,-(p.z-this.roomCenter.z)*this.scale+this.center[2]]; }
  resize(): void { this.original.resize(); }
  pose(p: Pose, k: Intrinsics): void {
    const r=p.r, c=this.center, s=this.scale, o=this.roomCenter;
    // Original Babylon scene is left-handed. Reflect room Z into the RH table,
    // and flip OpenCV camera Y. Keep original geometry/physics in original units.
    const offset: V3 = [c[0]-s*o.x,0,c[2]+s*o.z];
    const t: V3 = p.t.map((v,i)=>(v+r[i*3]!*offset[0]+r[i*3+2]!*offset[2])/s) as V3;
    const view=Matrix.FromValues(r[0]!,-r[3]!,r[6]!,0,r[1]!,-r[4]!,r[7]!,0,-r[2]!,r[5]!,-r[8]!,0,t[0],-t[1],t[2],1);
    const world=view.clone().invert();
    this.camera.position.copyFrom(world.getTranslation()); this.camera.rotationQuaternion=Quaternion.FromRotationMatrix(world);
    const near=.005/s,far=20/s;
    this.camera.minZ=near; this.camera.maxZ=far;
    this.camera.freezeProjectionMatrix(Matrix.FromValues(2*k.fx/k.width,0,0,0,0,2*k.fy/k.height,0,0,
      2*k.cx/k.width-1,1-2*k.cy/k.height,(far+near)/(far-near),1,0,0,-2*far*near/(far-near),0));
    this.original.visible=true;
  }
  hide(): void { this.original.visible=false; this.loseHand(true); this.engine.clear(new Color4(0,0,0,0),true,true,true); }
  hand(points: V3[], allow3D: boolean, now: number, pinchRatio?: number): InteractionResult {
    const arrival=performance.now();
    if(this.lastHand)this.handInterval=this.handInterval*.8+Math.min(1500,arrival-this.lastHand)*.2;
    this.lastHand=arrival;
    const tip=points[8]!,thumb=points[4]!, at=this.room(tip);
    this.fingertip.position.copyFrom(at);this.fingertip.isVisible=true;
    if (!allow3D) { this.disableFinger();this.fingertip.position.copyFrom(at); this.endContact(true); this.release(); return this.result={action:"idle",reason:"calibrate-touch",target:null}; }
    const gap=length(sub(tip,thumb)), palm=Math.max(.035,length(sub(points[5]!,points[17]!)));
    const ratio=pinchRatio ?? gap/palm;
    const pinching=ratio<(this.pinched ? .48 : .30);
    if(pinching)this.disableFinger();else this.moveFinger(at);
    const midpoint=this.room([(tip[0]+thumb[0])/2,(tip[1]+thumb[1])/2,(tip[2]+thumb[2])/2]);
    const x=unit(sub(points[5]!,points[17]!)),forward=unit(sub(points[9]!,points[0]!));
    const z=unit(cross(x,forward)),y=unit(cross(z,x));
    // Reflect both palm coordinates and one basis axis to preserve a proper rotation.
    const reflect=(p:V3):Vector3=>new Vector3(p[0],p[1],-p[2]);
    const orientation=Quaternion.RotationQuaternionFromAxis(reflect(x),reflect(y),reflect(z).negate());
    if (pinching && !this.held) {
      this.endContact(true);
      const candidates=[...this.original.things.values()].map(thing=>{
        thing.mesh.computeWorldMatrix(true);
        const box=thing.mesh.getBoundingInfo().boundingBox,min=box.minimumWorld,max=box.maximumWorld;
        const nearest=Vector3.Clamp(midpoint,min,max);
        return {thing,distance:Vector3.Distance(nearest,midpoint)*this.scale};
      }).sort((a,b)=>a.distance-b.distance);
      const best=candidates[0];
      // Search while pinch is held, so a pinch that starts just outside the zone can enter it.
      if(best && best.distance<.035) {
        const thing=best.thing; thing.body.body.setMotionType(PhysicsMotionType.ANIMATED);
        const rotation=thing.mesh.rotationQuaternion ?? Quaternion.FromEulerVector(thing.mesh.rotation);
        this.held={thing,offset:thing.mesh.position.subtract(midpoint).applyRotationQuaternion(orientation.conjugate()),relative:orientation.conjugate().multiply(rotation),target:thing.mesh.position.clone(),rotation:rotation.clone()};
        this.grabs++;
      } else this.result={action:"pinch",reason:"outside-grab-zone",target:best?.thing.mesh.name??null,distanceM:best?.distance??1,pinch:ratio};
    }
    if(this.held && pinching) {
      this.held.target=midpoint.add(this.held.offset.applyRotationQuaternion(orientation));
      this.held.target.y=Math.max(.35,this.held.target.y);
      this.held.rotation=orientation.multiply(this.held.relative);
      this.result={action:"grab",reason:"holding",target:this.held.thing.mesh.name,pinch:ratio};
      this.cursorMaterial.emissiveColor=Color3.FromHexString("#ffc676");
    } else if(!pinching) {
      const released=this.release(); this.cursorMaterial.emissiveColor=Color3.FromHexString("#91ffe0");
      if(released) this.result={action:"release",reason:"pinch-opened",target:released};
      else this.touch(at,tip[1]);
    }
    this.pinched=pinching; return this.result;
  }
  private touch(at: Vector3, height: number): void {
    const panel=this.original.panel;
    const inverse=panel.computeWorldMatrix(true).clone().invert();
    const local=Vector3.TransformCoordinates(at,inverse);
    const eye=Vector3.TransformCoordinates(this.camera.globalPosition,inverse);
    const ray=local.subtract(eye),t=Math.abs(ray.z)>1e-8?-eye.z/ray.z:-1;
    const surface=eye.add(ray.scale(t));
    const captured=this.contact?.down && this.contact.kind==="panel";
    const inPanel=t>0 && Math.abs(surface.x)<1.44+(captured ? .2 : 0) && Math.abs(surface.y)<.9+(captured ? .2 : 0);
    const onPanel=inPanel && Math.abs(local.z)*this.original.panel.scaling.z*this.scale<(captured ? .045 : .022);
    const board=this.original.floor.table;
    const onBoard=height>-.025 && height<(this.contact?.down ? .045 : .022) && Math.abs(at.x-board.center.x)<board.width/2 && Math.abs(at.z-board.center.z)<board.depth/2;
    const actor=[...this.original.things.values()].find(thing=>{
      thing.mesh.computeWorldMatrix(true);const box=thing.mesh.getBoundingInfo().boundingBox;
      return Vector3.Distance(at,Vector3.Clamp(at,box.minimumWorld,box.maximumWorld))*this.scale<.009;
    });
    if(actor){
      this.endContact(true);
      const recent=this.physicalContacts.at(-1);
      this.result={action:recent?.target===actor.mesh.name && performance.now()-recent.time<350?"touch":"hover",reason:"physical-finger-contact",target:actor.mesh.name};return;
    }
    const kind=onPanel?"panel":onBoard?"board":null;
    if(!kind) {
      if(this.contact?.down && performance.now()-this.contact.lastValid<180){this.result={action:"touch",reason:"contact-grace",target:this.contact.kind};return;}
      this.endContact(false); this.result={action:"hover",reason:"above-surface",target:null,distanceM:height}; return; }
    const worldRay=at.subtract(this.camera.globalPosition);
    const floorT=Math.abs(worldRay.y)>1e-8?-this.camera.globalPosition.y/worldRay.y:0;
    // Once near the plane, route the measured image ray to it. Flattening the
    // noisy 3D point vertically shifts sliders/buttons under an oblique camera.
    const point=kind==="panel"?Vector3.TransformCoordinates(new Vector3(surface.x,surface.y,0),panel.getWorldMatrix()):this.camera.globalPosition.add(worldRay.scale(floorT));
    if(this.contact && this.contact.kind!==kind) this.endContact(true);
    if(!this.contact) this.contact={kind,point,frames:0,down:false,lastValid:performance.now()};
    this.contact.point=point; this.contact.frames++;this.contact.lastValid=performance.now();
    if(!this.contact.down && this.contact.frames>=2) {
      const control=kind==="panel"?this.original.controlAt(point):null;
      this.original.pointer("down",point,kind); this.contact.down=true; this.presses++;
      if(control && ["crate","ball","gravity","clear"].includes(control)) {
        this.original.pointer("up",point,kind); this.contact.clickOnly=true;
      }
    } else if(this.contact.down && !this.contact.clickOnly) this.original.pointer("move",point,kind);
    this.result={action:"touch",reason:this.contact.down?"pointer-down":"debounce",target:kind};
  }
  private endContact(cancel: boolean): void {
    if(this.contact?.down && !this.contact.clickOnly) this.original.pointer(cancel?"cancel":"up",this.contact.point,this.contact.kind);
    this.contact=null;
  }
  private get handTimeout():number{return Math.max(700,Math.min(1800,this.handInterval*2.5));}
  private disableFinger():void{
    this.fingerEnabled=false;this.fingerTarget=null;
    if(this.fingerBody){this.fingerBody.shape.filterCollideMask=0;this.fingerBody.body.setLinearVelocity(Vector3.Zero());}
  }
  private moveFinger(at:Vector3):void{
    const target=at.clone();target.y=Math.max(.009/this.scale,target.y);
    if(!this.fingerBody)return;
    if(!this.fingerEnabled){
      // Teleport with collisions disabled on re-acquisition, never sweep through
      // the table from a stale/offscreen position.
      this.fingerProxy.position.copyFrom(target);this.fingerBody.body.disablePreStep=false;
      this.fingerBody.shape.filterCollideMask=0;
      this.scene.onAfterPhysicsObservable.addOnce(()=>{
        if(!this.fingerBody)return;this.fingerBody.body.disablePreStep=true;
        if(this.fingerEnabled)this.fingerBody.shape.filterCollideMask=0xffffffff;
      });
    }
    this.fingerEnabled=true;this.fingerTarget=target;
  }
  loseHand(immediate=false): void {
    // The timestamp is arrival time, not the beginning of a slow inference pass.
    // A single missing sample must not cancel every two-frame contact.
    const age=performance.now()-this.lastHand;
    if(!immediate && age<=this.handTimeout)return;
    this.fingertip.isVisible=false;this.endContact(true);this.disableFinger();
    this.release();this.pinched=false;
    this.result={action:"idle",reason:"hand-lost",target:null};
  }
  private release(): string|null {
    if(!this.held)return null;
    const id=this.held.thing.mesh.name,body=this.held.thing.body.body;
    body.setMotionType(PhysicsMotionType.DYNAMIC);body.setLinearVelocity(Vector3.Zero());body.setAngularVelocity(Vector3.Zero());
    this.held=null;this.releases++;return id;
  }
  resetObjects(): void {
    this.release(); let n=0;
    for(const thing of this.original.things.values()) {
      const area=this.original.floor.table,i=n++;
      thing.body.body.disablePreStep=false;
      thing.mesh.position.set(area.center.x+(i%3-1)*area.width*.22,1.5,area.center.z+(i<3?-.08:.12)*area.depth);
      thing.body.body.setLinearVelocity(Vector3.Zero());thing.body.body.setAngularVelocity(Vector3.Zero());
      this.scene.onAfterPhysicsObservable.addOnce(()=>{thing.body.body.disablePreStep=true;});
    }
  }
  dispose(): void { this.scene.dispose(); this.engine.dispose(); }
}
