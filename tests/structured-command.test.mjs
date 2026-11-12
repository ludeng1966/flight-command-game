import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {runStructuredCommand,duelDecisionPlan,createSilentCommandRadio} from '../game/structured-command.js';
import {initDuel} from '../game/duel.js';
import {notePlayerOrder} from '../sim/command-scope.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/duel.json',import.meta.url)));
const make=team=>{const w=new World(scenario,profiles);w.playerTeam=team;return w;};
const attack=(id,targetId=null)=>({unitId:id,action:'attack_task',attackOrder:{targetId,targetRef:targetId,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null}});
const plan=tasks=>({status:'accepted',summary:'自主搜索与攻击',tasks});
const issue=(world,tasks,extra={})=>runStructuredCommand({world,reply:{requestId:'test-command',plan:plan(tasks)},expectedRevision:world.revision,
  selectedUnitId:tasks[0].unitId,radio:createSilentCommandRadio(),pause:async()=>{},...extra});

test('双方结构化攻击任务经过同一session装订，生成真实任务与电台记录',async()=>{
  for(const team of ['blue','red']){
    const w=make(team),events=[],id=team+'-1';let committed=0;
    const result=await issue(w,[attack(id)],{radio:createSilentCommandRadio({onEvent:event=>events.push(event)}),onCommitted:()=>committed++});
    assert.equal(result.committed,true);assert.equal(committed,1);assert.equal(w.units.find(u=>u.id===id).attackTask.active,true);
    assert.ok(events.some(e=>e.record?.speaker==='commander'));assert.ok(events.some(e=>e.record?.speaker==='pilot'));
    assert.equal(w.units.find(u=>u.id===(team==='blue'?'red-1':'blue-1')).attackTask,undefined);
  }
});

test('跨阵营或未观测攻击目标在播报/装订之前被拒绝',async()=>{
  const w=make('red');let publications=0;
  const radio=createSilentCommandRadio({onEvent:()=>publications++});
  await assert.rejects(issue(w,[attack('blue-1')],{radio}),/当前阵营/);
  await assert.rejects(issue(w,[attack('red-1','blue-1')],{radio}),/有效观测/);
  assert.equal(publications,0);assert.ok(w.units.every(u=>!u.attackTask));
});

test('重复分工不重置已在空导弹、次数与任务，过时观测不能建立新攻击',async()=>{
  const w=make('red'),u=w.units.find(u=>u.id==='red-1');
  u.radar.contacts=[{id:'blue-1',callsign:'ALPHA',classification:'unknown',source:'radar',observedAt:0,position:[0,15000,6500],velocity:[0,250,0]}];
  const decision={reason:'指定分工',orders:[{unitId:u.id,targetId:'blue-1',posture:'attack'}]},proposal=duelDecisionPlan(w,decision);
  assert.equal(u.attackTask,undefined);await issue(w,proposal.plan.tasks);
  u.attackTask.firedMissileIds.push('missile-1');const original=u.attackTask;
  assert.equal(duelDecisionPlan(w,decision).plan,null);assert.equal(u.attackTask,original);assert.deepEqual(original.firedMissileIds,['missile-1']);
  w.time=3;assert.throws(()=>duelDecisionPlan(w,{reason:'新目标',orders:[{unitId:'red-2',targetId:'blue-1',posture:'attack'}]}),/有效观测/);
});

test('defend走标准自卫命令，双方默认即时规避，没有告警时拒绝',async()=>{
  const w=make('red'),u=w.units.find(u=>u.id==='red-1'),decision={reason:'规避已知告警',orders:[{unitId:u.id,targetId:null,posture:'defend'}]};
  const proposal=duelDecisionPlan(w,decision);
  await assert.rejects(issue(w,proposal.plan.tasks),/可用告警/);
  u.rwr.contacts=[{id:'RWR-1',level:'track',epoch:1,bearingDeg:180,signalType:'radar',firstSeen:0,observedAt:0}];
  await issue(w,proposal.plan.tasks);assert.equal(u.rwrDefense.active.manual,true);assert.equal(u.rwrDefense.active.maneuver,'notch');
  assert.equal(u.rwrDefense.lockDelaySec,0);assert.equal(u.rwrDefense.launchDelaySec,0);
  assert.equal(duelDecisionPlan(w,decision).plan,null);
});

