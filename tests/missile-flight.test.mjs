import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars} from '../sim/radar.js';
import {stepWeapons,launchAssessment,parseWeaponsContext,createWeapons} from '../sim/weapons.js';
import {MISSILE_MODELS,motorState,stepMissiles,spawnMissile,seekerObservation} from '../sim/missiles.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {createCommanderTransmission} from '../sim/commander-message.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA 01',profile:'f16',position:[0,0,5000],heading:0,speed:300,color:'#fff'}]};
const create=(range=18000)=>{const w=new World(scenario,profiles);w.radarTargets=[{id:'tgt-1',callsign:'TGT 01',team:'practice',radarPractice:true,position:[0,range,5000],velocity:[0,-250,0],alive:true}];w.radarTargetSequence=1;return w;};
const command=(w,operation,modelId=null,targetId=null,quantity=null)=>w.weaponCommand('blue-1',{operation,modelId,targetId,quantity});
// Straight, controlled carrier/target trajectories isolate seeker and missile physics.
function tick(w,dt=1/60){const previous=new Map([...w.units,...w.radarTargets].map(u=>[u.id,[...u.position]]));w.time+=dt;
  for(const u of [...w.units,...w.radarTargets])if(u.alive)u.position=u.position.map((x,i)=>x+u.velocity[i]*dt);
  stepRadars(w,dt);stepWeapons(w,dt);stepMissiles(w,dt,previous);
}
const advance=(w,s)=>{for(let i=0;i<Math.round(s*60);i++)tick(w);};
function ready(w,id='us_aim_120b'){
  // Explicit test carrier inventory isolates all five missile families; actual
  // game F-16 loadouts and practice rearming remain restricted to AIM-120/AIM-9M.
  if(!Object.hasOwn(w.units[0].weapons.inventory,id))w.units[0].weapons=createWeapons('missile-test-carrier',{[id]:2});
  command(w,'select',id);w.radarCommand('blue-1',{operation:'mode',mode:'pd',targetId:null});advance(w,3);
  w.radarCommand('blue-1',{operation:'lock',mode:null,targetId:'tgt-1'});command(w,'designate',null,'tgt-1');advance(w,2);
  assert.equal(launchAssessment(w,w.units[0]).ready,true);return w;
}
const launch=(w,id=w.units[0].weapons.selectedModelId)=>{command(w,'launch',id,'tgt-1',1);return w.missiles.at(-1);};
const interpretation=(intent,parameters={})=>({version:'1.0',status:'understood',summary:'武器指令',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]});

test('24个配置逐一使用本地质量、推力阶段、延时、寿命和飞控上限，没有混用面板数据',()=>{
  assert.equal(MISSILE_MODELS.size,24);
  for(const m of MISSILE_MODELS.values()){
    const source=JSON.parse(fs.readFileSync(new URL('../data/flight-research/missiles/'+m.id+'.json',import.meta.url)));
    assert.deepEqual(m.motorStages,source.motorStages);assert.equal(m.simulationLimits.autopilotMaxG,source.rawRocket.guidance.guidanceAutopilot.reqAccelMax);
    assert.equal(m.sourceSha256,source.provenance.sha256);assert.equal(motorState(m,0).massKg,m.massKg);
    for(const s of m.motorStages){const middle=motorState(m,s.startSec+s.durationSec/2);assert.equal(middle.thrustN,s.thrustN);assert.ok(Math.abs(middle.massKg-(s.initialMassKg+s.finalMassKg)/2)<1e-6);}
    const end=motorState(m,1000);assert.equal(end.thrustN,0);assert.equal(end.massKg,m.finalMassKg);
  }
  const sparrow=MISSILE_MODELS.get('us_aim7p_sparrow_fa_18');assert.equal(motorState(sparrow,.1).thrustN,0);assert.equal(motorState(sparrow,.26).thrustN,21479.88);
});

