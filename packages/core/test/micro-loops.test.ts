import { expect, test } from "bun:test";
import { type CubicPiece, pieceAt, isStraight } from "../src/geometry/curves";
import { removeMicroLoops } from "../src/geometry/micro-loops";

// Curves captured from actual 12/24-color horse borders. Eight samples per
// piece missed these crossings; use an independent dense geometric check.
const single: CubicPiece = {from:{x:127,y:185},c1:{x:132.16666666666637,y:185},c2:{x:121.00000000000057,y:185.33333333333314},to:{x:128,y:183}};
const pair: CubicPiece[] = [
  {from:{x:70,y:616},c1:{x:73.49999999999972,y:613.6666666666669},c2:{x:67.58333333333348,y:614},to:{x:71,y:614}},
  {from:{x:71,y:614},c1:{x:71,y:615.5152227420892},c2:{x:72.82766037652172,y:615.3106415060869},to:{x:73,y:616}},
];
const line = (x:number,y:number,xx:number,yy:number):CubicPiece=>({from:{x,y},c1:{x,y},c2:{x:xx,y:yy},to:{x:xx,y:yy}});
function crossings(pieces: readonly CubicPiece[]) {
  const points=pieces.flatMap((p,i)=>Array.from({length:129},(_,k)=>pieceAt(p,k/128)).slice(i?1:0));
  let count=0;
  for(let i=0;i+1<points.length;i++)for(let j=i+2;j+1<points.length;j++){
    const a=points[i]!,b=points[i+1]!,c=points[j]!,d=points[j+1]!;
    const side=(p:typeof a,q:typeof a,r:typeof a)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    if(side(a,b,c)*side(a,b,d)<-1e-16&&side(c,d,a)*side(c,d,b)<-1e-16)count++;
  }
  return count;
}
test("remove a tiny loop within one cubic without moving endpoints or its unaffected neighbor",()=>{
  const tail=line(128,183,150,180), input=[single,tail], saved=JSON.stringify(input);
  expect(crossings(input)).toBeGreaterThan(0);
  const next=removeMicroLoops(input,2.5);
  expect(crossings(next)).toBe(0);
  expect(next[0]!.from).toEqual(single.from);
  expect(next.at(-1)).toBe(tail);
  expect(JSON.stringify(input)).toBe(saved);
  expect(removeMicroLoops(next,2.5)).toEqual(next);
});
test("remove a loop across neighboring pieces, keeping the rest of both curves",()=>{
  expect(crossings(pair)).toBeGreaterThan(0);
  const next=removeMicroLoops(pair,2.5);
  expect(crossings(next)).toBe(0);
  expect(next[0]!.from).toEqual(pair[0]!.from);
  expect(next.at(-1)!.to).toEqual(pair[1]!.to);
});
test("the size bound, disabled mode, and long narrow features remain untouched",()=>{
  expect(removeMicroLoops(pair,0)).toEqual(pair);
  expect(removeMicroLoops(pair,.0001)).toEqual(pair);
  const limb=[line(0,0,20,0),line(20,0,20,40),line(20,40,21,40),line(21,40,21,0),line(21,0,40,0)];
  expect(removeMicroLoops(limb,2.5)).toEqual(limb);
  const hole=[line(0,0,1,0),line(1,0,1,1),line(1,1,0,1),line(0,1,0,0)];
  expect(removeMicroLoops(hole,2.5,true)).toEqual(hole);
});
test("a loop straddling a closed border seam is repaired without opening the ring",()=>{
  const ring=[pair[1]!,line(73,616,90,630),line(90,630,50,630),line(50,630,70,616),pair[0]!];
  expect(crossings(ring)).toBeGreaterThan(0);
  const next=removeMicroLoops(ring,2.5,true);
  expect(crossings(next)).toBe(0);
  for(let i=0;i<next.length;i++)expect(next[i]!.to).toEqual(next[(i+1)%next.length]!.from);
});

test("only a wholly microscopic intersecting window becomes a simple connector",()=>{
  const next=removeMicroLoops(pair,3.25);
  expect(next).toHaveLength(1);
  expect(isStraight(next[0]!)).toBe(true);
  expect(next[0]!.from).toEqual(pair[0]!.from);
  expect(next[0]!.to).toEqual(pair[1]!.to);
});
