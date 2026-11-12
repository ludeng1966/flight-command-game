import {traceFlight} from '../sim/safe-navigation.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';
import {installAttackTask,applyAttackDecision,stepEngagementIntents,monitorAttackTasks,validateAttackDecision,attackTaskEvent} from '../sim/attack-task.js';
import {installRadarTask} from '../sim/radar-task.js';
import {applyRadarOrder} from '../sim/radar.js';
import {applyWeaponOrder,stepWeapons} from '../sim/weapons.js';
import {engagementGuidance,cooperativeReleaseGate,combatReport} from '../sim/engagement-intent.js';
import {stepDatalinks,parseDatalinkContext,datalinkContext,configureDatalink} from '../sim/datalink.js';
import {AttackPilot} from '../game/attack-pilot.js';import {RadarPilot} from '../game/radar-pilot.js';import {RwrPilot} from '../game/rwr-pilot.js';
import {notePlayerOrder} from '../sim/command-scope.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const order=()=>({targetId:null,targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
const decision=(operation,extra={})=>({operation,mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟按当前任务执行',...extra});
const modelId='us_aim_120b';
function setup(n=1){const scenario={sensorModelVersion:2,sensorSeed:41,units:[...Array.from({length:n},(_,i)=>({id:'blue-'+i,callsign:'BLUE '+i,profile:'f16',team:'blue',position:[-3000*i,-2000*i,6500],heading:0,speed:250})),{id:'red',callsign:'RED',profile:'f16',team:'red',controllable:false,position:[0,30000,6500],heading:180,speed:250}]};
 const world=new World(scenario,profiles);for(const u of world.units){u.headingTarget=Math.atan2(u.velocity[0],u.velocity[1]);u.holdAltitude=u.position[2];u.rwrDefense.mode='report_only';}return {world,scenario,unit:world.units[0]};}
const advance=(w,seconds)=>{for(let i=0;i<Math.round(seconds*60);i++)w.step(1/60);};
function observe(w,u){applyRadarOrder(w,u,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});advance(w,5);const c=u.radar.contacts.find(c=>c.classification!=='friendly');assert(c);return c;}
function engage(w,u,c){installAttackTask(w,u,order());return applyAttackDecision(w,u,decision('engage',{modelId,targetId:c.id,quantity:1}),u.attackTask.id,0);}

test('a three-second delayed model intent captures the current firing window without another model turn',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);installAttackTask(w,u,order());const proposal=decision('engage',{modelId,targetId:c.id,quantity:1});
 // Actual physics, scanning and observations continue while the model thinks.
 advance(w,3);applyAttackDecision(w,u,proposal,u.attackTask.id,0);assert.equal(u.attackTask.selectedModelId,modelId);assert.equal(w.missiles.length,0);
 advance(w,12);const e=u.attackTask.engagement;assert.equal(w.weaponEvents.filter(x=>x.type==='launch'&&x.ownerId===u.id).length,1);assert.equal(u.weapons.inventory[modelId],3);
 assert(e.launchedAt>=8);assert(e.launchedAt-e.firstReadyAt<=.067,JSON.stringify(e));assert.equal(u.attackTask.events.filter(e=>e.type==='engage').length,1);
 assert.equal(u.attackTask.events.filter(e=>e.type==='intent_release').length,1);
 const m=w.missiles[0];m.phase='hit';m.alive=false;m.hitTargetId='red';monitorAttackTasks(w);assert.equal(u.attackTask.status,'completed');assert.equal(u.attackTask.flightResults[m.id].hitTargetId,c.id);
});

test('a pending release cannot survive cancellation, expiry, friendly reclassification or a defense takeover',()=>{
 for(const mode of ['cancel','expire','friendly','defense','recovery']){const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);
  if(mode==='cancel')applyWeaponOrder(w,u,{operation:'hold',modelId:null,targetId:null,quantity:null});
  if(mode==='expire')u.attackTask.engagement.expiresAt=w.time+.01;
  if(mode==='friendly')c.classification='friendly';
  if(mode==='recovery')u.flightState='stall-recovery';
  if(mode==='defense')u.rwrDefense.active={manual:true,headingDeg:90,altitudeM:6500,speedMps:250};
  // Preserve each injected condition while exercising the actual release gate.
  for(let i=0;i<100;i++){w.time+=.05;stepWeapons(w,.05);stepEngagementIntents(w);}
  assert.equal(w.missiles.length,0,mode);assert.equal(u.weapons.inventory[modelId],4,mode);
 }
});

