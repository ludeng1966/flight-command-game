import {World} from './world.js';
import {AirportOperations} from './airport.js';
import {captureWorld,encodeState,decodeState} from './save-state.js';
import {preparePilotPlan} from './orders.js';
import {TerrainHeight} from './terrain.js';
import {setUnitSystem} from './units.js';
import {navigationEnvelope} from './energy.js';
import {commandUnits} from './battle-observation.js';
import {resetDatalink} from './datalink.js';
import {applyPilotAdjustment} from './pilot-execution.js';

export function commandPlanningSnapshot(world){
  return encodeState({state:captureWorld(world),profiles:world.units.map(u=>u.profile),
    airport:world.airportOps?.airport??null,groundSlots:world.airportOps?.groundSlots??{}});
}
export function planningWorld(snapshot,terrain=null){
  const {state,profiles,airport,groundSlots}=decodeState(snapshot),world=Object.assign(Object.create(World.prototype),state,{terrain});
  world.units=state.units.map((u,i)=>({...u,profile:profiles[i],terrain}));
  for(const unit of world.units)resetDatalink(unit);
  if(airport){world.airportOps=new AirportOperations(airport);Object.assign(world.airportOps,{leases:state.airportOps.leases,cooldown:state.airportOps.cooldown,eventSequence:state.airportOps.eventSequence,groundSlots,groundNodeSlots:state.airportOps.groundNodeSlots??{},world});world.airportOps.traffic.nextThink=state.airportOps.nextThink??world.time;}
  else world.airportOps=null;
  setUnitSystem(world.unitSystem??'metric');
  return world;
}
export function runCommandForecast(job,terrain=null){
  const world=planningWorld(job.snapshot,terrain),forecasts=[];
  // Forecast own flight only. Hidden aircraft, radar targets or missile truth
  // must not change a model's prediction via future collisions/detections/hits.
  // Existing own orders and sampled warning state still drive the flight model.
  world.units=commandUnits(world);world.radarTargets=[];world.missiles=[];
  // A private simulation follows the existing orders. It cannot issue new live orders.
  world.playerCommandPending=true;world.ensureNavigation=()=>{};
  const start=world.time;
  for(const outputSec of job.timing.horizonsSec){
    const target=start+(job.timing.playing?outputSec*job.timing.rate:0);
    while(world.time<target-1e-7)world.step(Math.min(.05,target-world.time));
    forecasts.push({outputSec,simTimeSec:world.time,units:commandUnits(world).map(u=>({id:u.id,position:[...u.position],velocity:[...u.velocity],alive:u.alive!==false,navigationEnvelope:navigationEnvelope(u)}))});
  }
  return {...job.timing,forecasts};
}
export function runCommandPlanning(job,terrain=null){
  const world=planningWorld(job.snapshot,terrain);
  const draft=preparePilotPlan(world,job.plan,job.expectedRevision,job.options);
  for(const [unitId,plan]of draft.flightPlans??[]){const unit=world.units.find(u=>u.id===unitId),points=draft.plannedRoutes.get(unitId).points;
    plan.seed={profileId:unit.profileId,position:[...unit.position],velocity:[...unit.velocity],speed:unit.speed,bank:unit.bank,targetSpeed:job.plan.tasks.filter(t=>t.unitId===unitId&&Number.isFinite(t.speedMps)).at(-1)?.speedMps??unit.targetSpeed,key:JSON.stringify(points.map(p=>p.slice(0,3)))};
  }
  return encodeState({status:draft.status,expectedRevision:draft.expectedRevision,radioStyle:draft.radioStyle,sampledAt:world.time,
    headingPlans:[...(draft.headingPlans??[])],flightPlans:[...(draft.flightPlans??[])],departurePlans:[...(draft.departurePlans??[])],plannedRoutes:[...(draft.plannedRoutes??[])],routeSignatures:Object.fromEntries(world.units.map(u=>[u.id,JSON.stringify(u.waypoints.map(p=>p.slice(0,3)))])),previews:draft.previews??[]});
}
export function runAdjustmentPlanning(job,terrain=null){
  const world=planningWorld(job.snapshot,terrain),unit=world.units.find(u=>u.id===job.unitId);
  if(!unit)throw Error('受令机不存在');
  const seed={profileId:unit.profileId,position:[...unit.position],velocity:[...unit.velocity],speed:unit.speed,bank:unit.bank,targetSpeed:job.adjustment.speedMps};
  const result=applyPilotAdjustment(world,unit,job.adjustment,job.executionId);
  const points=unit.waypoints.map(p=>p.slice(0,3));seed.key=JSON.stringify(points);
  return {sampledAt:world.time,executionId:job.executionId,adjustment:JSON.stringify(job.adjustment),seed,result,
    navigation:!result.predictedRecoverySeconds&&(job.adjustment.via.length||unit.navLegs?.length)?{valid:true,points,legs:unit.navLegs,cursor:unit.navCursor??0,detour:unit.navDetour,continuous:unit.navContinuous,seed}:null};
}
export function runRoutePlanning(job,terrain=null){
  const world=planningWorld(job.snapshot,terrain),unit=world.units.find(u=>u.id===job.unitId);if(!unit)throw Error('受令机不存在');
  const plan=world.planRoute(unit.id,job.points,job.targetSpeed,{resetPower:true});
  plan.seed={profileId:unit.profileId,position:[...unit.position],velocity:[...unit.velocity],speed:unit.speed,bank:unit.bank,targetSpeed:job.targetSpeed,key:JSON.stringify(job.points.map(p=>p.slice(0,3)))};return plan;
}
export function hydrateCommandDraft(world,plan,payload){
  const data=decodeState(payload);
  return {...data,world,plan,headingPlans:new Map(data.headingPlans),flightPlans:new Map(data.flightPlans),departurePlans:new Map(data.departurePlans),plannedRoutes:new Map(data.plannedRoutes),backgroundPrepared:true,committed:false};
}
let terrain=null;
if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope)self.onmessage=event=>{
  const job=event.data;if(job.type==='init'){terrain=job.buffer?new TerrainHeight(job.meta,new Float32Array(job.buffer)):null;return;}
  try{self.postMessage({id:job.id,result:job.type==='forecast'?runCommandForecast(job,terrain):job.type==='adjustment'?runAdjustmentPlanning(job,terrain):job.type==='route'?runRoutePlanning(job,terrain):runCommandPlanning(job,terrain)});}
  catch(error){self.postMessage({id:job.id,error:error.message});}
};
