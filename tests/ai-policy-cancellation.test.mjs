import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {createQwenClient} from '../server/qwen.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {MILITARY_SYSTEM,PILOT_SYSTEM} from '../server/military-planner.mjs';
import {capabilityRules} from '../server/ai-role-policy.mjs';
import {pilotReading,readingTopics} from '../server/pilot-handbook.mjs';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const input=()=>({requestId:'cancel-policy',instruction:'Alpha，开始巡航',context:commandContext(new World(scenario,profiles),'blue-1')});
const config=()=>({...readConfig({}),apiKey:'test-only'});
test('指挥与飞行员有不同职责，计划规则不再把旧目标当作未指定参数',()=>{
  assert.match(MILITARY_SYSTEM,/传令接口/);assert.match(PILOT_SYSTEM,/接令后的飞机飞行员规划员/);assert.doesNotMatch(PILOT_SYSTEM,/传令接口/);
  for(const text of [MILITARY_SYSTEM,PILOT_SYSTEM]){assert.doesNotMatch(text,/未指定高度速度沿用当前目标设置|程序生成中间航点并执行/);assert(text.includes(capabilityRules()));}
  const commander=pilotReading('Alpha开始巡航',{role:'commander'});assert(commander.files.some(f=>f.id==='commander_role'));assert(!commander.files.some(f=>f.id==='role'));
});
test('中英文攻击及结构化意图按能力选择武器手册，不依赖导弹关键词',()=>{
  for(const text of ['Alpha，攻击前方目标。','Alpha, attack the target ahead.','attack']){const r=pilotReading(text);assert(r.files.some(f=>f.id==='weapons'));assert(r.files.some(f=>f.id==='actions'));}
  const r=pilotReading('继续处理当前任务',{intents:['attack','cover']});assert(r.files.some(f=>f.id==='weapons'));assert(r.files.some(f=>f.id==='formation'));
  assert(readingTopics('',{intents:['attack']}).capabilities.has('attack_tasking'));assert(!pilotReading('Alpha航向270').files.some(f=>f.id==='weapons'));
});
test('云指挥初次及纠错请求均受同一个取消信号控制，预先取消不调用上游',async()=>{
  for(const repair of [false,true]){
    const controller=new AbortController();let calls=0,upstreamSignal,started;const ready=new Promise(resolve=>started=resolve);
    const client=createQwenClient(config(),async(_url,options)=>{calls++;if(repair&&calls===1)return Response.json({choices:[{message:{content:'{}'}}]});upstreamSignal=options.signal;started();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));});
    const pending=client.interpret(input(),{signal:controller.signal}),rejected=assert.rejects(pending,{name:'AbortError'});await ready;controller.abort();await rejected;assert(upstreamSignal.aborted);assert.equal(calls,repair?2:1);
    await assert.rejects(client.interpret(input(),{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,repair?2:1);
  }
});
test('客户端断开取消云指挥上游并释放服务端调度槽',async t=>{
  let signal,started;const ready=new Promise(resolve=>started=resolve);
  const server=createGameServer(config(),{playerCredentials:false,fetchImpl:async(_url,options)=>{signal=options.signal;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,controller=new AbortController();
  const pending=fetch(base+'/api/tactical/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input()),signal:controller.signal}).catch(e=>e);
  await ready;controller.abort();await pending;
  for(let i=0;i<100&&!signal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,5));assert(signal.aborted);
  const health=await(await fetch(base+'/api/health')).json();assert.equal(health.tacticalQueue.active,0);
});
