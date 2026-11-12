import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {TacticalScheduler,tacticalPriority} from '../server/tactical-scheduler.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('等待测试状态超时');}
test('有界队列给RWR和攻击预留位置，按优先级及同级FIFO出队',async()=>{
  const q=new TacticalScheduler({concurrency:1,maxQueued:4,reservedUrgent:2}),release=await q.acquire(),order=[];
  const run=(name,path)=>q.acquire({priority:tacticalPriority(path)}).then(done=>{order.push(name);done();});
  const a=run('result-a','/pilot/result'),b=run('result-b','/pilot/result');
  await assert.rejects(q.acquire({priority:0}),e=>e.status===429);
  const attack=run('attack','/pilot/attack'),rwr=run('rwr','/pilot/rwr');
  await assert.rejects(q.acquire({priority:4}),e=>e.status===429);
  assert.equal(q.health().queued,4);release();release();await Promise.all([a,b,attack,rwr]);
  assert.deepEqual(order,['rwr','attack','result-a','result-b']);assert.equal(q.health().active,0);q.close();
});
test('排队取消立即释放位置，超时和关闭不会启动陈旧操作',async()=>{
  const q=new TacticalScheduler({concurrency:1,maxQueued:2,reservedUrgent:0,maxWaitMs:15}),release=await q.acquire(),controller=new AbortController();
  const cancelled=q.acquire({signal:controller.signal}),check=assert.rejects(cancelled,{name:'AbortError'});controller.abort();await check;assert.equal(q.health().queued,0);
  const timed=assert.rejects(q.acquire(),e=>e.status===503&&/超时/.test(e.message));await new Promise(resolve=>setTimeout(resolve,25));await timed;
  const closed=assert.rejects(q.acquire(),e=>e.status===503);q.close();await closed;release();assert.equal(q.health().active,0);
});
test('HTTP任务排队不再直接429，断开排队请求不启动模型，事件先于结果检查',async t=>{
  const entered=[],gates=new Map(),pilot={health:()=>({enabled:true}),stop(){for(const finish of gates.values())finish({});},
    checkResult(input){entered.push(input.requestId);return new Promise(resolve=>gates.set(input.requestId,resolve));},
    async assess(input){entered.push(input.requestId);return {ok:true};}};
  const server=createGameServer(readConfig({TACTICAL_AI_CONCURRENCY:'2'}),{playerCredentials:false,pilotAssistant:pilot,fetchImpl:async()=>{throw Error('不允许真实调用');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{pilot.stop();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,post=(id,path='result',signal)=>fetch(base+'/api/tactical/pilot/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:id}),signal});
  const count=async n=>(await(await fetch(base+'/api/health')).json()).tacticalQueue.queued===n;
  const a=post('active-a'),b=post('active-b');await until(()=>entered.length===2);
  const routine=post('queued-result');await until(()=>count(1));
  const abort=new AbortController(),cancelled=post('cancelled-result','result',abort.signal).catch(e=>e);await until(()=>count(2));
  const event=post('event','assess');await until(()=>count(3));abort.abort();await cancelled;await until(()=>count(2));
  gates.get('active-a')({ok:true});await until(()=>entered.includes('queued-result'));
  assert.deepEqual(entered.slice(2),['event','queued-result']);assert(!entered.includes('cancelled-result'));
  gates.get('active-b')({ok:true});gates.get('queued-result')({ok:true});
  assert.deepEqual((await Promise.all([a,b,routine,event])).map(r=>r.status),[200,200,200,200]);await tick();
});

test('default server admits seven aircraft concurrently; the cloud budget is explicit and configurable',async t=>{
 const entered=[],gates=[],pilot={health:()=>({enabled:true}),stop(){for(const finish of gates)finish({ok:true});},checkResult(input){entered.push(input.requestId);return new Promise(resolve=>gates.push(resolve));}};
 const config=readConfig({});assert.equal(config.tacticalConcurrency,0);assert.throws(()=>readConfig({TACTICAL_AI_CONCURRENCY:'-1'}),/并发/);
 const server=createGameServer(config,{playerCredentials:false,pilotAssistant:pilot});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{pilot.stop();server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port,requests=Array.from({length:7},(_,i)=>fetch(base+'/api/tactical/pilot/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'plane-'+i})}));
 await until(()=>entered.length===7);const health=await(await fetch(base+'/api/health')).json();assert.equal(health.tacticalQueue.active,7);assert.equal(health.tacticalQueue.queued,0);assert.equal(health.tacticalQueue.concurrency,0);
 pilot.stop();assert((await Promise.all(requests)).every(r=>r.status===200));
});
