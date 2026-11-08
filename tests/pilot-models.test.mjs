import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {createQwenClient} from '../server/qwen.mjs';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {captureCommandResult} from '../sim/pilot-result.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {PilotSupervisor} from '../game/pilot-supervisor.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const config=()=>readConfig({DASHSCOPE_API_KEY:'test-key',AI_PROVIDER:'hybrid'});
async function start(t,fetchImpl){
  const server=createGameServer(config(),{fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});return 'http://127.0.0.1:'+server.address().port;
}
function resultInput(){
  const world=new World(scenario,profiles),plan={status:'accepted',summary:'Alpha向西飞',tasks:[{unitId:'blue-1',action:'fly_heading',headingDeg:270,altitudeM:8000,speedMps:600/3.6,eastM:null,northM:null,distanceM:null,append:false}]};
  applyPlan(world,plan,0);return {requestId:'flash-result',context:commandContext(world,'blue-1'),plan,result:captureCommandResult(world)};
}
const post=(base,path,input)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
test('默认飞行员为Flash，旧hybrid配置也不启动本地2B；下载状态明确不可用',async t=>{
  let calls=0;const base=await start(t,()=>{calls++;throw Error('不应调用');});
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.defaultPilotModel,'flash');assert.equal(health.pilotAssistant.provider,'cloud');
  assert.equal(health.pilotAssistant.model,'qwen3.7-flash');assert.equal(health.pilotAssistant.pid,null);assert.equal(health.pilotAssistant.memory.dedicatedMiB,0);
  const catalog=await (await fetch(base+'/api/tactical/pilot/models')).json();assert.equal(catalog.defaultModel,'flash');
  assert.deepEqual(catalog.models.map(m=>m.id),['flash','2b']);assert.equal(catalog.models[1].downloadAvailable,false);assert.equal(catalog.models[1].downloadUrl,null);assert.equal(calls,0);
});
test('结果检查真实使用Flash模型和当前指令，保留程序事实校验',async t=>{
  let calls=0;const base=await start(t,async(_url,options)=>{
    calls++;const request=JSON.parse(options.body);assert.equal(request.model,'qwen3.7-flash');assert.equal(request.enable_thinking,false);
    const readback=request.response_format.json_schema.schema.properties.instructionReadback.enum[0];
    return Response.json({choices:[{message:{content:JSON.stringify({instructionReadback:readback,verdict:'executing',resultText:'已装订，正在执行，尚未达到目标。'})}}]});
  });
  const response=await post(base,'/api/tactical/pilot/result',resultInput());assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.checkedBy,'qwen3.7-flash');assert.equal(result.modelInvoked,true);assert.equal(result.checks[0].verdict,'executing');assert.match(result.checks[0].readbackText,/航向270/);assert.equal(calls,1);
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.pilotAssistant.pid,null);assert.equal(health.pilotAssistant.resultChecks,1);
});
test('选2B时所有飞行员端点拒绝执行且不回退Flash，非法选择同样拒绝',async t=>{
  let calls=0;const base=await start(t,()=>{calls++;throw Error('不应调用');});
  for(const path of ['/api/tactical/pilot/result','/api/tactical/pilot/assess','/api/tactical/pilot']){
    const response=await post(base,path,{pilotModel:'2b'});assert.equal(response.status,409);assert.match((await response.json()).error,/下载暂未提供/);
  }
  assert.equal((await post(base,'/api/tactical/pilot/result',{pilotModel:'unknown'})).status,400);assert.equal(calls,0);
});
test('Flash飞行员事件判断接入云端并保留教材；常规飞行不调用模型',async t=>{
  let calls=0;const base=await start(t,async(_url,options)=>{
    calls++;const request=JSON.parse(options.body);assert.equal(request.model,'qwen3.7-flash');assert.match(request.messages[0].content,/单机飞行员/);
    return Response.json({choices:[{message:{content:JSON.stringify({decision:'request_data',message:'需要目标位置',missingData:['目标位置']})}}]});
  });
  const world=new World(scenario,profiles),unit=world.units[0],normal={requestId:'normal',pilotModel:'flash',context:commandContext(world,unit.id),observation:{unitId:unit.id,blockedSince:null,blockedReason:null,mission:null,contacts:[]}};
  assert.equal((await (await post(base,'/api/tactical/pilot/assess',normal)).json()).modelInvoked,false);assert.equal(calls,0);
  unit.pilotMission={id:'intercept-1',intent:'intercept',revision:world.revision,timing:'now',condition:null,parameters:{targetRef:'contact-1'}};
  const response=await post(base,'/api/tactical/pilot/assess',{...normal,requestId:'event',observation:pilotObservation(world,unit)});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.modelInvoked,true);assert.ok(result.knowledgeUsed.length);assert.equal(calls,1);
});
test('切换模型会中止旧事件请求，迟到结果不能写回',async()=>{
  const world=new World(scenario,profiles),unit=world.units[0];let model='flash',signal,resolve;
  unit.pilotMission={id:'m',intent:'intercept',revision:0,timing:'now',condition:null,parameters:{targetRef:'x'}};
  const watch=new PilotSupervisor({getWorld:()=>world,getPilotModel:()=>model,enabled:()=>model==='flash',fetchImpl:(_url,options)=>{
    const input=JSON.parse(options.body);assert.equal(input.pilotModel,'flash');signal=options.signal;
    return new Promise(r=>{resolve=()=>r(Response.json({requestId:input.requestId,revision:0,simTimeSec:0,assessment:{decision:'notify_commander',message:'旧结果',missingData:[]}}));});
  }});
  watch.tick();model='2b';watch.tick();assert.equal(signal.aborted,true);resolve();await new Promise(r=>setImmediate(r));assert.equal(unit.pilotAssessment,undefined);watch.stop();
});
test('取消Flash检查会取消上游请求',async()=>{
  const controller=new AbortController();let upstreamSignal;
  const client=createQwenClient(config(),async(_url,options)=>{upstreamSignal=options.signal;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));});
  const pending=client.completePilot([],{type:'object'},{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(upstreamSignal.aborted,true);
});
