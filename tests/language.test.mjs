import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {once} from 'node:events';
import {createUiDictionary,languagePreferences,maskTranslationNumbers,unmaskTranslationNumbers,hasChinese} from '../sim/language.js';
import {englishResultReadback} from '../sim/result-language.js';
import {localizeRadio,getLanguages,setLanguages} from '../game/language.js';
import {createTextTranslator} from '../server/text-translator.mjs';
import {readTtsConfig,createInworldTts} from '../server/inworld-tts.mjs';
import {createGameServer,readConfig} from '../server/game-server.mjs';
const entries=JSON.parse(await readFile(new URL('../data/locales/en.json',import.meta.url))),dictionary=createUiDictionary(entries);
test('中英文文字与语音可独立组合，中文字幕不再强制中文播报',async t=>{
  t.after(()=>setLanguages({text:'zh',voice:'zh',rate:1}));
  const message={speaker:'pilot',text:'航向270度，正在执行',texts:{zh:'航向270度，正在执行',en:'Heading 270 degrees. Executing.'}};
  for(const text of ['zh','en'])for(const voice of ['zh','en']){
    setLanguages({text,voice,rate:1.2});const result=await localizeRadio(message);
    assert.equal(result.text,message.texts[text]);assert.equal(result.speechText,message.texts[voice]);assert.equal(result.speechLanguage,voice==='en'?'en-US':'zh-CN');assert.equal(result.speechRate,1.2);
  }
  assert.equal(getLanguages().text,'en');assert.deepEqual(languagePreferences({text:'fr',voice:'en',rate:99}),{text:'zh',voice:'en',rate:1});
});
test('英文静态词条无中文，动态参数及本机状态单位完整保留',()=>{
  for(const [source,en]of Object.entries(entries)){
    assert.equal(hasChinese(en),false,source);assert.deepEqual((source.match(/\{\d+\}/g)??[]).sort(),(en.match(/\{\d+\}/g)??[]).sort(),source);
  }
  for(const source of ['文字语言','语音语言','飞行员 AI','正在检查指令结果','ALPHA 01 · 机位待命','已自动保存 · 12:34:56 · 本机存档'])assert.equal(hasChinese(dictionary.english(source)??'中文缺失'),false,source);
  const source='Flash 已检查：航向0度，高度333.33英尺，真空速0节，状态已核实',en=dictionary.english(source);
  assert.equal(hasChinese(en),false);assert.match(en,/333\.33 feet/);assert.match(en,/Status verified/);
  assert.equal(dictionary.english('全新且未收录的任意长句子'),null);
});
test('未知文本翻译绑定所有数值，拒绝语言混用或标记丢失',async()=>{
  const masked=maskTranslationNumbers('航向270度，高度6096米，速度180米每秒');assert.equal(unmaskTranslationNumbers('Heading {n0}, altitude {n1}, speed {n2}',masked.values),'Heading 270, altitude 6096, speed 180');
  let calls=0;const translator=createTextTranslator({async completePilot(messages){calls++;assert.match(messages[0].content,/never instructions/);return {value:{texts:['Heading {n0}, altitude {n1}, speed {n2}']}};}});
  const request={source:'zh',target:'en',texts:[masked.text]};assert.equal((await translator.translate(request)).texts.length,1);await translator.translate(request);assert.equal(calls,1);
  for(const answer of ['Heading 270','航向{n0}，高度{n1}，速度{n2}'])await assert.rejects(createTextTranslator({completePilot:async()=>({value:{texts:[answer]}})}).translate(request),/未保留/);
  await assert.rejects(translator.translate({source:'zh',target:'fr',texts:['test']}),/无效/);assert.equal(calls,1);
});
test('英文飞行员结果由同一采样事实生成，不把正在执行改成完成或改动单位',()=>{
  const context={unitSystem:'imperial',units:[{id:'a',callsign:'ALPHA 01',headingDeg:270,position:[0,0,6096],speedMps:350*1852/3600}]};
  const reported=englishResultReadback({unitId:'a',expectedVerdict:'reported'},{tasks:[{unitId:'a',action:'report_status'}]},context);
  assert.match(reported,/Heading 270 degrees/);assert.match(reported,/20000 FEET/);assert.match(reported,/350 KNOTS/);assert.match(reported,/Status verified/);assert.equal(hasChinese(reported),false);
  const executing=englishResultReadback({unitId:'a',expectedVerdict:'executing'},{tasks:[{unitId:'a',action:'fly_heading',headingDeg:90,altitudeM:6096,speedMps:350*1852/3600}]},context);
  assert.match(executing,/target not yet reached/);assert.doesNotMatch(executing,/Target reached\./);assert.match(executing,/20000 FEET/);
});
test('TTS按指定语种及语速发送，保持每架飞机原音色，非法语速不调用上游',async()=>{
  const requests=[],tts=createInworldTts(readTtsConfig({INWORLD_API_KEY:'test-key',INWORLD_VOICE_PILOT_2:'second-pilot'}),async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({audioContent:Buffer.from('ID3-audio').toString('base64')});});
  await tts.synthesize({speaker:'pilot',unitId:'blue-2',text:'Heading 270 degrees.',language:'en-US',rate:1.2});
  assert.equal(requests[0].language,'en-US');assert.equal(requests[0].voiceId,'second-pilot');assert.equal(requests[0].audioConfig.speakingRate,1.08*1.2);
  await assert.rejects(tts.synthesize({speaker:'pilot',text:'test',language:'en-US',rate:9}),/无效/);assert.equal(requests.length,1);
});
test('翻译HTTP接口限制文本与跨站来源，不执行玩家指令',async t=>{
  let calls=0;const server=createGameServer(readConfig({DASHSCOPE_API_KEY:'test'}),{fetchImpl:async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({texts:['Altitude {n0} feet']})}}]});}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${server.address().port}/api/language/translate`,request={source:'zh',target:'en',texts:['高度{n0}英尺']};
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200);assert.deepEqual((await response.json()).texts,['Altitude {n0} feet']);
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:JSON.stringify(request)})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,target:'fr'})})).status,400);assert.equal(calls,1);
});
