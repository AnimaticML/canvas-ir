import {test,expect} from 'bun:test';
import {centimeterGrid} from '../src/ar/grid';
test('centimeter grid has exact 10 mm spacing and 50 mm major lines, clipped to field',()=>{
 const g=centimeterGrid(.4,.3),all=[...g.minor,...g.major],xs=all.filter(l=>l[0]![0]===l[1]![0]).map(l=>l[0]![0]).sort((a,b)=>a-b);
 for(let i=1;i<xs.length;i++)expect(xs[i]!-xs[i-1]!).toBeCloseTo(.01,10);
 for(const line of all)for(const p of line){expect(Math.abs(p[0])).toBeLessThanOrEqual(.2);expect(Math.abs(p[2])).toBeLessThanOrEqual(.15);}
 expect(g.major.some(l=>l[0]![0]===.05&&l[1]![0]===.05)).toBe(true);
});
