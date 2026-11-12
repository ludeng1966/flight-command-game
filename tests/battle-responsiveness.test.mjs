import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RadioQueue} from '../game/radio-queue.js';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {captureCommandResult,validateResultReadbacks,inspectCommandResult} from '../sim/pilot-result.js';
import {commandReceipt} from '../sim/command-receipt.js';
const tick=()=>new Promise(r=>setImmediate(r));

test('紧急电台插播后重播完整指挥通话，指挥调用不提前完成',async()=>{
  const queue=new RadioQueue(),events=[];let release,completed=false;
  const normal=queue.enqueue(signal=>new Promise((resolve,reject)=>{events.push('command');release=()=>resolve('complete');signal.addEventListener('abort',()=>reject(new DOMException('interrupted','AbortError')),{once:true});})).then(()=>{completed=true;});
  await tick();await queue.enqueue(async()=>{events.push('warning');assert.equal(completed,false);},{priority:100});
  await tick();assert.deepEqual(events,['command','warning','command']);assert.equal(completed,false);release();await normal;assert.equal(completed,true);
});
test('电台取消会取消正在播报和排队的消息，过期消息不播放',async()=>{
  const queue=new RadioQueue(),controller=new AbortController();let called=false;
  const first=queue.enqueue(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')))),{signal:controller.signal});
  const second=queue.enqueue(async()=>{called=true;});
  const outcomes=Promise.allSettled([first,second]);await tick();queue.cancel();assert.deepEqual((await outcomes).map(o=>o.status),['rejected','rejected']);assert.equal(called,false);
  await assert.rejects(queue.enqueue(async()=>{called=true;},{isCurrent:()=>false}),{name:'AbortError'});assert.equal(called,false);
});
test('事实回执无需模型，区分暂停、执行中和参数达到',()=>{
  const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),world=new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:180}]},profiles);
  const plan={status:'accepted',summary:'爬升',tasks:[{unitId:'blue-1',action:'set_flight',altitudeM:8000,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]};
  applyPlan(world,plan,world.revision);
  for(const clockRunning of [false,true]){
    const context=commandContext(world,'blue-1'),result=captureCommandResult(world,{clockRunning});
    const receipt=commandReceipt({requestId:'receipt',context,plan,result});assert.equal(receipt.checkedBy,'flight-computer');assert.equal(receipt.checks[0].verdict,'executing');
    assert.match(receipt.checks[0].readbackText,clockRunning?/正在执行/:/暂停/);validateResultReadbacks(receipt,inspectCommandResult(context,plan,undefined,result));
  }
  world.units[0].position[2]=8000;
  const reached=commandReceipt({requestId:'receipt',context:commandContext(world,'blue-1'),plan,result:captureCommandResult(world,{clockRunning:true})});assert.equal(reached.checks[0].verdict,'reached');
});
