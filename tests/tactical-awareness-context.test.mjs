import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {compactTacticalContext} from '../server/tactical-awareness.mjs';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[
  {id:'blue-1',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO',team:'blue',profile:'f16',position:[2000,0,6500],heading:0,speed:250},
  {id:'red-1',callsign:'RED ONE',team:'red',profile:'f16',position:[0,20000,6500],heading:180,speed:250},
  {id:'red-secret',callsign:'SECRET RED',team:'red',profile:'f16',position:[12345,54321,7200],heading:180,speed:250}
]};
const keys=value=>Object.keys(value).sort();
function create(){
  const world=new World(scenario,profiles);world.time=6;
  for(const id of ['blue-1','red-1']){
    const unit=world.units.find(u=>u.id===id),blue=id==='blue-1',targetId=blue?'red-1':'blue-1',direction=blue?1:-1;
    const sample=time=>({observedAt:time,position:[0,10000+(6-time)*250*direction,6500],velocity:[0,-250*direction,0],observerPosition:[0,blue?0:20000,6500],observerVelocity:[0,250*direction,0]});
    unit.radar.contacts=[{id:targetId,callsign:blue?'RED ONE':'ALPHA',classification:'unknown',source:'radar',...sample(6),history:[0,2,4,6].map(sample)}];
    unit.rwr.contacts=[{id:'RWR-1',level:'track',epoch:1,bearingDeg:blue?0:180,signalType:'radar',firstSeen:2,observedAt:6,emitterKey:'SECRET_EMITTER_KEY',hiddenLockTarget:'SECRET_LOCK_TARGET'}];
    world.missiles.push({id:blue?'missile-1':'missile-2',ownerId:id,modelId:'us_aim_120b',targetId,alive:true,phase:'datalink',ageSec:1,speedMps:800,position:[0,blue?1000:19000,6600],active:false});
  }
  return world;
}

test('commandContext and validated server context derive identical threat and own-missile facts',()=>{
  const world=create(),client=commandContext(world,'blue-1'),server=validateContext(client);
  for(let i=0;i<client.units.length;i++){
    assert.deepEqual(server.units[i].tacticalAwareness,client.units[i].tacticalAwareness);
    assert.deepEqual(server.units[i].ownMissileAssessment,client.units[i].ownMissileAssessment);
    assert.deepEqual(server.units[i].incomingMissileAssessment,client.units[i].incomingMissileAssessment);
  }
  const unit=server.units[0];assert.equal(unit.tacticalAwareness.contacts[0].hypotheses[0].intent,'possible_approach');
  assert.equal(unit.tacticalAwareness.signals[0].association.status,'possible');
  assert.equal(unit.ownMissileAssessment[0].source,'own_weapon_game_telemetry');
});
test('client supplied intention and missile assessments are ignored and rebuilt from whitelisted observations',()=>{
  const world=create(),client=commandContext(world,'blue-1'),expected=validateContext(client),forged=structuredClone(client);
  for(const u of forged.units){
    u.tacticalAwareness={contacts:[{contactId:'SECRET_FORGED_TARGET',confidence:1,intent:'definite_attack'}],emitterKey:'SECRET_FORGED_KEY'};
    u.ownMissileAssessment=[{id:'missile-999',reserveAssessment:'guaranteed_hit',remainingRangeM:999999}];
    u.incomingMissileAssessment=[{contactId:'FORGED_ENEMY',energyState:'spent',timeToImpactSec:1}];
  }
  const result=validateContext(forged);assert.deepEqual(result,expected);assert.doesNotMatch(JSON.stringify(result),/FORGED|guaranteed_hit|definite_attack/);
});
test('history keeps measured samples without exporting unseen enemies or RWR source identity',()=>{
  const world=create(),client=commandContext(world,'blue-1');
  const before=structuredClone(client.units[0].radar.contacts[0].history);
  const hidden=world.units.find(u=>u.id==='red-secret');hidden.position=[88888,77777,9999];hidden.velocity=[999,888,777];hidden.radar.targetId='SECRET_LOCK_TARGET';
  const server=validateContext(commandContext(world,'blue-1'));assert.deepEqual(server.units[0].radar.contacts[0].history,before);
  assert.doesNotMatch(JSON.stringify(server),/red-secret|SECRET RED|12345|54321|88888|77777|SECRET_EMITTER_KEY|SECRET_LOCK_TARGET/);
  assert.deepEqual(server.units.flatMap(u=>u.missileTelemetry.map(m=>m.id)),['missile-1']);
  const forged=structuredClone(client);forged.units[0].radar.contacts[0].history[0].emitterKey='SECRET_HISTORY_KEY';
  assert.doesNotMatch(JSON.stringify(validateContext(forged)),/SECRET_HISTORY_KEY/);
});
test('compact prompt context drops raw history and missile telemetry while retaining derived assessments',()=>{
  const server=validateContext(commandContext(create(),'blue-1')),before=structuredClone(server),compact=compactTacticalContext(server);
  for(let i=0;i<compact.units.length;i++){
    const u=compact.units[i];assert.equal(Object.hasOwn(u,'missileTelemetry'),false);
    assert.ok(u.radar.contacts.every(c=>!Object.hasOwn(c,'history')));
    assert.deepEqual(u.tacticalAwareness,server.units[i].tacticalAwareness);
    assert.deepEqual(u.ownMissileAssessment,server.units[i].ownMissileAssessment);
    assert.deepEqual(u.incomingMissileAssessment,server.units[i].incomingMissileAssessment);
  }
  assert.deepEqual(server,before,'prompt compaction must not mutate sensor/validation context');
  assert.ok(JSON.stringify(compact).length<JSON.stringify(server).length);
});
test('both teams receive the same assessment schema and only their own telemetry',()=>{
  const world=create(),blue=validateContext(commandContext(world,'blue-1'));
  world.playerTeam='red';const red=validateContext(commandContext(world,'red-1'));
  assert.deepEqual(blue.units.map(u=>u.id),['blue-1','blue-2']);assert.deepEqual(red.units.map(u=>u.id),['red-1','red-secret']);
  const a=blue.units[0],b=red.units[0];assert.deepEqual(keys(a),keys(b));assert.deepEqual(keys(a.tacticalAwareness),keys(b.tacticalAwareness));
  assert.deepEqual(keys(a.tacticalAwareness.contacts[0]),keys(b.tacticalAwareness.contacts[0]));
  assert.deepEqual(keys(a.ownMissileAssessment[0]),keys(b.ownMissileAssessment[0]));
  assert.deepEqual(a.missileTelemetry.map(m=>m.id),['missile-1']);assert.deepEqual(b.missileTelemetry.map(m=>m.id),['missile-2']);
  assert.equal(a.tacticalAwareness.contacts[0].kinematics.closureMps,b.tacticalAwareness.contacts[0].kinematics.closureMps);
});
test('future observed history and cross-owner missile telemetry fail server validation',()=>{
  const original=commandContext(create(),'blue-1'),future=structuredClone(original),foreign=structuredClone(original);
  future.units[0].radar.contacts[0].history.at(-1).observedAt=7;assert.throws(()=>validateContext(future),/雷达航迹/);
  foreign.units[0].missileTelemetry[0].ownerId='red-1';assert.throws(()=>validateContext(foreign),/己方导弹遥测/);
});
