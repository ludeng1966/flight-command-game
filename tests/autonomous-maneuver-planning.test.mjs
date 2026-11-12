import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {installAttackTask,applyAttackDecision} from '../sim/attack-task.js';import {installRadarTask} from '../sim/radar-task.js';
import {notePlayerOrder} from '../sim/command-scope.js';
import {AttackPilot} from '../game/attack-pilot.js';import {RadarPilot} from '../game/radar-pilot.js';
import {autonomousManeuverPlan} from '../game/autonomous-maneuver.js';import {CommandPlanner} from '../game/command-planner.js';import {createFlightWorker} from '../tools/node-flight-planner.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario={units:[{id:'a',callsign:'A',profile:'f16',team:'blue',position:[0,0,6500],heading:0,speed:250}]};
const order={targetId:null,targetRef:null,weaponRef:null,shotLimit:2,headingDeg:null,altitudeM:null,speedMps:null};
const move={operation:'maneuver',mode:null,modelId:null,targetId:null,quantity:null,headingDeg:0,altitudeM:6500,speedMps:250,message:'拟继续当前方向搜索'};
const settle=()=>new Promise(r=>setImmediate(r));
test('attack and search keep flying while background safety planning waits, and discard a manual takeover',async t=>{
 for(const Pilot of [AttackPilot,RadarPilot]){const world=new World(scenario,profiles),unit=world.units[0];unit.headingTarget=0;
  if(Pilot===AttackPilot)installAttackTask(world,unit,order);else installRadarTask(world,unit,{goal:'search',targetId:null,targetRef:null});
  let finish,planning=false;const pilot=new Pilot({getWorld:()=>world,now:()=>0,async preparePlan(){planning=true;return new Promise(r=>finish=r);},async fetchImpl(_path,o){const b=JSON.parse(o.body);return Response.json({requestId:b.requestId,taskId:b.taskId,revision:b.context.revision,simTimeSec:b.context.simTimeSec,decisionCount:0,controlSequence:0,decision:move});}});t.after(()=>pilot.stop());
  pilot.tick();await settle();assert(planning);const y=unit.position[1];for(let i=0;i<60;i++)world.step(1/60);assert(unit.position[1]>y+100);assert.equal(unit.waypoints.length,0);
  notePlayerOrder(world,[unit.id]);finish(null);await settle();assert.equal(unit.waypoints.length,0);assert.equal((Pilot===AttackPilot?unit.attackTask:unit.radarTask).decisionCount,0);assert.equal((Pilot===AttackPilot?unit.attackTask:unit.radarTask).retryCount,0);
 }
});
test('real worker prepares a physical search route and main-thread commit never calls the synchronous route solver',async t=>{
 const world=new World(scenario,profiles),unit=world.units[0],planner=new CommandPlanner(null,{workerFactory:createFlightWorker});t.after(()=>planner.cancel());unit.headingTarget=0;installAttackTask(world,unit,order);
 let heartbeats=0;const timer=setInterval(()=>heartbeats++,5);t.after(()=>clearInterval(timer));
 const draft=await planner.prepare(world,autonomousManeuverPlan(unit.id,move),world.revision,{scoped:true,unitIds:[unit.id]});assert(heartbeats>0);assert(draft.backgroundPrepared);
 world.planRoute=()=>assert.fail('CPU-heavy route solve must stay in the worker');applyAttackDecision(world,unit,move,unit.attackTask.id,0,{maneuverDraft:draft});
 assert(unit.waypoints.length>0);assert.equal(unit.attackTask.active,true);assert.equal(unit.attackTask.decisionCount,1);
});
