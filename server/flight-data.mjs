import fs from 'node:fs';import path from 'node:path';import {performanceAt} from '../sim/performance.js';
export function createFlightDataApi(root){
  const cache=new Map(),folder=path.join(root,'data','flight-research');
  const read=file=>{const stat=fs.statSync(file),entry=cache.get(file);if(entry?.mtime===stat.mtimeMs)return entry.data;const data=JSON.parse(fs.readFileSync(file,'utf8'));cache.set(file,{mtime:stat.mtimeMs,data});return data;};
  return url=>{
    if(!url.pathname.startsWith('/api/flight-data/'))return null;
    try{
      const catalog=read(path.join(folder,'catalog.json'));
      if(url.pathname==='/api/flight-data/catalog')return {status:200,data:catalog};
      if(url.pathname==='/api/flight-data/missile'){
        const id=url.searchParams.get('id');if(!id||!/^[-a-z0-9_]+$/.test(id)||!catalog.missiles.some(m=>m.id===id))return {status:404,data:{error:'导弹数据不存在'}};
        return {status:200,data:read(path.join(folder,'missiles',id+'.json'))};
      }
      if(url.pathname==='/api/flight-data/performance'){
        const profiles=read(path.join(root,'data','aircraft.json')),id=url.searchParams.get('aircraft')??'f16';if(!Object.hasOwn(profiles,id))return {status:404,data:{error:'机型不存在'}};
        const options={};for(const key of ['altitudeM','speedMps','loadG','afterburner','throttle','massKg'])if(url.searchParams.has(key))options[key]=Number(url.searchParams.get(key));
        for(const key of ['gearDown','speedBrake'])if(url.searchParams.has(key)){const value=url.searchParams.get(key);if(!['true','false'].includes(value))throw Error('构型参数必须为true或false');options[key]=value==='true';}
        if(url.searchParams.has('flaps'))options.flaps=url.searchParams.get('flaps');
        return {status:200,data:{aircraft:id,performance:performanceAt(profiles[id],options),profileProvenance:profiles[id].provenance??null}};
      }
      return {status:404,data:{error:'数据接口不存在'}};
    }catch(error){if(error.code==='ENOENT')return {status:503,data:{error:'飞行数据尚未导入，请运行数据导入工具'}};return {status:400,data:{error:'性能参数或数据格式无效'}};}
  };
}
