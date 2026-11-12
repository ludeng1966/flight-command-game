import {basis,dot,norm} from './flight.js';
import {radarGeometry} from './radar.js';
import {lineClear,MISSILE_MODELS} from './missiles.js';
import {RWR_REFERENCE} from '../data/rwr-reference.js';
import {beamGate,inBeam} from './radar-beam.js';
const emissionGates=new WeakMap();

export const RWR_LEVELS={search:1,track:2,launch:3};
export const RWR_LABELS={search:'搜索辐射',track:'雷达跟踪',launch:'疑似雷达导弹发射'};
export const RWR_DEFAULTS={rangeM:RWR_REFERENCE.rangeM,holdSec:RWR_REFERENCE.holdSec,trackedMax:RWR_REFERENCE.trackedMax,
  elevationHalfDeg:45,bearingStepDeg:15,minFrequencyGHz:2,maxFrequencyGHz:20,detectTracking:true,detectLaunch:true};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),degrees=v=>v*180/Math.PI;
const difference=(a,b)=>Math.abs(((a-b+540)%360)-180),distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
export function createRwr(profileId,override){
  const available=override===false?false:profileId==='f16'||!!override;
  const config={...RWR_DEFAULTS,...(override&&typeof override==='object'?override:{})};
  for(const key of ['rangeM','holdSec','trackedMax','elevationHalfDeg','bearingStepDeg','minFrequencyGHz','maxFrequencyGHz'])if(!Number.isFinite(config[key])||config[key]<=0)throw Error('RWR参数无效');
  if(config.trackedMax>32||config.elevationHalfDeg>90||config.bearingStepDeg>90||config.minFrequencyGHz>=config.maxFrequencyGHz||typeof config.detectTracking!=='boolean'||typeof config.detectLaunch!=='boolean')throw Error('RWR配置无效');
  return {available,enabled:true,config,contacts:[],events:[],sequence:0,contactSequence:0,accumulator:0};
}
export function rwrEvent(unit,time,type,text,extra={}){
  const r=unit.rwr;if(!r)return;const e={sequence:++r.sequence,time,type,text,controlSequence:unit.rwrDefense?.controlSequence??0,...extra};r.events.push(e);if(r.events.length>48)r.events.shift();return e;
}
function radarEmission(world,source,receiver,dt){
  const r=source.radar;if(!r?.available||r.mode==='off'||source.alive===false||source.surface?.grounded)return null;
  if(r.sensorModelVersion===2){
    let cached=emissionGates.get(r);
    if(!cached||cached.events!==r.emissions||cached.time!==world.time){const pose=source.sensorPose??r.antennaPose??basis(source);cached={events:r.emissions,time:world.time,gates:(r.emissions??[]).map(e=>({e,gate:beamGate(source.position,pose,e,e.beamHalfDeg,r.config)}))};emissionGates.set(r,cached);}
    const e=cached.gates.find(({gate})=>inBeam(gate,receiver.position[0],receiver.position[1],receiver.position[2]))?.e;
    if(!e)return null;
    return {key:'radar:'+source.id,position:source.position,level:e.role==='illumination'?'launch':e.job==='search'?'search':'track',frequencyGHz:r.config.frequencyGHz??8.5,signature:'fighter'};
  }
  const g=radarGeometry(source,receiver,r.config,world.terrain);
  if(Math.abs(g.azimuthDeg)>r.config.azimuthHalfDeg||Math.abs(g.elevationDeg)>r.config.elevationHalfDeg)return null;
  let level='search',beam;
  if(r.targetId){
    const track=r.contacts.find(c=>c.id===r.targetId);
    if(track){const delta=track.position.map((v,i)=>v+track.velocity[i]*Math.max(0,world.time-track.observedAt)-source.position[i]);beam=norm(delta);}
    else return null;
    const los=norm(receiver.position.map((v,i)=>v-source.position[i]));
    if(degrees(Math.acos(clamp(dot(beam,los),-1,1)))>r.config.beamHalfDeg)return null;
    if(r.established)level='track';
    if(r.canIlluminate&&world.missiles.some(m=>m.alive&&m.ownerId===source.id&&m.targetId===r.targetId&&MISSILE_MODELS.get(m.modelId)?.kind==='semi_active_radar'))level='launch';
  }else{
    const az=-r.config.azimuthHalfDeg+2*r.config.azimuthHalfDeg*r.scanPhase;
    // Cover the sweep during this sensor tick, including its wrap boundary.
    const width=r.config.beamHalfDeg+2*r.config.azimuthHalfDeg*dt/r.config.sweepSec;
    if(Math.abs(g.azimuthDeg-az)>width&&Math.abs(g.azimuthDeg-(az+2*r.config.azimuthHalfDeg))>width)return null;
  }
  return {key:'radar:'+source.id,position:source.position,level,frequencyGHz:r.config.frequencyGHz??8.5,
    signature:source.profile?.id==='f16'||source.rwrSignalClass==='fighter'||source.profile?.name?.includes('16')?'fighter':'radar'};
}
function missileEmission(m){
  const model=MISSILE_MODELS.get(m.modelId);if(!m.alive||!m.active||model?.kind!=='active_radar'||m.ageSec>(model.seeker.workSec??model.lifetimeSec))return null;
  const estimate=m.observation.position.map((v,i)=>v+m.observation.velocity[i]*m.observation.ageSec),beam=norm(estimate.map((v,i)=>v-m.position[i]));
  if(degrees(Math.acos(clamp(dot(beam,m.forward),-1,1)))>(model.seeker.gimbalAngleDeg??55))return null;
  return {key:'missile:'+m.id,position:m.position,beam,beamHalfDeg:model.guidance.radar?.transmitter?.antenna?.angleHalfSens??15,
    level:'launch',frequencyGHz:8.5,signature:'missile'};
}
function receive(world,unit,signal,time){
  const r=unit.rwr,config=r.config;
  if(signal.frequencyGHz<config.minFrequencyGHz||signal.frequencyGHz>config.maxFrequencyGHz||distance(signal.position,unit.position)>config.rangeM||!lineClear(world.terrain,unit.position,signal.position))return;
  const toSource=norm(signal.position.map((v,i)=>v-unit.position[i])),pose=basis(unit);
  if(Math.abs(degrees(Math.asin(clamp(dot(toSource,pose.up),-1,1))))>config.elevationHalfDeg)return;
  if(signal.beam){const outward=norm(unit.position.map((v,i)=>v-signal.position[i]));if(degrees(Math.acos(clamp(dot(outward,signal.beam),-1,1)))>signal.beamHalfDeg)return;}
  let level=signal.level;
  // Only recognised signal classes provide a launch indication; no universal launch flag.
  if(level==='launch'&&(!config.detectLaunch||!['fighter','missile'].includes(signal.signature)))level='track';
  if(level==='track'&&!config.detectTracking)level='search';
  const bearingDeg=(Math.round((degrees(Math.atan2(toSource[0],toSource[1]))+360)%360/config.bearingStepDeg)*config.bearingStepDeg)%360;
  let contact=r.contacts.find(c=>c.emitterKey===signal.key);
  if(!contact){
    if(r.contacts.length>=config.trackedMax){r.contacts.sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level]||b.observedAt-a.observedAt);if(RWR_LEVELS[level]<=RWR_LEVELS[r.contacts.at(-1).level])return;r.contacts.pop();}
    contact={id:'RWR-'+(++r.contactSequence),emitterKey:signal.key,firstSeen:time,observedAt:time,level,peakLevel:level,epoch:1,bearingDeg,signalType:signal.signature==='missile'?'active_seeker':'radar'};
    r.contacts.push(contact);rwrEvent(unit,time,'detected',`${RWR_LABELS[level]}，方位约${bearingDeg}度`,{contactId:contact.id,level,bearingDeg});
  }else{
    const upgrade=RWR_LEVELS[level]>RWR_LEVELS[contact.level];
    if(upgrade){contact.epoch++;contact.peakLevel=level;rwrEvent(unit,time,'escalated',`${RWR_LABELS[level]}，方位约${bearingDeg}度`,{contactId:contact.id,level,bearingDeg});}
    Object.assign(contact,{level,bearingDeg,observedAt:time});
  }
}
export function stepRwr(world,dt){
  for(const unit of world.units){const r=unit.rwr;if(!r?.available)continue;r.accumulator+=dt;
    if(r.accumulator+1e-9<.05)continue;const interval=r.accumulator;r.accumulator=0;
    if(!r.enabled||unit.alive===false||unit.surface?.grounded){r.contacts=[];continue;}
    const time=world.time;
    for(const source of [...world.units,...(world.radarTargets??[])])if(source.id!==unit.id){const signal=radarEmission(world,source,unit,interval);if(signal)receive(world,unit,signal,time);}
    for(const m of world.missiles??[]){if(m.ownerId===unit.id)continue;const signal=missileEmission(m);if(signal)receive(world,unit,signal,time);}
    for(const e of world.rwrPracticeEmitters??[]){
      if(e.ownerId!==unit.id||time-e.createdAt>120)continue;
      const level=e.mode==='search'?'search':e.mode==='track'?'track':'launch';
      // Training signals are deliberately directed at the receiver, not hidden missiles.
      if(level==='search'&&(time-e.createdAt)%2>.15)continue;
      receive(world,unit,{key:e.id,position:e.position,frequencyGHz:e.frequencyGHz,signature:e.mode==='active'?'missile':'fighter',level},time);
    }
    const expired=r.contacts.filter(c=>time-c.observedAt>r.config.holdSec);
    for(const c of expired)rwrEvent(unit,time,'lost','辐射信号消失；不代表威胁已解除',{contactId:c.id,level:c.level});
    r.contacts=r.contacts.filter(c=>time-c.observedAt<=r.config.holdSec);
  }
}
export function rwrContext(unit,time){
  const r=unit.rwr;if(!r)return null;
  return {available:r.available,enabled:r.enabled,contacts:r.contacts.map(c=>({id:c.id,level:c.level,epoch:c.epoch,bearingDeg:c.bearingDeg,signalType:c.signalType,
    firstSeen:c.firstSeen,observedAt:c.observedAt,ageSec:Math.max(0,time-c.observedAt)}))};
}
export function parseRwrContext(r,time){
  if(r==null)return null;
  if(typeof r.available!=='boolean'||typeof r.enabled!=='boolean'||!Array.isArray(r.contacts)||r.contacts.length>32)throw Error('RWR上下文无效');
  const ids=new Set();for(const c of r.contacts){if(!c||!/^RWR-\d+$/.test(c.id)||ids.has(c.id)||!Object.hasOwn(RWR_LEVELS,c.level)||!Number.isInteger(c.epoch)||c.epoch<1||!Number.isFinite(c.bearingDeg)||c.bearingDeg<0||c.bearingDeg>=360||!['radar','active_seeker'].includes(c.signalType)||![c.firstSeen,c.observedAt,c.ageSec].every(v=>Number.isFinite(v)&&v>=0)||c.firstSeen>c.observedAt||c.observedAt>time+.001||Math.abs(c.ageSec-(time-c.observedAt))>.01)throw Error('RWR观测无效');ids.add(c.id);}
  // Rebuild only permitted observations; source identity/range/position never cross this boundary.
  return {available:r.available,enabled:r.enabled,contacts:r.contacts.map(({id,level,epoch,bearingDeg,signalType,firstSeen,observedAt,ageSec})=>({id,level,epoch,bearingDeg,signalType,firstSeen,observedAt,ageSec}))};
}
export function strongestRwr(unit,time){return unit.rwr?.enabled?unit.rwr.contacts.filter(c=>time-c.observedAt<=Math.min(2.5,unit.rwr.config.holdSec)).sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level]||b.observedAt-a.observedAt)[0]??null:null;}
export function bearingClock(unit,bearing){const heading=(degrees(Math.atan2(unit.velocity[0],unit.velocity[1]))+360)%360;return Math.round(((bearing-heading+360)%360)/30)%12||12;}
export {difference as angleDifference};
