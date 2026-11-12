import test from 'node:test';
import assert from 'node:assert/strict';
import {translateText,localizeRadio,setLanguages,getLanguages} from '../game/language.js';
import {RadioQueue} from '../game/radio-queue.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_resolve,reject)=>timer=setTimeout(()=>reject(Error('取消或抢占仍在等待共享翻译')),500))]);}finally{clearTimeout(timer);}}
test('取消单个翻译等待者立即返回，其他等待者及共享缓存继续完成',async t=>{
  const original=globalThis.fetch,started=deferred(),response=deferred();let calls=0,upstreamSignal;
  globalThis.fetch=async(_url,options)=>{calls++;upstreamSignal=options.signal;started.resolve();return response.promise;};
  t.after(()=>{response.resolve(Response.json({texts:['Shared translation complete.']}));globalThis.fetch=original;});
  const controller=new AbortController(),text='共享翻译取消等待验证甲';
  const first=translateText(text,'en',{signal:controller.signal}),other=translateText(text,'en');
  const rejected=assert.rejects(first,{name:'AbortError'});await started.promise;controller.abort();await promptly(rejected);
  assert.equal(upstreamSignal.aborted,false);assert.equal(calls,1);
  response.resolve(Response.json({texts:['Shared translation complete.']}));assert.equal(await other,'Shared translation complete.');
  assert.equal(await translateText(text,'en'),'Shared translation complete.');assert.equal(calls,1);
});
test('紧急通联可抢占正在翻译的普通回执，随后复用共享翻译恢复原通话',async t=>{
  const original=globalThis.fetch,preferences=getLanguages(),started=deferred(),response=deferred(),urgentStarted=deferred();let calls=0;const delivered=[];
  globalThis.fetch=async()=>{calls++;started.resolve();return response.promise;};setLanguages({text:'en',voice:'en'});
  const queue=new RadioQueue();t.after(()=>{queue.cancel();response.resolve(Response.json({texts:['Routine receipt.']}));globalThis.fetch=original;setLanguages(preferences);});
  const routine=queue.enqueue(async signal=>{const message=await localizeRadio({text:'正在翻译且允许紧急抢占的普通回执乙'},{signal});delivered.push(message.text);},{priority:0});
  await started.promise;
  const urgent=queue.enqueue(async signal=>{const message=await localizeRadio({text:'紧急告警',texts:{zh:'紧急告警',en:'Urgent warning.'}},{signal});delivered.push(message.text);urgentStarted.resolve();},{priority:10});
  await promptly(urgentStarted.promise);await urgent;assert.deepEqual(delivered,['Urgent warning.']);assert.equal(calls,1);
  response.resolve(Response.json({texts:['Routine receipt.']}));await routine;assert.deepEqual(delivered,['Urgent warning.','Routine receipt.']);assert.equal(calls,1);
});
