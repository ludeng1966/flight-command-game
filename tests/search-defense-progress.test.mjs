import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {installRadarTask,applyRadarDecision,radarTaskEvent} from '../sim/radar-task.js';
import {searchAssessment} from '../sim/search-assessment.js';
import {commandContext} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {stepRwrDefense,defenseReviewEvent,applyDefenseRecommendation} from '../sim/rwr-defense.js';
import {createRwrPilot} from '../server/rwr-pilot.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function setup(){const w=new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);const u=w.units[0];w.attackManeuver(u.id,'巡航',{headingDeg:0,altitudeM:6500,speedMps:250});return {w,u};}
test('真实扫描形成搜索复核，客户端与服务端状态一致，转向后重置航段扫描',()=>{
 const {w,u}=setup();installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});
 applyRadarDecision(w,u,{operation:'mode',mode:'pd',targetId:null,message:'开始搜索'},u.radarTask.id);
 for(let i=0;i<20*60;i++)w.step(1/60);
 assert.equal(searchAssessment(u,u.radarTask,w.time).mustChangeSearch,true);
 assert.equal(radarTaskEvent(u,w.time).reason,'search_sector_review');
 const parsed=validateContext(commandContext(w,u.id)).units[0];assert.deepEqual(radarTaskEvent(parsed,w.time),radarTaskEvent(u,w.time));
 assert.throws(()=>applyRadarDecision(w,u,{operation:'hold',mode:null,targetId:null,message:'继续等'},u.radarTask.id),/新.*航段/);
 applyRadarDecision(w,u,{operation:'maneuver',mode:null,targetId:null,headingDeg:120,altitudeM:6500,speedMps:250,message:'请求换区搜索'},u.radarTask.id);
 assert.equal(u.radarTask.searchState.legSequence,1);assert.equal(searchAssessment(u,u.radarTask,w.time).mustChangeSearch,false);
 for(let i=0;i<25*60;i++)w.step(1/60);
 const actualHeading=(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360;
 assert.ok(Math.abs((actualHeading+540)%360-180)>20,'真实积分必须改变飞机运动方向');
 assert.ok(u.alive);assert.equal(u.radarTask.active,true);
});
test('持续告警到期复核会重新调用模型，不复用初次规避缓存',async()=>{
 const {w,u}=setup();u.rwr.contacts=[{id:'RWR-1',epoch:1,level:'track',signalType:'radar',bearingDeg:0,observedAt:0,firstSeen:0}];stepRwrDefense(w);
 let calls=0;const pilot=createRwrPilot({async completePilot(){calls++;return {value:{maneuver:calls===1?'notch':'maintain',side:'left',message:'拟依据当前告警判断'}};}});
 const input=()=>({requestId:'review-test',unitId:u.id,episodeKey:u.rwrDefense.episode.key,controlSequence:u.rwrDefense.controlSequence,context:commandContext(w,u.id)});
 await pilot(input());const e=u.rwrDefense.episode;e.reviewed=true;e.reviewedAt=0;w.time=13;u.rwr.contacts[0].observedAt=13;stepRwrDefense(w);
 const result=await pilot(input());assert.equal(calls,2);assert.equal(result.decision.maneuver,'maintain');
});
test('同级告警源交替更新不重置等待，横切越过目标航向不翻转分支',()=>{
 const {w,u}=setup();const signal=(id,bearingDeg)=>({id,epoch:1,level:'track',bearingDeg,observedAt:w.time});
 u.rwr.contacts=[signal('RWR-1',0),signal('RWR-2',180)];stepRwrDefense(w);const key=u.rwrDefense.episode.key,deadline=u.rwrDefense.episode.autoAt;
 for(let i=0;i<10;i++){w.time+=1;for(const c of u.rwr.contacts)c.observedAt=w.time-(c.id==='RWR-1'&&i%2?.1:0);stepRwrDefense(w);}
 assert.equal(u.rwrDefense.episode.key,key);assert.equal(u.rwrDefense.episode.autoAt,deadline);assert.ok(u.rwrDefense.active);
 const before=u.rwrDefense.active.headingDeg;u.velocity=[249,-20,0];stepRwrDefense(w);assert.equal(u.rwrDefense.active.headingDeg,before);
 assert.equal(applyDefenseRecommendation(u,{maneuver:'maintain',side:'auto'}),true);
 const e=u.rwrDefense.episode;e.reviewed=true;e.reviewedAt=w.time;e.reviewSignature='changed';assert.equal(defenseReviewEvent(u,w.time),null);w.time+=12;for(const c of u.rwr.contacts)c.observedAt=w.time;assert.ok(defenseReviewEvent(u,w.time));
});
