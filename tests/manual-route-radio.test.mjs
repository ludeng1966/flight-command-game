import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualRouteRadio,manualRouteReadback} from '../game/manual-route-radio.js';
import {createRadioConsole} from '../game/radio-console.js';

function fixture(){
  const point=(n,z)=>Object.assign([n*10000,10000,z],{number:n});
  return {time:20,unitSystem:'imperial',units:[{id:'a',callsign:'ALPHA 01',radioNumber:'101',alive:true,routeRevision:1,waypoints:[point(1,6096),point(2,7620)]},{id:'b',callsign:'BRAVO 02',alive:true,routeRevision:1,waypoints:[point(1,6096)]}]};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('手动追加和拖动复诵实际改动的航点高度，兼容单位与双语通联',()=>{
  const world=fixture(),point=world.units[0].waypoints[1];
  const reply=manualRouteReadback(world,'a',{kind:'append',point},'pla','imperial');
  assert.match(reply.text,/幺洞幺/);assert.match(reply.text,/追加航点/);assert.match(reply.text,/航点2，目标高度25000英尺/);assert.match(reply.texts.en,/Waypoint 2, target altitude 25000 FEET/);
  const moved=manualRouteReadback(world,'a',{kind:'move',point},'nato','metric');assert.match(moved.text,/ALPHA 01/);assert.match(moved.text,/目标高度7620米/);
  world.units[0].waypoints=[];assert.match(manualRouteReadback(world,'a',{kind:'clear'}).text,/航路已清除，盘旋待命/);
});

test('快速编辑合并一次，等待正在进行的电台通话，两架飞机依次确认',async()=>{
  const world=fixture(),sent=[];let clock=0,busy=false,finish;
  const queue=new ManualRouteRadio({getState:()=>({world}),now:()=>clock,isBusy:()=>busy,radio:{phase(){},transmit(message){sent.push(message);return new Promise(resolve=>{finish=resolve;});}}});
  queue.enqueue('a',{kind:'append'});clock=200;world.units[0].routeRevision++;queue.enqueue('a',{kind:'move'});queue.enqueue('b',{kind:'append'});
  clock=549;queue.pump();await settle();assert.equal(sent.length,0);
  clock=600;busy=true;queue.pump();await settle();assert.equal(sent.length,0);
  busy=false;queue.pump();await settle();assert.equal(sent.length,1);assert.match(sent[0].text,/航点已调整/);queue.pump();assert.equal(sent.length,1);
  finish();await settle();queue.pump();await settle();assert.equal(sent.length,2);assert.equal(sent[1].unitId,'b');finish();await settle();
});

test('新命令、重开场景与取消不会播报过时航路，朗读期间可中断',async()=>{
  let world=fixture(),sent=0,signal;
  const queue=new ManualRouteRadio({getState:()=>({world}),settleMs:0,radio:{phase(){},transmit(_message,options){sent++;signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled'))));}}});
  queue.enqueue('a',{kind:'append'});world.units[0].routeRevision++;queue.pump();await settle();assert.equal(sent,0);
  queue.enqueue('a',{kind:'append'});world=fixture();queue.pump();await settle();assert.equal(sent,0);
  queue.enqueue('a',{kind:'move'});queue.pump();await settle();assert.equal(sent,1);queue.clear();assert(signal.aborted);assert.equal(queue.pending.size,0);await settle();
});

test('手动确认实际进入现有语音输出与通联日志，不依赖指挥模型',async()=>{
  const world=fixture(),spoken=[];
  const radio=createRadioConsole({getWorld:()=>world,document:{querySelector:()=>null},speech:{cancel(){},async speak(message){spoken.push(message);return 'spoken';}}});
  radio.configure({provider:'inworld',ready:true});
  const queue=new ManualRouteRadio({getState:()=>({world}),radio,settleMs:0});queue.enqueue('a',{kind:'replace'});queue.pump();await settle();
  assert.equal(spoken.length,1);assert.equal(spoken[0].speaker,'pilot');assert.equal(world.radioLog.length,1);assert.equal(world.radioLog[0].source,'manual-route');assert.equal(world.radioLog[0].delivery,'spoken');assert.match(world.radioLog[0].text,/重绘航路已接收/);
});
