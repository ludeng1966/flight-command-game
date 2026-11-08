import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {beginPilotExecution,setPilotInstruction,monitorPilotExecution,applyPilotAdjustment} from '../sim/pilot-execution.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {PilotSupervisor} from '../game/pilot-supervisor.js';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {traceFlight} from '../sim/safe-navigation.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const make=()=>new World(scenario,profiles),flush=()=>new Promise(r=>setImmediate(r));
const adjustment={throttle:.95,afterburner:0,speedMps:185,via:[]};
function weakClimb(){
  const w=make(),u=w.units[0];u.headingTarget=0;u.holdAltitude=8000;
  u.departurePowerPlan={active:true,throttle:.08,afterburner:0,altitudeM:8000,climbSpeedMps:180,mode:'reduced_thrust'};
  beginPilotExecution(w,u);setPilotInstruction(u,'保持减推力，不使用加力，爬升至8000米');return {w,u};
}

test('持续能量不足自动调用模型并把推力方案接入实际飞行，不需新指令',async()=>{
  const {w,u}=weakClimb();let at=0,calls=0;const reports=[];
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',memory:{}}),async start(){},async stop(){},async complete(_role,messages,schema){
    calls++;assert(schema.properties.decision.enum.includes('adjust_plan'));const data=JSON.parse(messages[1].content);
    assert.equal(data.execution.constraints.afterburnerCap,0);assert(data.execution.feedback.availableThrustN>0);
    return {value:{decision:'adjust_plan',message:'拟提高军用推力，保持原任务爬升',missingData:[],adjustment},timing:{}};
  }})});
  const watch=new PilotSupervisor({getWorld:()=>w,now:()=>at,onReport:r=>reports.push(r),fetchImpl:async(_url,options)=>({ok:true,json:async()=>assistant.assess(JSON.parse(options.body))})});
  const revision=w.revision,initialAltitude=u.position[2];let appliedAt=null,maxThrottle=0;
  for(let sec=0;sec<100;sec++){
    for(let i=0;i<60;i++)w.step(1/60);at+=1000;watch.tick();await flush();
    if(u.pilotPowerPlan){appliedAt??=w.time;maxThrottle=Math.max(maxThrottle,u.throttle);}
  }
  assert(calls>=1);assert(appliedAt<60);assert(reports.some(r=>r.applied));assert.equal(u.pilotPowerPlan.afterburner,0);
  assert(maxThrottle>.6,'真实油门必须超过旧方案限制');assert(u.position[2]>initialAltitude+100);assert.equal(u.afterburner,0);
  assert.equal(w.revision,revision);assert.equal(u.pilotExecution.targetAltitudeM,8000);assert(u.alive);watch.stop();
});

test('重新规划仅添加中间点，保留原航点并按新推力做物理验证；人工操作覆盖方案',()=>{
  const w=make(),u=w.units[0],goal=[-8000,16000,7500];w.command(u.id,goal);const original=u.waypoints[0],id=u.pilotExecution.id;
  u.navigationBlocked='原爬升航路不适合';const applied=applyPilotAdjustment(w,u,{...adjustment,via:[[-8000,-3000,6600]]},id);
  assert.equal(applied.viaCount,1);assert.equal(u.waypoints.at(-1),original);assert.equal(u.waypoints[0].pilotTemporary,true);assert.equal(u.navigationBlocked,null);
  const before=structuredClone(u.pilotPowerPlan);traceFlight(u,u.waypoints,u.navLegs,{duration:15});assert.deepEqual(u.pilotPowerPlan,before,'预测不能修改实时推力方案');
  const saved=decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(w))))),restored=restoreWorld(saved,scenario,profiles);
  assert.deepEqual(restored.units[0].pilotPowerPlan,u.pilotPowerPlan);assert.equal(restored.units[0].pilotExecution.id,id);assert.equal(restored.units[0].waypoints[0].pilotTemporary,true);
  w.command(u.id,[-8000,20000,7500]);assert.equal(u.pilotPowerPlan,null);assert.notEqual(u.pilotExecution.id,id);
  assert.throws(()=>applyPilotAdjustment(w,u,adjustment,id),/作废/);
});

