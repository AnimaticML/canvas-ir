import {test,expect} from 'bun:test';
import {pointPrism,capsulePrism,referencePolygon,validReference,type Reference} from '../src/ar/reference-geometry';
const box:Reference={id:'cube',kind:'box',width:.02,depth:.02,height:.02,x:0,z:0,base:0,angle:0,locked:true,mode:'outline'};
test('box face, corner, interior and rotated translated prism signed distances',()=>{
 expect(pointPrism([.01,.01,0],box).normal[0]).toBeCloseTo(1,8);
 expect(pointPrism([.03,.01,0],box).distance).toBeCloseTo(.02,9);
 expect(pointPrism([.02,.03,0],box).distance).toBeCloseTo(Math.sqrt(.0002),9);
 expect(pointPrism([0,.01,0],box).distance).toBeCloseTo(-.01,9);
 const transformed={...box,x:.1,z:.2,base:.03,angle:90};expect(pointPrism([.1,.04,.23],transformed).distance).toBeCloseTo(.02,9);
});
test('finger surface gap, contact, penetration and above cube without physics',()=>{
 const a:[number,number,number]=[.025,.005,0],b:[number,number,number]=[.025,.015,0];
 const gap=capsulePrism(a,b,.005,box);expect(gap.gapM).toBeCloseTo(.01,8);expect(gap.fingerPoint[0]).toBeCloseTo(.02,8);expect(gap.objectPoint[0]).toBeCloseTo(.01,8);
 expect(capsulePrism([.015,.005,0],[.015,.015,0],.005,box).gapM).toBeCloseTo(0,8);
 expect(capsulePrism([.012,.005,0],[.012,.015,0],.005,box).penetrationM).toBeCloseTo(.003,8);
 expect(capsulePrism([0,.035,0],[0,.045,0],.005,box).gapM).toBeCloseTo(.01,8);
});
test('regular hex dimensions across flats and rectangle thickness are explicit',()=>{
 const hex={...box,kind:'hex' as const,width:.04};const p=referencePolygon(hex);expect(Math.max(...p.map(v=>v[1]))-Math.min(...p.map(v=>v[1]))).toBeCloseTo(.04,8);expect(Math.max(...p.map(v=>v[0]))-Math.min(...p.map(v=>v[0]))).toBeCloseTo(.08/Math.sqrt(3),8);
 expect(pointPrism([0,.01,.03],hex).distance).toBeCloseTo(.01,8);expect(validReference({...box,width:NaN})).toBe(false);expect(validReference({...box,height:0})).toBe(false);
});
test('thin card on a raised mat retains distinct bottom and top surfaces',()=>{
 const card={...box,kind:'rectangle' as const,width:.073,depth:.111,height:.0007,base:.004};
 const above=pointPrism([0,.0067,0],card);expect(above.distance).toBeCloseTo(.002,9);expect(above.point[1]).toBeCloseTo(.0047,9);
 const below=pointPrism([0,.0038,0],card);expect(below.distance).toBeCloseTo(.0002,9);expect(below.point[1]).toBeCloseTo(.004,9);
});
