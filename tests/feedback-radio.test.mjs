import test from 'node:test';import assert from 'node:assert/strict';
import {RadarRadio} from '../game/radar-radio.js';
import {PilotExecutionRadio} from '../game/pilot-execution-radio.js';
const flush=()=>new Promise(r=>setImmediate(r));
function setup(){const unit={id:'a',callsign:'ALPHA',alive:true,radar:{events:[],sequence:0,phase:'search',mode:'pd'},pilotExecution:{id:'a:1'}};const world={time:0,units:[unit]},messages=[],radio=new RadarRadio({getWorld:()=>world,isBusy:()=>false,radio:{async transmit(m){messages.push(m);}}});return {world,unit,messages,radio};}
function add(s,type,text,time=s.world.time){const e={sequence:++s.unit.radar.sequence,type,text,time};s.unit.radar.events.push(e);return e;}
test('雷达合并过时的锁定/丢锁，优先播实际终态且丢弃过期搜索',async()=>{
  const s=setup();add(s,'search','搜索',0);s.world.time=20;const lock=add(s,'locked','已锁定');s.unit.radar.lastLockSequence=lock.sequence;
  const lost=add(s,'lost','雷达失锁');s.unit.radar.lastLostSequence=lost.sequence;s.unit.radar.phase='search';
  s.radio.pump();await flush();assert.equal(s.messages.length,1);assert.match(s.messages[0].text,/失锁/);s.radio.pump();await flush();assert.equal(s.messages.length,1);
});
test('攻击命中事实跨单位优先，旧攻击阶段不在终态后补播',async()=>{
  const s=setup();s.world.units.push({id:'b',callsign:'BRAVO',radar:{sequence:1,phase:'search',mode:'pd',events:[{sequence:1,time:0,type:'search',text:'BRAVO搜索'}]}});
  const e=add(s,'attack_hit','命中已确认');s.unit.attackTask={id:'attack-1',active:false,status:'completed',engagedTargetId:'target',flightResults:{m:{phase:'hit',hitTargetId:'target'}},events:[{sequence:1,time:0,type:'hit',text:e.text}]};
  s.radio.pump();await flush();assert.match(s.messages[0].text,/命中已确认/);assert.equal(s.messages[0].observedAt,0);
});
test('播报微任务开始前再次复核，已丢失的锁定不会被说成成功',async()=>{
  const s=setup(),e=add(s,'locked','已锁定');s.unit.radar.phase='locked';s.unit.radar.lastLockSequence=e.sequence;s.radio.pump();s.unit.radar.phase='search';await flush();assert.equal(s.messages.length,0);
});
test('旧任务的攻击命中不会移植到新任务或在TTL后播报',async()=>{
  const s=setup();add(s,'attack_hit','旧目标命中');s.unit.attackTask={id:'new',events:[],flightResults:{}};s.radio.pump();await flush();assert.equal(s.messages.length,0);
  add(s,'search','旧搜索',0);s.world.time=20;s.radio.pump();await flush();assert.equal(s.messages.length,0);
});
test('执行报告按本机合并，丢弃超龄和被后续修订替代的报告',async()=>{
  const s=setup(),r=new PilotExecutionRadio({getWorld:()=>s.world,isBusy:()=>false,radio:{async transmit(m){s.messages.push(m);}}});
  const report=(at,error)=>({world:s.world,unitId:'a',executionId:'a:1',simTime:at,cause:{issue:'route_blocked'},error});
  r.enqueue(report(0,'旧错误'));r.enqueue(report(1,'最新错误'));assert.equal(r.queue.length,1);s.world.time=2;r.pump();await flush();assert.match(s.messages[0].text,/最新错误/);
  r.enqueue(report(2,'已过时'));s.world.time=40;r.pump();await flush();assert.equal(s.messages.length,1);
  r.enqueue(report(39,'被新方案替代'));s.unit.pilotExecution.lastAppliedAt=40;r.pump();await flush();assert.equal(s.messages.length,1);
});
