import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {radarContext,parseRadarContext} from '../sim/radar.js';
import {engagementPermission,stepWeapons} from '../sim/weapons.js';
import {estimateShotQuality} from '../sim/shot-quality.js';
import {MISSILE_MODELS} from '../sim/missiles.js';
import {installAttackTask,validateAttackDecision,attackObservation} from '../sim/attack-task.js';
import {validateContext} from '../server/qwen.mjs';
import {scopedAirportTraffic} from '../sim/battle-observation.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250},{id:'red-secret',callsign:'SECRET RED',team:'red',profile:'f16',position:[12345,54321,7000],heading:180,speed:250}]};
const create=()=>new World(scenario,profiles),model=MISSILE_MODELS.get('us_aim_120b');
const contact=(extra={})=>({id:'tgt-1',callsign:'TGT 01',classification:'unknown',source:'radar',observedAt:0,position:[0,15000,6500],velocity:[0,-250,0],...extra});
const task=(extra={})=>({targetId:null,targetRef:'前方目标',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null,...extra});
test('通用上下文不会暴露未观测红方真值，选中红方也不取得控制权',()=>{
  const w=create(),context=commandContext(w,'red-secret');assert.deepEqual(context.units.map(u=>u.id),['blue-1']);assert.equal(context.selectedUnitId,'blue-1');assert.doesNotMatch(JSON.stringify(context),/red-secret|SECRET RED|12345|54321/);assert.equal(validateContext(context).units.length,1);
});
test('机场旁路同样剔除红方交通、许可、排队和跑道使用记录',()=>{
  const w=create();w.airportOps={traffic:{snapshot:()=>({traffic:[{unitId:'blue-1'},{unitId:'red-secret',position:[12345,54321,7000]}],queue:[{unitId:'red-secret'}],clearances:[{unitId:'red-secret'}],pendingPilotRequests:[{unitId:'red-secret'}],runways:[{ownerId:'red-secret',lastUse:{unitId:'red-secret'}}]})}};
  const result=scopedAirportTraffic(w,[w.units[0]]);assert.deepEqual(result.traffic,[{unitId:'blue-1'}]);assert.equal(result.runways[0].ownerId,null);assert.equal(result.runways[0].lastUse,null);assert.doesNotMatch(JSON.stringify(result),/red-secret|12345|54321/);
});
test('观测携带来源和时效，过时采样不伪造精确误差或敌方识别',()=>{
  const w=create(),u=w.units[0];u.radar.contacts=[contact()];w.time=3;
  const c=parseRadarContext(radarContext(u,w.time),w.time).contacts[0];assert.equal(c.source,'radar');assert.equal(c.ageSec,3);assert.equal(c.quality,'coasting');assert.equal(c.positionErrorM,null);assert.equal(c.identification,'unidentified');assert.equal(c.measurementModel,'idealized_sample_no_noise_model');
  const picture=commandContext(w,u.id);assert.equal(picture.units[0].radar.contacts[0].id,'tgt-1');assert.doesNotMatch(JSON.stringify(picture),/SECRET RED/);
});
test('发射窗口预估可区分近遇与明显超出限制，始终声明近似假设',()=>{
  const u=create().units[0],near=estimateShotQuality(u,contact(),model,0),far=estimateShotQuality(u,contact({position:[0,250000,6500],velocity:[0,500,0]}),model,0);
  assert.equal(near.rating,'favorable');assert.ok(near.interceptSec>0);assert.ok(near.supportSec>=0);assert.equal(near.confidence,'approximation');assert.ok(near.assumptions.length>=4);assert.equal(far.rating,'poor');assert.equal(far.interceptSec,null);assert.ok(far.reasons.includes('no_intercept_within_model_limits'));
});
test('射击质量不替代ready，过时、地形、保险约束独立显示',()=>{
  const w=create(),u=w.units[0],stale=estimateShotQuality(u,contact(),model,3),blocked=estimateShotQuality(u,contact(),model,0,{heightAt:()=>10000});
  assert.equal(stale.rating,'blocked');assert.equal(blocked.terrainClear,false);assert.equal(blocked.rating,'blocked');
  const unarmed=estimateShotQuality(u,contact({position:[0,20,6500]}),model,0);assert.ok(unarmed.reasons.includes('before_fuse_armed'));
  installAttackTask(w,u,task());u.radar.contacts=[contact()];const o=attackObservation(w,u);assert.equal(o.launchOptions[0].ready,false);assert.equal(o.launchOptions[0].shotQuality.rating,'favorable');assert.equal(o.launchOptions[0].engagement.allowed,true);
});
test('ROE区分自主攻击与明确发射授权，tight不把未知当敌方，友机永远禁止',()=>{
  const w=create(),u=w.units[0],c=contact();installAttackTask(w,u,task());u.weapons.roe='tight';
  assert.equal(engagementPermission(u,c,{authorization:'attack'}).allowed,false);assert.equal(engagementPermission(u,c,{authorization:'direct'}).allowed,true);
  u.attackTask.targetId=c.id;assert.equal(engagementPermission(u,c,{authorization:'attack'}).allowed,true);u.attackTask.targetId=null;u.weapons.roe='free';assert.equal(engagementPermission(u,c,{authorization:'attack'}).allowed,true);
  u.weapons.roe='hold';u.attackTask.active=false;assert.equal(engagementPermission(u,c).allowed,false);assert.equal(engagementPermission(u,{...c,classification:'friendly'},{authorization:'direct'}).allowed,false);
});
test('攻击执行器在实际launch前阻止tight下未识别的自动选目标',()=>{
  const w=create(),u=w.units[0],c=contact();installAttackTask(w,u,task());u.radar.contacts=[c];u.weapons.roe='tight';
  const d={operation:'launch',mode:null,modelId:model.id,targetId:c.id,quantity:1,headingDeg:null,altitudeM:null,speedMps:null,message:'准备发射'};
  assert.throws(()=>validateAttackDecision(d,u,0),/严格识别/);assert.equal(w.missiles.length,0);
});