test('五类导弹均经过实际积分和近炸命中，发射不瞬移，弹量只扣一次',()=>{
  for(const id of ['us_aim_120b','us_aim7p_sparrow_fa_18','us_aim9m_sidewinder','cn_pl12','su_pl5e2']){
    const w=ready(create(id.includes('aim9')||id==='su_pl5e2'?6000:18000),id),u=w.units[0],before=[...u.position],target=[...w.radarTargets[0].position],ammo=u.weapons.inventory[id],m=launch(w,id);
    assert.deepEqual(u.position,before);assert.deepEqual(w.radarTargets[0].position,target);assert.equal(u.weapons.inventory[id],ammo-1);assert.equal(m.ageSec,0);assert.equal(m.alive,true);
    let peak=0;for(let i=0;i<6000&&m.alive;i++){tick(w);peak=Math.max(peak,m.speedMps);assert.ok(m.position.every(Number.isFinite));assert.ok(m.loadFactor<=MISSILE_MODELS.get(id).simulationLimits.autopilotMaxG+1e-6);}
    assert.equal(m.phase,'hit',id);assert.equal(w.radarTargets[0].alive,false);assert.ok(m.ageSec>1);assert.ok(peak>u.speed+200);assert.ok(m.massKg<MISSILE_MODELS.get(id).massKg);assert.ok(w.weaponEvents.some(e=>e.type==='hit'));assert.equal(u.weapons.inventory[id],ammo-1);
  }
});

test('发动机关机后失去推力并减速，重力继续作用；寿命和航程确实终止飞行',()=>{
  const w=ready(create(6000),'us_aim9m_sidewinder'),m=launch(w);w.radarTargets[0].position=[50000,50000,5000];advance(w,6);
  const speed=m.speedMps,height=m.position[2];assert.equal(m.thrustN,0);advance(w,3);assert.ok(m.speedMps<speed);assert.ok(m.position[2]<height);assert.equal(m.phase,'lost');
  m.ageSec=MISSILE_MODELS.get(m.modelId).lifetimeSec-.001;tick(w);assert.equal(m.phase,'expired');
  const w2=ready(create()),m2=launch(w2);m2.travelM=MISSILE_MODELS.get(m2.modelId).simulationLimits.maxTravelM;tick(w2);assert.equal(m2.phase,'spent');
});

test('红外弹关闭载机雷达仍寻的；半主动掉锁不再读取目标新位置',()=>{
  const ir=ready(create(6000),'us_aim9m_sidewinder');ir.radarCommand('blue-1',{operation:'mode',mode:'off',targetId:null});advance(ir,.1);
  const im=launch(ir);advance(ir,1);assert.equal(im.phase,'infrared');assert.equal(ir.units[0].radar.mode,'off');
  const w=ready(create(24000),'us_aim7p_sparrow_fa_18'),m=launch(w);advance(w,1);assert.equal(m.phase,'semi_active');
  w.radarCommand('blue-1',{operation:'mode',mode:'off',targetId:null});const received=structuredClone(m.observation);w.radarTargets[0].position=[12000,12000,9000];advance(w,.4);
  assert.equal(m.phase,'inertial');assert.deepEqual(m.observation.position,received.position);assert.deepEqual(m.observation.velocity,received.velocity);assert.ok(m.observation.ageSec>.39);
});

test('主动弹中段断链只外推；弹上雷达接获后关闭载机雷达仍跟踪',()=>{
  const w=ready(create(40000)),m=launch(w);advance(w,.2);assert.equal(m.phase,'datalink');assert.equal(m.active,false);
  w.radarCommand('blue-1',{operation:'mode',mode:'off',targetId:null});const received=structuredClone(m.observation);w.radarTargets[0].position[0]=15000;advance(w,.5);
  assert.equal(m.active,false);assert.equal(m.phase,'inertial');assert.deepEqual(m.observation.position,received.position);
  const a=ready(create(14000)),am=launch(a);advance(a,.5);assert.equal(am.phase,'active');a.radarCommand('blue-1',{operation:'mode',mode:'off',targetId:null});advance(a,.5);assert.equal(am.phase,'active');assert.equal(am.observation.ageSec,0);
});

