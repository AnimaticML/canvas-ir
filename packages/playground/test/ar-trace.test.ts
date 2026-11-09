import { expect, test } from "bun:test";
import { TraceBuffer } from "../src/ar/trace";

test("calibration inputs and setup decisions survive a full rolling trace buffer",()=>{
  const trace=new TraceBuffer({recent:4,important:3,pinned:8});
  trace.append("anchor-reset",{sizeM:.03},0);trace.pinFor(100,10);
  trace.append("calibration-start",{},10);trace.append("hand",{sample:1},20);trace.append("frame",{markers:[0,1]},21);
  for(let i=0;i<20;i++)trace.append("frame",{index:i},200+i);
  const saved=trace.export();
  expect(trace.recent.length).toBe(4);
  expect(saved.find(e=>e.kind==="anchor-reset")).toBeDefined();
  expect(saved.find(e=>e.kind==="hand"&&(e.data as {sample:number}).sample===1)).toBeDefined();
  expect(saved.find(e=>e.time===21)).toBeDefined();expect(saved.length).toBe(8);
  expect(saved.filter(e=>e.kind==="calibration-start").length).toBe(1);
});

test("all retained trace buffers have a bounded size",()=>{
  const trace=new TraceBuffer({recent:4,important:3,pinned:8});trace.pinFor(10000,0);
  for(let i=0;i<100;i++){trace.append("hand",{},i);trace.append("state",{},i);}
  expect(trace.export().length).toBeLessThanOrEqual(15);
});
