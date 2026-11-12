import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {applyPlan,commandContext} from '../sim/orders.js';
import {stepRwrDefense,configureDefense} from '../sim/rwr-defense.js';
import {validateContext} from '../server/qwen.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function setup(){const w=new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);return {w,u:w.units[0]};}
function warn(w,u,level='launch'){u.rwr.contacts=[{id:'RWR-1',epoch:level==='track'?1:2,level,bearingDeg:0,signalType:'radar',observedAt:w.time,firstSeen:w.time}];stepRwrDefense(w);}
function apply(w,u,task){applyPlan(w,{status:'accepted',summary:'测试指令',tasks:[{unitId:u.id,...task}]},w.revision);}
const flight={action:'set_flight',altitudeM:null,speedMps:280,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false};
test('威胁当帧规避，旧延迟、慢模型和待理解指令不能阻塞',()=>{
 const {w,u}=setup();u.rwrDefense.lockDelaySec=8;u.rwrDefense.launchDelaySec=4;w.playerCommandPending=true;warn(w,u);
 assert.equal(u.rwrDefense.active.startedAt,w.time);assert.equal(u.rwrDefense.launchDelaySec,0);
 assert.equal(validateContext(commandContext(w,u.id)).units[0].rwrDefense.launchDelaySec,0);
});
test('搜索、武器及兼容速度命令不中止规避；新高度约束优先',()=>{
 const {w,u}=setup();warn(w,u);const active=u.rwrDefense.active;
 apply(w,u,{action:'sensor_task',sensorTask:{goal:'search',targetId:null,targetRef:null}});assert.equal(u.rwrDefense.active,active);
 apply(w,u,{action:'weapon',weaponOrder:{operation:'hold',modelId:null,targetId:null,quantity:null}});
 assert.equal(u.rwrDefense.active,active);
 apply(w,u,flight);assert.equal(u.rwrDefense.active,active);assert.equal(u.targetSpeed,280);
 apply(w,u,{...flight,altitudeM:7000,speedMps:null});assert.equal(u.rwrDefense.active,null);warn(w,u,'track');assert.equal(u.rwrDefense.active,null);
 configureDefense(w,u,{mode:'auto'});stepRwrDefense(w);assert.ok(u.rwrDefense.active);
});
test('告警前的明确飞行约束同样优先，攻击任务可重新授权机动自卫',()=>{
 const {w,u}=setup();apply(w,u,{...flight,altitudeM:7000});warn(w,u);assert.equal(u.rwrDefense.active,null);
 apply(w,u,{action:'attack_task',attackOrder:{targetId:null,targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null}});stepRwrDefense(w);assert.ok(u.rwrDefense.active);
});