test('导引头角度、距离、地形和雷达杂波门会导致失去观测',()=>{
  const m=MISSILE_MODELS.get('us_aim9m_sidewinder'),target={position:[0,4000,5000],velocity:[0,-200,0],alive:true};
  assert.ok(seekerObservation(m,[0,0,5000],[0,1,0],target,null));assert.equal(seekerObservation(m,[0,0,5000],[1,0,0],target,null),null);
  assert.equal(seekerObservation(m,[0,0,5000],[0,1,0],{...target,position:[0,50000,5000]},null),null);
  assert.equal(seekerObservation(m,[0,0,5000],[0,1,0],target,{heightAt:()=>6000}),null);
  const radar=MISSILE_MODELS.get('us_aim_120b');assert.equal(seekerObservation(radar,[0,0,5000],[0,1,0],{...target,position:[0,4000,3000],velocity:[250,0,0]},null),null);
});

test('未准备、地面、友机、弹量不足均拒绝发射；交战规则不会自行发射',()=>{
  const w=create(6000);assert.throws(()=>launch(w),/锁定/);ready(w);const u=w.units[0];
  for(const operation of ['hold','tight','free']){command(w,operation);assert.equal(w.missiles.length,0);assert.equal(u.weapons.roe,operation);}
  u.surface={grounded:true};assert.throws(()=>launch(w),/离地/);delete u.surface;
  w.radarTargets[0].team='blue';assert.throws(()=>launch(w),/友机/);w.radarTargets[0].team='practice';
  u.weapons.inventory[u.weapons.selectedModelId]=2; // Two rounds already expended.
  assert.throws(()=>command(w,'launch',u.weapons.selectedModelId,'tgt-1',3),/不足/);assert.equal(u.weapons.inventory[u.weapons.selectedModelId],2);
  launch(w);assert.throws(()=>w.reloadPracticeMissile(u.id,'cn_pl12'),/在空/);
});

test('混合批次失败整体回滚发射、弹量、事件及序号；同机重复发射不绕过弹量检查',()=>{
  const w=ready(create()),before=w.units[0].weapons.inventory.us_aim_120b;
  const weapon={unitId:'blue-1',action:'weapon',weaponOrder:{operation:'launch',modelId:'us_aim_120b',targetId:'tgt-1',quantity:1}};
  assert.throws(()=>applyPlan(w,{status:'accepted',summary:'重复',tasks:[weapon,structuredClone(weapon)]},w.revision),/分条/);
  const other={...scenario.units[0],id:'blue-2',callsign:'BRAVO 02',position:[2000,0,5000]};
  const second=new World({units:[other]},profiles).units[0];w.units.push(second);
  const plan={status:'accepted',summary:'两机同时发射',tasks:[weapon,{...weapon,unitId:'blue-2'}]},beforeRevision=w.revision;
  assert.throws(()=>applyPlan(w,plan,w.revision),/锁定|准备/);assert.equal(w.missiles.length,0);assert.equal(w.units[0].weapons.inventory.us_aim_120b,before);assert.equal(w.revision,beforeRevision);
});

test('AI上下文只传感器观测，指挥播报保留型号、目标、数量；编译后实际发射',()=>{
  const w=ready(create()),context=validateContext(commandContext(w,'blue-1'));
  assert.ok(context.units[0].weapons.inventory.us_aim_120b===4);assert.ok(context.units[0].weapons.contacts.every(c=>c.source==='visual'));assert.equal(context.radarTargets,undefined);
  const compiled=compileMilitaryInterpretation(interpretation('launch_weapon',{weapon:'AIM-120',targetId:'tgt-1',quantity:2}),context);assert.equal(compiled.plan.status,'accepted');
  const speech=createCommanderTransmission(compiled,w.units).text;assert.match(speech,/发射 2 枚/);assert.match(speech,/tgt-1/);assert.match(speech,/AIM 120B/);
  applyPlan(w,compiled.plan,w.revision);assert.equal(w.missiles.length,2);assert.equal(w.units[0].weapons.inventory.us_aim_120b,2);
  const free=compileMilitaryInterpretation(interpretation('weapons_free'),commandContext(w,'blue-1'));applyPlan(w,free.plan,w.revision);assert.equal(w.missiles.length,2);
  const corrupt=structuredClone(context.units[0].weapons);corrupt.inventory.us_aim_120b=-1;assert.throws(()=>parseWeaponsContext(corrupt,w.time));
});

