import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {runCommandSession} from '../game/command-session.js';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {pilotObservation} from '../sim/pilot-watch.js';
import {englishResultReadback} from '../sim/result-language.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const task={unitId:'blue-1',action:'fly_heading',headingDeg:270,altitudeM:8000,speedMps:600/3.6,eastM:null,northM:null,distanceM:null,append:false};
const plan={status:'accepted',summary:'Alpha向西飞到八千米',tasks:[task]},reply={requestId:'result-test',plan};
const text='航向270度，高度8000米，真空速600公里每小时';
const checked=()=>({checks:[{unitId:'blue-1',verdict:'executing',readbackText:text+'，已装订，正在执行。'}]});
function request(){const w=world();applyPlan(w,plan,0);return {requestId:'result-test',context:commandContext(w,'blue-1'),plan,result:captureCommandResult(w)};}

test('暂停下装订任务如实报告等待继续，中英文不声称正在飞行',()=>{
  const input=request();input.result.clockRunning=false;const facts=inspectCommandResult(input.context,input.plan,null,input.result),fact=facts[0];
  assert.equal(fact.expectedVerdict,'executing');assert.match(fact.modelFacts.comparisonSummary,/模拟已暂停/);
  validateResultReadbacks({checks:[{unitId:fact.unitId,verdict:'executing',readbackText:fact.requiredReadback+'，已装订，模拟暂停，等待继续。'}]},facts);
  assert.throws(()=>validateResultReadbacks(checked(),facts),/模拟暂停/);
  assert.match(englishResultReadback(fact,input.plan,input.context),/Simulation paused; awaiting resume/);
});

