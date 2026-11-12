// This cheap gate runs without inference or GPU memory. It does not replace flight protection.
import {AIRPORT_INTENTS} from './airport.js';
import {executionEvent,executionObservation} from './pilot-execution.js';
import {ATC_INTENTS} from './atc-command.js';
import {playerOrderVersion} from './command-scope.js';
export const TACTICAL_INTENTS=Object.freeze(['intercept','attack','banzai','crank','f_pole','defend','notch','drag','disengage','reengage','bracket','extend','cover','cooperate','escort','follow_unit','join_formation','formation_change','formation_split','assign_role']);
export const ROUTINE_INTENTS=Object.freeze(['cruise','fly_heading','set_flight','fly_to','orbit','clear_waypoints','report_status','pause','resume','join_formation','follow_unit','formation_change','cover','escort','assign_role','return_to_base','defend','notch','drag',...AIRPORT_INTENTS,...ATC_INTENTS]);

export function pilotEvent(unit,time,blockedSince=null){
  if(unit.alive===false)return null;
  const execution=executionEvent(unit,time);if(execution)return execution;
  const contacts=(unit.pilotContacts??[]).filter(c=>c&&typeof c.id==='string'&&typeof c.source==='string'&&c.source&&
    Number.isFinite(c.observedAt)&&time>=c.observedAt&&time-c.observedAt<=5);
  const threat=contacts.find(c=>c.classification!=='friendly'&&(c.missileWarning===true||c.threat===true));
  if(threat)return {key:`threat:${unit.id}:${threat.id}:${!!threat.missileWarning}`,reason:'new_threat',summary:'发现需要判断的新威胁',contactId:threat.id};
  const mission=unit.pilotMission;
  if(mission&&mission.reviewed!==true&&TACTICAL_INTENTS.includes(mission.intent)&&!ROUTINE_INTENTS.includes(mission.intent)&&mission.timing==='now')return {
    key:`mission:${unit.id}:${mission.id}`,reason:'tactical_mission',summary:'收到战术任务，需要判断执行条件'};
  if(unit.navigationBlocked&&!unit.navigationPending&&Number.isFinite(blockedSince)&&time-blockedSince>=10)return {
    key:`blocked:${unit.id}:${blockedSince}`,reason:'route_blocked',summary:'程序多次规划后航路仍被阻断'};
  return null;
}

export function pilotObservation(world,unit,blockedSince=null){
  const saved=unit.pilotMission;
  const mission=saved&&(saved.orderVersion!==undefined?saved.orderVersion===playerOrderVersion(world,unit.id):saved.revision===world.revision)?saved:null;
  const event=pilotEvent({...unit,pilotMission:mission},world.time,blockedSince);if(!event)return null;
  return {unitId:unit.id,event,blockedSince,blockedReason:unit.navigationBlocked||null,
    mission:mission?structuredClone(mission):null,execution:executionObservation(unit),
    contacts:(unit.pilotContacts??[]).filter(c=>c&&Number.isFinite(c.observedAt)&&world.time>=c.observedAt&&world.time-c.observedAt<=5).slice(0,16).map(c=>({
      id:c.id,source:c.source,classification:c.classification??'unknown',observedAt:c.observedAt,threat:c.threat===true,missileWarning:c.missileWarning===true,
      position:c.position??null,velocity:c.velocity??null}))};
}
