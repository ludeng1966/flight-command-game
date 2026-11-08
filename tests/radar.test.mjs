import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {RADAR_DEFAULTS,radarGeometry,radarVisibility,stepRadars,radarView,parseRadarContext} from '../sim/radar.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS,MILITARY_SCHEMA,militarySchemaFor} from '../server/military-planner.mjs';
import {validateContext} from '../server/qwen.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {RadarRadio} from '../game/radar-radio.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA 01',profile:'f16',position:[0,0,5000],heading:0,speed:250,color:'#fff'}]};
const create=()=>new World(scenario,profiles),own=w=>w.units[0];
const target=(w,velocity=[0,-250,0],position=[0,15000,4500])=>{const t={id:'tgt-1',callsign:'TGT 01',team:'practice',radarPractice:true,position:[...position],velocity:[...velocity],alive:true};w.radarTargets.push(t);return t;};
const mode=(w,name='pd')=>w.radarCommand('blue-1',{operation:'mode',mode:name,targetId:null});
const sense=(w,seconds)=>{for(let i=0;i<Math.round(seconds*20);i++){w.time+=.05;stepRadars(w,.05);}};
const lock=w=>w.radarCommand('blue-1',{operation:'lock',mode:null,targetId:'tgt-1'});
const interpretation=(intent,p={})=>({version:'1.0',status:'understood',summary:'雷达指令',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...p}}]});