test('规划不满足硬限制时原子拒绝，持续问题自动重试并携带上次拒绝原因',async()=>{
  const {w,u}=weakClimb();setPilotInstruction(u,'油门85%，不使用加力，爬升至8000米');let at=0,calls=0;
  u.requiredThrustN=1e6;monitorPilotExecution(w,u);w.time=25;monitorPilotExecution(w,u);
  const position=[...u.position],route=structuredClone(u.waypoints);
  const watch=new PilotSupervisor({getWorld:()=>w,now:()=>at,fetchImpl:async(_url,options)=>{const b=JSON.parse(options.body);calls++;
    if(calls>1)assert.match(b.observation.execution.lastError,/推力限制/);
    return {ok:true,json:async()=>({requestId:b.requestId,revision:b.context.revision,simTimeSec:b.context.simTimeSec,modelInvoked:true,
      assessment:{decision:'adjust_plan',message:'拟调整',missingData:[],adjustment:{...adjustment,afterburner:1}}})};}});
  watch.tick();await flush();assert.equal(calls,1);assert.equal(u.pilotPowerPlan,null);assert.deepEqual(u.position,position);assert.deepEqual(u.waypoints,route);
  at=16000;w.time+=16;watch.tick();await flush();assert.equal(calls,2);assert.equal(u.pilotExecution.attempt,2);watch.stop();
});

test('人工改令、暂停和条件消失都使推理中的旧方案失效',async()=>{
  const {w,u}=weakClimb();let at=0,resolve,signal,playing=true;
  u.requiredThrustN=1e6;monitorPilotExecution(w,u);w.time=25;monitorPilotExecution(w,u);
  const watch=new PilotSupervisor({getWorld:()=>w,isPlaying:()=>playing,now:()=>at,fetchImpl:(_url,options)=>{
    signal=options.signal;const b=JSON.parse(options.body);return new Promise(r=>resolve=()=>r({ok:true,json:async()=>({requestId:b.requestId,revision:b.context.revision,simTimeSec:b.context.simTimeSec,modelInvoked:true,assessment:{decision:'adjust_plan',message:'旧方案',missingData:[],adjustment}})}));
  }});
  watch.tick();playing=false;watch.tick();assert(signal.aborted);resolve();await flush();assert.equal(u.pilotPowerPlan,null);watch.stop();
});

test('服务端拒绝损坏的执行快照；暂时能量变化不触发重新规划',async()=>{
  const {w,u}=weakClimb();u.requiredThrustN=1e6;monitorPilotExecution(w,u);w.time=10;monitorPilotExecution(w,u);assert.equal(pilotObservation(w,u),null);
  w.time=25;monitorPilotExecution(w,u);const observation=pilotObservation(w,u);assert.equal(observation.event.reason,'execution_deviation');
  observation.execution.feedback.speedMps='bad';const assistant=new PilotAssistant('.');
  await assert.rejects(assistant.assess({requestId:'bad-observation',context:commandContext(w,u.id),observation}),/快照无效/);
});

test('正常执行中的新威胁仍可判断，不会被空的重新规划事件快照拒绝',()=>{
  const w=make(),u=w.units[0];monitorPilotExecution(w,u);u.pilotContacts=[{id:'missile',source:'sensor',observedAt:0,classification:'hostile',threat:true,missileWarning:true,position:null,velocity:null}];
  const observation=pilotObservation(w,u);assert.equal(observation.execution,null);
  const parsed=new PilotAssistant('.').validate({requestId:'live-threat',context:commandContext(w,u.id),observation});assert.equal(parsed.event.reason,'new_threat');
});