test('radar missile preparation is not reset by duplicate target designation or a brief radar loss',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);stepWeapons(w,.2);const prepared=u.weapons.readySec;
 applyWeaponOrder(w,u,{operation:'designate',modelId:null,targetId:c.id,quantity:null},{autonomous:true});assert.equal(u.weapons.readySec,prepared);
 u.radar.canIlluminate=false;u.radar.phase='search';stepWeapons(w,.1);assert(u.weapons.readySec>=prepared);assert.equal(u.weapons.ready,false);
 assert.throws(()=>validateAttackDecision(decision('select',{modelId,targetId:c.id}),u,w.time),/不.*重复选弹/);
});

test('continuous tracking preserves the navigation task and yields to explicit heading, formation and defense',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);const points=u.waypoints;assert(engagementGuidance(u));assert.equal(u.waypoints,points);
 u.attackTask.headingDeg=0;assert.equal(engagementGuidance(u),null);u.attackTask.headingDeg=null;
 u.formation={leaderId:'friend'};assert.equal(engagementGuidance(u),null);u.formation=null;
 u.rwrDefense.active={manual:true};assert.equal(engagementGuidance(u),null);
});

test('an aged acquisition clue still guides recapture, but cannot be mistaken for fresh fire control',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);w.time+=8;
 u.attackTask.engagement.nextCheckAt=w.time;u.radar.lastSenseAt=w.time;
 assert(engagementGuidance(u),'an old but usable local clue must not strand the aircraft on its previous route');
 u.radar.phase='search';u.radar.canIlluminate=false;stepWeapons(w,.05);stepEngagementIntents(w);assert.equal(w.missiles.length,0);
});

test('intent persists across saves with remaining simulation-time validity and cannot revive expired release',()=>{
 const {world:w,unit:u,scenario}=setup(),c=observe(w,u);engage(w,u,c);const e=u.attackTask.engagement;
 const restored=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);assert.deepEqual(restored.units[0].attackTask.engagement,e);
 restored.time=e.expiresAt+.01;stepEngagementIntents(restored);assert.equal(restored.units[0].attackTask.engagement.phase,'expired');assert.equal(restored.missiles.length,0);
});

test('same-channel combat claims use delivered reports and release a waiting partner when the priority aircraft defends',()=>{
 const {world:w}=setup(2),a=w.units[0],b=w.units[1];const ca=observe(w,a);applyRadarOrder(w,b,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});advance(w,5);
 const cb=b.radar.contacts.find(c=>c.classification!=='friendly');assert(cb);engage(w,a,a.radar.contacts.find(c=>c.id===ca.id));engage(w,b,cb);
 // No reading of the partner task: only a delivered self-report can claim it.
 w.time+=2;for(const u of [a,b]){const c=u.radar.contacts.find(c=>c.id===u.attackTask.engagement.targetId);c.observedAt=w.time;c.position=[0,25000,6500];c.velocity=[0,-250,0];}const claim=combatReport(a,w.time);assert(claim);b.datalink.contacts=[];assert.equal(cooperativeReleaseGate(b,w.time).allowed,true);
 b.datalink.contacts=[{kind:'participant',sourceUnitId:a.id,channelId:'blue',observedAt:w.time,combat:claim}];assert.equal(cooperativeReleaseGate(b,w.time).allowed,false);
 const extra={...cb,id:'ambiguous-neighbor',observedAt:w.time,position:[0,25010,6500],velocity:[0,-250,0]};b.radar.contacts.push(extra);assert.equal(cooperativeReleaseGate(b,w.time).allowed,true);b.radar.contacts.pop();
 claim.defending=true;assert.equal(cooperativeReleaseGate(b,w.time).allowed,true);claim.airborne=true;assert.equal(cooperativeReleaseGate(b,w.time).allowed,false);
 b.datalink.contacts[0].channelId='other';assert.equal(cooperativeReleaseGate(b,w.time).allowed,true);
});

