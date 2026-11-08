import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {pilotExecutionMessage} from '../sim/pilot-execution-message.js';
import {PilotExecutionRadio} from '../game/pilot-execution-radio.js';
import {PilotSupervisor} from '../game/pilot-supervisor.js';
import {beginPilotExecution,monitorPilotExecution} from '../sim/pilot-execution.js';
import {World} from '../sim/world.js';import {setLanguages} from '../game/language.js';import {createRadioConsole} from '../game/radio-console.js';
import {createInworldTts,readTtsConfig} from '../server/inworld-tts.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const unit={id:'blue-1',callsign:'ALPHA 01',pilotExecution:{id:'execution-1'}};
const report=world=>({world,unitId:unit.id,executionId:'execution-1',simTime:17,cause:{issue:'route_blocked'},
  applied:{throttle:.8555,afterburner:.2,speedMps:180,viaCount:2},
  plan:{routeReplanned:true,targetAltitudeM:8000,nextFix:{bearingDeg:90,altitudeM:7200}}});

test('自主改航报告包含真实原因、完整新方案、原任务和呼号，公英制均明确',()=>{
  const r=report(null),zh=pilotExecutionMessage(r,unit).texts.zh,en=pilotExecutionMessage(r,unit,'imperial').texts.en;
  assert.match(zh,/原航路受阻/);assert.match(zh,/85.55%/);assert.match(zh,/加力上限20%/);assert.match(zh,/真空速648公里每小时/);
  assert.match(zh,/2个中间航点/);assert.match(zh,/方位090度，高度7200米/);assert.match(zh,/目标高度8000米，ALPHA 01/);
  assert.match(en,/UNABLE PREVIOUS ROUTE/);assert.match(en,/350 KNOTS/);assert.match(en,/ASSIGNED ALTITUDE 26250 FEET/);assert.doesNotMatch(en,/[\u3400-\u9fff]/);
  const recovery=report(null);recovery.cause={issue:'energy_shortfall',urgent:true};recovery.applied.recovery={flightPathDeg:-10,bankDeg:5,unloadG:.4};
  assert.match(pilotExecutionMessage(recovery,unit).texts.zh,/低速，能量不足.*目标航迹-10度.*坡度5度.*卸载上限0.4G.*恢复后继续原任务/);
});

test('四种文字与语音语言组合都进入真正无线电记录及统一TTS术语层，无需临时翻译',async()=>{
  const spoken=[],tts=createInworldTts(readTtsConfig({INWORLD_API_KEY:'test'}),async(_url,options)=>{spoken.push(JSON.parse(options.body));return Response.json({audioContent:Buffer.from('ID3-test').toString('base64')});});
  const world={time:30,units:[unit],unitSystem:'metric'},console=createRadioConsole({getWorld:()=>world,document:{querySelector:()=>null},speech:{cancel(){},async speak(message){
    await tts.synthesize({...message,text:message.speechText,language:message.speechLanguage});return 'spoken';
  }}}),bridge=new PilotExecutionRadio({getWorld:()=>world,radio:console,isBusy:()=>false});
  try{for(const text of ['zh','en'])for(const voice of ['zh','en']){
    setLanguages({text,voice});bridge.enqueue(report(world));bridge.pump();for(let i=0;i<20&&bridge.active;i++)await flush();
    assert.equal(bridge.active,false);const log=world.radioLog.at(-1),audio=spoken.at(-1);
    assert.equal(log.speaker,'pilot');assert.equal(log.time,17);assert.equal(log.delivery,'spoken');assert.equal(/[\u3400-\u9fff]/.test(log.text),text==='zh');
    assert.equal(log.speechLanguage,voice==='zh'?'zh-CN':'en-US');assert.match(log.text,text==='zh'?/原航路受阻/:/UNABLE PREVIOUS ROUTE/);
    assert.match(audio.text,voice==='zh'?/方位洞九洞/:/BEARING ZERO NINER ZERO/);assert.match(audio.text,voice==='zh'?/推力上限调整至85.55%/:/THRUST LIMIT REVISED TO 85.55 PERCENT/);
    if(voice==='en')assert.doesNotMatch(audio.text,/[\u3400-\u9fff]/);
  }}finally{setLanguages({text:'zh',voice:'zh',rate:1});}
});

test('等待频道时保存当时的原因与方案；串行报告且丢弃新指令覆盖的旧报告',async()=>{
  const world={time:30,units:[structuredClone(unit)]},messages=[];let busy=true,resolve;
  const bridge=new PilotExecutionRadio({getWorld:()=>world,isBusy:()=>busy,radio:{transmit(m){messages.push(m);return new Promise(r=>resolve=r);}}});
  const first=report(world);bridge.enqueue(first);first.cause.issue='energy_shortfall';first.applied.throttle=.1;first.plan.targetAltitudeM=15000;
  bridge.pump();assert.equal(messages.length,0);busy=false;bridge.pump();bridge.pump();await flush();assert.equal(messages.length,1);
  assert.match(messages[0].text,/原航路受阻.*85.55%.*目标高度8000米/);resolve();await flush();
  bridge.enqueue(report(world));world.units[0].pilotExecution.id='manual-new-order';bridge.pump();assert.equal(messages.length,1);assert.equal(bridge.queue.length,0);
});

test('校验失败也主动用UNABLE报告原因和重新规划，不在英文语音中夹带中文错误',()=>{
  const r={...report(null),applied:null,error:'修订推力不足以维持本段飞行'};r.cause.issue='energy_shortfall';
  const message=pilotExecutionMessage(r,unit);assert.match(message.texts.zh,/能量不足.*无法执行.*继续重新规划/);
  assert.match(message.texts.en,/INSUFFICIENT ENERGY.*UNABLE REVISED PLAN.*INSUFFICIENT THRUST.*REPLANNING/);assert.doesNotMatch(message.texts.en,/[\u3400-\u9fff]/);
});

test('飞行状态触发实际装订后，监督器将装订前原因与装订后新方案一并送入无线电',async()=>{
  const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),world=new World(scenario,profiles),u=world.units[0],messages=[];
  u.holdAltitude=8000;u.headingTarget=0;beginPilotExecution(world,u);u.requiredThrustN=1e6;monitorPilotExecution(world,u);world.time=25;monitorPilotExecution(world,u);
  const radio=new PilotExecutionRadio({getWorld:()=>world,isBusy:()=>false,radio:{async transmit(message){messages.push(message);}}});
  const watch=new PilotSupervisor({getWorld:()=>world,onReport:r=>radio.enqueue(r),fetchImpl:async(_url,options)=>{const b=JSON.parse(options.body);return {ok:true,json:async()=>({requestId:b.requestId,revision:b.context.revision,simTimeSec:b.context.simTimeSec,modelInvoked:true,
    assessment:{decision:'adjust_plan',message:'模型未验证的自由叙述',missingData:[],adjustment:{throttle:.95,afterburner:0,speedMps:185,via:[]}}})};}});
  watch.tick();await flush();assert.equal(u.pilotExecution.issue,null);radio.pump();await flush();
  assert.equal(messages.length,1);assert.match(messages[0].text,/能量不足.*95%.*暂用真空速666公里每小时.*目标高度8000米/);
  assert.doesNotMatch(messages[0].text,/模型未验证/);watch.stop();
});
