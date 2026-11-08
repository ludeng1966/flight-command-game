import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {normalizeAviationSpeech as speech} from '../sim/aviation-speech.js';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {createRadioConsole} from '../game/radio-console.js';
const zh='zh-CN',en='en-US';
test('跑道编号逐位读，L/R/C转换方位，覆盖紧邻中文与大小写/空格',()=>{
  assert.equal(speech('指挥台，已到09L等待点，跑道外等待，ALPHA 01。',zh),'指挥台，已到洞九左等待点，跑道外等待，ALPHA ONE。');
  assert.equal(speech('09L、09R、27C、36R',zh),'洞九左、洞九右、两拐中、三六右');
  assert.equal(speech('RWY09l, RUNWAY 9R, 27 C.',en),'RUNWAY ZERO NINER LEFT, RUNWAY ZERO NINER RIGHT, TWO SEVEN CENTER.');
  assert.equal(speech('跑道9L，9R等待点，跑道09，27跑道。',zh),'跑道洞九左，洞九右等待点，跑道洞九，两拐跑道。');
  assert.equal(speech('起飞 / TAKEOFF，跑道09L，reduced_thrust',zh),'起飞，跑道洞九左，减推力起飞');
});
test('限制上下文，不把容量、机型、版本或其他标识符当跑道，不改高度速度',()=>{
  for(const source of ['F-16C','F16C','ABC09L','v0.09L','0.09L','燃油09L','容量09L','00L','37R','120L','高度6096米，速度180米每秒，目标333.33英尺'])assert.equal(speech(source,zh),source,source);
  assert.equal(speech('航向270度，高度6096米，真空速350节',zh),'航向两拐洞度，高度6096米，真空速350节');
  assert.equal(speech('HEADING 270, ALTITUDE 20000 FEET, SPEED 350 KNOTS',en),'HEADING TWO SEVEN ZERO, ALTITUDE 20000 FEET, SPEED 350 KNOTS');
});
test('呼号数字、地面代号和常见术语有明确读法，重复处理不会重复展开',()=>{
  assert.equal(speech('Alpha 01, Bravo 02.',zh),'Alpha ONE, Bravo TWO.');assert.equal(speech('Alpha 01, Bravo 02.',en),'Alpha ONE, Bravo TWO.');
  assert.equal(speech('沿A、A1滑行到G1机位。',zh),'沿ALFA、ALFA ONE滑行到GOLF ONE机位。');
  assert.equal(speech('TAXI VIA A, A1 TO STAND G2.',en),'TAXI VIA ALFA, ALFA ONE TO STAND GOLF TWO.');
  assert.equal(speech('ILS进近，DME测距，VOR，ATC。',zh),'仪表着陆系统进近，测距仪测距，甚高频全向信标，空中交通管制。');
  assert.equal(speech('ILS, DME, VOR, ATC, ATIS, IFR, VFR.',en),'I L S, D M E, V O R, A T C, A T I S, I F R, V F R.');
  for(const source of ['09L、27R，ALPHA 01。','RUNWAY 09L, VIA A1. ILS APPROACH.','沿A、A1滑行到G1机位。'])for(const lang of [zh,en]){const value=speech(source,lang);assert.equal(speech(value,lang),value);}
});

test('同句按字段选择读法：G1机位与ALPHA 01用英语，中文跑道09L保留洞九左',()=>{
  const source='指挥台，G1机位就绪，等待指令，ALPHA 01。准备滑行至09L跑道外等待。';
  assert.equal(speech(source,zh),'指挥台，GOLF ONE机位就绪，等待指令，ALPHA ONE。准备滑行至洞九左跑道外等待。');
  assert.equal(source,'指挥台，G1机位就绪，等待指令，ALPHA 01。准备滑行至09L跑道外等待。');
  assert.equal(speech('机位G2，BRAVO 02，航向009，跑道09L。',zh),'机位GOLF TWO，BRAVO TWO，航向洞洞九，跑道洞九左。');
  assert.equal(speech('GOLF 03, ALPHA 010, BRAVO 00, RUNWAY 09L.',en),'GOLF THREE, ALPHA ONE ZERO, BRAVO ZERO, RUNWAY ZERO NINER LEFT.');
});
test('云端最终请求使用规范读法与塔台男声，客户端不能覆盖服务端音色',async t=>{
  const requests=[],server=createGameServer(readConfig({INWORLD_API_KEY:'test-key',INWORLD_VOICE_COMMANDER:'commander',INWORLD_VOICE_PILOT_1:'pilot-one',INWORLD_VOICE_PILOT_2:'pilot-two'}),{fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({audioContent:Buffer.from('ID3-test').toString('base64')});}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${server.address().port}/api/voice/synthesize`;
  const source={speaker:'controller',text:'Alpha 01，09L跑道外等待。',language:zh,voiceId:'Ashley'};
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(source)});assert.equal(response.status,200);assert.equal(source.text,'Alpha 01，09L跑道外等待。');
  assert.equal(requests[0].text,'Alpha ONE，洞九左跑道外等待。');assert.equal(requests[0].voiceId,'Yichen');assert.equal(requests[0].modelId,'inworld-tts-2-flash');
  const config=readConfig({});assert.equal(config.tts.voices.controller,'Oliver');assert.equal(config.tts.voices.commander,'Dennis');
});
test('浏览器本地TTS也按术语播报，字幕与通联记录保留09L',async()=>{
  const world={time:0,units:[]},spoken=[],radio=createRadioConsole({getWorld:()=>world,provider:'browser',document:{querySelector:()=>null},Utterance:class{constructor(text){this.text=text;}},synth:{getVoices:()=>[{lang:zh,localService:true}],cancel(){},speak(u){spoken.push(u.text);queueMicrotask(()=>u.onend());}}});
  const text='指挥台，已到09L等待点，跑道外等待，ALPHA 01。';const result=await radio.transmit({speaker:'pilot',text});
  assert.equal(result.delivery,'spoken');assert.match(spoken[0],/洞九左等待点/);assert.doesNotMatch(spoken[0],/09L/);assert.equal(result.text,text);assert.equal(world.radioLog[0].text,text);
});
