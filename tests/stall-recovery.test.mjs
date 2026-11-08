import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {aeroAt,flightSafety,stepFlight} from '../sim/flight.js';
import {updatePilot} from '../sim/pilot.js';
import {selectedAircraftStatus} from '../sim/unit-status.js';
import {monitorPilotExecution,applyPilotAdjustment} from '../sim/pilot-execution.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {runJob} from '../sim/planner-worker.js';
import {plannerUnit} from '../game/planner-client.js';
import {traceFlight} from '../sim/safe-navigation.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function lowSpeed(pitch=73){
  const w=new World(scenario,profiles),u=w.units[0],v=58/3.6,g=pitch*Math.PI/180,h=119*Math.PI/180;
  Object.assign(u,{position:[-8000,-7000,7217],velocity:[Math.sin(h)*v*Math.cos(g),Math.cos(h)*v*Math.cos(g),v*Math.sin(g)],speed:v,bank:0,
    cl:aeroAt(u.profile,7217,v).clMax/1.16**2,guidance:{bank:0,n:.1},energy:undefined,throttle:1,afterburner:1,targetSpeed:649/3.6,holdAltitude:6096,headingTarget:h,waypoints:[],stalled:false});
  return {w,u};
}

test('当前低速或改出不再封锁所有新航点，预测和实际飞行均先恢复再到达',()=>{
  for(const recovering of [false,true]){
    const {w,u}=lowSpeed();if(recovering){u.flightState='stall-recovery';u.recoveryTime=2;}
    const goal=[-8000,3000,6500],before=JSON.stringify(u);
    const plan=runJob({type:'plan',unit:plannerUnit(u,true),route:[goal]},null);
    assert(plan.valid,plan.reason);assert(plan.initialRecovery);assert(plan.recoverySeconds>5);assert(plan.recoverySeconds<35);
    assert.equal(JSON.stringify(u),before);assert.deepEqual(plan.points[0],u.position);
    assert(plan.legs[0].recoveryEndIndex>0);
    // 包括提交时的14秒近程校核，不能只放开光标提示而提交仍失败。
    w.command(u.id,goal,false,structuredClone(plan));assert.equal(u.waypoints.length,1);
    let recoverySeen=false;
    for(let i=0;i<360*60&&u.completedWaypoints!==1;i++){
      w.step(1/60);if(u.flightState==='stall-recovery')recoverySeen=true;
      assert(u.alive);assert(u.position[2]>100);
    }
    assert(recoverySeen);assert.equal(u.completedWaypoints,1);assert.equal(u.flightState,'normal');
  }
});

test('同一正常400km/h状态可向前后左右规划，不误报全图失速',()=>{
  const w=new World(scenario,profiles),u=w.units[0];u.targetSpeed=400/3.6;u.holdAltitude=6959;
  for(let i=0;i<400*60;i++)w.step(1/60);
  const heading=Math.atan2(u.velocity[0],u.velocity[1]);
  for(const angle of [0,Math.PI/2,Math.PI,-Math.PI/2]){
    const goal=[u.position[0]+Math.sin(heading+angle)*3000,u.position[1]+Math.cos(heading+angle)*3000,6791];
    const plan=runJob({type:'plan',unit:plannerUnit(u,true),route:[goal]},null);
    assert(plan.valid,`${angle}: ${plan.reason}`);assert(!plan.initialRecovery);
  }
});

test('确实没有改出净空仍拒绝；正常飞行的新失速仍被拦截',()=>{
  const {u}=lowSpeed(-70);u.position[2]=110;
  const terrain={heightAt:()=>0},goal=[-8000,3000,6500];
  const plan=runJob({type:'plan',unit:plannerUnit(u,true),route:[goal]},terrain);
  assert.equal(plan.valid,false);assert.match(plan.reason,/改出.*净空不足/);
  const normal=new World(scenario,profiles).units[0];
  // 初始没有改出标志，之后气动积分检测到迎角失速，仍须拒绝。
  normal.cl=aeroAt(normal.profile,normal.position[2],normal.speed).clMax*1.5;
  const trace=traceFlight(normal,[],[],{duration:120,settle:120});
  assert.equal(trace.initialRecovery,false);assert.equal(trace.valid,false);assert(trace.warnings.includes('失速风险'));
});

