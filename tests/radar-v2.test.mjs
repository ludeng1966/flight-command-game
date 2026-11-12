import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars,applyRadarOrder,radarContext,radarView,radarGeometry,createRadar} from '../sim/radar.js';
import {setScanPolicy,detectionQuality,scanFrameSec,migrateRadarV2} from '../sim/radar-v2.js';
import {trackUsable,radarSupport} from '../sim/radar-quality.js';
import {installRadarTask,applyRadarDecision,radarTaskEvent} from '../sim/radar-task.js';
import {commandContext} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {stepRwr} from '../sim/rwr.js';
import {RadarPilot} from '../game/radar-pilot.js';
import {launchAssessment,stepWeapons,applyWeaponOrder} from '../sim/weapons.js';
import {stepMissiles} from '../sim/missiles.js';
import {upgradeWorldSensors} from '../sim/radar-v2.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {applyPlan} from '../sim/orders.js';
import {createRadarPilot} from '../server/radar-pilot.mjs';
import {stepDatalinks,configureDatalink} from '../sim/datalink.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={sensorModelVersion:2,sensorSeed:7,units:[{id:'alpha',callsign:'ALPHA',profile:'f16',position:[0,0,5000],heading:0,speed:250}]};
function create(count=1){const s=structuredClone(scenario);for(let i=1;i<count;i++)s.units.push({...s.units[0],id:'alpha'+i,position:[1000*i,0,5000]});const w=new World(s,profiles);for(const u of w.units){u.velocity=[0,0,0];u.groundVelocity=[0,0,0];u.sensorPose={forward:[0,1,0],up:[0,0,1]};}return w;}
const mode=(w,m='pd',u=w.units[0])=>applyRadarOrder(w,u,{operation:'mode',mode:m,targetId:null},{autonomous:true});
const sense=(w,sec)=>{for(let i=0;i<Math.round(sec*20);i++){w.time+=.05;stepRadars(w,.05);}};
function target(w,el=0,id='tgt-1'){const t={id,callsign:'SECRET CALLSIGN',team:'red',position:[0,8000,5000+8000*Math.tan(el*Math.PI/180)],velocity:[0,0,0],velocityFrame:'world',radarRcsM2:100,alive:true};w.radarTargets.push(t);return t;}
test('v2 beams search altitude layers at different times, leaving unswept high airspace unknown',()=>{
 const w=create(),u=w.units[0];target(w,-6,'low');target(w,6,'high');target(w,25,'outside-bars');mode(w);
 const first=new Map();for(let i=0;i<180;i++){sense(w,.05);for(const c of u.radar.contacts)if(!first.has(u.radar.bindings[c.id]))first.set(u.radar.bindings[c.id],w.time);}
 assert.ok(first.has('low'));assert.ok(first.has('high'));assert.ok(first.get('high')-first.get('low')>3);assert.equal(first.has('outside-bars'),false);
 assert.ok(u.radar.coverage.some(Boolean));assert.ok(u.radar.coverage.some(c=>c===null));
});
test('narrow scan trades covered volume for a shorter actual revisit cycle',()=>{
 const w=create(),r=w.units[0].radar,wide=scanFrameSec(r);setScanPolicy(w.units[0],{azWidthDeg:40,barCount:2});assert.ok(scanFrameSec(r)<wide/3);
 assert.throws(()=>setScanPolicy(w.units[0],{azWidthDeg:180}),/范围/);assert.throws(()=>createRadar('f16',{sensorModelVersion:2,scanRateDegSec:0}),/参数/);
});
test('detection quality depends on range, RCS, dwell and clutter rather than a universal 60km step',()=>{
 const w=create(),r=w.units[0].radar,t=target(w);mode(w);const g={rangeM:40000,groundClutter:false,clutterSeparationMps:0};
 const at=detectionQuality(r,{radarRcsM2:1},g);assert.ok(Math.abs(at.pd-.8)<1e-9);
 assert.ok(detectionQuality(r,{radarRcsM2:.01},g).pd<at.pd);assert.ok(detectionQuality(r,t,{...g,rangeM:20000}).pd>detectionQuality(r,t,{...g,rangeM:50000}).pd);
 assert.ok(detectionQuality(r,t,g,.2).pd>detectionQuality(r,t,g,.05).pd);
 assert.ok(detectionQuality(r,t,{...g,groundClutter:true,clutterSeparationMps:60}).pd<detectionQuality(r,t,{...g,groundClutter:true,clutterSeparationMps:100}).pd);
});
test('first hit carries uncertainty, local identity and no exact complete velocity; 8-second revisit retains track',()=>{
 const w=create(),u=w.units[0],t=target(w);mode(w);sense(w,3.3);let c=u.radar.contacts[0];assert.ok(c);assert.notEqual(c.id,t.id);assert.notEqual(c.callsign,t.callsign);assert.notDeepEqual(c.position,t.position);assert.equal(c.velocityEstimateMps,null);assert.ok(Math.max(...c.uncertainty.velocitySigmaMps)>100);
 const id=c.id;sense(w,8.4);c=u.radar.contacts.find(c=>c.id===id);assert.ok(c);assert.equal(c.state,'confirmed');assert.ok(c.history.length>=2);assert.equal(trackUsable(c,w.time),true);
});
test('noisy observed context survives server validation and strips truth and forged quality metadata',()=>{
 const w=create();target(w);mode(w);sense(w,12);const c=commandContext(w,'alpha'),radar=c.units[0].radar;
 assert.equal(radar.sensorModelVersion,2);assert.ok(radar.coverage.length);assert.ok(!JSON.stringify(radar).includes('tgt-1'));assert.ok(!JSON.stringify(radar).includes('SECRET CALLSIGN'));
 radar.contacts[0].truthEntityId='secret';const parsed=validateContext(c).units[0].radar;assert.equal(parsed.contacts[0].truthEntityId,undefined);assert.equal(parsed.scanPolicy.barCount,4);
});
test('waveform changes and silent operation retain memory while invalidating weapon support',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,12);const id=u.radar.contacts[0].id;
 mode(w,'pulse');assert.ok(u.radar.contacts.some(c=>c.id===id));assert.equal(radarSupport(u,id,'active_radar',w.time).launchEligible,false);
 mode(w,'off');sense(w,.1);assert.ok(u.radar.contacts.length);assert.equal(u.radar.emissions.length,0);assert.equal(u.radar.contacts[0].awaitingValidation,true);
});
test('search starts locally without waiting for a model and cannot silently become permanent STT',()=>{
 const w=create(),u=w.units[0];target(w);installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});assert.equal(u.radar.mode,'pd');sense(w,12);
 assert.throws(()=>applyRadarDecision(w,u,{operation:'lock',mode:null,targetId:u.radar.contacts[0].id,message:'开始截获'},u.radarTask.id),/覆盖/);
 assert.equal(u.radar.targetId,null);assert.ok(radarTaskEvent(u,w.time));
});
test('model scan proposals change sensor coverage without modifying flight orders',()=>{
 const w=create(),u=w.units[0];installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});u.waypoints=[[0,10000,5000]];
 applyRadarDecision(w,u,{operation:'scan',mode:null,targetId:null,headingDeg:null,altitudeM:null,speedMps:null,message:'缩小搜索范围',scanPolicy:{frame:'body',azCenterDeg:0,azWidthDeg:40,elevationCenterDeg:0,barCount:2,rangeBandM:[150,60000]}},u.radarTask.id);
 assert.equal(u.radar.scanPolicy.barCount,2);assert.deepEqual(u.waypoints,[[0,10000,5000]]);
});
test('STT uses measured prediction and real antenna slewing before fire-control support',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,12);const id=u.radar.contacts[0].id;
 applyRadarOrder(w,u,{operation:'lock',mode:null,targetId:id},{autonomous:true});assert.equal(u.radar.canIlluminate,false);sense(w,3);
 assert.equal(u.radar.targetId,id);assert.equal(u.radar.phase,'locked');assert.equal(radarSupport(u,id,'semi_active_radar',w.time).illuminationAvailable,true);
 const before=structuredClone(u.radar.contacts[0]);w.radarTargets[0].position=[50000,0,5000];sense(w,.5);assert.equal(u.radar.canIlluminate,false);assert.equal(u.radar.contacts[0].observedAt,before.observedAt);assert.equal(u.radar.lastReason,'signal_lost');
});
test('RWR follows actual vertical radiation and illumination features without a hidden missile launch flag',()=>{
 const w=create(2),a=w.units[0],b=w.units[1];b.position=[0,8000,9000];mode(w);sense(w,1);stepRwr(w,.05);assert.equal(b.rwr.contacts.length,0);
 b.position=[0,8000,5000];a.radar.emissions=[{from:{az:0,el:0},to:{az:0,el:0},beamHalfDeg:3,role:'illumination',job:'track'}];stepRwr(w,.05);
 assert.equal(b.rwr.contacts[0]?.level,'launch');assert.equal(w.missiles.length,0);
});
test('v2 full filter, PRNG counters, coverage and tracks survive save/restore; invalid covariance is rejected',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,12);const saved=decodeState(encodeState(captureWorld(w))),restored=restoreWorld(saved,scenario,profiles);
 assert.equal(restored.sensorModelVersion,2);sense(w,3);sense(restored,3);assert.deepEqual(radarContext(restored.units[0],restored.time),radarContext(u,w.time));
 const bad=decodeState(encodeState(captureWorld(w)));bad.units[0].radar.tracks[0].P[0][0]=-1;assert.throws(()=>restoreWorld(bad,scenario,profiles),/雷达/);
});
test('no sensor clock passage while paused; fixed-step grouping preserves deterministic observations',()=>{
 const a=create(),b=create();target(a);target(b);mode(a);mode(b);sense(a,12);sense(b,6);sense(b,6);assert.deepEqual(radarContext(a.units[0],a.time),radarContext(b.units[0],b.time));
 const before=structuredClone(a.units[0].radar);stepRadars(a,0);assert.deepEqual(a.units[0].radar,before);
});
test('ground velocity and scripted world velocities define Doppler, not airspeed',()=>{
 const w=create(),u=w.units[0],t=target(w);u.velocity=[0,250,0];u.groundVelocity=[0,280,0];t.velocity=[0,60,0];t.velocityFrame='air';t.wind=[0,30,0];
 let g=radarGeometry(u,t,u.radar.config);assert.equal(g.clutterSeparationMps,-90);t.velocityFrame='world';g=radarGeometry(u,t,u.radar.config);assert.equal(g.clutterSeparationMps,-60);
});
test('one pending pilot does not block another aircraft and reset cancels all pending requests',async()=>{
 const w=create(2);for(const u of w.units)installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});let at=0,calls=0;
 const p=new RadarPilot({getWorld:()=>w,now:()=>at,fetchImpl:(_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));}});
 p.tick();at=1000;p.tick();assert.equal(calls,2);assert.equal(p.jobs.size,2);assert.ok(w.units.every(u=>u.radar.mode==='pd'));p.reset();await new Promise(resolve=>setImmediate(resolve));assert.equal(p.jobs.size,0);
});
test('real launch consumes ammunition using local track identity; active seeker obtains its own noisy estimate',()=>{
 const w=create(),u=w.units[0],t=target(w);mode(w);sense(w,12);const id=u.radar.contacts[0].id;
 applyRadarOrder(w,u,{operation:'lock',mode:null,targetId:id},{autonomous:true});sense(w,3);u.velocity=[0,250,0];
 for(let i=0;i<12;i++){sense(w,.05);stepWeapons(w,.05);}assert.equal(launchAssessment(w,u).ready,true);
 const before=u.weapons.inventory.us_aim_120b;applyWeaponOrder(w,u,{operation:'launch',modelId:'us_aim_120b',targetId:id,quantity:1});
 const m=w.missiles[0];assert.equal(m.targetId,id);assert.equal(m.truthTargetId,t.id);assert.equal(u.weapons.inventory.us_aim_120b,before-1);
 for(let i=0;i<10;i++){sense(w,.05);stepMissiles(w,.05);}assert.ok(m.active);assert.ok(m.seekerTrack);assert.notDeepEqual(m.observation.position,t.position);
 assert.ok(Number.isFinite(m.lastUpdateMeasuredAt??m.seekerLastMeasuredAt));
});
test('TWS data channels are bounded and never substitute for semi-active illumination',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,12);const c=u.radar.contacts[0];c.state='confirmed';c.observedAt=w.time;c.uncertainty={positionSigmaM:[10,10,10],velocitySigmaMps:[5,5,5],radialSigmaMps:3};
 u.radar.config.supportsTws=true;u.radar.config.maxDatalinkChannels=1;u.radar.scheduledTrackIds=['reserved',c.id];
 assert.equal(radarSupport(u,c.id,'active_radar',w.time).midcourseAvailable,false);u.radar.scheduledTrackIds=[c.id];
 assert.equal(radarSupport(u,c.id,'active_radar',w.time).launchEligible,true);assert.equal(radarSupport(u,c.id,'semi_active_radar',w.time).illuminationAvailable,false);
});
test('optical contact respects visibility and cannot backfill exact velocity or enemy callsign',()=>{
 const w=create(),u=w.units[0],t=target(w);u.visibilityM=1000;stepWeapons(w,.05);assert.equal(u.weapons.contacts.length,0);
 w.time=1;u.visibilityM=20000;stepWeapons(w,.05);const c=u.weapons.contacts[0];assert.ok(c);assert.equal(c.velocityEstimateMps,null);assert.notEqual(c.callsign,t.callsign);assert.ok(Math.max(...c.uncertainty.velocitySigmaMps)>=300);
 const context=validateContext(commandContext(w,u.id));assert.equal(context.units[0].weapons.contacts[0].measurementModel,'coarse_optical_measurement_v2');
});
test('legacy progress migrates to unvalidated memory rather than a fabricated v2 lock',()=>{
 const w=new World({...scenario,sensorModelVersion:1},profiles),u=w.units[0];u.radar.mode='pd';u.radar.targetId='tgt-1';u.radar.canIlluminate=true;
 u.radar.contacts=[{id:'tgt-1',callsign:'OLD',classification:'unknown',observedAt:0,position:[0,8000,5000],velocity:[0,-100,0]}];
 upgradeWorldSensors(w);assert.equal(w.sensorModelVersion,2);assert.equal(u.radar.targetId,null);assert.equal(u.radar.canIlluminate,false);assert.equal(u.radar.contacts[0].awaitingValidation,true);
 assert.notEqual(u.radar.contacts[0].id,'tgt-1');assert.equal(trackUsable(u.radar.contacts[0],w.time),false);
});
test('v2 support is invalidated on stale observations while target truth changes do not refresh measurements',()=>{
 const w=create(),u=w.units[0],t=target(w);mode(w);sense(w,12);const c=structuredClone(u.radar.contacts[0]);t.alive=false;sense(w,.2);
 const current=u.radar.contacts.find(x=>x.id===c.id);assert.equal(current.observedAt,c.observedAt);assert.deepEqual(current.position,c.position);
 assert.equal(radarSupport(u,c.id,'active_radar',w.time).launchEligible,false);
});
test('detection distribution follows configured Pd across independent seeded visits',()=>{
 let low=0,high=0;for(let seed=1;seed<=300;seed++){
  for(const [rcs,key]of [[.01,'low'],[100,'high']]){const w=create();w.sensorSeed=seed;const u=w.units[0],t=target(w);t.position=[0,40000,5000];t.velocity=[0,-250,0];t.radarRcsM2=rcs;
   setScanPolicy(u,{azWidthDeg:6,barCount:2});u.radar.antenna.azimuthDeg=-3;u.radar.antenna.elevationDeg=-2;mode(w);sense(w,.05);
   if(u.radar.contacts.length){if(key==='low')low++;else high++;}
  }
 }assert.ok(low<30);assert.ok(high>270);
});
test('commander direction/altitude/range compiles into a sensor policy without a navigation order',()=>{
 const w=create(),u=w.units[0],before=structuredClone(u.waypoints);
 const interpretation={version:'1.0',status:'understood',summary:'搜索东北空域',orders:[{id:'o1',intent:'search',unitIds:[u.id],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,headingDeg:45,altitudeM:6000,rangeM:30000}}]};
 const result=compileMilitaryInterpretation(interpretation,validateContext(commandContext(w,u.id)));assert.equal(result.execution.status,'ready');applyPlan(w,result.plan,w.revision);
 assert.equal(u.radar.mode,'pd');assert.equal(u.radar.scanPolicy.frame,'world');assert.equal(u.radar.scanPolicy.azCenterDeg,45);assert.deepEqual(u.radar.scanPolicy.altitudeBandM,[3000,9000]);assert.deepEqual(u.waypoints,before);
});
test('mocked server inference receives scan coverage and uncertainty, and returns a validated v2 scan policy',async()=>{
 const w=create(),u=w.units[0];target(w);installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});sense(w,12);let invoked=false;
 const run=createRadarPilot({completePilot:async(messages,schema)=>{invoked=true;const payload=JSON.parse(messages[1].content);assert.equal(payload.radar.sensorModelVersion,2);assert.ok(payload.radar.coverage.length);assert.ok(payload.radar.contacts[0].uncertainty);assert.ok(schema.required.includes('scanPolicy'));assert.equal(schema.properties.operation.enum.includes('lock'),false);
   return {value:{operation:'scan',mode:null,targetId:null,headingDeg:null,altitudeM:null,speedMps:null,message:'集中搜索前方',scanPolicy:{frame:'body',azCenterDeg:0,azWidthDeg:40,elevationCenterDeg:0,barCount:2,rangeBandM:[150,60000],altitudeBandM:null}}};}});
 const reply=await run({requestId:'v2-mock',unitId:u.id,taskId:u.radarTask.id,context:commandContext(w,u.id)});assert.ok(invoked);applyRadarDecision(w,u,reply.decision,u.radarTask.id,reply.event);assert.equal(u.radar.scanPolicy.azWidthDeg,40);
});
test('cached live projections do not mutate previously captured map or model snapshots',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,3.3);const context=commandContext(w,u.id),view=radarView(u,w.time),before=structuredClone({context,view});sense(w,9);
 assert.deepEqual({context,view},before);
});
test('known friend tracking is replaced only by an actually received, fresh same-channel position report',()=>{
 const w=create(2),u=w.units[0],friend=w.units[1];friend.position=[0,8000,5000];mode(w);
 for(let i=0;i<240;i++){sense(w,.05);stepDatalinks(w);}
 assert.ok(u.datalink.contacts.some(c=>c.kind==='participant'&&c.sourceUnitId===friend.id));assert.equal(u.radar.contacts.some(c=>c.classification==='friendly'),false);
 configureDatalink(w,u.id,{networkId:'other'});
 for(let i=0;i<240;i++){sense(w,.05);stepDatalinks(w);}
 assert.equal(u.datalink.contacts.length,0);assert.ok(u.radar.contacts.some(c=>c.classification==='friendly'));
});
test('explicit friendly tracking still measures friendlies even when position reports are available',()=>{
 const w=create(2),u=w.units[0],friend=w.units[1];friend.position=[0,8000,5000];
 installRadarTask(w,u,{goal:'track_target',targetId:null,targetRef:friend.callsign});
 for(let i=0;i<240;i++){sense(w,.05);stepDatalinks(w);}
 assert.ok(u.radar.contacts.some(c=>c.classification==='friendly'));assert.ok(u.datalink.contacts.some(c=>c.kind==='participant'));
});
test('ordinary search uses light estimates and STT promotes to full fire-control estimation',()=>{
 const w=create(),u=w.units[0];target(w);mode(w);sense(w,12);assert.equal(u.radar.contacts[0].estimationModel,'axis_search');
 applyRadarOrder(w,u,{operation:'lock',mode:null,targetId:u.radar.contacts[0].id},{autonomous:true});sense(w,3);
 assert.equal(u.radar.phase,'locked');assert.equal(u.radar.contacts[0].estimationModel,'full_ekf');
});
test('v2 progress created before the noise optimization still loads with its original noise kernel',()=>{
 const w=create();target(w);mode(w);sense(w,12);const saved=decodeState(encodeState(captureWorld(w)));delete saved.units[0].radar.config.noiseKernelVersion;delete saved.units[0].radar.config.trackKnownFriendlies;
 const restored=restoreWorld(saved,scenario,profiles);assert.equal(restored.units[0].radar.config.noiseKernelVersion,undefined);sense(restored,.5);assert.ok(restored.units[0].radar.contacts.length);
});
