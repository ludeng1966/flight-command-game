import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createLocalAiClient,expandCompact,compactTask,validatePilotReadback} from '../server/local-ai-client.mjs';
import {LocalAiRuntime} from '../server/local-ai-runtime.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {runCommandSession} from '../game/command-session.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const context=()=>commandContext(new World(scenario,profiles),'blue-1');
const compact={status:'understood',summary:'Alpha向西飞到八千米',orders:[{intent:'fly_heading',unitIds:['blue-1'],parameters:{headingDeg:270,altitudeM:8000}}]};
const input=()=>({requestId:'local-test',instruction:'Alpha，航向两拐洞，高度八千米',context:context()});

test('本地精简协议保留单位与条件，非法引用和遗漏条件均拒绝',()=>{
  const result=expandCompact(compact,context(),input().instruction);
  assert.equal(result.orders[0].parameters.speedMps,null);assert.equal(result.orders[0].parameters.altitudeM,8000);
  assert.throws(()=>expandCompact({...compact,orders:[{...compact.orders[0],unitIds:['fake']}]},context(),''),/无效/);
  assert.throws(()=>expandCompact(compact,context(),'如果遭袭则防御'),/遗漏触发条件/);
});
test('实验核对保留参数校验，正常航路直接交给程序而不调用模型',async()=>{
  const calls=[];let wrong=false;
  const runtime={async complete(role,messages){calls.push(role);
    if(role==='commander')return {value:compact,timing:{role}};
    const tasks=JSON.parse(messages.at(-1).content).tasks;if(wrong)tasks[0].parameters.headingDeg=90;
    return {value:{decision:'accept',reason:'收到',tasks},timing:{role}};
  }};
  const client=createLocalAiClient(runtime,{transcribe:()=>{throw Error('不应调用云端');}}),reply=await client.interpret(input());
  const pilot=await client.reviewPilot({...input(),plan:reply.plan});assert.equal(pilot.review.decision,'accept');assert.deepEqual(calls,['commander','pilot']);
  wrong=true;await assert.rejects(client.reviewPilot({...input(),plan:reply.plan}),/参数不一致/);
  const world=new World(scenario,profiles),before=world.units.map(u=>[...u.position]);let invoked=0;
  const result=await runCommandSession({world,reply,expectedRevision:0,radio:{phase(){},async transmit(){}},pause:async()=>{},reviewPilot:()=>{invoked++;return client.reviewPilot({...input(),plan:reply.plan});}});
  assert.equal(invoked,0);assert.equal(result.committed,true);assert.ok(world.units[0].waypoints.length>0);
  assert.deepEqual(world.units.map(u=>u.position),before);
});
test('飞行员不能少复诵、添加隐含参数或擅自接受其他单位',()=>{
  const plan={tasks:[{unitId:'blue-1',action:'orbit',altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]};
  assert.equal(validatePilotReadback({decision:'accept',tasks:plan.tasks.map(compactTask)},plan).decision,'accept');
  for(const tasks of [[],[{unitId:'blue-1',action:'orbit',parameters:{altitudeM:8000}}],[{unitId:'blue-2',action:'orbit',parameters:{}}]])assert.throws(()=>validatePilotReadback({decision:'accept',tasks},plan));
});
test('共享运行时串行推理，队列中已取消请求不再发给模型',async t=>{
  let active=0,peak=0,calls=0;
  const server=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,30));active--;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const runtime=new LocalAiRuntime('.');runtime.status='ready';runtime.port=server.address().port;runtime.key='test';
  const abort=new AbortController(),a=runtime.complete('commander',[],{}),b=runtime.complete('pilot',[],{},{signal:abort.signal}),c=runtime.complete('pilot',[],{});
  const rejected=assert.rejects(b,{name:'AbortError'});abort.abort();await Promise.all([a,c,rejected]);
  assert.equal(peak,1);assert.equal(calls,2);assert.equal(runtime.pending,0);
});
test('显存预算使用进程专用显存；越线或测量失效时停止模型',()=>{
  const runtime=new LocalAiRuntime('.');let killed=0;runtime.child={kill(){killed++;}};runtime.status='ready';
  runtime.observe({dedicatedBytes:1500*1048576,sharedBytes:400*1048576});assert.equal(runtime.memory.peakDedicatedMiB,1500);assert.equal(killed,0);
  runtime.observe({dedicatedBytes:1901*1048576,sharedBytes:0});assert.equal(runtime.status,'error');assert.equal(killed,1);
  runtime.status='ready';runtime.observe({error:'counter unavailable'});assert.equal(runtime.status,'error');assert.equal(killed,2);
});
test('本地 HTTP 路由提供真实就绪状态、共享模型与飞行员核对，配置不暴露',async t=>{
  const runtime={health:()=>({status:'ready',sharedModel:true}),async complete(role,messages){return {value:role==='commander'?compact:{decision:'accept',reason:'核对完成',tasks:JSON.parse(messages.at(-1).content).tasks},timing:{role}};}};
  const server=createGameServer({...readConfig({}),aiProvider:'local'},{localRuntime:runtime,fetchImpl:()=>{throw Error('不应调用云端');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,health=await(await fetch(base+'/api/health')).json();assert.equal(health.commandReady,true);assert.equal(health.ai.sharedModel,true);
  const post=(route,data)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const reply=await(await post('/api/tactical/interpret',input())).json();assert.equal(reply.ai.role,'commander');
  const pilot=await(await post('/api/tactical/pilot',{...input(),plan:reply.plan})).json();assert.equal(pilot.ai.role,'pilot');
  assert.equal((await fetch(base+'/.local-ai/models/Qwen3.5-2B-Q4_K_M.gguf')).status,404);
});
