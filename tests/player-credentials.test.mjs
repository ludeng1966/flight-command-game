import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {createPlayerCredentials,playerConfig,PLAYER_COOKIE} from '../server/player-credentials.mjs';

const env={DASHSCOPE_API_KEY:'owner-qwen-secret',INWORLD_API_KEY:'b3duZXItaW53b3JsZA==',INWORLD_VOICE_COMMANDER:'owner-private-voice'};
const keys=n=>({qwenKey:`sk-player-${n}-secret`,inworldKey:Buffer.from(`player-${n}-inworld`).toString('base64')});
const mp3=Buffer.from('ID3-test');
async function serve(t,fetchImpl){
  const server=createGameServer(readConfig(env),{fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;
}
const call=(base,path,input,cookie,method='POST',headers={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
async function save(base,input,cookie){const r=await call(base,'/api/player/credentials',input,cookie);assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],response:r};}
const translation={source:'zh',target:'en',texts:['收到']};

test('浏览器会话各自使用自己的Qwen和Inworld密钥，决策缓存独立，不覆盖本机配置',async t=>{
  const calls=[],base=await serve(t,async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body,authorization:options.headers.Authorization});
    return url.includes('inworld')?Response.json({audioContent:mp3.toString('base64')}):Response.json({choices:[{message:{content:JSON.stringify({texts:['Roger']})}}]});
  });
  const a=await save(base,keys('a')),b=await save(base,{...keys('b'),qwenRegion:'singapore',qwenModel:'qwen-plus',voices:{commander:'my-voice'}});
  assert.match(a.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  for(const [who,cookie]of [['a',a.cookie],['b',b.cookie]]){
    const data=await(await fetch(base+'/api/player/credentials',{headers:{Cookie:cookie}})).json();
    assert.equal(data.source,'player');assert(data.qwenConfigured&&data.inworldConfigured);assert(!JSON.stringify(data).includes('secret'));
    const translated=await call(base,'/api/language/translate',translation,cookie);assert.equal(translated.status,200);assert.deepEqual(await translated.json(),{texts:['Roger']});
    const ai=calls.at(-1);assert.equal(ai.authorization,`Bearer ${keys(who).qwenKey}`);
    assert(ai.url.startsWith(who==='a'?'https://dashscope.aliyuncs.com/':'https://dashscope-intl.aliyuncs.com/'));
    const voice=await call(base,'/api/voice/synthesize',{speaker:'commander',text:'测试连接。'},cookie);assert.equal(voice.status,200);assert.deepEqual(Buffer.from(await voice.arrayBuffer()),mp3);
    assert.equal(calls.at(-1).authorization,`Basic ${keys(who).inworldKey}`);assert.equal(calls.at(-1).body.voiceId,who==='a'?'Dennis':'my-voice');
  }
  // Identical text still produced two upstream calls, so one player's cache did
  // not suppress/bill another player's request. Default clients remain intact.
  assert.equal(calls.filter(c=>!c.url.includes('inworld')).length,2);
  const defaultVoice=await call(base,'/api/voice/synthesize',{speaker:'commander',text:'本机。'});assert.equal(defaultVoice.status,200);
  assert.equal(calls.at(-1).authorization,`Basic ${env.INWORLD_API_KEY}`);assert.equal(calls.at(-1).body.voiceId,'owner-private-voice');
  const health=await(await fetch(base+'/api/health',{headers:{Cookie:b.cookie}})).json();assert.equal(health.commandModel,'qwen-plus');assert(!JSON.stringify(health).includes(keys('b').qwenKey));
});

test('只填一个提供商时不借用主人的另一把密钥，更新留空仅保留本会话，清除恢复本机',async t=>{
  const calls=[],base=await serve(t,async(url,options)=>{calls.push(options.headers.Authorization);return Response.json({audioContent:mp3.toString('base64')});});
  const a=await save(base,{qwenKey:keys('a').qwenKey});
  const unavailable=await call(base,'/api/voice/synthesize',{speaker:'commander',text:'测试'},a.cookie);assert.equal(unavailable.status,503);assert.equal(calls.length,0);
  const b=await save(base,{inworldKey:keys('b').inworldKey});
  const noQwen=await call(base,'/api/language/translate',translation,b.cookie);assert.equal(noQwen.status,503);assert.equal(calls.length,0);
  const updated=await save(base,{qwenKey:'',inworldKey:keys('a').inworldKey},a.cookie);
  assert.notEqual(updated.cookie,a.cookie);
  assert.equal((await fetch(base+'/api/health',{headers:{Cookie:a.cookie}})).status,401);
  const status=await updated.response.json();assert(status.qwenConfigured&&status.inworldConfigured);
  const cleared=await call(base,'/api/player/credentials',undefined,updated.cookie,'DELETE');assert.equal(cleared.status,200);assert.match(cleared.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await cleared.json()).source,'local');assert.equal((await fetch(base+'/api/health',{headers:{Cookie:updated.cookie}})).status,401);
  const local=await(await fetch(base+'/api/player/credentials')).json();assert.equal(local.source,'local');assert(local.qwenConfigured&&local.inworldConfigured);
});