test('装订成功和达到目标分别检查，快照不改变真实状态',()=>{
  const w=world(),before=JSON.stringify(w);captureCommandResult(w);assert.equal(JSON.stringify(w),before);
  applyPlan(w,plan,0);const context=commandContext(w,'blue-1'),receipt=captureCommandResult(w),facts=inspectCommandResult(context,plan,null,receipt);
  assert.equal(facts[0].expectedVerdict,'executing');assert.equal(facts[0].modelFacts.observed.altitude,6500);assert.ok(facts[0].modelFacts.installation.every(c=>c.matched));
  context.units[0].position[2]=8000;context.units[0].headingDeg=270;context.units[0].speedMps=600/3.6;
  assert.equal(inspectCommandResult(context,plan,null,receipt)[0].expectedVerdict,'reached');
  receipt.units[0].headingRoute.headingDeg=90;assert.equal(inspectCommandResult(context,plan,null,receipt)[0].expectedVerdict,'mismatch');
  receipt.outcome='blocked';receipt.reason='目标低于安全高度';assert.equal(inspectCommandResult(context,plan,null,receipt)[0].expectedVerdict,'blocked');
});
test('复述不能改变参数、漏掉飞机或把执行中说成已经达到',()=>{
  const input=request(),facts=inspectCommandResult(input.context,input.plan,null,input.result);assert.deepEqual(validateResultReadbacks(checked(),facts),checked());
  assert.equal(facts[0].modelFacts.installation.find(c=>c.field==='目标真空速').actual,600);
  validateResultReadbacks({checks:[{...checked().checks[0],readbackText:'正在执行指令：航向 270 度，高度 8000 米，真空速 600 公里/小时。'}]},facts);
  assert.throws(()=>validateResultReadbacks({checks:[{...checked().checks[0],readbackText:text+'，目标速度166.67公里每小时，正在执行。'}]},facts),/没有要求的数值/);
  assert.throws(()=>validateResultReadbacks({checks:[]},facts),/遗漏/);
  assert.throws(()=>validateResultReadbacks({checks:[{...checked().checks[0],verdict:'reached'}]},facts),/实际执行结果不一致/);
  assert.throws(()=>validateResultReadbacks({checks:[{...checked().checks[0],readbackText:'航向90度，高度8000米，真空速600公里每小时，正在执行。'}]},facts),/关键参数/);
  assert.throws(()=>validateResultReadbacks({checks:[{...checked().checks[0],readbackText:text+'，已达到目标，正在执行。'}]},facts),/不能报告/);
});
test('程序先装订并开始飞行，再由2B检查，最后只播报检查后的复述',async()=>{
  const w=world(),events=[],position=[...w.units[0].position];
  const result=await runCommandSession({world:w,reply,expectedRevision:0,pause:async()=>{},radio:{phase(){},async transmit(message){events.push(message);}},
    checkPilotResult:async payload=>{assert.equal(payload.outcome,'applied');assert.ok(w.units[0].waypoints.length>0);assert.ok(w.revision>0);assert.deepEqual(w.units[0].position,position);
      for(let i=0;i<60;i++)w.step(1/60);events.push({speaker:'check'});return {...checked(),checkedBy:'Qwen3.5-2B-Q4_K_M'};}});
  assert.deepEqual(events.map(e=>e.speaker),['commander','check','pilot']);assert.equal(events[2].checkedByModel,true);assert.match(events[2].text,/正在执行/);
  assert.equal(result.verifiedByModel,true);assert.equal(result.committed,true);assert.notDeepEqual(w.units[0].position,position);
});
test('检查中人工改令会丢弃旧复述，模型检查失败不会撤销已装订任务',async()=>{
  const w=world(),messages=[];
  await assert.rejects(runCommandSession({world:w,reply,expectedRevision:0,pause:async()=>{},radio:{phase(){},async transmit(m){messages.push(m);}},
    checkPilotResult:async()=>{w.revision++;w.units[0].holdAltitude=9000;return {...checked(),checkedBy:'Qwen3.5-2B-Q4_K_M'};}}),/旧结果/);
  assert.deepEqual(messages.map(m=>m.speaker),['commander']);assert.equal(w.units[0].holdAltitude,9000);assert.ok(w.units[0].waypoints.length>0);
  const w2=world();await assert.rejects(runCommandSession({world:w2,reply,expectedRevision:0,pause:async()=>{},radio:{phase(){},async transmit(){}},
    checkPilotResult:async()=>{throw Error('模型不可用');}}),/模型不可用/);assert.ok(w2.units[0].waypoints.length>0);
});
test('无法执行的指令也在程序结果出来后检查并复述，保留原航路',async()=>{
  const w=world(),before=JSON.stringify(w),events=[];
  const unavailable={requestId:'blocked-result',plan:{status:'unsupported',summary:'尚未具备起飞能力',tasks:[]},execution:{status:'capability_unavailable'},interpretation:{orders:[{unitIds:['blue-1'],intent:'takeoff',parameters:{...EMPTY_PARAMETERS}}]}};
  const result=await runCommandSession({world:w,reply:unavailable,expectedRevision:0,pause:async()=>{},radio:{phase(){},async transmit(m){events.push(m);}},
    checkPilotResult:async payload=>{assert.equal(payload.outcome,'blocked');events.push({speaker:'check'});return {checkedBy:'Qwen3.5-2B-Q4_K_M',checks:[{unitId:'blue-1',verdict:'blocked',readbackText:'起飞，当前无法执行，起飞能力尚未实现。'}]};}});
  assert.equal(result.verifiedByModel,true);assert.equal(result.committed,false);assert.deepEqual(events.map(m=>m.speaker),['commander','check','pilot']);assert.equal(JSON.stringify(w),before);
});
test('模型结果复述调用后卸载，输出与实际不符时最多修复一次',async()=>{
  let starts=0,stops=0,calls=0;
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',pid:1,memory:{dedicatedMiB:1300,peakDedicatedMiB:1300}}),
    async start(){starts++;},async stop(){stops++;},async complete(_role,messages){calls++;const data=JSON.parse(messages[1].content);assert.equal(data.observed.altitude,6500);
      const value={instructionReadback:data.instruction,verdict:'executing',resultText:'已装订，正在执行。'};return {value:calls===1?{...value,verdict:'reached'}:value,timing:{inferenceMs:300}};}})});
  const input=request(),result=await assistant.checkResult(input);assert.equal(result.modelInvoked,true);assert.equal(result.checks[0].verdict,'executing');assert.equal(calls,2);assert.equal(starts,1);assert.equal(stops,1);
  const repeat=await assistant.checkResult(input);assert.equal(repeat.modelInvoked,false);assert.equal(repeat.cached,true);assert.equal(starts,1);
  assert.equal(assistant.health().status,'sleeping');assert.equal(assistant.health().memory.dedicatedMiB,0);assert.equal(assistant.health().resultChecks,1);
  assert.ok(result.knowledgeUsed.some(f=>f.id==='result'));
});
test('已经检查的战术指令不再被后台事件检查重复唤醒',()=>{
  const w=world(),id='already-reviewed';w.units[0].lastPilotResult={requestId:id,verdict:'blocked'};
  w.recordMilitaryOrder(id,{orders:[{id:'order-1',unitIds:['blue-1'],intent:'crank',speechAct:'directive',timing:'now',condition:null,parameters:{}}]},{status:'capability_unavailable'});
  assert.equal(w.units[0].pilotMission.reviewed,true);assert.equal(pilotObservation(w,w.units[0]),null);
});
test('执行结果HTTP接口会真实进入2B检查器，非法快照不触发加载',async t=>{
  let loads=0;const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',memory:{}}),async start(){loads++;},async stop(){},async complete(_role,messages){return {value:{instructionReadback:JSON.parse(messages[1].content).instruction,verdict:'executing',resultText:'已装订，正在执行。'},timing:{}};}})});
  const server=createGameServer({...readConfig({}),aiProvider:'hybrid'},{pilotAssistant:assistant});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/api/tactical/pilot/result`;
  const post=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const bad=request();bad.result.units=[];assert.equal((await post(bad)).status,400);assert.equal(loads,0);
  const response=await post(request());assert.equal(response.status,200);assert.equal((await response.json()).checks[0].verdict,'executing');assert.equal(loads,1);
});
