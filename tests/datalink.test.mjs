import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createDatalink,stepDatalinks,datalinkPath,datalinkContext,parseDatalinkContext,configureDatalink} from '../sim/datalink.js';
import {World} from '../sim/world.js';
import {captureWorld,restoreWorld} from '../sim/save-state.js';
import {commandContext} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {validateRadarOrder} from '../sim/radar.js';
import {communicationChannel} from '../sim/communication-channel.js';
import {createRadioConsole} from '../game/radio-console.js';

function unit(id,profile='f16',position=[0,0,6500],team='blue'){
  return {id,profileId:profile,team,callsign:id,alive:true,position,velocity:[0,200,0],datalink:createDatalink(profile,undefined,team),radar:{contacts:[]},weapons:{contacts:[]}};
}
const setup=()=>({time:0,units:[unit('a'),unit('b','f16',[10000,0,6500])],terrain:null});
function advance(w,seconds){for(let i=0;i<seconds*8;i++){w.time+=.125;stepDatalinks(w);}}
const contact=(time=0)=>({id:'TRACK-1',callsign:'unknown',classification:'unknown',observedAt:time,position:[0,30000,6000],velocity:[0,-200,0],binding:'hidden-id',alive:true,targetId:'hidden-id',uncertainty:{positionSigmaM:[120,150,200],velocitySigmaMps:[5,5,5]}});

test('time slots and latency delay independent reports, without copying hidden state',()=>{
  const w=setup();w.units[0].radar.contacts=[contact()];
  stepDatalinks(w);assert.equal(w.units[1].datalink.contacts.length,0);
  advance(w,.125);assert.equal(w.units[1].datalink.contacts.length,0);
  advance(w,.125);const shared=w.units[1].datalink.contacts.find(c=>c.kind==='track');
  assert(shared);assert.equal(shared.observedAt,0);assert.equal(shared.receivedAt,.25);assert.equal(shared.source,'datalink');
  for(const key of ['binding','targetId','alive','bank','inventory'])assert.equal(Object.hasOwn(shared,key),false);
  w.units[0].radar.contacts[0].position[0]=99999;assert.equal(shared.position[0],0);
  assert.equal(w.units[1].radar.contacts.length,0);assert.equal(w.units[1].weapons.contacts.length,0);
});

test('team, link family, network and training key must all match',()=>{
  for(const patch of [{team:'red'},{family:'eastern-training'},{networkId:'other'},{keyId:'other'}]){
    const w=setup();if(patch.team)w.units[1].team=patch.team;else Object.assign(w.units[1].datalink.config,patch);
    advance(w,3);assert.equal(w.units[1].datalink.received,0);
  }
  for(const p of ['f86','b7478','a320'])assert.equal(createDatalink(p).config.available,false);
  assert.equal(createDatalink('j11').config.family,createDatalink('su27').config.family);
});

test('receive-only terminal shares no PPLI; off clears received picture',()=>{
  const w=setup();configureDatalink(w,'b',{mode:'receive'});advance(w,3);
  assert(w.units[1].datalink.received>0);assert.equal(w.units[1].datalink.sent,0);assert.equal(w.units[0].datalink.received,0);
  configureDatalink(w,'b',{mode:'off'});assert.deepEqual(datalinkContext(w.units[1],w.time).contacts,[]);
});

test('range, radio horizon and actual terrain independently block LOS',()=>{
  const a=unit('a'),b=unit('b','f16',[190000,0,6500]);assert.equal(datalinkPath(a,b).reason,'range');
  a.position=[0,0,10];b.position=[100000,0,10];assert.equal(datalinkPath(a,b).reason,'horizon');
  a.position=[0,0,1000];b.position=[10000,0,1000];
  assert.equal(datalinkPath(a,b,{heightAt:x=>x>4000&&x<6000?1500:0}).reason,'terrain');
  assert.equal(datalinkPath(a,b,{heightAt:()=>0}).valid,true);
});

test('delivery rechecks path and terminal generation, so old packets cannot cross a changed net',()=>{
  for(const change of [w=>w.units[1].position=[300000,0,6500],w=>configureDatalink(w,'b',{networkId:'new'}),w=>w.units[0].alive=false]){
    const w=setup();stepDatalinks(w);change(w);advance(w,.25);assert.equal(w.units[1].datalink.received,0);
  }
});

test('old samples do not become fresh by retransmission; errors grow and tracks expire',()=>{
  const w=setup();w.units[0].radar.contacts=[contact()];advance(w,1);
  const early=datalinkContext(w.units[1],w.time).contacts.find(c=>c.kind==='track');assert(early);
  advance(w,5);const late=datalinkContext(w.units[1],w.time).contacts.find(c=>c.kind==='track');
  assert.equal(late.observedAt,0);assert.equal(late.quality,'coasting');assert(late.positionErrorM>early.positionErrorM);
  advance(w,7);assert(!datalinkContext(w.units[1],w.time).contacts.some(c=>c.kind==='track'));
});

test('no automatic relaying, no world-truth tracks, bounded bandwidth and receiver memory',()=>{
  const w=setup();w.units.push(unit('c','f16',[170000,0,6500]));w.units[1].position=[85000,0,6500];
  for(const u of w.units)u.datalink.config.rangeM=100000;
  w.units[0].radar.contacts=Array.from({length:200},(_,i)=>({...contact(),id:'T'+i}));advance(w,2);
  assert(w.units[1].datalink.contacts.filter(c=>c.sourceUnitId==='a'&&c.kind==='track').length<=8);
  assert(!w.units[2].datalink.contacts.some(c=>c.sourceUnitId==='a'));
  assert(w.units.every(u=>u.datalink.contacts.length<=128));
});