test('速度门相对地面杂波，不使用双方闭合率或总空速作替代',()=>{
  const w=create(),t=target(w,[250,0,0]);mode(w);let g=radarVisibility(own(w),t,own(w).radar);
  assert.ok(g.closureMps>240);assert.equal(g.clutterSeparationMps,0);assert.equal(g.reason,'notch');
  t.velocity=[0,250,0];g=radarVisibility(own(w),t,own(w).radar);assert.equal(g.closureMps,0);assert.ok(Math.abs(g.clutterSeparationMps)>240);assert.equal(g.visible,true);
});
test('默认速度门半宽80m/s，边界与左右径向方向对称',()=>{
  const w=create(),t=target(w,[0,0,0],[0,15000,5000]);mode(w);
  for(const v of [-79.999,0,79.999]){t.velocity=[0,v,0];assert.equal(radarVisibility(own(w),t,own(w).radar).reason,'notch');}
  for(const v of [-80,80]){t.velocity=[0,v,0];assert.equal(radarVisibility(own(w),t,own(w).radar).visible,true);}
  own(w).radar.config.speedGateHalfWidthMps=40;t.velocity=[0,50,0];assert.equal(radarVisibility(own(w),t,own(w).radar).visible,true);
});
test('明确上视无主瓣地面杂波时，不套用地面杂波速度门',()=>{
  const w=create(),t=target(w,[250,0,0],[0,15000,11000]);mode(w);
  const g=radarVisibility(own(w),t,own(w).radar);assert.equal(g.groundClutter,false);assert.equal(g.clutterSeparationMps,0);assert.equal(g.visible,true);
  mode(w,'pulse');assert.equal(radarVisibility(own(w),t,own(w).radar).visible,true);
});
test('SRC 脉冲模式下视受地面杂波遮蔽，PD 可看到有效径向运动',()=>{
  const w=create(),t=target(w);mode(w,'pulse');assert.equal(radarVisibility(own(w),t,own(w).radar).reason,'ground_clutter');mode(w);assert.equal(radarVisibility(own(w),t,own(w).radar).visible,true);
});
test('距离、方位、俯仰、地球曲率与地形均能阻断探测',()=>{
  const w=create(),t=target(w);mode(w);const r=own(w).radar;
  t.position=[0,61000,5000];assert.equal(radarVisibility(own(w),t,r).reason,'range');
  t.position=[15000,0,5000];assert.equal(radarVisibility(own(w),t,r).reason,'gimbal');
  t.position=[0,5000,15000];assert.equal(radarVisibility(own(w),t,r).reason,'gimbal');
  own(w).position=[0,0,1];t.position=[0,15000,1];assert.equal(radarVisibility(own(w),t,r).reason,'horizon');
  own(w).position=[0,0,5000];t.position=[0,15000,4500];const terrain={heightAt:(_x,y)=>y>6000&&y<9000?6000:0};assert.equal(radarVisibility(own(w),t,r,terrain).reason,'terrain');
  own(w).position=[0,0,5001];t.position=[0,50000,1];const cliff={heightAt:(_x,y)=>y<100?5000:0};assert.equal(radarVisibility(own(w),t,r,cliff).visible,true);
});
test('扫描到目标才产生航迹，截获等待后才锁定并提供有效跟踪',()=>{
  const w=create();target(w);mode(w);sense(w,.1);assert.equal(own(w).radar.contacts.length,0);sense(w,1);assert.equal(own(w).radar.contacts.length,1);
  lock(w);assert.equal(own(w).radar.phase,'acquiring');assert.equal(own(w).radar.canIlluminate,false);sense(w,.7);assert.equal(own(w).radar.phase,'acquiring');sense(w,.1);assert.equal(own(w).radar.phase,'locked');assert.equal(own(w).radar.canIlluminate,true);
  assert.equal(own(w).radar.events.filter(e=>e.type==='locked').length,1);
});
test('横切先外推再掉锁，外推不读取隐蔽目标的新位置，连续支持立即中断',()=>{
  const w=create(),t=target(w);mode(w);sense(w,1.1);lock(w);sense(w,.8);
  const measured=[...own(w).radar.contacts[0].position],velocity=[...own(w).radar.contacts[0].velocity],stamp=w.time;
  t.velocity=[250,0,0];t.position=[100,15000,4500];sense(w,.5);
  assert.equal(own(w).radar.phase,'coasting');assert.equal(own(w).radar.canIlluminate,false);
  const c=radarView(own(w),w.time).contacts[0];assert.deepEqual(c.position,measured);assert.deepEqual(c.predictedPosition,measured.map((v,i)=>v+velocity[i]*(w.time-stamp)));
  sense(w,1);assert.equal(own(w).radar.targetId,null);assert.equal(own(w).radar.phase,'search');assert.match(own(w).radar.events.at(-1).text,/掉锁.*速度门/);
});
test('短暂丢波在记忆期内恢复，长时间丢失航迹最终删除',()=>{
  const w=create(),t=target(w);mode(w);sense(w,1.1);lock(w);sense(w,.8);t.velocity=[250,0,0];sense(w,.5);t.velocity=[0,-250,0];sense(w,.1);assert.equal(own(w).radar.phase,'locked');
  t.alive=false;sense(w,4.1);assert.equal(own(w).radar.contacts.length,0);assert.equal(own(w).pilotContacts.length,0);
});
test('未发现、超时、毁伤目标不可锁定，关闭雷达清除外部航迹',()=>{
  const w=create(),t=target(w);mode(w);assert.throws(()=>lock(w),/航迹/);sense(w,1.1);t.alive=false;assert.throws(()=>lock(w),/不可锁定/);t.alive=true;
  mode(w,'off');assert.equal(own(w).radar.contacts.length,0);assert.equal(own(w).pilotContacts.length,0);assert.equal(own(w).radar.canIlluminate,false);
});
test('本机滚转影响天线坐标；停放和无搜索雷达机型不产生回波',()=>{
  const w=create(),t=target(w,[0,-200,0],[6000,10000,5000]);const g=radarGeometry(own(w),t);own(w).bank=Math.PI/2;const rolled=radarGeometry(own(w),t);assert.ok(Math.abs(g.azimuthDeg-rolled.azimuthDeg)>20);
  own(w).surface={grounded:true};mode(w);sense(w,2);assert.equal(own(w).radar.phase,'standby');assert.equal(own(w).radar.contacts.length,0);
  const noRadar=new World({units:[{...scenario.units[0],profile:'f86'}]},profiles);assert.throws(()=>mode(noRadar),/没有可用/);
});
test('口令经上下文校验、编译与飞机执行，雷达操作保留航路和编队',()=>{
  const w=create();const t=w.addRadarPracticeTarget('blue-1');mode(w);sense(w,1.1);
  own(w).waypoints=[[0,30000,5000]];own(w).formation={leaderId:'other',shape:'trail'};
  const c=validateContext(commandContext(w,'blue-1')),v=interpretation('lock_target',{targetId:t.id}),compiled=compileMilitaryInterpretation(v,c);
  assert.equal(compiled.execution.status,'ready');assert.equal(compiled.plan.tasks[0].action,'radar');applyPlan(w,compiled.plan,w.revision);assert.equal(own(w).radar.targetId,t.id);assert.equal(own(w).waypoints.length,1);assert.ok(own(w).formation);
  assert.ok(militarySchemaFor(c).properties.orders.items.anyOf[1].properties.parameters.properties.targetId.enum.includes(t.id));
  const fact=inspectCommandResult(commandContext(w,'blue-1'),compiled.plan,v,captureCommandResult(w))[0];assert.equal(fact.expectedVerdict,'executing');assert.ok(fact.requiredReadback.includes('开始截获'));
  assert.throws(()=>validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'executing',readbackText:fact.requiredReadback+'，正在执行，目标已锁定。'}]},[fact]),/尚未建立/);
});
test('雷达型号不足或额外参数须澄清，不能把不支持模式伪装成执行',()=>{
  const w=create(),c=commandContext(w,'blue-1');
  for(const p of [{mode:'tws'},{mode:'pd',headingDeg:90}])assert.equal(compileMilitaryInterpretation(interpretation('radar_mode',p),c).execution.status,'needs_clarification');
  const compiled=compileMilitaryInterpretation(interpretation('radar_mode',{mode:'pd'}),c);assert.equal(compiled.execution.status,'ready');applyPlan(w,compiled.plan,w.revision);
  const off=compileMilitaryInterpretation(interpretation('emcon'),commandContext(w,'blue-1'));applyPlan(w,off.plan,w.revision);assert.equal(own(w).radar.mode,'off');
  assert.equal(compileMilitaryInterpretation(interpretation('lock_target',{targetId:'blue-1'}),commandContext(w,'blue-1')).execution.status,'needs_clarification');
});
test('雷达批次失败不会部分执行；地面关闭雷达是合法操作',()=>{
  const w=create();target(w);mode(w);sense(w,1.1);const before=structuredClone(own(w).radar),revision=w.revision;
  assert.throws(()=>applyPlan(w,{status:'accepted',summary:'无效组合',tasks:[{unitId:'blue-1',action:'radar',radarOrder:{operation:'mode',mode:'off',targetId:null}},{unitId:'blue-1',action:'radar',radarOrder:{operation:'lock',mode:null,targetId:'tgt-1'}}]},w.revision),/先.*开启/);
  assert.deepEqual(own(w).radar,before);assert.equal(w.revision,revision);own(w).surface={grounded:true};mode(w,'off');assert.equal(own(w).radar.mode,'off');
});
test('雷达与练习靶机存档续接，旧存档没有雷达字段仍可读取',()=>{
  const w=create();w.addRadarPracticeTarget('blue-1');mode(w);sense(w,1.1);lock(w);sense(w,.8);
  const restored=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);assert.deepEqual(restored.radarTargets,w.radarTargets);assert.equal(own(restored).radar.phase,'locked');assert.equal(restored.radarTargetSequence,1);
  const legacy=captureWorld(w);delete legacy.radarTargets;delete legacy.radarTargetSequence;delete legacy.units[0].radar;assert.equal(own(restoreWorld(legacy,scenario,profiles)).radar.mode,'off');
  const corrupt=captureWorld(w);corrupt.units[0].radar.accumulator=Infinity;assert.throws(()=>restoreWorld(corrupt,scenario,profiles),/雷达存档/);
});
test('雷达回执按事件逐条播报，不在忙时抢占通联或重播旧存档事件',async()=>{
  const w=create();let busy=true;const calls=[],radio=new RadarRadio({getWorld:()=>w,radio:{transmit:async e=>calls.push(e)},isBusy:()=>busy});mode(w);radio.pump();assert.equal(calls.length,0);busy=false;radio.pump();await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,1);radio.pump();await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,1);
  assert.equal(calls[0].speaker,'pilot');assert.match(calls[0].text,/PD/);
});
test('雷达上下文拒绝无穷速度、重复航迹和未来观测时间',()=>{
  const w=create();target(w);mode(w);sense(w,1.1);const c=commandContext(w,'blue-1');assert.doesNotThrow(()=>parseRadarContext(c.units[0].radar,w.time));
  for(const mutate of [r=>r.contacts[0].velocity[0]=Infinity,r=>r.contacts.push(r.contacts[0]),r=>r.contacts[0].observedAt=w.time+1]){const bad=structuredClone(c.units[0].radar);mutate(bad);assert.throws(()=>parseRadarContext(bad,w.time));}
});