function harness(fetchImpl,commandOptions={}){
  let world=make('blue'),playing=false,writes=0;const elements=[],pilots=[],pilotOptions=[];
  const document={createElement:()=>({value:'',get textContent(){return this.value;},set textContent(value){this.value=value;writes++;}}),body:{append:element=>elements.push(element)}};
  const pilot=options=>{const p={ticks:0,stops:0,tick(){this.ticks++;},stop(){this.stops++;}};pilots.push(p);pilotOptions.push(options);return p;};
  const duel=initDuel({getWorld:()=>world,isPlaying:()=>playing,setPlaying:value=>{playing=value;},document,fetchImpl,createAttackPilot:pilot,createRwrPilot:pilot,
    getCommandOptions:()=>({pause:async()=>{},...commandOptions})});
  return {duel,pilots,get writes(){return writes;},get redWorld(){return pilotOptions.at(-1).getWorld();},get world(){return world;},set world(value){world=value;},get playing(){return playing;},set playing(value){playing=value;},get report(){return JSON.parse(elements[0].textContent);}};
}
const response=body=>({ok:true,async json(){return body;},clone(){return this;}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('duel红方指挥真正通过共享装订，双边trace格式相同',async()=>{
  const h=harness(async(url,options)=>{const {requestId,context}=JSON.parse(options.body);return response({requestId,revision:context.revision,simTimeSec:context.simTimeSec,
    decision:{reason:'开始搜索',orders:[{unitId:'red-1',targetId:null,posture:'search'}]}});});
  h.duel.tick();h.playing=true;h.world.time=1;h.duel.tick();await settle();await settle();
  assert.ok(h.world.units.find(u=>u.id==='red-1').attackTask?.active);
  assert.ok(h.report.commands.some(e=>e.side==='red'&&e.stage==='committed'));
  await h.duel.traceFetch('blue',async()=>response({ok:true}))('/test',{body:JSON.stringify({requestId:'blue-test'})});
  assert.deepEqual(h.report.requests.map(r=>r.side),['red','blue']);assert.ok(h.report.requests.every(r=>r.stage==='returned'&&typeof r.returnedAt==='number'));
  assert.ok(h.report.requests.every(r=>r.elapsedMs>=0&&r.returnedWallMs>=r.issuedWallMs));
  assert.ok(!h.world.radioLog?.some(r=>r.id?.startsWith('opponent-radio')));
});

test('终局不能继续，换世界清理结果、去重缓存、帧采样和旧飞行员',()=>{
  const h=harness(async()=>{throw Error('不应请求');});h.duel.tick();h.duel.recordBlue({requestId:'old',plan:plan([attack('blue-1')])});
  h.world.weaponEvents.push({id:'missile-1',type:'launch',time:0});h.world.time=180;h.playing=true;h.duel.tick();
  assert.equal(h.playing,false);assert.equal(h.duel.canResume(),false);assert.ok(h.report.result);
  h.playing=true;h.duel.tick();assert.equal(h.playing,false);
  const previous=h.pilots.slice();h.world=make('blue');h.world.weaponEvents.push({id:'missile-1',type:'launch',time:0});h.duel.tick();
  assert.equal(h.duel.ended,false);assert.equal(h.duel.canResume(),true);assert.equal(h.report.result,undefined);
  assert.equal(h.report.orders.length,0);assert.equal(h.report.commands.length,0);assert.equal(h.report.frames[0].time,0);assert.equal(h.report.events.length,1);
  assert.ok(previous.every(p=>p.stops>=1));
});

test('重置后的旧云响应不能装订或污染新对局证据',async()=>{
  let resolve,request;const h=harness((_url,options)=>{request=JSON.parse(options.body);return new Promise(done=>{resolve=done;});});
  h.playing=true;h.world.time=1;h.duel.tick();const old=h.world;
  h.world=make('blue');h.playing=false;h.duel.tick();
  resolve(response({requestId:request.requestId,revision:request.context.revision,simTimeSec:request.context.simTimeSec,
    decision:{reason:'旧搜索',orders:[{unitId:'red-1',targetId:null,posture:'search'}]}}));await settle();await settle();
  assert.equal(h.report.requests.length,0);assert.equal(h.report.commands.length,0);assert.equal(h.report.orders.length,0);
  assert.ok(old.units.every(u=>!u.attackTask));assert.ok(h.world.units.every(u=>!u.attackTask));
});

for(const changedId of ['red-1','red-2'])test(`红指挥等待期间${changedId==='red-1'?'同机新令作废旧提案':'另一架飞机新令不作废当前提案'}`,async()=>{
  let resolve,request;const h=harness((_url,options)=>{request=JSON.parse(options.body);return new Promise(done=>{resolve=done;});});
  h.playing=true;h.world.time=1;h.duel.tick();const stable=h.redWorld;
  notePlayerOrder(stable,[changedId]);stable.revision++;
  assert.equal(h.redWorld,stable);
  resolve(response({requestId:request.requestId,revision:request.context.revision,simTimeSec:request.context.simTimeSec,
    decision:{reason:'红一搜索',orders:[{unitId:'red-1',targetId:null,posture:'search'}]}}));await settle();await settle();
  const expected=changedId!=='red-1';assert.equal(!!h.world.units.find(u=>u.id==='red-1').attackTask,expected);
  assert.equal(h.report.commands.some(e=>e.stage==='committed'),expected);
  if(!expected)assert.ok(h.report.commands.some(e=>e.stage==='failed'&&/新操作/.test(e.error)));
});

test('红方装订后重抓单位版本，异步实际结果核实仍能完成',async()=>{
  const errors=[];let checked=0;
  const h=harness(async(_url,options)=>{const {requestId,context}=JSON.parse(options.body);return response({requestId,revision:context.revision,simTimeSec:context.simTimeSec,
    decision:{reason:'红一搜索',orders:[{unitId:'red-1',targetId:null,posture:'search'}]}});},
    {checkPilotResult:async()=>{checked++;return {checkedBy:'flight-computer',checks:[{unitId:'red-1',verdict:'executing',readbackText:'攻击任务已核实'}]};},onSpeechError:error=>errors.push(error.message)});
  h.playing=true;h.world.time=1;h.duel.tick();await settle();await settle();
  assert.equal(checked,1);assert.deepEqual(errors,[]);assert.ok(h.report.commands.some(e=>e.stage==='radio'&&e.record.text.includes('攻击任务已核实')));
});

test('证据常规快照每仿真秒写一次，武器事件立即写，暂停不重复序列化',()=>{
  const h=harness(async()=>{throw Error('不应请求');});h.duel.tick();const initial=h.writes;
  for(let i=1;i<=50;i++){h.world.time=i/100;h.duel.tick();}assert.equal(h.writes,initial);
  h.world.weaponEvents.push({id:'missile-1',type:'launch',time:.5});h.duel.tick();assert.equal(h.writes,initial+1);assert.equal(h.report.events.length,1);
  h.world.time=1;h.duel.tick();assert.equal(h.writes,initial+2);
  for(let i=0;i<20;i++)h.duel.tick();assert.equal(h.writes,initial+2);
});
