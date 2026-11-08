import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {applyPlan,commandContext} from '../sim/orders.js';
import {installRadarTask,radarTaskEvent,applyRadarDecision,validateRadarDecision} from '../sim/radar-task.js';
import {stepRadars,applyRadarOrder} from '../sim/radar.js';
import {createRadarPilot} from '../server/radar-pilot.mjs';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {RadarPilot} from '../game/radar-pilot.js';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario={units:[{id:'blue-1',callsign:'ALPHA 01',profile:'f16',color:'#fff',position:[0,0,5000],heading:0,speed:250}]};
const create=()=>new World(scenario,profiles),own=w=>w.units[0],sense=(w,s)=>{for(let i=0;i<Math.round(s*20);i++){w.time+=.05;stepRadars(w,.05);}};
const assign=(w,goal='search',targetId=null)=>installRadarTask(w,own(w),{goal,targetId,targetRef:null});
const decide=(w,operation,mode=null,targetId=null,message='根据当前回波执行雷达操作')=>applyRadarDecision(w,own(w),{operation,mode,targetId,message},own(w).radarTask.id,radarTaskEvent(own(w),w.time));
const body=w=>({requestId:'radar-test',unitId:'blue-1',taskId:own(w).radarTask?.id??'none',context:commandContext(w,'blue-1')});

