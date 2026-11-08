import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {radioReadback} from '../sim/radio.js';
import {createCommandExchange} from '../sim/radio-procedure.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {englishResultReadback} from '../sim/result-language.js';
import {createCommanderTransmission} from '../sim/commander-message.js';
import {TRAINING_LEVELS} from '../sim/training-levels.js';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const scenario=read('data/scenarios/demo.json'),profiles=read('data/aircraft.json');
const plan={status:'accepted',tasks:[{unitId:'blue-1',action:'report_status'}]};
test('机位准备通联：真实机位与等待滑行，不把机场海拔和零空速当离场准备报告',()=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0],before=JSON.stringify(u),context=validateContext(commandContext(w,u.id));
  const direct=radioReadback(plan,w.units,'nato');assert.match(direct,/G1.*等待滑行/);assert.doesNotMatch(direct,/高度|空速/);
  assert.match(createCommandExchange(plan,w.units,'nato').commander.text,/REPORT POSITION AND GROUND STATUS/);
  const [fact]=inspectCommandResult(context,plan,null,captureCommandResult(w));assert.match(fact.requiredReadback,/机位G1.*等待滑行/);assert.equal(fact.modelFacts.observed.altitude,undefined);
  validateResultReadbacks({checks:[{unitId:u.id,verdict:'reported',readbackText:fact.requiredReadback+'，收到。'}]},[fact]);
  assert.throws(()=>validateResultReadbacks({checks:[{unitId:u.id,verdict:'reported',readbackText:fact.requiredReadback+'，高度333英尺。'}]},[fact]),/地面准备通联/);
  const english=englishResultReadback(fact,plan,context);assert.match(english,/STAND G1.*AWAITING TAXI/);assert.doesNotMatch(english,/altitude|airspeed/i);assert.equal(JSON.stringify(u),before);
});
test('跑道外、对正与起飞滑跑的状态不混用许可，空中报告仍保留实际飞行参数',()=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),u=w.units[0];
  for(const [phase,expected]of [['holding',/跑道09L外等待，准备离场/],['lined_up',/已对正，等待起飞许可/],['takeoff_roll',/起飞滑跑中/]]){
    u.surface={...u.surface,phase,runway:'09L'};assert.match(radioReadback(plan,w.units),expected);
  }
  u.surface.grounded=false;u.surface.phase='climb';u.position[2]=6096;u.speed=350*1852/3600;
  const [fact]=inspectCommandResult(commandContext(w,u.id),plan,null,captureCommandResult(w));assert.match(fact.requiredReadback,/高度6100米/);assert.match(englishResultReadback(fact,plan,commandContext(w,u.id)),/true airspeed/i);
});
test('零基础地面课程询问机位和准备情况，不布置停机位高度空速报告或起飞中额外报告',()=>{
  const first=TRAINING_LEVELS[0].missions;
  for(const s of first.filter(s=>['demo','report','bravo-report'].includes(s.id))){assert.match(s.text,/机位|地面准备/);assert.doesNotMatch(s.sample??'',/高度|速度/);}
  assert(!TRAINING_LEVELS[1].missions.some(s=>s.intent==='report_status'));
});


test('北约呼号在中文通话里仍叫Alpha和Bravo，不因语种变成另一套数字呼号',()=>{
 const w=new World(scenario,profiles,null,{spawnMode:'stands'}),reply={plan};
 const spoken=createCommanderTransmission(reply,w.units,'nato','imperial');assert.match(spoken.texts.zh,/ALPHA ZERO ONE/);assert.doesNotMatch(spoken.texts.zh,/幺洞幺/);assert.match(spoken.texts.en,/ALPHA ZERO ONE/);
});
