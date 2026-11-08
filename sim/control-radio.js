import {createCommanderTransmission} from './commander-message.js';
import {controlAuthority} from './control-authority.js';
import {AIRPORT_STATIONS} from './airport-atc.js';
const airportActions=new Set(['taxi','hold_short','line_up','takeoff','abort_takeoff','approach','land','return_to_base','go_around']);
export function towerTask(reply,world){
  const tasks=reply.plan?.tasks??[];return tasks.length>0&&tasks.every(t=>t.unitId&&(t.action==='atc'||t.action==='airport'&&airportActions.has(t.airportOrder.intent)||t.action==='report_status'&&controlAuthority(world,world.units.find(u=>u.id===t.unitId)).owner==='tower'));
}
export function createTowerTransmission(reply,world,style,system){
  const airport=world.airportOps?.airport.id??'BAY',base=createCommanderTransmission(reply,world.units,style,system);
  const tasks=reply.plan?.tasks??[],units=tasks.map(t=>world.units.find(u=>u.id===t.unitId)).filter(Boolean),airborne=units.some(u=>!u.surface?.grounded),station=airborne?'approach':units.some(u=>['holding','lined_up','takeoff_roll'].includes(u.surface?.phase))?'tower':'ground',name=AIRPORT_STATIONS[station];
  const texts={zh:base.texts.zh.replaceAll('，指挥台。',`，${airport}${name.zh}。`),en:base.texts.en.replaceAll(', CONTROL.',`, ${airport} ${name.en}.`)};
  if(tasks.some(t=>t.action==='airport'&&['takeoff','land','approach'].includes(t.airportOrder.intent))){texts.zh+='这是进离场任务安排，各阶段等待相应许可。';texts.en+=' THIS IS AN AIRPORT TASK ASSIGNMENT. AWAIT SEPARATE PHASE CLEARANCES.';}
  return {...base,speaker:'controller',label:`${name.zh} · ${airport}`,text:texts[style==='nato'?'en':'zh'],texts,controllerRole:station};
}