test('存档恢复在空导弹、已耗弹量和制导记忆，旧存档兼容；伪造弹型拒绝恢复',()=>{
  const w=ready(create()),m=launch(w);advance(w,1);const saved=decodeState(encodeState(captureWorld(w))),restored=restoreWorld(saved,scenario,profiles);
  assert.deepEqual(restored.missiles,w.missiles);assert.equal(restored.units[0].weapons.inventory.us_aim_120b,3);assert.equal(restored.missileSequence,1);
  tick(w);tick(restored);assert.deepEqual(restored.missiles[0].position,m.position);
  saved.missiles[0].modelId='unknown';assert.throws(()=>restoreWorld(saved,scenario,profiles),/导弹/);
  const legacy=captureWorld(create());delete legacy.missiles;delete legacy.missileSequence;delete legacy.weaponEvents;delete legacy.units[0].weapons;assert.equal(restoreWorld(legacy,scenario,profiles).missiles.length,0);
});

test('发射结果检查按真实记录复述，不会把已发射说成命中',()=>{
  const w=ready(create()),plan=compileMilitaryInterpretation(interpretation('launch_weapon',{quantity:1,targetId:'tgt-1'}),commandContext(w,'blue-1')).plan;
  applyPlan(w,plan,w.revision);const facts=inspectCommandResult(commandContext(w,'blue-1'),plan,null,captureCommandResult(w));
  assert.equal(facts[0].expectedVerdict,'reported');assert.match(facts[0].requiredReadback,/已发射，尚未确认命中/);
  assert.doesNotThrow(()=>validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'reported',readbackText:facts[0].requiredReadback+'，状态已核实。'}]},facts));
  assert.throws(()=>validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'reported',readbackText:facts[0].requiredReadback+'，已击毁目标。'}]},facts),/发射记录/);
});

test('真实World.step推进导弹，世界快照提供弹道而不改变既有航路',()=>{
  const w=ready(create(14000)),m=launch(w),route=JSON.stringify(w.units[0].waypoints);for(let i=0;i<120;i++)w.step(1/60);
  assert.ok(m.ageSec>1.9);assert.ok(m.travelM>500);assert.ok(w.snapshot('blue-1',{forecast:false}).missiles.some(v=>v.id===m.id));assert.equal(JSON.stringify(w.units[0].waypoints),route);
});

test('24个变体均可装载和飞行；弹体差异实际进入推力质量计算',()=>{
  for(const model of MISSILE_MODELS.values()){
    const w=ready(create(model.kind==='infrared'?6000:18000),model.id),m=launch(w);advance(w,2);
    assert.ok(m.travelM>600,model.id);assert.ok(m.massKg<model.massKg,model.id);assert.ok(m.speedMps>300,model.id);assert.equal(m.modelId,model.id);
  }
});

test('高速穿越目标用相对扫掠判定近炸，保险未解除时不提前命中',()=>{
  for(const armed of [false,true]){
    const w=create(),u=w.units[0],target=w.radarTargets[0];target.position=[0,60,5000];target.velocity=[0,0,0];
    const model=MISSILE_MODELS.get('us_aim_120b'),m=spawnMissile(w,u,target,model,{position:target.position,velocity:target.velocity});
    m.position=[0,0,5000];m.velocity=[0,1500,0];m.forward=[0,1,0];m.ageSec=armed?2:0;w.time=3;
    stepMissiles(w,.1,new Map([[target.id,[...target.position]],[u.id,[...u.position]]]));assert.equal(target.alive,!armed);assert.equal(m.phase==='hit',armed);
  }
});

test('已选型号重复选择不清除导引头准备，AI复述选择加发射仍只发一枚',()=>{
  const w=ready(create(6000),'us_aim9m_sidewinder'),modelId=w.units[0].weapons.selectedModelId,revision=w.revision;
  const tasks=[{unitId:'blue-1',action:'weapon',weaponOrder:{operation:'select',modelId,targetId:null,quantity:null}},
    {unitId:'blue-1',action:'weapon',weaponOrder:{operation:'launch',modelId,targetId:'tgt-1',quantity:1}}];
  applyPlan(w,{status:'accepted',summary:'选择并发射',tasks},revision);assert.equal(w.missiles.length,1);assert.equal(w.units[0].weapons.inventory[modelId],1);
});