test('保存不计费，测试调用确实使用玩家密钥；错误不泄漏密钥或上游原文',async t=>{
  let mode='ok';const calls=[],base=await serve(t,async(url,options)=>{
    calls.push(options.headers.Authorization);
    if(mode==='fail')return new Response(keys('a').qwenKey,{status:401});
    return url.includes('inworld')?Response.json({audioContent:mp3.toString('base64')}):Response.json({choices:[{message:{content:'{"ok":true}'}}]});
  });
  const a=await save(base,keys('a'));assert.equal(calls.length,0);
  const q=await call(base,'/api/player/credentials/test',{provider:'qwen'},a.cookie);assert.equal(q.status,200);assert.equal((await q.json()).ok,true);assert.equal(calls.at(-1),`Bearer ${keys('a').qwenKey}`);
  const v=await call(base,'/api/player/credentials/test',{provider:'inworld'},a.cookie);assert.equal(v.status,200);assert.equal(v.headers.get('content-type'),'audio/mpeg');assert.equal(calls.at(-1),`Basic ${keys('a').inworldKey}`);
  mode='fail';const failed=await call(base,'/api/player/credentials/test',{provider:'qwen'},a.cookie);assert.equal(failed.status,502);assert(!(await failed.text()).includes('secret'));
});

test('跨站修改/删除/测试、超长配置、任意上游地址与无效音色被拒绝',async t=>{
  const base=await serve(t,()=>{throw Error('不应请求上游');});
  for(const method of ['POST','DELETE']){
    const r=await call(base,'/api/player/credentials',method==='POST'?keys('a'):undefined,undefined,method,{Origin:'https://evil.example'});assert.equal(r.status,403);
  }
  assert.equal((await call(base,'/api/player/credentials/test',{provider:'qwen'},undefined,'POST',{'Sec-Fetch-Site':'cross-site'})).status,403);
  for(const input of [null,[],{}, {...keys('a'),qwenKey:'x\r\nInjected'}, {...keys('a'),inworldKey:'not base64!'}, {...keys('a'),qwenRegion:'http://evil.example'}, {...keys('a'),qwenModel:'a\nb'}, {...keys('a'),voices:{commander:'x\r\ny'}}, {...keys('a'),pilotEnglishLocalized:'true'}]){
    assert.equal((await call(base,'/api/player/credentials',input)).status,400);
  }
  assert.equal((await call(base,'/api/player/credentials',{qwenKey:'x'.repeat(20000)})).status,413);
  const config=playerConfig(readConfig(env),{...keys('a'),baseUrl:'https://evil.example'});assert.equal(config.baseUrl,'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('过期或服务重启后的cookie不回退主人密钥；可直接重填；内存会话有上限且释放运行时',()=>{
  let clock=1000,disposed=0;
  const manager=createPlayerCredentials(readConfig(env),()=>({dispose(){disposed++;}}),{now:()=>clock,ttl:100,maxSessions:1});
  const request={headers:{}},res={setHeader(_key,value){this.cookie=value.split(';')[0];}};
  try{
    manager.update(request,res,keys('a'));const saved={headers:{cookie:res.cookie}};
    assert.throws(()=>manager.update(request,res,keys('b')),error=>error.status===503);
    clock=1101;assert.throws(()=>manager.runtime(saved),error=>error.status===401);assert.equal(disposed,1);
    manager.update(saved,res,keys('b'));assert.equal(manager.status({headers:{cookie:res.cookie}}).source,'player');
    assert.throws(()=>manager.runtime({headers:{cookie:`${PLAYER_COOKIE}=${'A'.repeat(43)}`}}),error=>error.status===401);
  }finally{manager.close();}assert.equal(disposed,2);
});
