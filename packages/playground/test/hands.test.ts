import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { type HandHost, type HandSurface, Hands, handOrientation, meshHandSurface } from "../src/hands";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { FLAT_HEIGHTS, flatHandScale } from "../src/ar/flat-hand";
import { intrinsics, project, toCamera, type Pose, type V3 } from "../src/ar/geometry";

// A right hand, palm down, index pointing at -z, its index tip at `tip`, `gap` meters from thumb tip to index tip.
const hand = (tip: Vector3, gap: number): Vector3[] => {
  const j = Array.from({ length: 21 }, () => tip.add(new Vector3(0.02, 0.04, 0.12)));
  j[0] = tip.add(new Vector3(0.02, 0.05, 0.17));
  j[5] = tip.add(new Vector3(0, 0.04, 0.08));
  j[9] = tip.add(new Vector3(0.02, 0.04, 0.08));
  j[17] = tip.add(new Vector3(0.07, 0.04, 0.09));
  j[8] = tip;
  j[4] = tip.add(new Vector3(-gap, 0, 0));
  return j;
};

const table: HandSurface = { id: "table", point: Vector3.Zero(), normal: Vector3.Up(), contains: (at, margin) => Math.abs(at.x) <= 0.5 + margin && Math.abs(at.z) <= 0.5 + margin };

const host = () => {
  const log: string[] = [];
  const ball = { id: "ball", mesh: { computeWorldMatrix: () => {}, getBoundingInfo: () => ({ boundingBox: { minimumWorld: new Vector3(0.2, 0, 0.2), maximumWorld: new Vector3(0.26, 0.06, 0.26) } }) } };
  const h: HandHost = {
    scene: { getPhysicsEngine: () => null } as never,
    things: () => [ball as never],
    surfaces: () => [table],
    press: (phase, at, pointer, _time, buttons) => log.push(`${phase}${phase === "move" && !buttons ? "/hover" : ""} ${pointer} ${at.x.toFixed(2)},${at.y.toFixed(3)}`),
    hold: (pointer, id, at) => log.push(id ? `hold ${pointer} ${id} ${at!.y.toFixed(2)}` : `let go ${pointer}`),
  };
  return { h, log };
};

describe("hands", () => {
  test("a fingertip presses the table where it touches, with a gap between pressing and letting go", () => {
    const { h, log } = host();
    const hands = new Hands(h, { solid: false, route: "contact" });
    const at = (y: number) => hands.update([{ id: "R", joints: hand(new Vector3(0.1, y, 0), 0.06) }])[0]!;
    expect(at(0.05).action).toBe("hover");
    expect(at(0.01).action).toBe("touch");
    // Above where it pressed, but under where it lets go: still pressing.
    expect(at(0.02).action).toBe("touch");
    expect(at(0.04).action).toBe("hover");
    expect(log).toEqual(["move/hover 1001 0.10,0.000", "down 1001 0.10,0.000", "move 1001 0.10,0.000", "up 1001 0.10,0.000", "move/hover 1001 0.10,0.000"]);
  });

  test("routed by ray, a touch presses at the fingertip, for the camera's ray through it", () => {
    const { h, log } = host();
    const hands = new Hands(h, { solid: false });
    hands.update([{ id: "R", joints: hand(new Vector3(0.1, 0.008, 0), 0.06) }]);
    expect(log).toEqual(["down 1001 0.10,0.008"]);
  });

  test("a pinch next to a thing holds it and lets go when it opens; elsewhere it presses like a finger", () => {
    const { h, log } = host();
    const hands = new Hands(h, { solid: false });
    hands.update([{ id: "R", joints: hand(new Vector3(0.23, 0.08, 0.23), 0.004) }]);
    hands.update([{ id: "R", joints: hand(new Vector3(0.23, 0.3, 0.23), 0.004) }]);
    expect(hands.states[0]).toMatchObject({ action: "hold", target: "ball" });
    hands.update([{ id: "R", joints: hand(new Vector3(0.23, 0.3, 0.23), 0.06) }]);
    expect(log).toEqual(["hold 1000 ball 0.08", "hold 1000 ball 0.30", "let go 1000"]);
    log.length = 0;
    hands.update([{ id: "R", joints: hand(new Vector3(-0.2, 0.3, 0), 0.004) }]);
    hands.update([{ id: "R", joints: hand(new Vector3(-0.1, 0.3, 0), 0.004) }]);
    hands.update([{ id: "R", joints: hand(new Vector3(-0.1, 0.3, 0), 0.06) }]);
    expect(log.map((l) => l.split(" ")[0])).toEqual(["down", "move", "up"]);
  });

  test("a hand that's gone cancels its press", () => {
    const { h, log } = host();
    const hands = new Hands(h, { solid: false });
    hands.update([{ id: "R", joints: hand(new Vector3(0, 0.005, 0), 0.06) }]);
    hands.update([]);
    expect(log.map((l) => l.split(" ")[0])).toEqual(["down", "cancel"]);
    expect(hands.states).toEqual([]);
  });
});

