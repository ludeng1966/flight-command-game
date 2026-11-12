import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {initVoiceCommands} from '../game/voice-command.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('语音或另一架飞机仍阻塞任务')),1500))]);}finally{clearTimeout(timer);}}
function ui(t){
  const element=()=>({value:'',checked:true,disabled:false,textContent:'',dataset:{},children:[],style:{setProperty(){}},setAttribute(){},addEventListener(){},focus(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},prepend(child){this.children.unshift(child);child.remove=()=>this.children.pop();},get lastElementChild(){return this.children.at(-1);}});
  const elements=new Map(),document=Object.assign(new EventTarget(),{querySelector:s=>{if(!elements.has(s))elements.set(s,element());return elements.get(s);},createElement:element});
  const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};globalThis.document=document;globalThis.window=new EventTarget();
  const window=globalThis.window;t.after(()=>{window.dispatchEvent(new Event('pagehide'));Object.assign(globalThis,previous);});return s=>document.querySelector(s);
}
function response(input,{unitId=input.context.selectedUnitId,intent='set_flight',parameters={altitudeM:7000}}={}){
  const interpretation={version:'1.0',status:'understood',summary:`${unitId} ${intent}`,orders:[{id:'order-1',intent,unitIds:[unitId],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]};
  return Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,interpretation,...compileMilitaryInterpretation(interpretation,input.context)});
}
async function fixture(t,{hangSpeech=false}={}){
  const $=ui(t),world=new World(scenario,profiles),pending=[],published=[],cancelled=[],commits=[],api=[];let selectedId='blue-1',sequence=0;
  const radio={phase(){},configure(){},clear(){},cancel(filter){cancelled.push(filter);},hasPending:()=>false,
    publish(message,{signal}={}){published.push(message);const record={...message,id:`test-radio-${++sequence}`,reception:'accepted',delivery:'queued'};
      const completion=hangSpeech?new Promise((resolve,reject)=>{if(signal?.aborted)reject(new DOMException('cancelled','AbortError'));else signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});}):Promise.resolve({...record,delivery:'spoken'});
      return {record,completion};},async transmit(message,options){return this.publish(message,options).completion;}};
  const fetchImpl=async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true,pilotReady:true,pilotAssistant:{commandPlanning:true,enabled:true}});
    api.push(url);assert.equal(url,'/api/tactical/interpret','参数/攻击任务不应调用第二次模型解析');
    const input=JSON.parse(options.body);return new Promise(resolve=>pending.push({input,signal:options.signal,resolve}));
  };
  globalThis.fetch=fetchImpl; // Health polling currently uses the browser fetch directly.
  const control=initVoiceCommands({getState:()=>({world,selectedId,playing:true,rate:1}),fetchImpl,radio,pause:async()=>{},onApplied(){},onSimulation(){},onCommandCommitted:event=>commits.push(event)});
  await tick();
  return {$,world,control,pending,published,cancelled,commits,api,select(id){selectedId=id;},resolve(index,options){pending[index].resolve(response(pending[index].input,options));}};
}
test('不同飞机请求并行；后发Bravo先提交不使Alpha旧采样失效',async t=>{
  const f=await fixture(t),a=f.control.issue('Alpha七千米',{unitId:'blue-1'}),b=f.control.issue('Bravo八千米',{unitId:'blue-2'});
  await tick();assert.equal(f.pending.length,2);assert.equal(f.control.busyFor('blue-1'),true);assert.equal(f.control.busyFor('blue-2'),true);
  assert.equal(f.control.tacticalPlanningEnabled,true);assert.equal(f.control.playerCommandPending,true);assert.equal(f.$('#command-text').disabled,false);
  f.resolve(1,{parameters:{altitudeM:8000}});assert.equal((await promptly(b)).committed,true);assert.equal(f.world.units[1].holdAltitude,8000);assert.equal(f.pending[0].signal.aborted,false);
  f.resolve(0,{parameters:{altitudeM:7000}});assert.equal((await promptly(a)).committed,true);assert.equal(f.world.units[0].holdAltitude,7000);assert.equal(f.commits.length,2);assert.equal(f.world.commandLog.length,2);
});
test('同机新指令替代旧请求，迟到回包不能覆盖新任务且原已装订任务保留',async t=>{
  const f=await fixture(t),installed=f.control.issue('Alpha七千米');await tick();f.resolve(0);await installed;
  const old=f.control.issue('Alpha九千米');await tick();const next=f.control.issue('Alpha七千二百米');await tick();
  assert.equal(f.pending[1].signal.aborted,true);assert.equal(f.world.units[0].holdAltitude,7000,'新指令未提交前继续旧任务');
  f.resolve(2,{parameters:{altitudeM:7200}});assert.equal((await next).committed,true);f.resolve(1,{parameters:{altitudeM:9000}});await old;
  assert.equal(f.world.units[0].holdAltitude,7200);assert.equal(f.commits.length,2);assert.equal(f.world.commandLog.length,2);assert.ok(f.cancelled.every(c=>typeof c?.commandId==='string'));
});
test('挂起TTS仍立即装订攻击授权；不调用pilot/plan且提交日志不等待播完',async t=>{
  const f=await fixture(t,{hangSpeech:true}),running=f.control.issue('Alpha，搜索并攻击前方目标');await tick();
  f.resolve(0,{intent:'attack',parameters:{targetRef:'前方目标'}});const result=await promptly(running);
  assert.equal(result.committed,true);assert.equal(f.world.units[0].attackTask.active,true);assert.equal(f.world.commandLog.length,1);assert.equal(f.control.busyFor('blue-1'),false);assert.equal(f.control.tacticalPlanningEnabled,true);
  assert.deepEqual(f.api,['/api/tactical/interpret']);assert.equal(result.reply.commanderMessage.receipt,'accepted');assert.equal(result.reply.commanderMessage.delivery,'queued');assert.ok(f.published.length>=1);
});
test('取消仅影响指定飞机；另一架仍可提交，等待解释不关掉战术规划',async t=>{
  const f=await fixture(t),a=f.control.issue('Alpha七千米',{unitId:'blue-1'}),b=f.control.issue('Bravo八千米',{unitId:'blue-2'});await tick();
  f.select('blue-1');f.control.cancel();assert.equal(f.pending[0].signal.aborted,true);assert.equal(f.pending[1].signal.aborted,false);assert.equal(f.control.busyFor('blue-1'),false);assert.equal(f.control.busyFor('blue-2'),true);assert.equal(f.control.tacticalPlanningEnabled,true);
  f.resolve(1,{parameters:{altitudeM:8000}});await b;f.resolve(0);await a;
  assert.equal(f.world.units[0].holdAltitude,6500);assert.equal(f.world.units[1].holdAltitude,8000);assert.equal(f.commits.length,1);assert.ok(!f.cancelled.some(c=>c?.commandId===f.pending[1].input.requestId));
});
test('同机相同输入等待期间复用请求，不因第二次点击取消正在处理的命令',async t=>{
  const f=await fixture(t),first=f.control.issue('Alpha七千米'),again=f.control.issue('Alpha七千米');await tick();assert.equal(f.pending.length,1);assert.equal(f.pending[0].signal.aborted,false);
  f.resolve(0);const results=await Promise.all([first,again]);assert.ok(results.every(r=>r.committed));assert.equal(f.commits.length,1);
});