test('没有航点的爬升也拒绝无法维持飞行的推力，不让模型只略微提高旧限推值',()=>{
  const {w,u}=weakClimb(),before=structuredClone(u.pilotExecution);
  assert.throws(()=>applyPilotAdjustment(w,u,{...adjustment,throttle:.15,speedMps:130},u.pilotExecution.id),/推力不足/);
  assert.equal(u.pilotPowerPlan,null);assert.deepEqual(u.pilotExecution,before);
});

test('受限推力的航路预测不能借助保护自动解除限制来冒充可飞',()=>{
  const w=make(),u=w.units[0];u.pilotPowerPlan={active:true,throttle:.08,afterburner:0,executionId:'test'};
  u.velocity=[0,85,0];u.speed=85;
  const legs=[[[-8000,-7000,6500],[-8000,0,8000]]],forecast=traceFlight(u,[[-8000,0,8000]],legs,{duration:500});
  assert.equal(forecast.valid,false);assert.match(forecast.warnings.join(' '),/推力|失速/);assert.equal(u.pilotPowerPlan.active,true);
});

test('反复失速保护即使短暂改出也触发任务方案重规划',()=>{
  const w=make(),u=w.units[0];monitorPilotExecution(w,u);
  for(const [time,state]of [[1,'stall-recovery'],[10,'normal'],[20,'stall-recovery'],[30,'normal'],[41,'normal']]){w.time=time;u.flightState=state;monitorPilotExecution(w,u);}
  assert.equal(pilotObservation(w,u).event.reason,'execution_deviation');assert.equal(u.pilotExecution.feedback.recentRecoveryCount,2);
});

test('模型格式偏离时自动修正一次，再返回可执行调整协议',async()=>{
  const {w,u}=weakClimb();u.requiredThrustN=1e6;monitorPilotExecution(w,u);w.time=25;monitorPilotExecution(w,u);let calls=0;
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',memory:{}}),async start(){},async stop(){},async complete(_role,messages){
    calls++;if(calls===1)return {value:{decision:'execute',message:'错误协议',missingData:[]}};
    assert.match(messages.at(-1).content,/修正协议/);return {value:{decision:'adjust_plan',message:'拟调整推力并继续原任务',missingData:[],adjustment},timing:{}};
  }})});
  const result=await assistant.assess({requestId:'repair-execution',context:commandContext(w,u.id),observation:pilotObservation(w,u)});assert.equal(calls,2);assert.equal(result.assessment.decision,'adjust_plan');
});

test('人工新航路会替换旧限推，不被已失效的自动方案阻止；普通“不加力”也保留为硬限制',()=>{
  const w=make(),u=w.units[0];beginPilotExecution(w,u);setPilotInstruction(u,'保持不加力');assert.equal(u.pilotExecution.constraints.afterburnerCap,0);
  u.pilotPowerPlan={active:true,throttle:.08,afterburner:0,executionId:u.pilotExecution.id};const id=u.pilotExecution.id;
  w.command(u.id,[-8000,16000,7500]);assert.equal(u.pilotPowerPlan,null);assert.notEqual(u.pilotExecution.id,id);assert.deepEqual(u.waypoints.at(-1).slice(0,3),[-8000,16000,7500]);
});

test('减推力限制按实际推力保留，不把飞行员先前选择的无加力方案当成玩家永久禁令',()=>{
  const w=make(),u=w.units[0];u.holdAltitude=8000;u.departurePowerPlan={active:true,throttle:.8,afterburner:0,altitudeM:8000,mode:'reduced_thrust'};
  beginPilotExecution(w,u);setPilotInstruction(u,'减推力爬升到8000米');assert.equal(u.pilotExecution.constraints.afterburnerCap,1);
  assert.throws(()=>applyPilotAdjustment(w,u,{...adjustment,throttle:1,afterburner:1},u.pilotExecution.id),/减推力范围/);
  applyPilotAdjustment(w,u,{...adjustment,throttle:.9,afterburner:.2},u.pilotExecution.id);assert.equal(u.pilotPowerPlan.afterburner,.2);
});
