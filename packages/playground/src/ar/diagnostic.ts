/** Local, uncompressed ZIP writer. No network, no image upload. */
const encoder=new TextEncoder();
export const crc32=(data:Uint8Array):number=>{let crc=0xffffffff;for(const byte of data){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
export const zip=(files:{name:string;data:Uint8Array}[]):Uint8Array=>{
  const chunks:Uint8Array[]=[],directory:Uint8Array[]=[];let offset=0;
  for(const file of files){const name=encoder.encode(file.name),crc=crc32(file.data),header=new Uint8Array(30+name.length),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,file.data.length,true);h.setUint32(22,file.data.length,true);h.setUint16(26,name.length,true);header.set(name,30);chunks.push(header,file.data);
    const d=new Uint8Array(46+name.length),v=new DataView(d.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint16(14,33,true);v.setUint32(16,crc,true);v.setUint32(20,file.data.length,true);v.setUint32(24,file.data.length,true);v.setUint16(28,name.length,true);v.setUint32(42,offset,true);d.set(name,46);directory.push(d);offset+=header.length+file.data.length;
  }
  const directoryLength=directory.reduce((s,c)=>s+c.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,directoryLength,true);v.setUint32(16,offset,true);chunks.push(...directory,end);const out=new Uint8Array(offset+directoryLength+22);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return out;
};
export const jsonBytes=(v:unknown):Uint8Array=>encoder.encode(JSON.stringify(v,null,2));
export const png=(canvas:HTMLCanvasElement):Promise<Uint8Array>=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?void b.arrayBuffer().then(a=>resolve(new Uint8Array(a)),reject):reject(Error('Не удалось сохранить PNG')),'image/png'));
export interface DiagnosticShot { id:string; data:Record<string,unknown>; raw:Uint8Array; composite:Uint8Array }
export class DiagnosticStore {
  readonly shots:DiagnosticShot[]=[];
  readonly limit=5;
  readonly maxBytes=32*1024*1024;
  get bytes():number{return this.shots.reduce((s,v)=>s+v.raw.length+v.composite.length+jsonBytes(v.data).length,0);}
  add(shot:DiagnosticShot):void { if(shot.raw.length+shot.composite.length+jsonBytes(shot.data).length>this.maxBytes)throw Error('Кадр превышает лимит 32 МБ');while(this.shots.length>=this.limit||this.bytes+shot.raw.length+shot.composite.length+jsonBytes(shot.data).length>this.maxBytes)this.shots.shift();this.shots.push(shot); }
  export(trace:unknown):Uint8Array {
    const entries=this.shots.map(s=>({id:s.id,metadata:`${s.id}/frame.json`,camera:`${s.id}/camera.png`,overlay:`${s.id}/overlay.png`,capture:s.data.capture,estimates:s.data.estimates}));
    return zip([{name:'manifest.json',data:jsonBytes({version:1,containsCameraImages:true,imagesUploaded:false,coordinateUnits:'metres',clock:'performance.timeOrigin + performance.now(); capture is sampled before drawing the video snapshot; processing completion is separate',entries})},{name:'trace.json',data:jsonBytes(trace)},...this.shots.flatMap(s=>[{name:`${s.id}/frame.json`,data:jsonBytes(s.data)},{name:`${s.id}/camera.png`,data:s.raw},{name:`${s.id}/overlay.png`,data:s.composite}])]);
  }
}