describe("a hand laid flat calibrates its size", () => {
  const k = intrinsics(1280, 720, 65);
  const angle = 0.6;
  const camera: Pose = { r: [1, 0, 0, 0, -Math.sin(angle), Math.cos(angle), 0, -Math.cos(angle), -Math.sin(angle)], t: [0.02, 0.03, 0.55] };
  // A flat hand on the table: joints spread over the palm and fingers, each at its height above the table.
  const truth: V3[] = FLAT_HEIGHTS.map((h, i) => [-0.04 + (i % 5) * 0.02, h, 0.06 - Math.floor(i / 5) * 0.035] as V3);
  const pixels = truth.map((p) => project(camera, k, p));

  test("the tracked hand, guessed too small, comes out at the scale that makes it its true size", () => {
    const guessed = truth.map((p) => toCamera(camera, p).map((v) => v / 1.3) as V3);
    const fit = flatHandScale(guessed, pixels, camera, k)!;
    expect(fit.scale).toBeCloseTo(1.3, 3);
    expect(fit.spread).toBeLessThan(0.001);
  });

  test("a hand held above the table instead disagrees with itself", () => {
    const lifted = truth.map((p, i) => [p[0], p[1] + (i % 3) * 0.03, p[2]] as V3);
    const fit = flatHandScale(lifted.map((p) => toCamera(camera, p)), lifted.map((p) => project(camera, k, p)), camera, k)!;
    expect(fit.spread).toBeGreaterThan(0.02);
  });
});


describe("shared hand regressions from the AR adapter", () => {
  test("an already closed pinch enters the grab zone, cancelling its prior drag", () => {
    const {h,log}=host(),hands=new Hands(h,{solid:false});
    hands.update([{id:"R",joints:hand(new Vector3(-.2,.04,.23),.004)}]);
    expect(hands.states[0]!.action).toBe("pinch");
    hands.update([{id:"R",joints:hand(new Vector3(.23,.04,.23),.004)}]);
    expect(hands.states[0]).toMatchObject({action:"hold",target:"ball"});
    expect(log.map(v=>v.split(" ")[0])).toEqual(["down","cancel","hold"]);
  });
  test("holding passes the palm rotation to the board and tolerates a degenerate palm", () => {
    const {h}=host(),rotations:Quaternion[]=[],hands=new Hands({...h,hold:(_id,_thing,_at,q)=>{if(q)rotations.push(q.clone());}},{solid:false});
    const center=new Vector3(.23,.04,.23),first=hand(center,.004),turn=Quaternion.RotationAxis(Vector3.Up(),.6);
    hands.update([{id:"R",joints:first}]);
    hands.update([{id:"R",joints:first.map(p=>p.subtract(center).applyRotationQuaternion(turn).add(center))}]);
    expect(rotations.length).toBe(2);
    expect(Math.abs(Quaternion.Dot(rotations[1]!,turn.multiply(rotations[0]!)))).toBeCloseTo(1,6);
    expect(handOrientation(Array.from({length:21},()=>Vector3.Zero()))).toBeNull();
    hands.update([{id:"R",joints:Array.from({length:21},()=>center.clone()),pinch:.05}]);
    expect(Math.abs(Quaternion.Dot(rotations[2]!,rotations[1]!))).toBeCloseTo(1,6);
  });
  test("a scaled rotated panel uses its full visible extent and metric edge margin", () => {
    const engine=new NullEngine(),scene=new Scene(engine),panel=CreatePlane("panel",{width:2.88,height:1.8},scene);
    try{
      panel.scaling.set(2.43,1.7,1);panel.rotation.set(Math.PI/2,.2,.3);panel.position.set(2,3,4);
      const surface=meshHandSurface("panel",panel,2.88,1.8,"z"),world=(x:number,y:number)=>Vector3.TransformCoordinates(new Vector3(x,y,0),panel.computeWorldMatrix(true));
      expect(surface.contains(world(1,.7),0)).toBe(true);
      expect(surface.contains(world(1.45,0),0)).toBe(false);
      expect(surface.contains(world(1.45,0),.03)).toBe(true);
      expect(surface.contains(world(0,.92),.03)).toBe(false);
    }finally{scene.dispose();engine.dispose();}
  });
});
