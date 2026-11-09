import { describe, expect, test } from "bun:test";
import { HandRuntime, type Delegate, type HandModel } from "../src/ar/hand-runtime";
const empty={landmarks:[],worldLandmarks:[],handedness:[]};
const model=():HandModel=>({detectForVideo:()=>empty,close:()=>{}});

describe("MediaPipe GPU lifecycle",()=>{
  test("requests GPU first and records the active delegate",async()=>{
    const requested:Delegate[]=[],events:string[]=[];
    const runtime=new HandRuntime(kind=>events.push(kind),async d=>{requested.push(d);return model();});
    await runtime.load();expect(requested).toEqual(["GPU"]);expect(runtime.active).toBe("GPU");
    expect(runtime.detect({} as HTMLCanvasElement,1)).toEqual(empty);expect(events).toContain("hands-ready");runtime.close();
  });
  test("falls back to CPU when GPU initialization is unsupported",async()=>{
    const requested:Delegate[]=[],events:string[]=[];
    const runtime=new HandRuntime(kind=>events.push(kind),async d=>{requested.push(d);if(d==="GPU")throw Error("WebGL unavailable");return model();});
    await runtime.load();expect(requested).toEqual(["GPU","CPU"]);expect(runtime.active).toBe("CPU");
    expect(runtime.snapshot().requested).toBe("GPU");expect(runtime.fallbackReason).toContain("WebGL");expect(events).toContain("hands-gpu-fallback");runtime.close();
  });
  test("a lost GPU during inference switches the hand backend without throwing into camera tracking",async()=>{
    const requested:Delegate[]=[];let closed=false;
    const runtime=new HandRuntime(()=>{},async d=>{requested.push(d);return d==="GPU"?{detectForVideo:()=>{throw Error("context lost");},close:()=>{closed=true;}}:model();});
    await runtime.load();expect(runtime.detect({} as HTMLCanvasElement,1)).toBeNull();
    await runtime.load();expect(requested).toEqual(["GPU","CPU"]);expect(closed).toBe(true);expect(runtime.active).toBe("CPU");
    expect(runtime.snapshot().requested).toBe("GPU");expect(runtime.detect({} as HTMLCanvasElement,2)).toEqual(empty);runtime.close();
  });
});
