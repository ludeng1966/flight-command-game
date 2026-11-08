import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Worker} from 'node:worker_threads';
import {World} from '../sim/world.js';
import {CommandPlanner} from '../game/command-planner.js';
import {DecisionLatency,sameDecisionClock} from '../sim/decision-timing.js';
import {commandPlanningSnapshot,runCommandForecast} from '../sim/command-planning-worker.js';
import {commandContext,commitPilotPlan} from '../sim/orders.js';
import {validateAiNavigation} from '../sim/ai-navigation.js';
import {navigationSchema,navigationOutput,parseDecisionTiming} from '../server/navigation-planning.mjs';
import {militarySchemaFor,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {validateContext} from '../server/qwen.mjs';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {runCommandSession} from '../game/command-session.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const make=()=>new World({units:[{id:'blue-1',callsign:'ALPHA 01',profile:'f16',position:[0,0,6500],heading:0,speed:220}]},profiles);
const plan={status:'accepted',summary:'向北飞行',tasks:[{unitId:'blue-1',action:'fly_heading',headingDeg:0,altitudeM:6500,speedMps:220,eastM:null,northM:null,distanceM:20000,append:false}]};
const factory=()=>{
  const worker=new Worker(new URL('./helpers/command-planner-worker.mjs',import.meta.url));
  const bridge={postMessage:(...args)=>worker.postMessage(...args),terminate:()=>worker.terminate()};
  worker.on('message',data=>bridge.onmessage?.({data}));worker.on('error',error=>bridge.onerror?.(error));return bridge;
};
function timingContext(world,playing=true){
  const tracker=new DecisionLatency();tracker.record(4);
  const timing=tracker.timing({playing,rate:1});return {...commandContext(world,'blue-1'),decisionTiming:runCommandForecast({snapshot:commandPlanningSnapshot(world),timing})};
}
test('暂停不估计延时、不启动预测worker；运行和倍率使用实测延时',async()=>{
  const tracker=new DecisionLatency();tracker.record(4);tracker.record(6);
  const paused=tracker.timing({playing:false,rate:8});assert.deepEqual(paused.horizonsSec,[0]);assert.equal(paused.estimatedOutputSec,0);assert.deepEqual(paused.recentOutputSec,[]);
  const w=make(),before=JSON.stringify(w),client=new CommandPlanner(null,{workerFactory:()=>{throw Error('暂停不应启动worker');}});
  const forecast=await client.forecast(w,paused);assert.deepEqual(forecast.forecasts[0].units[0].position,w.units[0].position);assert.equal(JSON.stringify(w),before);
  const running=tracker.timing({playing:true,rate:4}),result=runCommandForecast({snapshot:commandPlanningSnapshot(w),timing:running});
  assert.equal(result.forecasts[1].simTimeSec,w.time+running.horizonsSec[1]*4);assert.notDeepEqual(result.forecasts[1].units[0].position,w.units[0].position);assert.equal(JSON.stringify(w),before);
  assert.equal(sameDecisionClock({playing:false,rate:1},{playing:false,rate:8}),true);assert.equal(sameDecisionClock({playing:true,rate:1},{playing:false,rate:1}),false);
});
test('后台真实规划时主线程物理继续推进，装订不再调用主线程完整规划',async t=>{
  const w=make(),u=w.units[0];u.headingTarget=0;w.deferNavigation=()=>{};
  const client=new CommandPlanner(null,{workerFactory:factory});t.after(()=>client.cancel());
  let ticks=0;const timer=setInterval(()=>{w.step(.02);ticks++;},2);t.after(()=>clearInterval(timer));
  const draft=await client.prepare(w,plan,0);clearInterval(timer);
  assert.ok(ticks>3);assert.ok(w.time>0);assert.ok(u.position[1]>0);assert.equal(u.waypoints.length,0);
  w.planRoute=()=>{throw Error('禁止主线程完整规划');};commitPilotPlan(draft);assert.equal(draft.committed,true);assert.ok(u.waypoints.length);assert.equal(u.headingRoute.headingDeg,0);
});
test('后台规划取消或新操作后迟到结果不能装订',async t=>{
  const w=make(),client=new CommandPlanner(null,{workerFactory:factory});t.after(()=>client.cancel());
  const controller=new AbortController(),pending=client.prepare(w,plan,0,{},controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(w.units[0].waypoints.length,0);
  const stale=client.prepare(w,plan,0);w.revision++;await assert.rejects(stale,/新操作/);assert.equal(w.units[0].waypoints.length,0);
});
test('模型输出三维航点进入实际航路；按最新机位平移航向航路而不回追旧位置',async t=>{
  const w=make(),context=timingContext(w),seconds=context.decisionTiming.horizonsSec[1],origin=context.decisionTiming.forecasts[1].units[0].position;
  const points=[[origin[0]+500,origin[1]+6000,6500],[origin[0],origin[1]+20000,6500]];
  const aiRoutes=validateAiNavigation([{unitId:'blue-1',waypoints:points}],plan,context,seconds);
  const client=new CommandPlanner(null,{workerFactory:factory});t.after(()=>client.cancel());
  w.units[0].position=[1000,2000,6500];const draft=await client.prepare(w,plan,0,{aiRoutes});commitPilotPlan(draft);
  assert.deepEqual(w.units[0].waypoints.map(p=>p.slice(0,3)),[[1500,8000,6500],[1000,22000,6500]]);assert.equal(w.units[0].headingRoute.continuous,false);
});
test('地理目的地不随延时平移；拒绝缺失、乱序、超限航点和暂停时非零预测',()=>{
  const w=make(),context=timingContext(w,false),geo={...plan,tasks:[{...plan.tasks[0],action:'fly_to',headingDeg:null,distanceM:null,eastM:12000,northM:15000,altitudeM:7000}]};
  const points=[[6000,10000,6800],[12000,15000,7000]],routes=validateAiNavigation([{unitId:'blue-1',waypoints:points}],geo,context,0);
  assert.equal(routes[0].relative,false);assert.deepEqual(routes[0].waypoints,points);
  assert.throws(()=>validateAiNavigation([],geo,context,0),/实际三维航点/);
  assert.throws(()=>validateAiNavigation([{unitId:'blue-1',waypoints:[[12000,15000,6990]]}],geo,context,0),/目标坐标和高度/);
  assert.throws(()=>validateAiNavigation([{unitId:'blue-1',waypoints:points}],geo,context,4),/暂停/);
  assert.throws(()=>validateAiNavigation([{unitId:'blue-1',waypoints:[[12000,15000,20000]]}],geo,context,0),/升限/);
});
test('飞机型号、速度和构型决定模型看到的机动包线，传入服务器后仍保留',()=>{
  const w=make(),a=commandContext(w,'blue-1').units[0].navigationEnvelope;
  const p=structuredClone(w.units[0].profile);p.maxG=2;w.units[0].profile=p;
  const low=validateContext(commandContext(w,'blue-1')).units[0].navigationEnvelope;
  assert.equal(low.structuralMaxG,2);assert.ok(low.availableG<2);assert.ok(a.availableG>low.availableG);assert.ok(low.minimumTurnRadiusM>a.minimumTurnRadiusM);
  w.units[0].speed=100;w.units[0].velocity=[0,100,0];const slow=commandContext(w,'blue-1').units[0].navigationEnvelope;assert.ok(slow.availableG<low.availableG);
});
test('暂停预测协议拒绝伪造延时；航点根字段与原军事意图schema兼容',()=>{
  const context=timingContext(make(),false),schema=navigationSchema(militarySchemaFor(context),context);
  assert.deepEqual(schema.properties.latencyPredictionSec.enum,[0]);assert.ok(schema.properties.orders.items.anyOf);
  assert.throws(()=>parseDecisionTiming({...context.decisionTiming,estimatedOutputSec:5},context.units),/预测无效/);
  const out=navigationOutput({version:'1.0',status:'unknown',summary:'不明',orders:[],latencyPredictionSec:0,navigationPlans:[]},context);
  assert.deepEqual(Object.keys(out.interpretation),['version','status','summary','orders']);assert.deepEqual(out.validate({status:'unsupported',tasks:[]}),[]);
});
test('模型真实接令协议要求输出航点，缺失时要求模型修正而非程序代拟',async()=>{
  const w=make(),context=timingContext(w,false),responses=[];
  const interpretation={version:'1.0',status:'understood',summary:'向北飞',orders:[{id:'order-1',intent:'fly_heading',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,headingDeg:0,altitudeM:6500,speedMps:220,distanceM:20000}}]};
  const pilot=new PilotAssistant(new URL('..',import.meta.url).pathname,{provider:'cloud',runtimeFactory:()=>({async start(){},async stop(){},async complete(_role,messages,schema){responses.push({messages,schema});return {value:{...interpretation,latencyPredictionSec:0,navigationPlans:responses.length===1?[]:[{unitId:'blue-1',waypoints:[[0,10000,6500],[0,20000,6500]]}]},timing:{inferenceMs:1}};}})});
  const result=await pilot.planCommand({requestId:'ai-route',context,commanderMessage:{id:'command-1',text:'ALPHA 01，航向洞洞洞，高度六千五百米，速度七百九十二公里每小时，前出二十公里。',language:'zh-CN',speaker:'commander'}});
  assert.equal(responses.length,2);assert.equal(result.latencyPredictionSec,0);assert.equal(result.pilotNavigationPlans[0].waypoints.length,2);assert.match(responses[1].messages.at(-1).content,/实际三维航点/);assert.match(responses[0].messages[0].content,/暂停时/);
});
test('规划、预览和模型检查期间持续飞行；暂停状态不被流程自动恢复',async t=>{
  const w=make(),client=new CommandPlanner(null,{workerFactory:factory});t.after(()=>client.cancel());w.units[0].headingTarget=0;w.deferNavigation=()=>{};
  const states=[],before=[...w.units[0].position];let checksStarted=0,checksFinished=0;
  const timer=setInterval(()=>w.step(.01),2);t.after(()=>clearInterval(timer));
  const result=await runCommandSession({world:w,reply:{requestId:'continuous',plan},expectedRevision:0,radio:{phase(){},async transmit(){}},preparePlan:(...args)=>client.prepare(...args),pause:async()=>new Promise(r=>setTimeout(r,10)),onSimulation:v=>states.push(v),checkPilotResult:async()=>{checksStarted=w.time;await new Promise(r=>setTimeout(r,40));checksFinished=w.time;return {checkedBy:'mock',checks:[{unitId:'blue-1',verdict:'executing',readbackText:'航路已装订，正在执行。'}]};}});
  assert.equal(result.committed,true);assert.ok(checksFinished>checksStarted);assert.notDeepEqual(w.units[0].position,before);assert.deepEqual(states,[]);
  const paused=make(),start=JSON.stringify(paused.units[0].position);
  await runCommandSession({world:paused,reply:{plan},expectedRevision:0,radio:{phase(){},async transmit(){}},preparePlan:(...args)=>client.prepare(...args),pause:async()=>{},onSimulation:v=>states.push(v)});
  assert.equal(JSON.stringify(paused.units[0].position),start);assert.equal(paused.time,0);assert.deepEqual(states,[]);
});
