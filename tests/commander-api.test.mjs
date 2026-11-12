import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {createCommanderApi,registerCommanderTools} from '../game/commander-api.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World({units:[
  {id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO',profile:'f16',position:[2000,0,6500],heading:0,speed:250},
  {id:'red-secret',callsign:'SECRET RED',team:'red',profile:'f16',position:[12345,54321,7000],heading:180,speed:250}
]},profiles);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  const state={world:world(),selectedId:'blue-1',playing:false,rate:1},calls=[],pending=[],cancelledUnits=[];let busy=false,cancels=0,sequence=0;
  const controller=createCommanderApi({getState:()=>state,isBusy:()=>busy,
    issue:(text,options)=>{calls.push({text,options});return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
    cancel:id=>{cancels++;cancelledUnits.push(id);},select:id=>{state.selectedId=id;},setRunning:value=>{state.playing=value;},createId:()=>`command-${++sequence}`});
  return {state,calls,pending,cancelledUnits,controller,api:controller.api,setBusy:value=>{busy=value;},get cancels(){return cancels;}};
}

test('API立即返回编号，沿用电台入口，装订与通联结束分别记录',async()=>{
  const h=setup(),job=h.api.submit('Alpha，搜索前方目标');
  assert.equal(job.status,'processing');assert.equal(job.committed,false);assert.equal(h.calls[0].options.source,'api');
  assert.equal(h.state.world.units[0].attackTask?.active??false,false);assert.equal(h.state.world.revision,0);
  h.calls[0].options.onStatus('正在接令');assert.equal(h.api.status(job.commandId,{includeObservation:false}).command.message,'正在接令');
  h.calls[0].options.onCommitted({plan:{status:'accepted',tasks:[]}});
  let snapshot=h.api.status(job.commandId,{includeObservation:false});assert.equal(snapshot.command.status,'committed');assert.equal(snapshot.command.committed,true);
  h.pending[0].resolve({committed:true,status:'executed',summary:'程序已核实',reply:{plan:{status:'accepted',tasks:[]}}});await flush();
  snapshot=h.api.status(job.commandId,{includeObservation:false});assert.equal(snapshot.command.status,'completed');assert.equal(snapshot.activeCommandId,null);
});

test('API观测不泄露未发现敌机、RWR辐射源或可变世界引用',()=>{
  const h=setup(),u=h.state.world.units[0];u.rwr.contacts=[{id:'RWR-1',emitterKey:'missile-secret',level:'launch',epoch:1,bearingDeg:45,signalType:'active_seeker',firstSeen:0,observedAt:0}];
  const snapshot=h.api.status();assert.doesNotMatch(JSON.stringify(snapshot),/red-secret|SECRET RED|12345|54321|missile-secret/);
  snapshot.observation.units[0].position[0]=999;assert.equal(u.position[0],0);
  assert.throws(()=>h.api.submit('攻击',{unitId:'red-secret'}),/玩家方/);assert.equal(h.calls.length,0);
});

test('取消保留装订事实，且迟到响应不能改写取消结果',async()=>{
  for(const committed of [false,true]){
    const h=setup(),job=h.api.submit('Alpha，保持航向');if(committed)h.calls[0].options.onCommitted({plan:{tasks:[]}});
    const result=h.api.cancel(job.commandId);assert.equal(h.cancels,1);assert.equal(result.status,'cancelled');assert.equal(result.committed,committed);
    h.pending[0].resolve({committed:true,status:'executed',summary:'迟到响应'});await flush();
    assert.equal(h.api.status(job.commandId,{includeObservation:false}).command.status,'cancelled');
    h.api.cancel(job.commandId);assert.equal(h.cancels,1);
  }
});

test('无效参数被拒绝，服务失败不伪报成功',async()=>{
  const h=setup();assert.throws(()=>h.api.submit(' '),/1–1000/);assert.throws(()=>h.api.submit('a'.repeat(1001)),/1–1000/);
  const job=h.api.submit('Alpha，保持航向');
  h.pending[0].reject(Error('服务暂不可用'));await flush();
  const status=h.api.status(job.commandId,{includeObservation:false});assert.equal(status.command.status,'failed');assert.equal(status.command.committed,false);
  assert.throws(()=>h.api.setRunning('true'),/布尔值/);assert.equal(h.api.setRunning(true).playing,true);
});

test('两机可以并发，同机新令替代旧令，迟到提交与错误不污染新请求',async()=>{
  const h=setup(),alpha=h.api.submit('Alpha，保持航向',{unitId:'blue-1'}),bravo=h.api.submit('Bravo，搜索',{unitId:'blue-2'});
  assert.equal(h.api.submit('Alpha，保持航向',{unitId:'blue-1'}).commandId,alpha.commandId);assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].options.unitId,'blue-1');assert.equal(h.calls[1].options.unitId,'blue-2');
  assert.deepEqual(h.api.status(null,{includeObservation:false}).activeCommandIds,[alpha.commandId,bravo.commandId]);
  const replacement=h.api.submit('Alpha，向左转',{unitId:'blue-1'});
  assert.equal(h.api.status(alpha.commandId,{includeObservation:false}).command.status,'cancelled');
  h.calls[0].options.onCommitted({requestId:'old-response',plan:{tasks:[{unitId:'blue-1'}]}});
  h.pending[0].reject(Object.assign(Error('旧结果失败'),{commandCommitted:true}));await flush();
  assert.equal(h.api.status(replacement.commandId,{includeObservation:false}).command.committed,false);
  h.calls[1].options.onCommitted({requestId:'bravo-response',plan:{tasks:[{unitId:'blue-2'}]}});
  assert.equal(h.api.status(bravo.commandId,{includeObservation:false}).command.committed,true);
  h.api.cancel(replacement.commandId);assert.equal(h.cancels,1);assert.deepEqual(h.cancelledUnits,['blue-1']);
  assert.equal(h.api.status(bravo.commandId,{includeObservation:false}).command.status,'committed');
  h.pending[1].resolve({committed:true,status:'executing',summary:'Bravo继续执行'});h.pending[2].resolve();await flush();
});

test('WebMCP注册四个工具，提交不等待语音，错误信息可读',async()=>{
  const h=setup(),tools=new Map(),lifetime=new AbortController(),options=[];
  const result=await registerCommanderTools(h.api,{modelContext:{registerTool(tool,opts){tools.set(tool.name,tool);options.push(opts);}},signal:lifetime.signal});
  assert.equal(result.available,true);assert.equal(tools.size,4);assert.ok(options.every(v=>v.signal===lifetime.signal));
  assert.equal(tools.get('commander_status').annotations.readOnlyHint,true);
  const sent=await tools.get('issue_commander_order').execute({instruction:'Alpha，搜索前方'}),job=JSON.parse(sent.content[0].text);
  assert.equal(job.status,'processing');
  const status=await tools.get('commander_status').execute({commandId:job.commandId,includeObservation:false});assert.equal(JSON.parse(status.content[0].text).command.commandId,job.commandId);
  const error=await tools.get('cancel_commander_order').execute({commandId:'unknown'});assert.equal(error.isError,true);assert.match(error.content[0].text,/未知指挥/);
  const aborted=new AbortController();aborted.abort();await assert.rejects(tools.get('issue_commander_order').execute({instruction:'第二条'},{signal:aborted.signal}),{name:'AbortError'});
  h.pending[0].resolve({committed:false,status:'clarification',summary:'请重发'});await flush();
  const absent=await registerCommanderTools(h.api,{modelContext:{}});assert.equal(absent.available,false);
});
