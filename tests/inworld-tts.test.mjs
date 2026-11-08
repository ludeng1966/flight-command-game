import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {readTtsConfig,createInworldTts,INWORLD_TTS_MODEL} from '../server/inworld-tts.mjs';
import {createInworldSpeech} from '../game/inworld-speech.js';
import {createRadioConsole} from '../game/radio-console.js';

const bytes=Buffer.from('ID3-test-mp3');
const env={INWORLD_API_KEY:'test-base64-key',INWORLD_VOICE_COMMANDER:'commander-id',INWORLD_VOICE_CONTROLLER:'tower-id',INWORLD_VOICE_PILOT:'pilot-id'};
const message={speaker:'pilot',text:'Alpha，航向两拐洞。',language:'zh-CN'};
const post=(base,input=message,headers={})=>fetch(base+'/api/voice/synthesize',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
async function serve(t,env,fetchImpl){
  const server=createGameServer(readConfig(env),{fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return `http://127.0.0.1:${server.address().port}`;
}

test('Inworld HTTP 使用 Flash、服务端角色音色与 Basic 原始凭据，返回 MP3 且不暴露密钥',async t=>{
  const calls=[],base=await serve(t,env,async(url,options)=>{calls.push({url,...options});return Response.json({audioContent:bytes.toString('base64')});});
  for(const speaker of ['commander','controller','pilot','system']){
    const response=await post(base,{...message,speaker,voiceId:'untrusted-id',modelId:'untrusted-model'});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mpeg');assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }
  assert.deepEqual(calls.map(c=>JSON.parse(c.body).voiceId),['commander-id','tower-id','pilot-id','commander-id']);
  assert.deepEqual(calls.map(c=>JSON.parse(c.body).audioConfig.speakingRate),[1.12,1.08,1.08,1.08]);
  for(const call of calls){assert.equal(call.url,'https://api.inworld.ai/tts/v1/voice');assert.equal(call.headers.Authorization,'Basic test-base64-key');assert.equal(call.redirect,'error');assert.equal(JSON.parse(call.body).modelId,INWORLD_TTS_MODEL);assert.equal(JSON.parse(call.body).audioConfig.audioEncoding,'MP3');}
  const health=await(await fetch(base+'/api/health')).json();assert.deepEqual(health.tts,{provider:'inworld',model:INWORLD_TTS_MODEL,ready:true});assert(!JSON.stringify(health).includes(env.INWORLD_API_KEY));
});

test('无密钥明确显示待配置，浏览器来源可显式选用，配置拒绝无效值',async t=>{
  const base=await serve(t,{},()=>{throw Error('不应调用');});assert.equal((await post(base)).status,503);
  assert.equal((await(await fetch(base+'/api/health')).json()).tts.ready,false);
  assert.equal(readTtsConfig({INWORLD_API_KEY:'Basic abc='}).apiKey,'abc=');
  assert.deepEqual(createInworldTts(readTtsConfig({TTS_PROVIDER:'browser'})).health(),{provider:'browser',model:null,ready:true});
  for(const config of [{TTS_PROVIDER:'other'},{INWORLD_TTS_TIMEOUT_MS:'0'},{INWORLD_RATE_COMMANDER:'2'},{INWORLD_RATE_COMMANDER:'NaN'},{INWORLD_VOICE_PILOT:'\r\n'},{INWORLD_API_KEY:'key\r\nx'}])assert.throws(()=>readTtsConfig(config));
});

test('两位飞行员按固定单位选择不同音色，缺省与其他角色保持兼容',async t=>{
  const calls=[],base=await serve(t,{...env,INWORLD_VOICE_PILOT_1:'alpha-male',INWORLD_VOICE_PILOT_2:'bravo-male'},async(_url,options)=>{
    calls.push(JSON.parse(options.body));return Response.json({audioContent:bytes.toString('base64')});
  });
  for(const input of [
    {...message,unitId:'blue-2'}, {...message,unitId:'blue-1'}, {...message,unitId:'blue-2'},
    message, {...message,unitId:'unknown'}, {...message,unitId:'toString'},
    {...message,speaker:'commander',unitId:'blue-2'}, {...message,speaker:'controller',unitId:'blue-1'}
  ])assert.equal((await post(base,{...input,voiceId:'client-override'})).status,200);
  assert.deepEqual(calls.map(c=>c.voiceId),['bravo-male','alpha-male','bravo-male','pilot-id','pilot-id','pilot-id','commander-id','tower-id']);
  assert.deepEqual(readTtsConfig(env).pilotVoices,{'blue-1':'pilot-id','blue-2':'pilot-id'});
  assert.throws(()=>readTtsConfig({...env,INWORLD_VOICE_PILOT_2:'\ninvalid'}));
  for(const unitId of [null,[],42,'','x'.repeat(65),'blue-1\n'])assert.equal((await post(base,{...message,unitId})).status,400);
  assert.equal(calls.length,8);
});

test('英文呼号保持原样，跑道读法规范化；混合通联不强制中文',async t=>{
  const calls=[],base=await serve(t,env,async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({audioContent:bytes.toString('base64')});});
  for(const text of ['指挥台，Bravo 收到。Alpha 保持高度，BAY 跑道09L。','Bravo, ROGER. HEADING TWO SEVEN ZERO.','指挥台，收到，正在执行。'])assert.equal((await post(base,{...message,text,language:'zh-CN'})).status,200);
  assert.equal(calls[0].text,'指挥台，Bravo 收到。Alpha 保持高度，BAY 跑道洞九左。');
  assert.equal(Object.hasOwn(calls[0],'language'),false);
  assert.equal(calls[1].language,'en-US');assert.equal(calls[1].text,'Bravo, ROGER. HEADING TWO SEVEN ZERO.');
  assert.equal(calls[2].language,'zh-CN');
});

test('无效文本、角色、语言、跨站请求均不调用计费上游',async t=>{
  let calls=0;const base=await serve(t,env,()=>{calls++;throw Error('不应调用');});
  for(const input of [null,{}, {...message,text:''},{...message,text:'字'.repeat(2001)},{...message,speaker:'toString'},{...message,language:'bad code'}])assert.equal((await post(base,input)).status,400);
  assert.equal((await post(base,message,{Origin:'https://other.example'})).status,403);assert.equal(calls,0);
});

test('上游拒绝、无效 JSON 和空音频不会泄露上游原文或密钥',async t=>{
  for(const upstream of [new Response('test-base64-key',{status:401}),new Response('not json'),Response.json({audioContent:''}),Response.json({audioContent:'!!!!'})]){
    const base=await serve(t,env,async()=>upstream),r=await post(base);assert.equal(r.status,502);assert(!JSON.stringify(await r.json()).includes(env.INWORLD_API_KEY));
  }
});

test('客户端断连会取消上游合成；TTS 并发额度独立且受限',async t=>{
  const signals=[],base=await serve(t,env,async(_url,{signal})=>{signals.push(signal);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  const first=new AbortController(),second=new AbortController(),held=new AbortController();
  const request=controller=>fetch(base+'/api/voice/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message),signal:controller.signal}).catch(e=>e);
  const a=request(held);
  const b=request(first);
  for(let i=0;i<200&&signals.length<2;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(signals.length,2);
  assert.equal((await request(second)).status,429);
  first.abort();await b;
  for(let i=0;i<100&&!signals[1].aborted;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(signals[1].aborted,true);
  // The AI limiter is free even while speech is pending.
  const ai=await fetch(base+'/api/tactical/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.notEqual(ai.status,429);
  held.abort();await a;
});

test('上游超时返回 504，预先取消不发起上游请求',async t=>{
  let calls=0;const base=await serve(t,{...env,INWORLD_TTS_TIMEOUT_MS:'1000'},async(_url,{signal})=>{
    calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  assert.equal((await post(base)).status,504);assert.equal(calls,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(createInworldTts(readTtsConfig(env),()=>{throw Error('不应调用');}).synthesize(message,{signal:controller.signal}),{name:'AbortError'});
});

function playback(fetchImpl,rejectPlay=false){
  const players=[],revoked=[],created=[];
  class Audio{
    constructor(src){this.src=src;players.push(this);}play(){if(rejectPlay)return Promise.reject(new DOMException('请先与页面交互','NotAllowedError'));this.onplaying?.();return Promise.resolve();}pause(){this.paused=true;}removeAttribute(){this.src='';}
  }
  return {players,revoked,created,speech:createInworldSpeech({fetchImpl,Audio,urlApi:{createObjectURL(blob){created.push(blob);return 'blob:audio';},revokeObjectURL(url){revoked.push(url);}}})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('浏览器等待音频结束才记录 spoken，清理 URL，中文覆盖英文通联语言',async()=>{
  const sent=[],p=playback(async(_url,options)=>{sent.push(JSON.parse(options.body));return new Response(bytes,{headers:{'Content-Type':'audio/mpeg'}});}),row={dataset:{}};
  let complete=false;const pending=p.speech.speak({...message,unitId:'blue-2',text:'收到（检查完毕）',language:'en-US'},{row}).then(value=>{complete=true;return value;});await tick();
  assert.equal(complete,false);assert.equal(row.dataset.speaking,'true');assert.equal(sent[0].text,'收到');assert.equal(sent[0].language,'zh-CN');assert.equal(sent[0].unitId,'blue-2');
  p.players[0].onended();assert.equal(await pending,'spoken');assert.equal(row.dataset.speaking,'false');assert.deepEqual(p.revoked,['blob:audio']);assert.equal(p.players[0].paused,true);
});

test('静音或取消会终止合成，晚到的音频不能播放；播放中取消会释放音频',async()=>{
  for(const muted of [true,false]){
    let finish,signal;const p=playback(async(_url,options)=>{signal=options.signal;return new Promise(r=>finish=r);});
    const pending=p.speech.speak(message).catch(e=>e);p.speech.cancel(muted?'muted':'cancelled');assert.equal(signal.aborted,true);
    const result=await pending;assert.equal(muted?result:result.name,muted?'muted':'AbortError');finish(new Response(bytes));await tick();assert.equal(p.players.length,0);
  }
  const p=playback(async()=>new Response(bytes)),controller=new AbortController(),pending=p.speech.speak(message,{signal:controller.signal}).catch(e=>e);await tick();controller.abort();
  assert.equal((await pending).name,'AbortError');assert.equal(p.players[0].paused,true);assert.equal(p.revoked.length,1);
});

test('播放被拒绝或接口失败明确回退字幕，不假报 spoken',async()=>{
  for(const mode of ['api-error','decode-error','autoplay-blocked']){
    const errors=[],p=playback(async()=>mode==='api-error'?Response.json({error:'请配置 INWORLD_API_KEY'},{status:503}):new Response(bytes),mode==='autoplay-blocked');
    const promise=p.speech.speak(message,{onError:error=>errors.push(error)});await tick();
    if(mode==='decode-error')p.players[0].onerror();assert.equal(await promise,'unavailable');assert.equal(errors.length,1);
  }
});

test('通联语音关闭不调用云端，恢复后使用配置来源，失败保留字幕记录',async()=>{
  const world={time:0,units:[]},button={setAttribute(){}},calls=[];
  const radio=createRadioConsole({getWorld:()=>world,document:{querySelector:s=>s==='#radio-audio'?button:null},speech:{cancel(){},async speak(message){calls.push(message);return 'spoken';}}});
  radio.configure({provider:'inworld',ready:false});assert.match(button.textContent,/待配置/);assert.equal((await radio.transmit(message)).delivery,'unavailable');assert.equal(calls.length,0);
  radio.configure({provider:'inworld',ready:true});assert.equal(button.title,'');button.onclick();assert.equal((await radio.transmit(message)).delivery,'muted');assert.equal(calls.length,0);
  button.onclick();assert.equal((await radio.transmit(message)).delivery,'spoken');assert.equal(calls.length,1);assert.equal(world.radioLog.length,3);
});

test('云端402失败后同一句切回本地播报，后续通联不反复请求故障云端，静音仍生效',async()=>{
 const world={time:0,units:[]},button={setAttribute(){}},spoken=[];let cloudCalls=0;
 const radio=createRadioConsole({getWorld:()=>world,storage:null,document:{querySelector:s=>s==='#radio-audio'?button:null},
  Utterance:class{constructor(text){this.text=text;}},synth:{getVoices:()=>[{lang:'zh-CN',localService:true}],cancel(){},speak(u){spoken.push(u.text);queueMicrotask(()=>u.onend());}},
  speech:{cancel(){},async speak(_m,{onError}){cloudCalls++;onError('Inworld：计费或可用额度受限（HTTP 402）');return 'unavailable';}}});
 radio.configure({provider:'inworld',ready:true});
 assert.equal((await radio.transmit(message)).delivery,'spoken');assert.match(button.textContent,/本地/);assert.match(button.title,/402/);
 radio.configure({provider:'inworld',ready:true});assert.equal((await radio.transmit(message)).delivery,'spoken');assert.equal(cloudCalls,1);assert.equal(spoken.length,2);
 button.onclick();assert.equal((await radio.transmit(message)).delivery,'muted');assert.equal(spoken.length,2);assert.equal(cloudCalls,1);
 button.onclick();assert.equal((await radio.transmit(message)).delivery,'spoken');assert.equal(cloudCalls,2);
});

test('云端失败后的本地语音可被中止，不提前记为已播报',async()=>{
 let utterance;const controller=new AbortController(),world={time:0,units:[]};
 const radio=createRadioConsole({getWorld:()=>world,storage:null,document:{querySelector:()=>null},Utterance:class{constructor(text){this.text=text;}},synth:{getVoices:()=>[{lang:'zh-CN'}],speak(u){utterance=u;},cancel(){}},speech:{cancel(){},async speak(){return 'unavailable';}}});
 const pending=radio.transmit(message,{signal:controller.signal});await tick();assert(utterance);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(world.radioLog[0].delivery,'cancelled');
});

test('云端恢复后重新验证即使用Inworld，不继续播本地回退',async()=>{
 const button={setAttribute(){}},world={time:0,units:[]};let recovered=false,localCalls=0,cloudCalls=0;
 const radio=createRadioConsole({getWorld:()=>world,storage:null,document:{querySelector:s=>s==='#radio-audio'?button:null},Utterance:class{constructor(text){this.text=text;}},synth:{getVoices:()=>[{lang:'zh-CN'}],cancel(){},speak(u){localCalls++;queueMicrotask(()=>u.onend());}},speech:{cancel(){},async speak(_m,{onError}){cloudCalls++;if(recovered)return 'spoken';onError('Inworld HTTP 402');return 'unavailable';}}});
 await radio.transmit(message);assert.equal(localCalls,1);assert.match(button.textContent,/本地/);
 recovered=true;button.onclick();button.onclick();await radio.transmit(message);assert.equal(cloudCalls,2);assert.equal(localCalls,1);assert.equal(button.textContent,'通话语音：Inworld Flash');assert.equal(button.title,'');
});
