import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {AirportRadio,airportEventIsCurrent} from '../game/airport-radio.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {createRadioConsole} from '../game/radio-console.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const create=()=>new World(scenario,profiles,null,{spawnMode:'stands'}),flush=()=>new Promise(r=>setImmediate(r));
const airborne=u=>{u.surface={phase:'airborne',grounded:false,route:[],heading:0};u.position[2]=6000;};
function harness(w){const sent=[],bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(m){sent.push(m);}}});return {sent,bridge};}

test('空中丢弃旧机位就绪，即使事件没有新阶段字段或尚未过期也不播报',async()=>{
  for(const age of [0,794]){
    const w=create();for(const u of w.units)airborne(u);w.time=age;
    for(const e of w.airportOps.airport.events){delete e.phase;delete e.grounded;}
    const {sent,bridge}=harness(w);bridge.pump();await flush();assert.equal(sent.length,0);assert.equal(bridge.cursor,w.airportOps.eventSequence);
  }
});

test('新场景仍播报实际机位就绪，旧机位或过期记录不会阻塞新有效事件',async()=>{
  const w=create();w.airportOps.park(w.units[0],'G3');w.airportOps.log(w.units[0],'G3机位就绪，等待指令',w.time);
  const {sent,bridge}=harness(w);for(let i=0;i<4;i++){bridge.pump();await flush();}
  assert.equal(sent.length,2);assert.ok(sent.some(m=>/机位G3/.test(m.text)));assert.ok(sent.some(m=>/机位G2/.test(m.text)));assert.ok(sent.every(m=>!/机位G1/.test(m.text)));
});

test('读档不会重播已保存的历史通联，读档后新产生的有效事件照常发送',async()=>{
  const original=create(),w=restoreWorld(decodeState(encodeState(captureWorld(original))),scenario,profiles),{sent,bridge}=harness(w);
  bridge.pump();await flush();assert.equal(sent.length,0);
  const u=w.units[0];w.airportOps.log(u,`${u.surface.node}机位就绪，等待指令`,w.time);bridge.pump();await flush();assert.equal(sent.length,1);assert.equal(sent[0].airportEventId,w.airportOps.eventSequence);
});

test('电台忙碌时飞机离地，恢复空闲后不会再读地面历史',async()=>{
  const w=create(),sent=[];let busy=true;const bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>busy,radio:{async transmit(m){sent.push(m);}}});
  bridge.pump();for(const u of w.units)airborne(u);busy=false;bridge.pump();await flush();assert.equal(sent.length,0);
});

test('阶段在语音生成或播放期间失效，取消该条机场播报',async()=>{
  const w=create();let signal;const bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{transmit(_m,options){signal=options.signal;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('旧机位通话','AbortError')),{once:true});});}}});
  bridge.pump();assert.equal(signal.aborted,false);airborne(w.units[0]);bridge.pump();assert.equal(signal.aborted,true);await flush();assert.equal(bridge.active,false);
});

test('机场许可与报告按真实阶段筛选，离地后的旧滑行/起飞许可不会重播',()=>{
  const w=create(),u=w.units[0];airborne(u);
  for(const text of ['G1机位就绪，等待指令','滑行许可：P1 → H09L，跑道外等待','起飞许可 09L','已到09L等待点，跑道外等待'])assert.equal(airportEventIsCurrent(w,{text,time:w.time},u),false,text);
  u.surface.phase='climb';assert.equal(airportEventIsCurrent(w,{text:'抬轮离地，爬升',time:w.time},u),true);
  u.surface.phase='final';u.surface.runway='09L';assert.equal(airportEventIsCurrent(w,{text:'着陆许可 09L',time:w.time},u),true);assert.equal(airportEventIsCurrent(w,{text:'着陆许可 27R',time:w.time},u),false);
});

test('切换到新场景重新播报新机位状态，不沿用上一世界的历史游标',async()=>{
  let w=restoreWorld(decodeState(encodeState(captureWorld(create()))),scenario,profiles);const sent=[];
  const bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(m){sent.push(m);}}});bridge.pump();await flush();assert.equal(sent.length,0);
  w=create();bridge.pump();await flush();assert.equal(sent.length,1);assert.match(sent[0].text,/机位G1/);
});

test('本地化完成前已取消的机场通话不会进入字幕和历史记录',async()=>{
  const w=create(),controller=new AbortController();
  const radio=createRadioConsole({getWorld:()=>w,document:{querySelector:()=>null},synth:null,Utterance:null,storage:null,speech:{cancel(){}}});
  const pending=radio.transmit({speaker:'pilot',unitId:w.units[0].id,text:'机位准备就绪',texts:{zh:'机位准备就绪',en:'STAND READY'}},{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(w.radioLog,undefined);
});
