import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorTaskFeedback,taskFeedback,taskTimeline,TASK_STABLE_SECONDS} from '../sim/task-feedback.js';
import {missionBrief} from '../game/mission-report.js';
const create=()=>{const u={id:'a',callsign:'ALPHA',alive:true,position:[0,0,3000],velocity:[0,180,0],speed:180,targetSpeed:180,holdAltitude:3000,headingTarget:0,waypoints:[],completedWaypoints:0,pilotExecution:{id:'a:1',targetAltitudeM:3000,targetSpeedMps:180},controlAuthority:{owner:'commander',phase:'owned'}};return {time:0,units:[u],commandLog:[]};};
const tick=(w,t)=>{w.time=t;monitorTaskFeedback(w);};
test('到达参数必须连续稳定，短暂越过目标和倍速显示刷新不触发完成',()=>{
  const w=create(),u=w.units[0];tick(w,0);tick(w,7);assert.equal(taskFeedback(w,u).phase,'执行中');
  u.position[2]=3100;tick(w,8);u.position[2]=3000;tick(w,9);tick(w,16);assert.equal(taskFeedback(w,u).phase,'执行中');
  tick(w,9+TASK_STABLE_SECONDS);assert.equal(taskFeedback(w,u).phase,'参数稳定达标');assert.match(taskFeedback(w,u).result,/原定飞行参数/);
  assert.equal(taskTimeline(w,u).filter(e=>e.summary.includes('稳定达标')).length,1);
});
test('临时改速不能覆盖原命令目标；新任务保留旧任务替代事实',()=>{
  const w=create(),u=w.units[0];u.speed=190;u.targetSpeed=190;tick(w,0);tick(w,20);assert.equal(taskFeedback(w,u).phase,'执行中');
  u.pilotExecution={id:'a:2',targetAltitudeM:3000,targetSpeedMps:190};tick(w,21);tick(w,30);
  const events=taskTimeline(w,u);assert.ok(events.some(e=>e.taskId==='a:1'&&e.summary.includes('替代')));assert.equal(taskFeedback(w,u).phase,'参数稳定达标');
});
test('清空航点不等于通过；真实最后原定航点通过后才稳定完成',()=>{
  const w=create(),u=w.units[0];u.headingTarget=null;u.waypoints=[[1000,0,3000]];tick(w,0);
  u.waypoints=[];tick(w,1);tick(w,12);assert.equal(taskFeedback(w,u).phase,'执行中');
  u.completedWaypoints=1;u.previousWaypoint=[1000,0,3000];tick(w,13);tick(w,21);assert.match(taskFeedback(w,u).result,/原定航路已实际通过/);
});
test('任务卡优先显示规避、攻击阶段、等待条件；命中必须有仿真事实',()=>{
  const w=create(),u=w.units[0];u.attackTask={id:'a-attack-1',active:true,status:'supporting',targetId:'track-1',engagedTargetId:'track-1',shotLimit:2,firedMissileIds:['missile-1'],flightResults:{'missile-1':{phase:'flying',alive:true}},events:[]};
  let brief=missionBrief(w,u.id);assert.match(brief.objective,/攻击任务/);assert.match(brief.feedback.waiting,/雷达支持/);assert.match(brief.feedback.result,/未确认命中/);
  u.attackTask.status='completed';assert.match(taskFeedback(w,u).result,/未确认命中/);
  u.attackTask.flightResults['missile-1']={phase:'hit',hitTargetId:'track-1',alive:false};assert.match(taskFeedback(w,u).result,/仿真确认/);
  u.rwrDefense={active:{maneuver:'notch',manual:false},episode:{level:'launch'}};brief=missionBrief(w,u.id);assert.match(brief.objective,/横切规避/);assert.match(brief.feedback.result,/未确认威胁解除/);
});
test('事实时间线隔离单位，去重攻击镜像，保留来源与证据且换任务不丢旧记录',()=>{
  const w=create(),u=w.units[0];w.units.push({...u,id:'b',pilotExecution:null});
  w.commandLog=[{requestId:'b-command',time:1,interpretation:{summary:'只给Bravo',orders:[{unitIds:['b']}]}},{requestId:'a-command',time:2,interpretation:{summary:'Alpha攻击',orders:[{unitIds:['a']}]}}];
  u.attackTask={id:'attack-1',events:[{sequence:1,time:3,type:'launch',text:'实际发射1枚'}]};u.radar={events:[{sequence:9,time:3,type:'attack_launch',text:'实际发射1枚'},{sequence:10,time:4,type:'lost',text:'雷达失锁'}]};
  tick(w,4);u.attackTask={id:'attack-2',events:[]};tick(w,5);
  const rows=taskTimeline(w,u);assert.ok(!rows.some(e=>e.summary==='只给Bravo'));assert.equal(rows.filter(e=>e.summary==='实际发射1枚').length,1);assert.match(rows.find(e=>e.summary==='实际发射1枚').evidence,/命中另行确认/);
  assert.ok(rows.every(e=>e.source&&e.evidence&&Number.isFinite(e.time)));
});
test('同帧撤销攻击并接入新航路，旧攻击终态不遮蔽当前飞行任务',()=>{
  const w=create(),u=w.units[0];u.pilotExecution.startedAt=10;u.attackTask={id:'old',active:false,status:'cancelled',issuedAt:0,events:[{sequence:1,time:10,type:'cancelled',text:'攻击已停止'}]};
  assert.equal(taskFeedback(w,u).kind,'flight');
});
test('时间线不泄露敌方发射真值，但记录本机发射和自身实际受击',()=>{
  const w=create(),u=w.units[0];w.weaponEvents=[{id:'enemy-missile',type:'launch',ownerId:'enemy',targetId:'a',time:1,text:'隐蔽发射'},{id:'own-missile',type:'launch',ownerId:'a',targetId:'enemy',time:2,text:'本机发射'},{id:'enemy-missile',type:'hit',ownerId:'enemy',targetId:'a',time:3,text:'本机受击'}];
  const rows=taskTimeline(w,u);assert.ok(!rows.some(e=>e.summary==='隐蔽发射'));assert.equal(rows.filter(e=>e.source==='武器实测').length,2);
});
