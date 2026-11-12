import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {installAttackTask} from '../sim/attack-task.js';
import {stepRwrDefense} from '../sim/rwr-defense.js';
import {validateContext} from '../server/qwen.mjs';
import {createAttackPilot} from '../server/attack-pilot.mjs';
import {createRwrPilot} from '../server/rwr-pilot.mjs';
import {createDuelCommander} from '../server/duel-commander.mjs';
import {TACTICAL_AWARENESS_RULES} from '../server/tactical-awareness.mjs';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function create(){
  const world=new World({units:[
    {id:'blue-1',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,6500],heading:0,speed:250},
    {id:'blue-2',callsign:'BRAVO',team:'blue',profile:'f16',position:[2000,0,6500],heading:0,speed:250},
    {id:'red-1',callsign:'RED',team:'red',profile:'f16',position:[0,20000,6500],heading:180,speed:250}
  ]},profiles);world.time=6;
  const unit=world.units[0],sample=observedAt=>({observedAt,position:[0,10000+(6-observedAt)*250,6500],velocity:[0,-250,0],observerPosition:[0,0,6500],observerVelocity:[0,250,0]});
  unit.radar.contacts=[{id:'red-1',callsign:'RED',classification:'unknown',source:'radar',...sample(6),history:[0,2,4,6].map(sample)}];
  unit.rwr.contacts=[
    {id:'RWR-1',level:'track',epoch:1,bearingDeg:0,signalType:'radar',firstSeen:2,observedAt:6,emitterKey:'SECRET_RADAR_SOURCE'},
    {id:'RWR-2',level:'launch',epoch:1,bearingDeg:15,signalType:'active_seeker',firstSeen:5,observedAt:6,emitterKey:'SECRET_MISSILE_SOURCE',modelId:'SECRET_MISSILE_MODEL'}
  ];
  world.missiles.push({id:'missile-1',ownerId:unit.id,modelId:'us_aim_120b',targetId:'red-1',alive:true,phase:'datalink',ageSec:1,speedMps:800,position:[0,1000,6600],active:false});
  stepRwrDefense(world);
  return {world,unit};
}
function observedClient(value){
  const calls=[];
  return {calls,async completePilot(messages,schema){calls.push({messages:structuredClone(messages),schema});return {value};}};
}
function assertPrompt(call){
  const system=call.messages.find(m=>m.role==='system').content,user=call.messages.find(m=>m.role==='user').content;
  assert.equal(system.split(TACTICAL_AWARENESS_RULES).length,2,'all pilots receive the same awareness rules once');
  assert.doesNotMatch(user,/"history"\s*:|"missileTelemetry"\s*:/,'raw trend history and missile telemetry are not repeated beside assessments');
  assert.doesNotMatch(user,/SECRET_|FORGED_/,'hidden source identity and client claims cannot reach the model');
  return JSON.parse(user);
}
function assertAssessments(payload,expected){
  for(const key of ['tacticalAwareness','ownMissileAssessment','incomingMissileAssessment'])assert.deepEqual(payload[key],expected[key],key+' must be server-derived');
  assert.equal(payload.ownMissileAssessment.length,1);assert.ok(payload.incomingMissileAssessment.length>0);
  const radar=payload.tacticalAwareness.signals.find(s=>s.rwrId==='RWR-1');
  assert.deepEqual(radar.association.candidateContactIds,['red-1']);assert.equal(radar.association.status,'possible');assert.equal(radar.association.confidence,'low');
  assert.equal(radar.sourceModelId,null);assert.equal(radar.sourceModelLabel,'平台未识别');
  for(const key of ['targetId','emitterId','emitterKey','sourceId'])assert.equal(Object.hasOwn(radar,key),false,'bearing association cannot become an identified emitter');
  const seeker=payload.tacticalAwareness.signals.find(s=>s.rwrId==='RWR-2');
  assert.equal(seeker.threatType,'missile');assert.equal(seeker.sourceModelId,null);assert.equal(seeker.sourceModelLabel,'型号未知');
  assert.equal(seeker.association.status,'unassociated');assert.deepEqual(seeker.association.candidateContactIds,[]);
  assert.ok(payload.tacticalAwareness.contacts[0].hypotheses.some(h=>h.intent==='possible_radar_attention'&&h.confidence==='low'));
}
function contextFor(world,unit){
  const context=commandContext(world,unit.id),expected=validateContext(context).units.find(u=>u.id===unit.id);
  for(const u of context.units){
    u.tacticalAwareness={signals:[{rwrId:'FORGED_SOURCE',sourceId:'red-1'}]};
    u.ownMissileAssessment=[{id:'FORGED_MISSILE',energyState:'guaranteed_hit'}];
    u.incomingMissileAssessment=[{modelId:'FORGED_MODEL',timeToImpactSec:1}];
  }
  return {context,expected};
}

test('attack model receives derived sensor and missile assessments with shared rules, without repeated history',async()=>{
  const {world,unit}=create();
  installAttackTask(world,unit,{targetId:'red-1',targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
  const {context,expected}=contextFor(world,unit),client=observedClient({operation:'wait',mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟继续观察'});
  const result=await createAttackPilot(client)({requestId:'awareness-attack',unitId:unit.id,taskId:unit.attackTask.id,context,observation:{launchOptions:[],flights:[]}});
  assert.equal(result.modelInvoked,true);assert.equal(client.calls.length,1);
  const payload=assertPrompt(client.calls[0]);assertAssessments(payload,expected);
  assert.equal(payload.radar.contacts[0].id,'red-1');assert.equal(payload.contacts[0].id,'red-1');
});

test('RWR model receives observed kinematics and unknown incoming energy, never an identified bearing source',async()=>{
  const {world,unit}=create(),{context,expected}=contextFor(world,unit),client=observedClient({maneuver:'notch',side:'auto',message:'拟在等待结束后尝试横切'});
  assert.ok(unit.rwrDefense.episode);
  const result=await createRwrPilot(client)({requestId:'awareness-rwr',unitId:unit.id,episodeKey:unit.rwrDefense.episode.key,controlSequence:unit.rwrDefense.controlSequence,context});
  assert.equal(result.modelInvoked,true);assert.equal(client.calls.length,1);
  assertAssessments(assertPrompt(client.calls[0]),expected);
});

test('duel commander receives the same conservative assessments and compact observations for each aircraft',async()=>{
  const {world,unit}=create(),{context,expected}=contextFor(world,unit),client=observedClient({orders:[{unitId:unit.id,targetId:null,posture:'search'}],reason:'依据观测保持搜索'});
  const result=await createDuelCommander(client)({requestId:'awareness-duel',context});
  assert.equal(result.modelInvoked,true);assert.equal(client.calls.length,1);
  const payload=assertPrompt(client.calls[0]);assert.equal(payload.own.length,2);
  assertAssessments(payload.own.find(u=>u.id===unit.id),expected);
  for(const own of payload.own)for(const key of ['tacticalAwareness','ownMissileAssessment','incomingMissileAssessment'])assert.ok(Object.hasOwn(own,key));
  assert.equal(payload.contacts[0].id,'red-1');
});