test('只接收任务不硬编码打开雷达；模型选择搜索，发现回波再截获',()=>{
 const w=create(),u=own(w);w.addRadarPracticeTarget(u.id);u.waypoints=[[0,40000,5000]];assign(w);assert.equal(u.radar.mode,'off');assert.equal(radarTaskEvent(u,w.time).reason,'task_start');
 decide(w,'mode','pd');assert.equal(u.radar.mode,'pd');sense(w,1.1);assert.equal(radarTaskEvent(u,w.time).reason,'contacts_changed');
 decide(w,'lock',null,'tgt-1','发现不明回波，开始截获');assert.equal(u.radar.phase,'acquiring');assert.equal(u.radarTask.active,true);sense(w,.8);assert.equal(u.radar.phase,'locked');assert.equal(radarTaskEvent(u,w.time),null);assert.equal(u.waypoints.length,1);
});
test('丢波触发模型重评，不能把外推当有效照射，恢复后可重新截获',()=>{
 const w=create(),u=own(w),t=w.addRadarPracticeTarget(u.id);assign(w,'track_target');decide(w,'mode','pd');sense(w,1.1);decide(w,'lock',null,t.id);sense(w,.8);t.velocity=[250,0,0];sense(w,.2);
 assert.equal(u.radar.phase,'coasting');assert.equal(u.radar.canIlluminate,false);const event=radarTaskEvent(u,w.time);assert.equal(event.reason,'signal_lost');sense(w,1.4);assert.equal(radarTaskEvent(u,w.time).key,event.key);
 decide(w,'hold',null,null,'目标进入杂波门，继续搜索等待有效回波');assert.equal(u.radarTask.reviewedLossEpoch,event.lossEpoch);t.velocity=[0,-250,0];sense(w,2.1);decide(w,'lock',null,t.id);sense(w,.8);assert.equal(u.radar.phase,'locked');
});
test('不可凭全局目标真值锁定，不可自主锁友机或偷换指名对象',()=>{
 const w=create(),u=own(w),t=w.addRadarPracticeTarget(u.id);assign(w);assert.throws(()=>decide(w,'lock',null,t.id),/本机刚刚/);decide(w,'mode','pd');sense(w,1.1);
 u.radar.contacts[0].classification='friendly';assert.throws(()=>decide(w,'lock',null,t.id),/友机/);u.radar.contacts[0].classification='unknown';assign(w,'track_target','different-target');assert.throws(()=>decide(w,'lock',null,t.id),/更换/);
 assign(w);assert.throws(()=>decide(w,'lock',null,t.id,'已锁定目标'),/尚未建立/);
});
test('静默中止自主任务，旧任务答复不能重开雷达',()=>{
 const w=create(),u=own(w);assign(w);const id=u.radarTask.id;decide(w,'mode','pd');applyRadarOrder(w,u,{operation:'mode',mode:'off',targetId:null});assert.equal(radarTaskEvent(u,w.time),null);
 assert.throws(()=>applyRadarDecision(w,u,{operation:'mode',mode:'pd',targetId:null,message:'开启搜索'},id),/任务已变化/);assert.equal(u.radar.mode,'off');
});
test('搜索无新情况20秒才复核，锁定稳定不重复请求',()=>{
 const w=create(),u=own(w);assign(w);decide(w,'mode','pd');sense(w,10);assert.equal(radarTaskEvent(u,w.time),null);sense(w,10.1);assert.equal(radarTaskEvent(u,w.time).reason,'search_review');
});
test('高层口令编译为自主任务，执行结果按任务接收复述',()=>{
 const w=create(),v={version:'1.0',status:'understood',summary:'搜索并持续观察前方空域',orders:[{id:'order-1',intent:'search',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS}}]};
 const compiled=compileMilitaryInterpretation(v,commandContext(w,'blue-1'));assert.equal(compiled.plan.status,'accepted');assert.equal(compiled.plan.tasks[0].action,'sensor_task');applyPlan(w,compiled.plan,w.revision);
 const facts=inspectCommandResult(commandContext(w,'blue-1'),compiled.plan,v,captureCommandResult(w));assert.equal(facts[0].expectedVerdict,'executing');assert.ok(facts[0].modelFacts.installation.every(x=>x.matched));assert.match(facts[0].requiredReadback,/自主操作/);
});
test('模型请求只包含本机观测，不包含其他飞机真值；同一事件缓存',async()=>{
 const w=create();w.units.push({...own(w),id:'blue-2',callsign:'SECRET BRAVO',position:[123456,654321,7000]});assign(w);let calls=0;
 const api=createRadarPilot({async completePilot(messages){calls++;assert.doesNotMatch(messages[1].content,/SECRET|123456|654321/);return {value:{operation:'mode',mode:'pd',targetId:null,message:'任务需要主动探测，采用PD搜索'}};}});
 const a=await api(body(w));assert.equal(a.modelInvoked,true);assert.equal(a.decision.mode,'pd');const b=await api(body(w));assert.equal(b.modelInvoked,false);assert.equal(calls,1);
});
test('搜索加持续跟踪合为同一任务，不能同时指名两个单目标跟踪对象',()=>{
 const w=create(),order=(intent,targetRef=null)=>({id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,targetRef}}),compile=orders=>compileMilitaryInterpretation({version:'1.0',status:'understood',summary:'任务指令',orders:orders.map((o,i)=>({...o,id:'order-'+(i+1)}))},commandContext(w,'blue-1'));
 const combined=compile([order('search'),order('track_target','不明目标')]);assert.equal(combined.plan.status,'accepted');assert.equal(combined.plan.tasks.length,1);assert.equal(combined.plan.tasks[0].sensorTask.goal,'track_target');
 assert.equal(compile([order('track_target','TGT 01'),order('track_target','TGT 02')]).execution.status,'needs_clarification');
});
test('服务端重新判断事件，不接受无任务或地面伪造判断',async()=>{
 const w=create();let calls=0;const api=createRadarPilot({async completePilot(){calls++;throw Error('不应调用');}});await assert.rejects(()=>api({...body(w),taskId:'fake'}),/任务已变化/);
 assign(w);own(w).surface={grounded:true};const result=await api(body(w));assert.equal(result.decision,null);assert.equal(calls,0);
});
test('异步判断期间更换任务，旧模型答复作废',async()=>{
 const w=create();assign(w);let finish;const pending=new Promise(r=>finish=r);const pilot=new RadarPilot({getWorld:()=>w,fetchImpl:async(_url,options)=>{const input=JSON.parse(options.body);await pending;return {ok:true,json:async()=>({requestId:input.requestId,taskId:input.taskId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,controlSequence:0,event:{reason:'task_start'},decision:{operation:'mode',mode:'pd',targetId:null,message:'采用PD搜索'}})};},now:()=>1000});
 pilot.tick();const old=own(w).radarTask.id;assign(w,'track_target');assert.notEqual(own(w).radarTask.id,old);finish();await new Promise(r=>setTimeout(r,0));assert.equal(own(w).radar.mode,'off');pilot.stop();
});
test('自主任务随进度恢复，丢弃已中断的模型等待状态',()=>{
 const w=create();assign(w);own(w).radarTask.pending=true;const restored=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);assert.equal(own(restored).radarTask.active,true);assert.equal(own(restored).radarTask.pending,false);assert.equal(radarTaskEvent(own(restored),restored.time).reason,'task_start');
});
test('模型误把飞行参数放入雷达任务时先自修正，不要求玩家重发',async()=>{
 const w=create();let calls=0;
 const assistant=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async(_role,messages)=>{
  calls++;if(calls===2)assert.match(messages.at(-1).content,/修正雷达任务表达/);
  return {value:{version:'1.0',status:'understood',summary:'持续跟踪目标',orders:[{id:'order-1',intent:'track_target',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,speedMps:calls===1?210:null}}]},timing:{}};
 }})});
 const result=await assistant.planCommand({requestId:'radar-self-repair',commanderMessage:{id:'radar-radio',speaker:'commander',text:'Alpha，指挥台。持续跟踪前方不明目标。',language:'zh-CN'},context:commandContext(w,'blue-1')});
 assert.equal(calls,2);assert.equal(result.plan.status,'accepted');assert.equal(result.plan.tasks[0].action,'sensor_task');
});
