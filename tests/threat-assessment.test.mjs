import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assessThreats} from '../sim/threat-assessment.js';
import {World} from '../sim/world.js';
import {radarContext,parseRadarContext,stepRadars,RADAR_HISTORY} from '../sim/radar.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const sample=(time,velocity=[0,-250,0],position=[0,20000-time*250,6500])=>({observedAt:time,position:[...position],velocity:[...velocity],observerPosition:[0,time*250,6500],observerVelocity:[0,250,0]});
const contact=(id='red-1',extra={})=>({id,callsign:id,classification:'unknown',source:'radar',...sample(6),history:[0,2,4,6].map(t=>sample(t)),...extra});
const own=(contacts=[contact()],signals=[])=>({id:'blue-1',position:[0,1500,6500],velocity:[0,250,0],radar:{contacts},weapons:{contacts:[]},rwr:{enabled:true,contacts:signals}});
const signal=(extra={})=>({id:'RWR-1',level:'track',signalType:'radar',bearingDeg:0,observedAt:6,...extra});

test('repeated observed closure supports a bounded hypothesis without asserting hostile intent',()=>{
  const a=assessThreats(own(),6),c=a.contacts[0];assert.equal(c.kinematics.closureMps,500);assert.equal(c.kinematics.targetSpeedMps,250);assert.equal(c.kinematics.targetHeadingDeg,180);assert.equal(c.kinematics.targetAspectDeg,0);
  assert.equal(c.observation.sampleCount,4);assert.equal(c.hypotheses[0].intent,'possible_approach');assert.equal(c.hypotheses[0].confidence,'medium');assert.ok(!JSON.stringify(a).includes('enemyLockTargetId'));
});
test('single samples and stale contacts do not invent turn trends or current intentions',()=>{
  const u=own([contact('red-1',{history:[]})]),first=assessThreats(u,6).contacts[0];assert.equal(first.kinematics.turnRateDegSec,null);assert.equal(first.hypotheses[0].intent,'unknown');
  const stale=assessThreats(own(),9).contacts[0];assert.equal(stale.hypotheses[0].intent,'unknown');assert.deepEqual(stale.hypotheses[0].evidence,['stale_track']);assert.equal(assessThreats(own(),11).contacts.length,0);
});
test('turn estimates use observed velocity history and wrap across north correctly',()=>{
  const velocity=d=>[Math.sin(d*Math.PI/180)*250,Math.cos(d*Math.PI/180)*250,0];
  const history=[350,0,10].map((d,i)=>sample(2+i*2,velocity(d)));const c=contact('red-1',{...history.at(-1),history});
  const result=assessThreats(own([c]),6).contacts[0];assert.equal(result.kinematics.turnRateDegSec,5);assert.equal(result.kinematics.speedTrendMps2,0);assert.ok(result.hypotheses.some(h=>h.intent==='observed_turn'));
});
test('RWR bearings provide possible or ambiguous associations, never emitter identity',()=>{
  const r=signal();Object.defineProperty(r,'emitterKey',{get(){throw Error('hidden source read');}});
  const single=assessThreats(own([contact()],[r]),6);assert.equal(single.signals[0].association.status,'possible');assert.equal(single.signals[0].association.confidence,'low');assert.deepEqual(single.signals[0].association.candidateContactIds,['red-1']);
  const both=assessThreats(own([contact(),contact('red-2',{position:[200,18500,6500]})],[r]),6);assert.equal(both.signals[0].association.status,'ambiguous');assert.equal(both.signals[0].association.confidence,'unknown');assert.equal(both.signals[0].association.candidateContactIds.length,2);
});
test('active seeker signals and friendly or stale tracks are not attributed to aircraft emitters',()=>{
  const seeker=assessThreats(own([contact()],[signal({signalType:'active_seeker',level:'launch'})]),6);assert.equal(seeker.signals[0].association.status,'unassociated');assert.deepEqual(seeker.signals[0].association.candidateContactIds,[]);
  assert.equal(assessThreats(own([contact('red-1',{classification:'friendly'})],[signal()]),6).signals[0].association.status,'unassociated');
  assert.equal(assessThreats(own([contact('red-1',{observedAt:3})],[signal()]),6).signals[0].association.status,'unassociated');assert.equal(assessThreats(own([],[]),6).signals.length,0);
});
test('signal threat type is observed but hidden aircraft or missile model never becomes a label',()=>{
  for(const signalType of ['radar','active_seeker']){
    const s=signal({signalType,level:'launch'});
    for(const key of ['modelId','sourceModelId','ownerId','sourceProfile'])Object.defineProperty(s,key,{get(){throw Error('hidden model read');}});
    const item=assessThreats(own([contact()],[s]),6).signals[0];
    assert.equal(item.threatType,signalType==='active_seeker'?'missile':'radar_emitter');assert.equal(item.sourceModelId,null);
    assert.equal(item.sourceModelLabel,signalType==='active_seeker'?'型号未知':'平台未识别');
  }
});
test('newer visual observations retain prior measured radar history for trend assessment',()=>{
  const u=own();u.weapons.contacts=[contact('red-1',{...sample(6.1),history:undefined,source:'visual'})];
  const result=assessThreats(u,6.1).contacts[0];assert.equal(result.observation.source,'visual');assert.equal(result.observation.sampleCount,5);assert.equal(result.hypotheses[0].intent,'possible_approach');
});
test('real sensor history advances only after detection and stays bounded; hidden motion leaves it unchanged',()=>{
  const w=new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles),u=w.units[0];
  const t={id:'red-1',callsign:'RED',team:'red',alive:true,position:[0,15000,6000],velocity:[0,-250,0]};w.radarTargets.push(t);w.radarCommand(u.id,{operation:'mode',mode:'pd',targetId:null});
  const sense=seconds=>{for(let i=0;i<seconds*20;i++){w.time+=.05;stepRadars(w,.05);}};sense(1.1);w.radarCommand(u.id,{operation:'lock',mode:null,targetId:t.id});sense(10);
  const c=u.radar.contacts[0];assert.ok(c.history.length>3&&c.history.length<=RADAR_HISTORY.maxSamples);assert.ok(c.history.every((s,i,a)=>i===0||s.observedAt-a[i-1].observedAt>=.75-1e-8));
  const before=structuredClone(c.history);t.velocity=[250,0,0];t.position=[500,15000,6000];sense(.5);assert.deepEqual(u.radar.contacts[0].history,before);
  const parsed=parseRadarContext(radarContext(u,w.time),w.time);assert.deepEqual(parsed.contacts[0].history,before);assert.notEqual(parsed.contacts[0].history,c.history);
});
test('history parser rejects future, unsorted, oversized and malformed samples and strips hidden fields',()=>{
  const base={available:true,mode:'pd',phase:'search',targetId:null,canIlluminate:false,speedGateHalfWidthMps:80,contacts:[contact()]};
  for(const change of [c=>c.history.push(sample(7)),c=>c.history.reverse(),c=>c.history=Array.from({length:9},(_,i)=>sample(i/2)),c=>c.history[0].observerPosition=[NaN,0,0]]){const value=structuredClone(base);change(value.contacts[0]);assert.throws(()=>parseRadarContext(value,6),/历史样本/);}
  base.contacts[0].history[0].hiddenTargetIntent='attack';base.contacts[0].emitterKey='radar:SECRET';const parsed=parseRadarContext(base,6);assert.equal(parsed.contacts[0].history[0].hiddenTargetIntent,undefined);assert.equal(parsed.contacts[0].emitterKey,undefined);
  const legacy=structuredClone(base);delete legacy.contacts[0].history;assert.deepEqual(parseRadarContext(legacy,6).contacts[0].history,[]);
});