test('local track numbers are namespaced by reporting terminal',()=>{
  const w=setup();w.units.push(unit('c','f16',[2000,0,6500]));
  w.units[0].radar.contacts=[contact()];w.units[2].radar.contacts=[{...contact(),position:[10000,30000,6000]}];advance(w,2);
  const reports=w.units[1].datalink.contacts.filter(c=>c.kind==='track');assert.equal(reports.length,2);assert.notEqual(reports[0].id,reports[1].id);
});

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));
test('World, server context and reload preserve settings, but reacquire sensor observations',()=>{
  const w=new World(scenario,profiles);for(let i=0;i<180;i++)w.step(1/60);
  const u=w.units[1];assert(u.datalink.received>0);
  const context=validateContext(commandContext(w,u.id));assert(context.units[1].datalink.contacts.length>0);
  const restored=restoreWorld(captureWorld(w),scenario,profiles);assert.equal(restored.units[1].datalink.config.networkId,u.datalink.config.networkId);
  assert.deepEqual(restored.units[1].datalink.contacts,[]);assert.equal(restored.units[1].datalink.lastReceivedAt,null);
  for(let i=0;i<120;i++)restored.step(1/60);assert(restored.units[1].datalink.received>0);
  const sharedId=u.datalink.contacts[0].id;
  w.radarCommand(u.id,{operation:'mode',mode:'pd',targetId:null});
  assert.throws(()=>validateRadarOrder(w,u,{operation:'lock',mode:null,targetId:sharedId}),/航迹|无效|跟踪/);
});

test('context parser strips extra fields and cannot turn shared observations into fire control',()=>{
  const w=setup();w.units[0].radar.contacts=[contact()];advance(w,1);
  const view=datalinkContext(w.units[1],w.time);view.contacts[0].fireControl=true;view.contacts[0].binding='hidden';
  const parsed=parseDatalinkContext(view,w.time);assert.equal(parsed.contacts[0].fireControl,false);assert.equal(parsed.contacts[0].binding,undefined);
  assert(!JSON.stringify(view).includes('keyId'));
  view.contacts[0].observedAt=100;assert.throws(()=>parseDatalinkContext(view,w.time));
});

test('actual radar detection crosses the link while the receiving fighter radar remains off',()=>{
  const s={units:[{id:'a',callsign:'A',profile:'f16',position:[0,0,6500],heading:0,speed:220},
    {id:'b',callsign:'B',profile:'f16',position:[10000,0,6500],heading:0,speed:220},
    {id:'enemy',callsign:'RED',profile:'f16',team:'red',position:[0,30000,6500],heading:180,speed:220}]};
  const w=new World(s,profiles);w.radarCommand('a',{operation:'mode',mode:'pd',targetId:null});
  for(const u of w.units)u.headingTarget=Math.atan2(u.velocity[0],u.velocity[1]);
  for(let i=0;i<480;i++)w.step(1/60);
  const received=w.units[1].datalink.contacts.filter(c=>c.kind==='track'&&c.sourceUnitId==='a');
  assert(received.length>0);assert(received.every(c=>c.observedAt<c.receivedAt));assert.equal(w.units[1].radar.mode,'off');
  assert.equal(w.units[1].radar.contacts.length,0);assert.equal(w.units[2].datalink.contacts.length,0);
});
test('friendly self-reports preserve heading, airspeed, altitude and the shared tactical channel',()=>{
 const w=setup();w.units[0].velocity=[100,200,0];advance(w,1);const c=datalinkContext(w.units[1],w.time).contacts.find(c=>c.kind==='participant'&&c.sourceUnitId==='a');
 assert.ok(c);assert.ok(Math.abs(c.headingDeg-26.565)<.001);assert.equal(c.speedMps,224);assert.equal(c.altitudeM,6500);assert.equal(c.channelId,communicationChannel(w.units[0]));
 const parsed=parseDatalinkContext(datalinkContext(w.units[1],w.time),w.time);assert.equal(parsed.contacts.find(x=>x.id===c.id).headingDeg,c.headingDeg);
 const original=[...c.position];w.units[0].position=[90000,0,6500];assert.deepEqual(c.position,original);
});
test('voice records use the same terminal channel as tactical reports',async()=>{
 const w=setup(),radio=createRadioConsole({getWorld:()=>w,document:{querySelector:()=>null},provider:'browser',storage:null,
  Utterance:class{constructor(text){this.text=text;}},synth:{getVoices:()=>[{lang:'zh-CN',localService:true}],cancel(){},speak(u){queueMicrotask(()=>u.onend());}},speech:{cancel(){}}});
 const sent=radio.publish({unitId:'a',speaker:'pilot',text:'报告位置',texts:{zh:'报告位置',en:'POSITION REPORT'},language:'zh-CN'});assert.equal(sent.record.channelId,communicationChannel(w.units[0]));await sent.completion;
 configureDatalink(w,'a',{networkId:'new-net'});assert.equal(communicationChannel(w.units[0]),'new-net');
 radio.cancel();
});
