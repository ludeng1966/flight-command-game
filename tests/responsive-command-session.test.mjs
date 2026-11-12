import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {runCommandSession} from '../game/command-session.js';
import {createRadioConsole} from '../game/radio-console.js';
import {RadioQueue} from '../game/radio-queue.js';
import {receivedCommanderMessage} from '../sim/commander-message.js';
import {controlAuthority} from '../sim/control-authority.js';
import {preparePilotPlan} from '../sim/orders.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const create=()=>new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:180}]},profiles);
const task=(action='set_flight')=>({unitId:'blue-1',action,altitudeM:7000,speedMps:190,headingDeg:action==='fly_heading'?90:null,eastM:null,northM:null,distanceM:null,append:false});
const reply=action=>({requestId:'responsive-test',plan:{status:'accepted',summary:'调整飞行任务',tasks:[task(action)]}});
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('任务仍被语音或结果检查阻塞')),1500))]);}finally{clearTimeout(timer);}}
test('普通任务提交与返回不等待TTS或结果回读，也不做第二次语义解释',async()=>{
  const w=create(),speech=deferred(),review=deferred(),messages=[],errors=[];let modelCalls=0,pauses=0;
  const r=reply();const result=await promptly(runCommandSession({world:w,reply:r,expectedRevision:0,responsive:true,
    radio:{phase(){},publish(m){messages.push(m);return {record:{...m,id:'accepted-record',delivery:'queued'},completion:speech.promise};}},
    planPilotCommand:async()=>{modelCalls++;throw Error('不应调用');},checkPilotResult:()=>review.promise,pause:async()=>{pauses++;},onSpeechError:e=>errors.push(e)}));
  assert.equal(result.committed,true);assert.equal(w.units[0].holdAltitude,7000);assert.equal(modelCalls,0);assert.equal(pauses,0);assert.equal(result.resultReviewPending,true);
  assert.equal(r.commanderMessage.receipt,'accepted');assert.equal(r.commanderMessage.delivery,'queued');assert.ok(Object.isFrozen(r.commanderMessage));assert.equal(receivedCommanderMessage({commanderMessage:r.commanderMessage}).receipt,'accepted');
  assert.equal(messages[0].commandId,'responsive-test');speech.reject(Error('TTS不可用'));review.reject(Error('检查失败'));await tick();assert.ok(errors.length>=2);assert.equal(w.units[0].holdAltitude,7000);
});
test('导航仍等必要模型航点和当前物理校验，预览一次显示不逐点等待',async()=>{
  const w=create(),r=reply('fly_heading'),planning=deferred(),previews=[];let called=0;
  const running=runCommandSession({world:w,reply:r,expectedRevision:0,responsive:true,radio:{phase(){},async transmit(){}},
    planPilotCommand:async({commanderMessage})=>{called++;assert.ok(Object.isFrozen(commanderMessage));await planning.promise;return {plan:r.plan};},pause:async()=>assert.fail('不能等待展示动画'),onPreview:p=>previews.push(p)});
  await tick();assert.equal(called,1);assert.equal(w.units[0].waypoints.length,0);planning.resolve();const result=await running;
  assert.equal(result.committed,true);assert.ok(w.units[0].waypoints.length);assert.equal(previews.length,1);assert.equal(previews[0].count,previews[0].points.length);
});
test('提交前取消不安装任务；提交后停止音频不撤销任务或使返回失败',async()=>{
  const w=create(),controller=new AbortController();controller.abort();await assert.rejects(runCommandSession({world:w,reply:reply(),expectedRevision:0,responsive:true,signal:controller.signal,radio:{phase(){},async transmit(){}}}),{name:'AbortError'});assert.equal(w.units[0].holdAltitude,6500);
  const other=new AbortController();const result=await runCommandSession({world:w,reply:reply(),expectedRevision:0,responsive:true,signal:other.signal,onCommitted:()=>other.abort(),radio:{phase(){},async transmit(){throw Error('语音失败');}}});assert.equal(result.committed,true);assert.equal(w.units[0].holdAltitude,7000);await tick();
});
test('publish即时记录已接收，定向停止普通命令保留另一架飞机告警',async()=>{
  const w=create(),started=[],speech={cancel(){},speak(message,{signal}){started.push(message.commandId??'warning');return new Promise((resolve,reject)=>{if(message.priority===100)return resolve('spoken');signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});});}};
  const radio=createRadioConsole({getWorld:()=>w,document:{querySelector:()=>null},speech});
  const normal=radio.publish({commandId:'a-command',unitId:'blue-1',speaker:'commander',text:'调整飞行'});assert.equal(w.radioLog[0].reception,'accepted');assert.equal(w.radioLog[0].delivery,'queued');
  await tick();const warning=radio.publish({unitId:'blue-2',speaker:'pilot',text:'告警',priority:100});radio.cancel({commandId:'a-command'});await warning.completion;await assert.rejects(normal.completion,{name:'AbortError'});await tick();
  assert.deepEqual(started,['a-command','warning']);assert.equal(w.radioLog.length,2);assert.equal(w.radioLog[0].delivery,'cancelled');assert.equal(w.radioLog[1].delivery,'spoken');assert.equal(radio.hasPending({commandId:'a-command'}),false);
});
test('普通播报抢占后不从头重播，协议播报最多重试一次',async()=>{
  const queue=new RadioQueue(),starts=[];
  const blocking=label=>signal=>new Promise((_,reject)=>{starts.push(label);signal.addEventListener('abort',()=>reject(new DOMException('preempted','AbortError')),{once:true});});
  const normal=queue.enqueue(blocking('normal'),{preemptPolicy:'drop'});const rejected=assert.rejects(normal,{name:'AbortError'});await tick();await queue.enqueue(async()=>starts.push('urgent'),{priority:100});await rejected;assert.deepEqual(starts,['normal','urgent']);
  const protocol=queue.enqueue(blocking('protocol'),{preemptPolicy:'restart',maxRestarts:1});const stopped=assert.rejects(protocol,{name:'AbortError'});await tick();await queue.enqueue(async()=>{}, {priority:100});await tick();await queue.enqueue(async()=>{}, {priority:100});await stopped;assert.equal(starts.filter(s=>s==='protocol').length,2);
});
test('responsive塔台报告仍等正式播报，不把接收记录当成完成通联',async()=>{
  const w=create(),r=reply('report_status'),voice=deferred();Object.assign(r.plan.tasks[0],{altitudeM:null,speedMps:null});controlAuthority(w,w.units[0]).owner='tower';let calls=0,finished=false;
  const running=runCommandSession({world:w,reply:r,expectedRevision:0,responsive:true,radio:{phase(){},async transmit(m){if(calls++===0)await voice.promise;return {...m,id:'tower-spoken',delivery:'spoken'};}}}).then(result=>{finished=true;return result;});
  await tick();assert.equal(finished,false);assert.equal(calls,1);voice.resolve();const result=await running;assert.equal(result.status,'reported');assert.equal(r.commanderMessage.receipt,undefined);
});
test('有明确单位guard才允许跨无关revision提交，单位冲突仍取消',async()=>{
  for(const conflict of [false,true]){
    const w=create(),r=reply();let ownChanged=false,checkedScoped=false;
    const running=runCommandSession({world:w,reply:r,expectedRevision:0,responsive:true,radio:{phase(){},async transmit(){}},
      executionGuard:{assertCurrent(){if(ownChanged)throw Error('本机任务已更新');},rebase:()=>w.revision},
      async preparePlan(world,plan,revision,options){checkedScoped=options.scoped;const draft=preparePilotPlan(world,plan,revision,options);w.revision++;ownChanged=conflict;return draft;}});
    if(conflict){await assert.rejects(running,/本机任务已更新/);assert.equal(w.units[0].holdAltitude,6500);}else{assert.equal((await running).committed,true);assert.equal(w.units[0].holdAltitude,7000);}assert.equal(checkedScoped,true);
  }
});
