import type {V3} from './geometry';
/** Metres, centered on the field. Major lines every 5 cm; no accumulated float steps. */
export const centimeterGrid=(width:number,depth:number):{minor:V3[][];major:V3[][]}=>{
 const minor:V3[][]=[],major:V3[][]=[];
 for(let i=Math.ceil(-width*50);i<=Math.floor(width*50);i++)(i%5===0?major:minor).push([[i/100,0,-depth/2],[i/100,0,depth/2]]);
 for(let i=Math.ceil(-depth*50);i<=Math.floor(depth*50);i++)(i%5===0?major:minor).push([[-width/2,0,i/100],[width/2,0,i/100]]);
 return {minor,major};
};
