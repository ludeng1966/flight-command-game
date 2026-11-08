import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {pilotEvent,pilotObservation} from '../sim/pilot-watch.js';
import {PilotSupervisor} from '../game/pilot-supervisor.js';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const mission=w=>({id:'mission-1',intent:'intercept',timing:'now',condition:null,parameters:{targetRef:'contact-1'},revision:w.revision});
const input=(w,tactical=false)=>{if(tactical)w.units[0].pilotMission=mission(w);return {requestId:'watch-test',context:commandContext(w,'blue-1'),
  observation:pilotObservation(w,w.units[0])??{unitId:'blue-1',event:{reason:'tactical_mission'},mission:null,contacts:[],blockedSince:null,blockedReason:null}};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('正常飞行与无执行异常的状态标记不重复推理，持续阻断才触发',()=>{
  const w=world(),u=w.units[0];
  for(const flightState of ['normal','stall-recovery'])for(const task of ['heading','waypoints','orbit'])assert.equal(pilotEvent({...u,flightState,task,energyMode:'加力'},20),null);
  u.navigationBlocked='山脉阻挡';assert.equal(pilotEvent(u,9,0),null);assert.equal(pilotEvent(u,10,0).reason,'route_blocked');
  u.navigationPending=true;assert.equal(pilotEvent(u,20,0),null);u.navigationPending=false;u.alive=false;assert.equal(pilotEvent(u,20,0),null);
});
test('战术任务只按当前版本唤醒，旧任务、条件未触发和无来源威胁不唤醒',()=>{
  const w=world(),u=w.units[0];u.pilotMission=mission(w);assert.equal(pilotObservation(w,u).event.reason,'tactical_mission');
  w.revision++;assert.equal(pilotObservation(w,u),null);
  u.pilotMission={...mission(w),timing:'on_condition',condition:'遭袭'};assert.equal(pilotObservation(w,u),null);u.pilotMission=null;
  u.pilotContacts=[{id:'x',observedAt:0,threat:true}];assert.equal(pilotObservation(w,u),null);
  u.pilotContacts[0].source='test_sensor';assert.equal(pilotObservation(w,u).event.reason,'new_threat');
  w.time=6;assert.equal(pilotObservation(w,u),null);w.time=0;u.pilotContacts[0].classification='friendly';assert.equal(pilotObservation(w,u),null);
});
test('正常航点飞行一直走现有内核，客户端不发送模型判断请求',()=>{
  const w=world(),u=w.units[0];let calls=0,at=0;
  const task={unitId:u.id,action:'fly_heading',headingDeg:90,altitudeM:7000,speedMps:180,eastM:null,northM:null,distanceM:null,append:false};
  applyPlan(w,{status:'accepted',summary:'常规航路',tasks:[task]},0);
  const watch=new PilotSupervisor({getWorld:()=>w,now:()=>at,fetchImpl:()=>{calls++;throw Error('不应调用');}});
  for(let i=0;i<30;i++){for(let j=0;j<60;j++)w.step(1/60);at+=1000;watch.tick();}
  assert.equal(calls,0);assert.equal(u.alive,true);assert.ok(u.position[0]>scenario.units[0].position[0]);watch.stop();
});
test('同一事件只判断一次，模型选择继续程序飞行不会修改航路或物理状态',async()=>{
  const w=world(),u=w.units[0];u.pilotMission=mission(w);let calls=0,at=0;
  const before={position:[...u.position],velocity:[...u.velocity],waypoints:structuredClone(u.waypoints),revision:w.revision};
  const watch=new PilotSupervisor({getWorld:()=>w,now:()=>at,fetchImpl:async function(_url,options){assert.equal(this,globalThis);calls++;const body=JSON.parse(options.body);
    return {ok:true,json:async()=>({requestId:body.requestId,revision:body.context.revision,simTimeSec:body.context.simTimeSec,modelInvoked:true,
      assessment:{decision:'continue_autopilot',message:'无需介入',missingData:[]}})};}});
  watch.tick();await flush();for(let i=0;i<60;i++){at+=1000;watch.tick();await flush();}
  assert.equal(calls,1);assert.equal(u.pilotAssessment.decision,'continue_autopilot');
  assert.deepEqual({position:u.position,velocity:u.velocity,waypoints:u.waypoints,revision:w.revision},before);watch.stop();
});
test('人工改令使正在返回的模型判断作废，不能写回过期结果',async()=>{
  const w=world(),u=w.units[0];u.pilotMission=mission(w);let resolve,signal,at=0;
  const watch=new PilotSupervisor({getWorld:()=>w,now:()=>at,fetchImpl:(_url,options)=>{signal=options.signal;const body=JSON.parse(options.body);
    return new Promise(r=>{resolve=()=>r({ok:true,json:async()=>({requestId:body.requestId,revision:0,simTimeSec:0,modelInvoked:true,
      assessment:{decision:'notify_commander',message:'旧判断',missingData:[]}})});});}});
  watch.tick();w.revision++;at=1001;watch.tick();assert.equal(signal.aborted,true);resolve();await flush();assert.equal(u.pilotAssessment,undefined);watch.stop();
});
test('服务端重算触发条件，伪造事件不能让正常航路启动模型',async()=>{
  let factories=0;const assistant=new PilotAssistant('.',{runtimeFactory:()=>{factories++;throw Error('不应启动');}});
  const result=await assistant.assess(input(world()));assert.equal(result.modelInvoked,false);assert.equal(factories,0);
  assert.equal(assistant.health().status,'sleeping');assert.equal(assistant.health().memory.dedicatedMiB,0);
});
test('真正事件按需加载并卸载，重复请求复用判断，待机显存归零',async()=>{
  let starts=0,stops=0,completions=0,factories=0;
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>{factories++;let status='stopped';return {
    health:()=>({status,pid:123,memory:{dedicatedMiB:1400,peakDedicatedMiB:1400}}),async start(){starts++;status='ready';},async stop(){stops++;status='stopped';},
    async complete(){completions++;return {value:{decision:'request_data',message:'需要目标位置',missingData:['目标位置']},timing:{inferenceMs:300}};}};}});
  const request=input(world(),true),[a,b]=await Promise.all([assistant.assess(request),assistant.assess({...request,requestId:'watch-test-2'})]);
  assert.equal(a.modelInvoked,true);assert.equal(b.modelInvoked,false);assert.equal(b.cached,true);assert.equal(factories,1);assert.equal(starts,1);assert.equal(completions,1);assert.equal(stops,1);
  const health=assistant.health();assert.equal(health.status,'sleeping');assert.equal(health.pid,null);assert.equal(health.memory.dedicatedMiB,0);assert.equal(health.memory.peakDedicatedMiB,1400);
  assert.ok(a.knowledgeUsed.some(f=>f.id==='intervention'));
});
test('加载期间取消会释放模型，不执行后续推理',async()=>{
  let begin,release,stops=0,completions=0;const begun=new Promise(r=>begin=r),abort=new AbortController();
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',memory:{}}),start(){begin();return new Promise(r=>release=r);},
    async stop(){stops++;release?.();},async complete(){completions++;throw Error('不应推理');}})});
  const task=assistant.assess(input(world(),true),{signal:abort.signal});const rejected=assert.rejects(task,{name:'AbortError'});await begun;abort.abort();await rejected;
  assert.ok(stops>=1);assert.equal(completions,0);assert.equal(assistant.health().pending,0);
});
test('混合模式健康接口保持云端指挥官就绪，普通判断请求不加载2B',async t=>{
  let factories=0;const assistant=new PilotAssistant('.',{runtimeFactory:()=>{factories++;throw Error('不应启动');}});
  const server=createGameServer({...readConfig({}),aiProvider:'hybrid',apiKey:'test-key'},{pilotAssistant:assistant});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;
  const health=await(await fetch(base+'/api/health')).json();assert.equal(health.provider,'hybrid');assert.equal(health.commandReady,true);assert.equal(health.commandModel,'qwen3.7-flash');assert.equal(health.pilotAssistant.modelCalls,0);
  const response=await fetch(base+'/api/tactical/pilot/assess',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input(world()))});
  assert.equal(response.status,200);assert.equal((await response.json()).modelInvoked,false);assert.equal(factories,0);
});
