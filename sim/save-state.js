import {World} from './world.js';
import {controlAuthority} from './control-authority.js';
import {createRadar,radarContext,parseRadarContext} from './radar.js';
import {radarTaskContext,parseRadarTaskContext} from './radar-task.js';
import {attackTaskContext,parseAttackTaskContext} from './attack-task.js';
import {parseWeaponsContext,weaponsContext,restoreCarrierLoadout} from './weapons.js';
import {MISSILE_MODELS,MISSILE_PHASES} from './missiles.js';
import {createRwr,rwrContext,parseRwrContext} from './rwr.js';
import {defenseContext,parseDefenseContext} from './rwr-defense.js';
import {updateAircraftMass} from './aircraft-mass.js';

export const SAVE_VERSION=1;
const worldKeys=['spawnMode','executionMode','unitSystem','bullseye','time','ai','history','revision','commandLog','lastDt','radarTargets','radarTargetSequence','missiles','missileSequence','weaponEvents','rwrPracticeEmitters','rwrPracticeSequence'];
const airportKeys=['clock','events','wind','closed','closedTaxiways','weather','weatherSequence','weatherUpdatedAt','atc','procedures','frequencies'];
const forbidden=new Set(['__proto__','constructor','prototype']);
const fields=(value,exclude=[])=>Object.fromEntries(Object.entries(value).filter(([key,v])=>!exclude.includes(key)&&!forbidden.has(key)&&typeof v!=='function'));

