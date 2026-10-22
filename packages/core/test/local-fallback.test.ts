import { expect, test } from "bun:test";
import { labelRegions, traceBorders, traceRegionPath } from "../src/geometry/regions";
import { isStraight } from "../src/geometry/curves";
import { RecordingContext } from "../src/context";
import { Scene } from "../src/geometry/scene";
import fixture from "./fixtures/wave-junction.json";

const width=fixture.rows[0]!.length, height=fixture.rows.length;
const values=fixture.rows.flatMap(row=>[...row].map(c=>parseInt(c,36)));
const options={tolerance:1.2,cornerAngle:90,detourSize:2.5,microLoopSize:3.25,curves:true};
test("a local topology repair retains the distant waves of a real horse border",()=>{
  const map=labelRegions(width,height,values), saved=JSON.stringify(map);
  const before=traceBorders(map,options), after=traceBorders(map,{...options,localFallback:true});
  // The long border at (13,13)..(63,123) previously fell back as a whole.
  const wave=before.borders.find(b=>Math.max(...b.exact.map(p=>p.y))-Math.min(...b.exact.map(p=>p.y))===110)!;
  expect(wave).toBeDefined();
  expect(wave.pieces?.filter(p=>!isStraight(p)).length??0).toBe(0);
  const next=after.borders[wave.id]!;
  expect(next.pieces!.filter(p=>!isStraight(p)).length).toBeGreaterThan(10);
  expect(next.pieces!.some(p=>!isStraight(p)&&p.from.y>60)).toBe(true);
  expect(after.rings).toEqual(before.rings);
  expect(after.borders.map(b=>[b.id,b.left,b.right,b.closed,b.exact])).toEqual(before.borders.map(b=>[b.id,b.left,b.right,b.closed,b.exact]));
  expect(JSON.stringify(map)).toBe(saved);
  expect(traceBorders(map,{...options,localFallback:false})).toEqual(before);
});
test("locally repaired shared curves tile the cropped painting without holes or overlaps",()=>{
  const map=labelRegions(width,height,values), outlines=traceBorders(map,{...options,localFallback:true});
  const ctx=new RecordingContext();
  for(const r of map.regions){ctx.beginGroup({id:`r${r.id}`});ctx.beginPath();traceRegionPath(ctx,outlines,r.id);ctx.fill();ctx.endGroup();}
  const scene=new Scene(ctx.getDocument()); let misses=0,total=0;
  for(let y=.37;y<height;y+=.71)for(let x=.23;x<width;x+=.83){total++;if(scene.hitTest({x,y}).length!==1)misses++;}
  // Independent flattened hit-testing has a small tolerance near shared curves.
  expect(misses/total).toBeLessThan(.002);
});
