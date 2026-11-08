import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {AirportRadio} from '../game/airport-radio.js';import {airportRadioProcedure} from '../sim/airport-radio-procedure.js';
import {localizeRadio,setLanguages} from '../game/language.js';import {createInworldTts,readTtsConfig} from '../server/inworld-tts.mjs';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));

test('塔台完整经过独立中英文、语音术语与中性男声选择，四种字幕语音组合均有效',async()=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0];w.airportOps.airport.events=[];w.time=7;u.surface.phase='takeoff_roll';u.surface.runway='09L';w.airportOps.log(u,'起飞许可 09L',w.time);
  const spoken=[],tts=createInworldTts(readTtsConfig({INWORLD_API_KEY:'test'}),async(_url,options)=>{spoken.push(JSON.parse(options.body));return Response.json({audioContent:Buffer.from('ID3-test').toString('base64')});});
  try{for(const text of ['zh','en'])for(const voice of ['zh','en']){
    setLanguages({text,voice});let displayed;
    const bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(message){displayed=await localizeRadio(message);await tts.synthesize({...displayed,text:displayed.speechText,language:displayed.speechLanguage});}}});
    bridge.pump();for(let i=0;i<20&&bridge.active;i++)await new Promise(r=>setImmediate(r));assert.equal(bridge.active,false);assert.equal(displayed.speaker,'controller');
    assert.equal(/[\u3400-\u9fff]/.test(displayed.text),text==='zh');assert.match(displayed.text,/09L/);
    const audio=spoken.at(-1);assert.equal(audio.voiceId,voice==='zh'?'Yichen':'Oliver');
    assert.match(audio.text,voice==='zh'?/跑道洞九左，可以起飞/:/RUNWAY ZERO NINER LEFT, CLEARED FOR TAKEOFF/);
    assert.doesNotMatch(audio.text,/09L/);assert.equal(displayed.speechLanguage,voice==='zh'?'zh-CN':'en-US');
  }}finally{setLanguages({text:'zh',voice:'zh',rate:1});}
});

test('滑行许可用实际滑行道和跑道，不将H09L或APRON等内部节点送给TTS',async()=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0];w.airportCommand(u.id,{intent:'taxi',runway:'09L'});
  const event=w.airportOps.airport.events.at(-1),message=airportRadioProcedure(event,u,w.airportOps.airport);
  assert.equal(message.speaker,'controller');assert.match(message.texts.zh,/滑行道P1/);assert.match(message.texts.en,/TAXIWAY P1/);
  assert.match(message.texts.en,/HOLD SHORT OF RUNWAY 09L/);assert.doesNotMatch(JSON.stringify(message),/APRON|H09L|R09L|→/);
  const {normalizeAviationSpeech}=await import('../sim/aviation-speech.js');
  for(const locale of ['zh','en']){const spoken=normalizeAviationSpeech(message.texts[locale],locale);assert.match(spoken,/PAPA ONE/);assert.doesNotMatch(spoken,/\bP1\b|09L/);}
});