// Waypoint identity and array metadata matter to the flight and training controllers.
// A small graph format preserves shared points, Sets and waypoint.number across JSON.
export function encodeState(value){
  const nodes=[],seen=new Map();
  function visit(v){
    if(v===undefined)return {undefined:true};
    if(typeof v==='number'&&!Number.isFinite(v))return {number:String(v)};
    if(v===null||typeof v!=='object')return v;
    if(seen.has(v))return {ref:seen.get(v)};
    const ref=nodes.length;seen.set(v,ref);nodes.push(null);
    nodes[ref]=v instanceof Set?{type:'set',items:[...v].map(visit)}:
      {type:Array.isArray(v)?'array':'object',properties:Object.entries(v).filter(([key,item])=>!forbidden.has(key)&&typeof item!=='function').map(([key,item])=>[key,visit(item)])};
    return {ref};
  }
  const root=visit(value);return {root,nodes};
}
export function decodeState(graph){
  if(!graph||!Array.isArray(graph.nodes)||graph.nodes.length>100000)throw Error('存档结构无效');
  const nodes=graph.nodes.map(n=>{if(!n||!['set','array','object'].includes(n.type))throw Error('存档节点无效');return n.type==='set'?new Set():n.type==='array'?[]:{};});
  function read(v){
    if(v===null||typeof v!=='object')return v;
    if(Number.isInteger(v.ref)&&v.ref>=0&&v.ref<nodes.length)return nodes[v.ref];
    if(v.undefined===true)return undefined;
    if(['Infinity','-Infinity','NaN'].includes(v.number))return Number(v.number);
    throw Error('存档引用无效');
  }
  graph.nodes.forEach((n,i)=>{
    if(n.type==='set'){if(!Array.isArray(n.items))throw Error('存档集合无效');for(const v of n.items)nodes[i].add(read(v));return;}
    if(!Array.isArray(n.properties))throw Error('存档字段无效');
    for(const pair of n.properties){
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||forbidden.has(pair[0])||pair[0]==='length'&&n.type==='array')throw Error('存档字段无效');
      nodes[i][pair[0]]=read(pair[1]);
    }
  });
  return read(graph.root);
}
export function saveFingerprint(scenario,profiles){
  const text=JSON.stringify([scenario,profiles]);let hash=2166136261;
  for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return 'demo-'+(hash>>>0).toString(16);
}
export function captureWorld(world){
  return {...Object.fromEntries(worldKeys.filter(k=>world[k]!==undefined).map(k=>[k,world[k]])),
    units:world.units.map(u=>fields(u,['profile','terrain'])),
    airportOps:world.airportOps?{leases:world.airportOps.leases,cooldown:world.airportOps.cooldown,eventSequence:world.airportOps.eventSequence,
      airport:Object.fromEntries(airportKeys.filter(k=>world.airportOps.airport[k]!==undefined).map(k=>[k,world.airportOps.airport[k]]))}:null};
}
export function restoreWorld(saved,scenario,profiles,terrain=null){
  const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  if(!saved||!['stands','airborne'].includes(saved.spawnMode)||!['strict','relaxed'].includes(saved.executionMode)||
    !Number.isFinite(saved.time)||saved.time<0||!Number.isInteger(saved.revision)||saved.revision<0||
    !Array.isArray(saved.units)||saved.units.length!==scenario.units.length)throw Error('飞行进度无效');
  const ids=new Set();
  if(saved.rwrPracticeEmitters!==undefined&&(!Array.isArray(saved.rwrPracticeEmitters)||saved.rwrPracticeEmitters.length>4||!Number.isSafeInteger(saved.rwrPracticeSequence)||saved.rwrPracticeSequence<0||saved.rwrPracticeEmitters.some(e=>!e||!/^rwr-practice-\d+$/.test(e.id)||!saved.units.some(u=>u.id===e.ownerId)||!['search','track','illumination','active'].includes(e.mode)||!vec(e.position)||!Number.isFinite(e.frequencyGHz)||e.frequencyGHz<=0||!Number.isFinite(e.createdAt)||e.createdAt<0||e.createdAt>saved.time)))throw Error('RWR演练存档无效');
  if(saved.missiles!==undefined){
    if(!Array.isArray(saved.missiles)||saved.missiles.length>512||!Number.isSafeInteger(saved.missileSequence)||saved.missileSequence<0||!Array.isArray(saved.weaponEvents)||saved.weaponEvents.length>48)throw Error('导弹存档无效');
    const missileIds=new Set();for(const m of saved.missiles){
      if(!m||!/^missile-\d+$/.test(m.id)||missileIds.has(m.id)||!MISSILE_MODELS.has(m.modelId)||!saved.units.some(u=>u.id===m.ownerId)||typeof m.targetId!=='string'||typeof m.alive!=='boolean'||!Object.hasOwn(MISSILE_PHASES,m.phase)||
        !vec(m.position)||!vec(m.velocity)||!vec(m.forward)||!m.observation||!vec(m.observation.position)||!vec(m.observation.velocity)||!Number.isFinite(m.observation.ageSec)||
        !['ageSec','travelM','massKg','speedMps','mach','loadFactor','thrustN','dragN','lostSec','trailClock','launchedAt'].every(k=>Number.isFinite(m[k])&&m[k]>=0)||
        !Array.isArray(m.trail)||m.trail.length>240||!m.trail.every(vec))throw Error('导弹飞行存档无效');missileIds.add(m.id);
    }
  }
  if(saved.radarTargets!==undefined&&(!Array.isArray(saved.radarTargets)||saved.radarTargets.length>8||saved.radarTargets.some(t=>!t||!/^tgt-\d+$/.test(t.id)||!vec(t.position)||!vec(t.velocity)||typeof t.callsign!=='string'||typeof t.alive!=='boolean')||!Number.isSafeInteger(saved.radarTargetSequence)||saved.radarTargetSequence<0))throw Error('雷达演练存档无效');
  for(const u of saved.units){
    if(!u||ids.has(u.id)||!scenario.units.some(s=>s.id===u.id)||!vec(u.position)||!vec(u.velocity)||
      typeof u.alive!=='boolean'||!['speed','bank','cl','holdAltitude','targetSpeed'].every(k=>Number.isFinite(u[k]))||
      !Array.isArray(u.waypoints)||!u.waypoints.every(vec)||!u.control||!Number.isFinite(u.control.bank))throw Error('飞机存档无效');
    ids.add(u.id);
    if(u.rwr){try{
      createRwr('f16',u.rwr.config);parseRwrContext(rwrContext(u,saved.time),saved.time);
      if(!['sequence','contactSequence'].every(k=>Number.isSafeInteger(u.rwr[k])&&u.rwr[k]>=0)||!Number.isFinite(u.rwr.accumulator)||u.rwr.accumulator<0||u.rwr.accumulator>=.051||!Array.isArray(u.rwr.events)||u.rwr.events.length>48)throw Error();
      parseDefenseContext(defenseContext(u),saved.time);
    }catch{throw Error('告警与自卫存档无效');}}
    if(u.attackTask){try{parseAttackTaskContext(attackTaskContext(u),saved.time);}catch{throw Error('自主攻击任务存档无效');}}
    if(u.radarTask?.active){try{parseRadarTaskContext(radarTaskContext(u),saved.time);}catch{throw Error('自主雷达任务存档无效');}}
    if(u.weapons){try{parseWeaponsContext(weaponsContext(u,saved.time),saved.time);if(!Number.isFinite(u.weapons.readySec)||u.weapons.readySec<0||!Number.isInteger(u.weapons.sequence)||u.weapons.sequence<0)throw Error();}catch{throw Error('武器存档无效');}}
    if(u.radar){
      const r=u.radar;
      try{createRadar('f16',r.config);parseRadarContext(radarContext(u,saved.time),saved.time);}catch{throw Error('雷达存档无效');}
      if(!['scanPhase','accumulator','acquiredSec','missingSec','sequence'].every(k=>Number.isFinite(r[k])&&r[k]>=0)||r.scanPhase>=1||r.accumulator>=.051||!Number.isInteger(r.sequence)||!Array.isArray(r.events)||r.events.length>32)throw Error('雷达存档无效');
    }
  }
  const world=new World(scenario,profiles,terrain,{spawnMode:saved.spawnMode,mode:saved.executionMode});
  for(const key of worldKeys)if(saved[key]!==undefined)world[key]=saved[key];
  for(const unit of world.units){
    const state=saved.units.find(u=>u.id===unit.id);Object.assign(unit,fields(state,['profile','terrain']));
    if(!state.controlAuthority){delete unit.controlAuthority;controlAuthority(world,unit);}
    unit.weapons=restoreCarrierLoadout(scenario.units.find(u=>u.id===unit.id).profile,unit.weapons);
    updateAircraftMass(unit,0);
    unit.terrain=terrain;if(unit.navigationPending)unit.navigationKey=null;unit.navigationPending=false;
    if(unit.radarTask)unit.radarTask.pending=false;
    if(unit.attackTask)unit.attackTask.pending=false;
  }
  if(world.airportOps){
    const savedOps=saved.airportOps;
    if(!savedOps||!savedOps.leases||!savedOps.cooldown||!savedOps.airport||!Array.isArray(savedOps.airport.events)||!Array.isArray(savedOps.airport.closed))throw Error('机场存档无效');
    for(const owner of Object.values(savedOps.leases))if(!ids.has(owner))throw Error('跑道占用存档无效');
    Object.assign(world.airportOps,{leases:savedOps.leases,cooldown:savedOps.cooldown,eventSequence:savedOps.eventSequence});
    for(const key of airportKeys)if(savedOps.airport[key]!==undefined)world.airportOps.airport[key]=savedOps.airport[key];
  }
  // Restored airport events remain history; only events created after this point go on air.
  world.airportRadioStartId=Math.max(world.airportOps?.eventSequence??0,...(world.airportOps?.airport.events??[]).map(e=>Number.isSafeInteger(e.id)?e.id:0));
  world.airportOps?.traffic.resume(world);
  return world;
}
