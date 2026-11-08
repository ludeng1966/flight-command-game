import {World} from './world.js';
import {AirportOperations} from './airport.js';
import {captureWorld,encodeState,decodeState} from './save-state.js';
import {preparePilotPlan} from './orders.js';
import {TerrainHeight} from './terrain.js';
import {setUnitSystem} from './units.js';

export function commandPlanningSnapshot(world){
  return encodeState({state:captureWorld(world),profiles:world.units.map(u=>u.profile),
    airport:world.airportOps?.airport??null,groundSlots:world.airportOps?.groundSlots??{}});
}
export function runCommandPlanning(job,terrain=null){
  const {state,profiles,airport,groundSlots}=decodeState(job.snapshot),world=Object.assign(Object.create(World.prototype),state,{terrain});
  world.units=state.units.map((u,i)=>({...u,profile:profiles[i],terrain}));
  if(airport){world.airportOps=new AirportOperations(airport);Object.assign(world.airportOps,{leases:state.airportOps.leases,cooldown:state.airportOps.cooldown,eventSequence:state.airportOps.eventSequence,groundSlots,world});}
  else world.airportOps=null;
  setUnitSystem(world.unitSystem??'metric');
  const draft=preparePilotPlan(world,job.plan,job.expectedRevision,job.options);
  for(const [unitId,plan]of draft.flightPlans??[]){const unit=world.units.find(u=>u.id===unitId),points=draft.plannedRoutes.get(unitId).points;
    plan.seed={position:[...unit.position],velocity:[...unit.velocity],speed:unit.speed,bank:unit.bank,targetSpeed:job.plan.tasks.filter(t=>t.unitId===unitId&&Number.isFinite(t.speedMps)).at(-1)?.speedMps??unit.targetSpeed,key:JSON.stringify(points.map(p=>p.slice(0,3)))};
  }
  return encodeState({status:draft.status,expectedRevision:draft.expectedRevision,radioStyle:draft.radioStyle,sampledAt:world.time,
    headingPlans:[...(draft.headingPlans??[])],flightPlans:[...(draft.flightPlans??[])],departurePlans:[...(draft.departurePlans??[])],plannedRoutes:[...(draft.plannedRoutes??[])],routeSignatures:Object.fromEntries(world.units.map(u=>[u.id,JSON.stringify(u.waypoints.map(p=>p.slice(0,3)))])),previews:draft.previews??[]});
}
export function hydrateCommandDraft(world,plan,payload){
  const data=decodeState(payload);
  return {...data,world,plan,headingPlans:new Map(data.headingPlans),flightPlans:new Map(data.flightPlans),departurePlans:new Map(data.departurePlans),plannedRoutes:new Map(data.plannedRoutes),backgroundPrepared:true,committed:false};
}
let terrain=null;
if(typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope)self.onmessage=event=>{
  const job=event.data;if(job.type==='init'){terrain=job.buffer?new TerrainHeight(job.meta,new Float32Array(job.buffer)):null;return;}
  try{self.postMessage({id:job.id,result:runCommandPlanning(job,terrain)});}
  catch(error){self.postMessage({id:job.id,error:error.message});}
};
