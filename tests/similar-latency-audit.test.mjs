import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {TowerSupervisor} from '../game/tower-supervisor.js';
import {notePlayerOrder} from '../sim/command-scope.js';import {beginPilotExecution,applyPilotAdjustment} from '../sim/pilot-execution.js';
import {CommandPlanner} from '../game/command-planner.js';import {createFlightWorker} from '../tools/node-flight-planner.mjs';
import {TacticalDirector} from '../game/tactical-director.js';
import {pilotContext,commandContext} from '../sim/orders.js';import {validateContext} from '../server/qwen.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));
const settle=()=>new Promise(r=>setImmediate(r));
test('tower retains unrelated progress, rejects changed recipients/requests/weather and retries expired assessments',async t=>{
 for(const condition of ['unrelated','recipient','request','weather','expired']){const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0];w.airportOps.traffic.request(u,'departure',w);let finish,input,at=0,calls=0;
  const tower=new TowerSupervisor({getWorld:()=>w,now:()=>at,fetchImpl:(_p,o)=>{calls++;input=JSON.parse(o.body);return new Promise(r=>finish=r);}});t.after(()=>tower.reset());tower.tick();assert.equal(calls,1);
  w.revision++;if(condition==='recipient')notePlayerOrder(w,[u.id]);else if(condition==='request')w.airportOps.traffic.request(u,'arrival',w);else if(condition==='weather')w.airportOps.airport.closed.push('test-closure');else if(condition==='expired')w.time+=11;else notePlayerOrder(w,[w.units[1].id]);
  finish(Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,decisions:[{unitId:u.id,action:'hold',reason:'当前请求建议保持'}]}));await settle();
  assert.equal((w.airportOps.traffic.state.recommendations??[]).length,condition==='unrelated'?1:0,condition);
  if(condition==='expired'){at=1001;tower.tick();assert.equal(calls,2);}
 }
});
test('flight adjustment route trials run on a real worker and preserve the original navigation goals',async t=>{
 const w=new World({units:[{id:'a',callsign:'A',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles),u=w.units[0];u.headingTarget=0;u.waypoints=[[0,12000,6500]];u.navigationBlocked='needs replanning';beginPilotExecution(w,u);
 const planner=new CommandPlanner(null,{workerFactory:createFlightWorker});t.after(()=>planner.cancel());const adjustment={throttle:1,afterburner:0,speedMps:250,via:[]};
 const prepared=await planner.adjustment(w,u,adjustment,u.pilotExecution.id);assert(prepared.navigation?.valid);assert(u.navigationBlocked);assert.equal(u.pilotPowerPlan,null);
 w.planRoute=()=>assert.fail('main-thread route solve is forbidden');const result=applyPilotAdjustment(w,u,adjustment,u.pilotExecution.id,{prepared});assert.equal(result.viaCount,0);assert.deepEqual(u.waypoints.map(p=>p.slice(0,3)),[[0,12000,6500]]);assert.equal(u.navigationBlocked,null);
});
test('post-maneuver route recovery waits in the background and cannot overwrite a new player order',async()=>{
 const w=new World({units:[{id:'a',callsign:'A',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles),u=w.units[0];let finish,called=0;
 const director=new TacticalDirector({getWorld:()=>w,prepareRoute:async()=>{called++;return new Promise(r=>finish=r);}}),d={id:'direct-1',maneuver:'turn_left',phase:'recovering'},g={offense:'auto',defense:'survival',revision:0,direct:d,resume:{points:[[0,0,6500],[0,12000,6500]],speed:250}};u.tacticalGuidance=g;
 const pending=director.completeRecovery(w,u,g,d);assert.equal(called,1);assert(d.pending);const before=[...u.position];u.headingTarget=0;for(let i=0;i<30;i++)w.step(1/60);assert(u.position[1]>before[1]);
 notePlayerOrder(w,[u.id]);finish({valid:true});await pending;assert.equal(u.waypoints.length,0);assert.notEqual(d.phase,'completed');assert.equal(d.pending,false);director.reset();
});
test('CPU planning queues more than eight requests without rejection and samples when dispatched',async t=>{
 const w=new World({units:[{id:'a',callsign:'A',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles),workers=[];
 const planner=new CommandPlanner(null,{maxWorkers:2,workerFactory:()=>{const x={jobs:[],postMessage(j){if(j.type!=='init')this.jobs.push(j);},terminate(){}};workers.push(x);return x;}});t.after(()=>planner.cancel());
 const requests=Array.from({length:12},()=>planner.route(w,w.units[0],[[0,10000,6500]],250));assert.equal(workers.length,2);assert.equal(planner.jobs.size,12);
 w.time=3;w.revision++;const first=workers[0].jobs[0];workers[0].onmessage({data:{id:first.id,result:{valid:true}}});await settle();assert.equal(workers.length,3);assert.equal(workers[2].jobs[0].expectedRevision,w.revision);
 while(planner.jobs.size){for(const x of [...workers]){const j=x.jobs[0];if(j&&planner.jobs.has(j.id))x.onmessage({data:{id:j.id,result:{valid:true}}});}await settle();}
 assert.equal((await Promise.all(requests)).length,12);assert.equal(planner.running,0);
});
test('eighty aircraft preserve fleet numbering while each pilot sends only its own context',()=>{
 const w=new World({units:Array.from({length:80},(_,i)=>({id:'plane-'+i,callsign:'PILOT '+i,profile:'f16',position:[i*1000,0,6500],heading:0,speed:250}))},profiles);
 const own=pilotContext(w,'plane-79');assert.equal(own.units.length,1);assert.equal(own.units[0].number,80);assert.equal(own.selectedUnitId,'plane-79');assert.equal(validateContext(own).units[0].id,'plane-79');
 const fleet=commandContext(w,'plane-79');assert.equal(validateContext(fleet).units.length,80);
});
