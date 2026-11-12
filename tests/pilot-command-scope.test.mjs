import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {installAttackTask} from '../sim/attack-task.js';
import {installRadarTask} from '../sim/radar-task.js';
import {applyRadarOrder} from '../sim/radar.js';
import {notePlayerOrder,capturePlayerOrderScope,isPlayerOrderScopeCurrent,assertPlayerOrderScope,captureUnitOrderScope,isUnitOrderScopeCurrent,playerOrderVersion} from '../sim/command-scope.js';
import {AttackPilot} from '../game/attack-pilot.js';
import {RadarPilot} from '../game/radar-pilot.js';
import {RwrPilot} from '../game/rwr-pilot.js';
import {PilotSupervisor} from '../game/pilot-supervisor.js';
import {pilotObservation} from '../sim/pilot-watch.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/duel.json',import.meta.url)));
const create=()=>new World(scenario,profiles);
const attackOrder=()=>({targetId:null,targetRef:'前方目标',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
const attackDecision=()=>({operation:'radar_mode',mode:'pd',targetId:null,modelId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟设置雷达搜索模式'});
const radarDecision=()=>({operation:'mode',mode:'pd',targetId:null,message:'拟采用PD搜索'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function pendingFetch(){
  const jobs=[];
  const fetchImpl=async(_url,options)=>{
    const input=JSON.parse(options.body);
    return new Promise(resolve=>jobs.push({input,signal:options.signal,reply(decision,extra={}){
      resolve(Response.json({requestId:input.requestId,taskId:input.taskId,revision:input.context.revision,
        simTimeSec:input.context.simTimeSec,decisionCount:0,controlSequence:input.controlSequence??0,
        episodeKey:input.episodeKey,event:{reason:'task_start'},decision,...extra}));
    }}));
  };
  return {jobs,fetchImpl};
}

test('player scope can narrow to the actual recipients after interpretation',()=>{
  const world=create(),scope=capturePlayerOrderScope(world);
  world.revision+=10;assert.equal(isPlayerOrderScopeCurrent(world,scope),true);
  notePlayerOrder(world,['blue-1']);assert.equal(isPlayerOrderScopeCurrent(world,scope),false);
  assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-2']),true);
  assert.throws(()=>assertPlayerOrderScope(world,scope,['blue-1']),/新操作/);
  assert.doesNotThrow(()=>assertPlayerOrderScope(world,scope,['blue-2']));
  notePlayerOrder(world,['blue-2']);assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-2']),false);
});

test('autonomous progress and uncommitted batches never advance manual authority',()=>{
  const world=create(),scope=capturePlayerOrderScope(world);
  world.autonomousCommand=true;notePlayerOrder(world,['blue-1']);notePlayerOrder(world);world.autonomousCommand=false;
  world.commandCommitInProgress=true;notePlayerOrder(world,['blue-2']);notePlayerOrder(world);world.commandCommitInProgress=false;
  assert.equal(isPlayerOrderScopeCurrent(world,scope),true);
  notePlayerOrder(world,['blue-2']);assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-1']),true);
  assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-2']),false);
});

test('global manual changes, changed world, and replaced recipient identity invalidate scopes',()=>{
  const world=create(),scope=capturePlayerOrderScope(world);
  assert.equal(isPlayerOrderScopeCurrent(create(),scope,['blue-2']),false);
  world.units[1]={...world.units[1]};assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-2']),false);
  assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-1']),true);
  notePlayerOrder(world);assert.equal(isPlayerOrderScopeCurrent(world,scope,['blue-1']),false);
});

test('unit scope ignores ordinary motion and sensor updates while guarding control choices',()=>{
  const world=create(),unit=world.units[0],scope=captureUnitOrderScope(world,unit);
  world.time=2;world.revision++;unit.position[0]+=500;unit.velocity[1]-=5;unit.radar.phase='search';unit.radar.scanPhase=.8;
  unit.radar.contacts=[{id:'red-1',observedAt:2}];unit.weapons.readySec=2;unit.weapons.ready=true;
  assert.equal(isUnitOrderScopeCurrent(world,unit,scope),true);
  for(const mutate of [u=>u.routeRevision=(u.routeRevision??0)+1,u=>u.radar.controlSequence=(u.radar.controlSequence??0)+1,
    u=>u.weapons.selectedModelId='us_aim9m_sidewinder',u=>u.weapons.targetId='red-2',u=>u.weapons.roe='free',
    u=>u.rwrDefense.controlSequence++,u=>u.alive=false]){
    const current=create(),own=current.units[0],captured=captureUnitOrderScope(current,own);mutate(own);
    assert.equal(isUnitOrderScopeCurrent(current,own,captured),false);
  }
});

test('Alpha manual change does not abort Bravo attack inference or require current global revision',async t=>{
  const world=create(),bravo=world.units[1],pending=pendingFetch();installAttackTask(world,bravo,attackOrder());
  const pilot=new AttackPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  installAttackTask(world,world.units[0],attackOrder());notePlayerOrder(world,['blue-1']);world.revision++;
  pilot.tick();assert.equal(pending.jobs[0].signal.aborted,false);
  pending.jobs[0].reply(attackDecision());await settle();
  assert.equal(bravo.radar.mode,'pd');assert.equal(bravo.attackTask.decisionCount,1);assert.equal(bravo.attackTask.pending,false);
});

test('Alpha manual change does not abort Bravo radar inference',async t=>{
  const world=create(),bravo=world.units[1],pending=pendingFetch();installRadarTask(world,bravo,{goal:'search',targetId:null,targetRef:null});
  const pilot=new RadarPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  applyRadarOrder(world,world.units[0],{operation:'mode',mode:'pulse',targetId:null});notePlayerOrder(world,['blue-1']);world.revision++;
  pilot.tick();assert.equal(pending.jobs[0].signal.aborted,false);pending.jobs[0].reply(radarDecision());await settle();
  assert.equal(bravo.radar.mode,'pd');assert.equal(bravo.radarTask.decisionCount,1);
});

test('same-unit manual authority blocks late attack and radar replies without spurious rejection reports',async t=>{
  for(const Pilot of [AttackPilot,RadarPilot]){
    const world=create(),unit=world.units[0],pending=pendingFetch();
    if(Pilot===AttackPilot)installAttackTask(world,unit,attackOrder());else installRadarTask(world,unit,{goal:'search',targetId:null,targetRef:null});
    const pilot=new Pilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
    notePlayerOrder(world,[unit.id]);pending.jobs[0].reply(Pilot===AttackPilot?attackDecision():radarDecision());await settle();
    const task=Pilot===AttackPilot?unit.attackTask:unit.radarTask;
    assert.equal(unit.radar.mode,'off');assert.equal(task.decisionCount,0);assert.equal(task.retryCount,0);assert.equal(task.pending,false);
  }
});

test('ordinary simulation advancement does not discard a valid attack reply',async t=>{
  const world=create(),unit=world.units[0],pending=pendingFetch();installAttackTask(world,unit,attackOrder());
  const pilot=new AttackPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  world.time=.5;unit.position[1]+=125;unit.radar.scanPhase=.5;world.revision++;
  pending.jobs[0].reply(attackDecision());await settle();assert.equal(unit.radar.mode,'pd');
});

test('response must still match its sampled request revision',async t=>{
  const world=create(),unit=world.units[0],pending=pendingFetch();installAttackTask(world,unit,attackOrder());
  const pilot=new AttackPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  pending.jobs[0].reply(attackDecision(),{revision:pending.jobs[0].input.context.revision+1});await settle();
  assert.equal(unit.radar.mode,'off');assert.match(unit.attackTask.lastError,/过期/);
});

test('an explicitly configured single-slot budget rotates units even when Alpha remains eligible',async t=>{
  for(const Pilot of [AttackPilot,RadarPilot]){
    let at=0;const world=create(),pending=pendingFetch();
    for(const unit of world.units.slice(0,2)){
      if(Pilot===AttackPilot)installAttackTask(world,unit,attackOrder());else installRadarTask(world,unit,{goal:'search',targetId:null,targetRef:null});
    }
    const pilot=new Pilot({getWorld:()=>world,now:()=>at,fetchImpl:pending.fetchImpl,maxConcurrent:1});t.after(()=>pilot.stop());pilot.tick();
    assert.equal(pending.jobs[0].input.unitId,'blue-1');at=1000;pilot.tick();assert.equal(pending.jobs.length,1);
    pending.jobs[0].reply(null);await settle();pilot.tick();assert.equal(pending.jobs[1].input.unitId,'blue-2');
    at=2000;pilot.tick();assert.equal(pending.jobs.length,2);pending.jobs[1].reply(null);await settle();pilot.tick();
    assert.equal(pending.jobs[2].input.unitId,'blue-1');
  }
});

function rwrReady(unit){unit.rwr.contacts=[{id:'RWR-1',epoch:1,observedAt:0,firstSeen:0,bearingDeg:180,level:'launch',signalType:'radar'}];unit.rwrDefense.episode={key:'RWR-1:1',contactId:'RWR-1',epoch:1,firstSeen:0,autoAt:4,lastSeen:0,reviewed:false,playerOverride:false,bearingDeg:180,level:'launch'};}
const rwrDecision=()=>({maneuver:'extend',side:'left',message:'拟背向脱离'});

test('RWR inference survives another aircraft manual command and same-unit autonomous radar progress',async t=>{
  const world=create(),unit=world.units[1],pending=pendingFetch();rwrReady(unit);
  const pilot=new RwrPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  notePlayerOrder(world,['blue-1']);world.revision++;
  applyRadarOrder(world,unit,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});world.revision++;
  pilot.tick();assert.equal(pending.jobs[0].signal.aborted,false);pending.jobs[0].reply(rwrDecision());await settle();
  assert.equal(unit.rwrDefense.modelReview.maneuver,'extend');
});

test('RWR inference respects same-unit manual takeover even without a new episode',async t=>{
  const world=create(),unit=world.units[1],pending=pendingFetch();rwrReady(unit);
  const pilot=new RwrPilot({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  notePlayerOrder(world,[unit.id]);pending.jobs[0].reply(rwrDecision());await settle();assert.equal(unit.rwrDefense.modelReview,null);
});

function scopedMission(world,unit){
  unit.pilotMission={id:'mission-1',intent:'intercept',timing:'now',condition:null,parameters:{targetRef:'contact-1'},revision:world.revision,orderVersion:playerOrderVersion(world,unit.id)};
}

test('mission observation follows its own manual version and remains serializable',()=>{
  const world=create(),unit=world.units[1];scopedMission(world,unit);world.revision+=10;notePlayerOrder(world,['blue-1']);
  const observation=pilotObservation(world,unit);assert.equal(observation.event.reason,'tactical_mission');
  assert.deepEqual(structuredClone(observation),observation);assert.ok(JSON.stringify(observation).length<3000);
  notePlayerOrder(world,[unit.id]);assert.equal(pilotObservation(world,unit),null);
});

test('supervisor keeps Bravo inference when Alpha changes while retaining sampled response alignment',async t=>{
  let at=0;const world=create(),unit=world.units[1],pending=pendingFetch();scopedMission(world,unit);
  const pilot=new PilotSupervisor({getWorld:()=>world,now:()=>at,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  notePlayerOrder(world,['blue-1']);world.revision++;at=1000;pilot.tick();assert.equal(pending.jobs[0].signal.aborted,false);
  pending.jobs[0].reply(null,{assessment:{decision:'continue_autopilot',message:'继续原任务',missingData:[]},modelInvoked:true});await settle();
  assert.equal(unit.pilotAssessment.decision,'continue_autopilot');
});

test('supervisor drops a same-unit manual takeover without imposing stale request cooldown',async t=>{
  const world=create(),unit=world.units[1],pending=pendingFetch();scopedMission(world,unit);
  const pilot=new PilotSupervisor({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();
  notePlayerOrder(world,[unit.id]);pending.jobs[0].reply(null,{assessment:{decision:'continue_autopilot',message:'过期',missingData:[]}});await settle();
  assert.equal(unit.pilotAssessment,undefined);assert.equal(pilot.states.get(unit.id).cooldownAt,0);
});

test('flight supervision requests are independent for every aircraft and only the retuned aircraft cancels',async t=>{
 const world=create(),pending=pendingFetch();for(const u of world.units.filter(u=>u.team==='blue'))scopedMission(world,u);
 const supervisor=new PilotSupervisor({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>supervisor.stop());supervisor.tick();assert.equal(pending.jobs.length,2);
 world.setDatalink('blue-1',{networkId:'other'});pending.jobs[0].reply(null,{assessment:{decision:'continue_autopilot',message:'过期',missingData:[]}});pending.jobs[1].reply(null,{assessment:{decision:'continue_autopilot',message:'继续原任务',missingData:[]}});await settle();
 assert.equal(world.units[0].pilotAssessment,undefined);assert.equal(world.units[1].pilotAssessment.decision,'continue_autopilot');
});

test('normal flight supervision cannot compete with an active attack controller for navigation',t=>{
 const world=create(),unit=world.units[0],pending=pendingFetch();scopedMission(world,unit);installAttackTask(world,unit,attackOrder());
 const pilot=new PilotSupervisor({getWorld:()=>world,now:()=>0,fetchImpl:pending.fetchImpl});t.after(()=>pilot.stop());pilot.tick();assert.equal(pending.jobs.length,0);
});
