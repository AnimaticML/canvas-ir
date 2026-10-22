import { expect, test } from "bun:test";
import { simplifyDetours } from "../src/geometry/curves";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import { labelRegions, traceBorders, regionRings, traceRegionPath } from "../src/geometry/regions";

const hairpin = [{x:0,y:0},{x:10,y:0},{x:10,y:7},{x:11,y:7},{x:11,y:0},{x:22,y:0}];
test("bounded hairpins are removed while open endpoints and long narrow features stay", () => {
  expect(simplifyDetours(hairpin, 2)).toEqual([{x:0,y:0},{x:10,y:0},{x:11,y:0},{x:22,y:0}]);
  const leg=hairpin.map(p=>({...p,y:p.y*4}));
  expect(simplifyDetours(leg,2)).toEqual(leg);
  for(const size of [0,-1,NaN,Infinity]) expect(simplifyDetours(hairpin,size)).toEqual(hairpin);
  expect(hairpin[2]!.y).toBe(7);
});
test("closed tiny rings survive and retain their winding",()=>{
  for(const ring of [[{x:0,y:0},{x:4,y:0},{x:4,y:1},{x:0,y:1}],hairpin.concat([{x:22,y:-20},{x:0,y:-20}])]){
    const area=(pts:readonly {x:number;y:number}[])=>pts.reduce((s,p,i)=>{const q=pts[(i+1)%pts.length]!;return s+p.x*q.y-q.x*p.y},0);
    const next=simplifyDetours(ring,2,true);
    expect(next.length).toBeGreaterThanOrEqual(4);
    expect(area(next)*area(ring)).toBeGreaterThan(0);
    expect(Math.abs(area(next))).toBeGreaterThanOrEqual(Math.abs(area(ring))*.5);
  }
});
test("detour cleanup operates once on a shared border without changing canonical labels",()=>{
  const w=36,h=32,values=new Int16Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)values[y*w+x]=(y<12 || (x>=13&&x<15&&y<20))?1:0;
  const map=labelRegions(w,h,values), before=Array.from(map.labels);
  const exact=traceBorders(map,{tolerance:0,curves:false});
  const next=traceBorders(map,{tolerance:.3,curves:true,cornerAngle:90,detourSize:2.5});
  expect(Array.from(map.labels)).toEqual(before);
  expect(next.rings.length).toBe(exact.rings.length);
  const shared=next.borders.filter(b=>b.left>=0&&b.right>=0);
  expect(shared).toHaveLength(1);
  const b=shared[0]!;
  expect(next.rings[b.left]!.flat().some(u=>u.border===b.id&&u.reversed)).toBe(true);
  expect(next.rings[b.right]!.flat().some(u=>u.border===b.id&&!u.reversed)).toBe(true);
  expect(Math.max(...b.points.map(p=>p.y))).toBeLessThan(18);
  for(const r of map.regions) expect(regionRings(next,r.id).length).toBeGreaterThan(0);
});

test("opt-in cleanup still tiles around close borders, junctions and holes",()=>{
  const width=48,height=40,values=new Int16Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    let v=x<24?0:1;
    if(x>8&&x<18&&y>8&&y<30)v=2;
    if(x>11&&x<15&&y>12&&y<26)v=0;
    if(x>=24&&x<26&&y>10&&y<19)v=0;
    values[y*width+x]=v;
  }
  const map=labelRegions(width,height,values);
  for(const curves of [false,true]) {
    const outlines=traceBorders(map,{tolerance:1.2,cornerAngle:90,detourSize:2.5,curves});
    const ctx=new RecordingContext();
    for(const r of map.regions){ctx.beginGroup({id:`r${r.id}`});ctx.beginPath();traceRegionPath(ctx,outlines,r.id);ctx.fill();ctx.endGroup();}
    const scene=new Scene(ctx.getDocument()); let misses=0;
    for(let y=.37;y<height;y+=.71)for(let x=.23;x<width;x+=.83)if(scene.hitTest({x,y}).length!==1)misses++;
    expect(misses).toBeLessThan(15);
    expect(map.regions.length).toBe(4);
  }
});

test("a pixel-sampled long thin limb is not shortened one local tip at a time",()=>{
  const sparse=hairpin.map(p=>({...p,y:p.y*4}));
  const dense: {x:number;y:number}[]=[];
  for(let i=0;i<sparse.length-1;i++){
    const a=sparse[i]!,b=sparse[i+1]!,n=Math.max(Math.abs(b.x-a.x),Math.abs(b.y-a.y));
    for(let k=0;k<n;k++)dense.push({x:a.x+(b.x-a.x)*k/n,y:a.y+(b.y-a.y)*k/n});
  }
  dense.push(sparse.at(-1)!);
  const next=simplifyDetours(dense,2.5);
  expect(Math.max(...next.map(p=>p.y))).toBe(28);
  expect(next.some(p=>p.x===10&&p.y===24)).toBe(true);
});