test('后台预测使用真实构型、失速标志和改出限制且不共享对象',()=>{
  const {u}=lowSpeed();Object.assign(u,{stalled:true,gearDown:true,flaps:'landing',speedBrake:true,pilotExecution:{constraints:{afterburnerCap:0,throttleCap:.8}}});
  const snapshot=plannerUnit(u,true);
  for(const key of ['stalled','gearDown','flaps','speedBrake'])assert.equal(snapshot[key],u[key]);
  assert.deepEqual(snapshot.pilotExecution.constraints,u.pilotExecution.constraints);
  snapshot.pilotExecution.constraints.afterburnerCap=1;assert.equal(u.pilotExecution.constraints.afterburnerCap,0);
});
test('58km/h与73度上仰即使CL未超限也显示严重低速，航路提示不能覆盖险情',()=>{
  const {u}=lowSpeed();u.navigationBlocked='航路暂缓';
  assert.equal(u.flightState,'normal');assert.equal(u.stalled,false);assert(flightSafety(u).severeLowSpeed);
  assert.equal(selectedAircraftStatus(u).phase,'严重低速');assert.equal(selectedAircraftStatus(u).alert,'danger');
  const before=[...u.position];updatePilot(u,.1);assert.deepEqual(u.position,before);assert.equal(u.flightState,'stall-recovery');assert.equal(u.recoveryCause,'low-speed');
  assert.equal(u.control.bank,0);assert.equal(u.control.throttle,1);assert.equal(u.control.afterburner,1);assert.equal(selectedAircraftStatus(u).phase,'低速改出');
});
test('物理帧也能识别严重掉速，触发保护时不瞬间补速度',()=>{
  const {u}=lowSpeed();const speed=u.speed;stepFlight(u,1/60);assert.equal(u.flightState,'stall-recovery');assert(Math.abs(u.speed-speed)<1);
});
test('58km/h高空低速状态自然改出并稳定返回目标，近垂直时也不再俯冲失控',()=>{
  for(const pitch of [0,73,89.9,90,-70]){
    const {w,u}=lowSpeed(pitch);let entered=false,recoveredAt=null,minAltitude=7217;
    for(let i=0;i<180*60;i++){
      w.step(1/60);minAltitude=Math.min(minAltitude,u.position[2]);if(u.flightState==='stall-recovery')entered=true;
      if(entered&&u.flightState==='normal')recoveredAt??=w.time;
      assert(u.position.every(Number.isFinite));
    }
    assert(entered);assert(recoveredAt<35,`pitch ${pitch}`);assert(minAltitude>5500,`pitch ${pitch}, altitude ${minAltitude}`);
    assert.equal(u.flightState,'normal');assert(Math.abs(u.position[2]-6096)<15);assert(Math.abs(u.speed-649/3.6)<2);assert.equal(u.recoveryCause,null);
  }
});
test('目标在后下方时先水平转向，避免用拉升或俯冲追反向目标',()=>{
  const w=new World(scenario,profiles),u=w.units[0];u.headingTarget=Math.atan2(u.velocity[0],u.velocity[1])+Math.PI-1e-6;u.holdAltitude=6096;
  let steepest=0,minSpeed=u.speed;
  for(let i=0;i<180*60;i++){w.step(1/60);steepest=Math.max(steepest,Math.abs(Math.asin(u.velocity[2]/u.speed)));minSpeed=Math.min(minSpeed,u.speed);assert.equal(u.flightState,'normal');}
  assert(steepest<Math.PI/4);assert(minSpeed>100);assert(Math.abs(u.position[2]-6096)<30);
});
test('机位和滑行低速不误报失速，真失速优先于航路暂缓显示',()=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0];updatePilot(u,.1);assert.equal(u.flightState,'normal');assert.equal(selectedAircraftStatus(u).alert,null);
  u.surface=undefined;u.velocity=[180,0,0];u.speed=180;u.stalled=true;u.navigationBlocked='等待重规划';assert.equal(selectedAircraftStatus(u).phase,'失速');updatePilot(u,.1);assert.equal(u.recoveryCause,'stall');assert.equal(selectedAircraftStatus(u).phase,'失速改出');
});
test('严重低速立即唤醒AI，模型的推力、下降、坡度与卸载选择真正进入控制器',()=>{
  for(const plan of [
    {throttle:1,afterburner:.4,speedMps:180,via:[],recovery:{flightPathDeg:-10,bankDeg:0,unloadG:.4}},
    {throttle:.85,afterburner:1,speedMps:185,via:[],recovery:{flightPathDeg:0,bankDeg:5,unloadG:.6}},
  ]){
    const {w,u}=lowSpeed();monitorPilotExecution(w,u);const observation=pilotObservation(w,u);
    assert(observation.event.urgent);assert.equal(w.time,0);assert.equal(observation.execution.feedback.recoveryCause,null);
    const position=[...u.position],velocity=[...u.velocity],originalSpeed=u.targetSpeed;
    const result=applyPilotAdjustment(w,u,plan,u.pilotExecution.id);assert(result.predictedRecoverySeconds<90);assert.deepEqual(u.position,position);assert.deepEqual(u.velocity,velocity);
    updatePilot(u,.1);assert.equal(u.recoveryPowerSource,'model');assert.equal(u.control.afterburner,plan.afterburner);assert.equal(u.control.throttle,plan.throttle);assert.equal(u.control.bank,plan.recovery.bankDeg*Math.PI/180);
    let recovered=false;for(let i=0;i<90*60;i++){w.step(1/60);if(u.flightState==='normal'){recovered=true;break;}}
    assert(recovered);assert.equal(u.pilotPowerPlan.active,false);assert.equal(u.targetSpeed,originalSpeed);
  }
});
test('无法改出的模型方案原子拒绝；硬性推力限制不能借改出绕过',()=>{
  const {w,u}=lowSpeed();monitorPilotExecution(w,u);const before=JSON.stringify(u.pilotPowerPlan),id=u.pilotExecution.id;
  const plan={throttle:1,afterburner:1,speedMps:180,via:[],recovery:{flightPathDeg:5,bankDeg:0,unloadG:.5}};
  assert.throws(()=>applyPilotAdjustment(w,u,plan,id),/改出俯仰/);assert.equal(JSON.stringify(u.pilotPowerPlan),before);
  u.pilotExecution.constraints.afterburnerCap=0;plan.recovery.flightPathDeg=-10;assert.throws(()=>applyPilotAdjustment(w,u,plan,id),/原指令的推力限制/);
  u.pilotExecution.constraints.afterburnerCap=1;u.pilotExecution.constraints.maximumThrustFraction=.5;assert.throws(()=>applyPilotAdjustment(w,u,plan,id),/原指令的推力限制/);
  assert.equal(JSON.stringify(u.pilotPowerPlan),before);
});
