import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {installAttackTask,applyAttackDecision,attackTaskEvent} from '../sim/attack-task.js';
import {validateContext} from '../server/qwen.mjs';
import {createAttackPilot} from '../server/attack-pilot.mjs';
import {AttackPilot} from '../game/attack-pilot.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const waitDecision={operation:'wait',mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟保持当前状态继续观察'};
function create({headingTarget=null,searchLegEstablished=false,inFlight=false}={}){
  const world=new World({units:[{id:'blue-1',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles),unit=world.units[0];
  unit.headingTarget=headingTarget;unit.headingRoute=null;unit.waypoints=[];
  installAttackTask(world,unit,{targetId:null,targetRef:'前方目标',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
  unit.attackTask.searchLegEstablished=searchLegEstablished;
  if(inFlight){
    unit.attackTask.firedMissileIds=['missile-1'];unit.attackTask.flightResults={'missile-1':{alive:true,phase:'datalink',hitTargetId:null}};
    world.missiles.push({id:'missile-1',ownerId:unit.id,modelId:'us_aim_120b',targetId:'observed-target',alive:true,phase:'datalink',ageSec:1,speedMps:800,position:[0,1000,6500],active:false});
  }
  applyAttackDecision(world,unit,waitDecision,unit.attackTask.id,0);
  return {world,unit};
}
function assertEventParity(world,unit,reason){
  const wire=commandContext(world,unit.id),parsed=validateContext(wire).units[0],client=attackTaskEvent(unit,world.time),server=attackTaskEvent(parsed,world.time);
  assert.deepEqual(client,server,'live unit and validated context must derive the same event');
  assert.equal(client?.reason??null,reason);
  return parsed;
}

test('north and nonzero heading holds with empty waypoints are not search-orbit events on either side',()=>{
  for(const headingTarget of [0,270])for(const inFlight of [false,true]){
    const {world,unit}=create({headingTarget,inFlight});world.time=1;
    const parsed=assertEventParity(world,unit,null);assert.equal(parsed.task,'heading');
    assert.equal(unit.attackTask.searchLegEstablished,false);assert.equal(unit.waypoints.length,0);
  }
});

test('genuine orbit search and an established search leg retain client/server event parity',()=>{
  for(const searchLegEstablished of [false,true]){
    const {world,unit}=create({searchLegEstablished});world.time=1;
    assert.equal(assertEventParity(world,unit,searchLegEstablished?null:'search_flight').task,'orbit');
  }
  const {world,unit}=create({headingTarget:0});
  applyAttackDecision(world,unit,{...waitDecision,operation:'maneuver',headingDeg:0,altitudeM:6500,speedMps:250,message:'拟建立搜索航段'},unit.attackTask.id,unit.attackTask.decisionCount);
  world.time=1;assert.equal(unit.attackTask.searchLegEstablished,true);
  assert.equal(assertEventParity(world,unit,'search_sensors').task,'heading');
});

test('an in-flight weapon on a heading hold requests review only at its real review deadline',()=>{
  const {world,unit}=create({headingTarget:0,inFlight:true});
  for(const time of [.5,1,5,9.99]){world.time=time;assertEventParity(world,unit,null);}
  world.time=10;const parsed=assertEventParity(world,unit,'review');
  assert.equal(parsed.missileTelemetry[0].id,'missile-1');assert.equal(parsed.ownMissileAssessment[0].source,'own_weapon_game_telemetry');
});

test('AttackPilot does not flood the server with empty search decisions while holding north and supporting a missile',async()=>{
  const {world,unit}=create({headingTarget:0,inFlight:true});let clock=0,requests=0,models=0,empty=0;
  const service=createAttackPilot({async completePilot(){models++;return {value:waitDecision};}});
  const pilot=new AttackPilot({getWorld:()=>world,now:()=>clock,fetchImpl:async(_url,options)=>{
    requests++;const result=await service(JSON.parse(options.body));if(!result.modelInvoked)empty++;
    return {ok:true,json:async()=>result};
  }});
  try{
    for(let i=0;i<=26;i++){
      world.time=i*.75;clock=i*750;pilot.tick();await new Promise(resolve=>setImmediate(resolve));
      if(world.time<10)assert.equal(requests,0,'no request is due before the supporting review');
    }
    assert.equal(requests,1);assert.equal(models,1);assert.equal(empty,0);
    assert.equal(unit.attackTask.decisionCount,2);assert.equal(unit.attackTask.lastError,null);
    assert.equal(unit.attackTask.pending,false);
  }finally{pilot.stop();}
});