test('combat preparation reports actually traverse the delayed tactical channel and its parser',()=>{
 const {world:w}=setup(2),a=w.units[0],b=w.units[1],c=observe(w,a);engage(w,a,c);
 // Keep one explicit observed clue current while running the actual link slots.
 c.observedAt=w.time;
 for(let i=0;i<12;i++){w.time+=.125;stepDatalinks(w);}
 const received=datalinkContext(b,w.time),p=received.contacts.find(p=>p.kind==='participant'&&p.sourceUnitId===a.id);
 assert(p?.combat);assert(p.receivedAt>p.observedAt);assert.equal(p.combat.taskId,a.attackTask.id);assert.equal(p.combat.target.position.length,3);
 const parsed=parseDatalinkContext(received,w.time).contacts.find(p=>p.sourceUnitId===a.id&&p.kind==='participant');assert.deepEqual(parsed.combat,p.combat);assert.equal(parsed.fireControl,false);
 const last=p.observedAt;configureDatalink(w,a.id,{networkId:'isolated'});
 for(let i=0;i<12;i++){w.time+=.125;stepDatalinks(w);}
 assert.equal(datalinkContext(b,w.time).contacts.find(p=>p.sourceUnitId===a.id&&p.kind==='participant').observedAt,last);
});

test('all aircraft have independent request slots, configurable budgets, and per-aircraft cancellation',async t=>{
 for(const Pilot of [AttackPilot,RadarPilot,RwrPilot]){let at=0;const {world:w}=setup(7),requests=[];
  const prepare=u=>{
   if(Pilot===AttackPilot)installAttackTask(w,u,order());
   else if(Pilot===RadarPilot)installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});
   else{u.rwrDefense.mode='auto';u.rwr.contacts=[{id:'R',epoch:1,observedAt:0,bearingDeg:10,level:'launch'}];u.rwrDefense.episode={key:'R:1',contactId:'R',epoch:1,level:'launch',firstSeen:0,lastSeen:0,reviewed:false,playerOverride:false};}
  };for(const u of w.units.filter(u=>u.team==='blue'))prepare(u);
  const pilot=new Pilot({getWorld:()=>w,now:()=>at,fetchImpl:(_url,o)=>{requests.push({input:JSON.parse(o.body),signal:o.signal});return new Promise(()=>{});}});t.after(()=>pilot.stop());pilot.tick();
  assert.equal(requests.length,7,Pilot.name);assert.equal(new Set(requests.map(r=>r.input.unitId)).size,7);
  at=1000;pilot.tick();assert.equal(requests.length,7);notePlayerOrder(w,['blue-0']);pilot.tick();assert(requests[0].signal.aborted);assert(requests.slice(1).every(r=>!r.signal.aborted));
  w.units[0].alive=false;const added=setup(8).world.units[7];prepare(added);w.units.push(added);at=1100;pilot.tick();assert.equal(requests.length,8);assert.equal(requests.at(-1).input.unitId,'blue-7');pilot.stop();
 }
});

test('candidate navigation traces ignore an old engagement overlay after flight takeover',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);c.position=[20000,u.position[1],6500];
 const goals=[[0,10000,6500]],legs=[[[...u.position],[...goals[0]]]];
 assert.deepEqual(traceFlight(u,goals,legs,{duration:5}),traceFlight({...u,attackTask:null},goals,legs,{duration:5}));
});

test('carrier guidance releases after an active seeker takes over but retains semi-active illumination support',()=>{
 const {world:w,unit:u}=setup(),c=observe(w,u);engage(w,u,c);advance(w,5);assert(w.missiles.length);const m=w.missiles[0];
 m.active=true;stepEngagementIntents(w);assert.equal(u.attackTask.engagement.phase,'released');assert.equal(engagementGuidance(u),null);assert.equal(combatReport(u,w.time).airborne,true);
 m.modelId='us_aim7p_sparrow_fa_18';stepEngagementIntents(w);assert.equal(u.attackTask.engagement.phase,'supporting');
});
