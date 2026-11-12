import {setUnitSystem} from './units.js';
import {TerrainHeight} from './terrain.js';
import {planSafeRoute,traceFlight} from './safe-navigation.js';
let terrain=null;
export function runJob(job,heightfield=terrain){
  setUnitSystem(job.unitSystem??'metric');
  const unit={...job.unit,terrain:heightfield};
  if(job.type==='check')return traceFlight(unit,job.route,unit.navLegs??[],{duration:14,cursor:unit.navCursor??0});
  if(job.type==='trace')return traceFlight(unit,job.route,unit.navLegs??[],{duration:180,cursor:unit.navCursor??0});
  const result=planSafeRoute(unit,job.route,heightfield);
  result.seed={profileId:unit.profileId,position:unit.position,velocity:unit.velocity,speed:Math.hypot(...unit.velocity),bank:unit.bank,targetSpeed:unit.targetSpeed,key:JSON.stringify(job.route)};
  return result;
}
if(typeof self!=='undefined')self.onmessage=event=>{
  const job=event.data;
    if(job.type==='init'){terrain=job.buffer?new TerrainHeight(job.meta,new Float32Array(job.buffer)):null;return;}
  try{self.postMessage({id:job.id,result:runJob(job)});}
  catch(error){self.postMessage({id:job.id,result:{valid:false,reason:error.message,points:[],warnings:['航路计算未能完成']}});}
};
