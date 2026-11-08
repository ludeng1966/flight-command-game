import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {splitBilingualSpeech,bilingualSpeechText,PILOT_DELIVERY} from '../server/bilingual-speech.mjs';
import {createInworldTts,readTtsConfig} from '../server/inworld-tts.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';

test('中英标记保留文字、标点与中文跑道，作为同一句的发音提示',()=>{
  const text='指挥台，GOLF TWO机位就绪，等待指令，BRAVO TWO。跑道洞九左。';
  const parts=splitBilingualSpeech(text);assert.equal(parts.map(p=>p.text).join(''),text);
  assert.deepEqual(parts.filter(p=>p.language==='en-US').map(p=>p.text),['GOLF TWO','BRAVO TWO']);
  const tagged=bilingualSpeechText(text);
  assert(tagged.startsWith(PILOT_DELIVERY));
  assert.match(tagged,/<lang lang="en-US">GOLF TWO<\/lang>/);
  assert.match(tagged,/<lang lang="zh-CN">。跑道洞九左。<\/lang>/);
  assert.equal(tagged.slice(PILOT_DELIVERY.length).replace(/<[^>]+>/g,''),text);
  for(const source of ['ALPHA ONE, BRAVO TWO，指挥台。','指挥台，F-16，Mach 0.85。','270 Alpha One，收到。','指挥台，收到。']){
    assert.equal(splitBilingualSpeech(source).map(p=>p.text).join(''),source);
    for(const part of splitBilingualSpeech(source))if(part.language==='en-US')assert.doesNotMatch(part.text,/[\u3400-\u9fff]/);
  }
});

test('文本不能插入额外语言或表演指令',()=>{
  const tagged=bilingualSpeechText('Alpha <lang lang="ja-JP">[shout]&收到');
  assert(!tagged.includes('[shout]'));assert.match(tagged,/&lt;/);assert.match(tagged,/&gt;/);assert.match(tagged,/&amp;/);
  assert(!tagged.includes('<lang lang="ja-JP">'));
});

test('两个男声均保持原音色，一次TTS-2请求生成整句，使用英语本地化与中英文标记',async t=>{
  const calls=[],audio=Buffer.from('ID3-continuous');
  const normalized='指挥台，GOLF TWO机位就绪，等待指令，BRAVO TWO。跑道洞九左。';
  const server=createGameServer(readConfig({INWORLD_API_KEY:'test',INWORLD_VOICE_PILOT_1:'same-alpha',INWORLD_VOICE_PILOT_2:'same-bravo',INWORLD_PILOT_EN_LOCALIZED:'true'}),{fetchImpl:async(_url,options)=>{
    calls.push(JSON.parse(options.body));return Response.json({audioContent:audio.toString('base64')});
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  for(const [unitId,voiceId]of [['blue-1','same-alpha'],['blue-2','same-bravo']]){
    const start=calls.length,response=await fetch(`http://127.0.0.1:${server.address().port}/api/voice/synthesize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speaker:'pilot',unitId,text:'指挥台，G2机位就绪，等待指令，BRAVO 02。跑道09L。',language:'zh-CN'})});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/mpeg');assert.deepEqual(Buffer.from(await response.arrayBuffer()),audio);
    assert.equal(calls.length-start,1);
    const body=calls.at(-1);assert.equal(body.voiceId,voiceId);assert.equal(body.modelId,'inworld-tts-2');assert.equal(body.language,'en-US');assert.equal(body.deliveryMode,'STABLE');
    assert.equal(body.audioConfig.audioEncoding,'MP3');assert.equal(body.audioConfig.speakingRate,1.08);assert.equal(body.text,bilingualSpeechText(normalized));
  }
});

test('单语、指挥员和未启用本地化继续Flash单次合成',async()=>{
  const calls=[];
  for(const localized of ['true','false']){
    const tts=createInworldTts(readTtsConfig({INWORLD_API_KEY:'test',INWORLD_PILOT_EN_LOCALIZED:localized}),async(_url,options)=>{
      calls.push(JSON.parse(options.body));return Response.json({audioContent:Buffer.from('ID3').toString('base64')});
    });
    const inputs=[{speaker:'pilot',unitId:'blue-1',text:'Alpha ONE, ROGER.',language:'en-US'},{speaker:'pilot',unitId:'blue-1',text:'收到，跑道09L外等待。',language:'zh-CN'},{speaker:'commander',text:'ALPHA 01，跑道09L外等待。',language:'zh-CN'}];
    if(localized==='false')inputs.push({speaker:'pilot',unitId:'blue-1',text:'ALPHA 01，收到。',language:'zh-CN'});
    for(const input of inputs){const start=calls.length;assert.equal((await tts.synthesizeAudio(input)).contentType,'audio/mpeg');assert.equal(calls.length-start,1);assert.equal(calls.at(-1).modelId,'inworld-tts-2-flash');assert(!calls.at(-1).text.includes('<lang'));}
  }
});

test('双语整句失败不重试分段，取消不发请求，标记后超长不调用上游',async()=>{
  let calls=0;
  const tts=createInworldTts(readTtsConfig({INWORLD_API_KEY:'test',INWORLD_PILOT_EN_LOCALIZED:'true'}),async()=>{calls++;return new Response('',{status:429});});
  const input={speaker:'pilot',unitId:'blue-1',text:'指挥台，BRAVO TWO，跑道09L，GOLF TWO，待命。',language:'zh-CN'};
  await assert.rejects(tts.synthesizeAudio(input),/额度/);assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(tts.synthesizeAudio(input,{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,1);
  await assert.rejects(tts.synthesizeAudio({...input,text:'字A'.repeat(200)}),error=>error.status===400);assert.equal(calls,1);
});
