import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {controlAuthority,requestHandoff} from '../sim/control-authority.js';
import {ControlHandoffRadio,transmitHandoff} from '../game/control-handoff.js';
import {runCommandSession} from '../game/command-session.js';
import {commandContext} from '../sim/orders.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const scenario=read('data/scenarios/demo.json'),profiles=read('data/aircraft.json');
const make=(mode='strict',spawnMode='stands')=>new World(scenario,profiles,null,{mode,spawnMode});
function depart(w){const u=w.units[0];w.airportCommand(u.id,{intent:'taxi',runway:'09L'});for(let i=0;i<600*60&&u.surface.phase!=='holding';i++)w.step(1/60);w.airportCommand(u.id,{intent:'line_up',runway:'09L'});for(let i=0;i<120*60&&u.surface.phase!=='lined_up';i++)w.step(1/60);w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});let sawAirborneBeforeReady=false;for(let i=0;i<200*60&&controlAuthority(w,u).phase!=='ready';i++){w.step(1/60);if(!u.surface.grounded&&u.position[2]<w.airportOps.airport.elevation+300){sawAirborneBeforeReady=true;assert.equal(controlAuthority(w,u).owner,'tower');assert.equal(controlAuthority(w,u).phase,'owned');}}assert(sawAirborneBeforeReady);assert.equal(controlAuthority(w,u).phase,'ready');return u;}
const settle=async bridge=>{for(let i=0;i<30&&bridge.active;i++)await new Promise(r=>setImmediate(r));assert.equal(bridge.active,false);};
const reply=(w,intent,parameters={})=>{const interpretation={version:'1.0',status:'understood',summary:'Alpha执行任务',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]};return {...compileMilitaryInterpretation(interpretation,commandContext(w,'blue-1')),interpretation};};
for(const mode of ['strict','relaxed'])test(`${mode}真实离场后交接：先四段通话，最后才改变管制方`,async()=>{
 const w=make(mode),u=depart(w),messages=[],pending=[];const radio={phase(){},transmit(m){messages.push(m);return new Promise(resolve=>pending.push(resolve));}};
 const bridge=new ControlHandoffRadio({getWorld:()=>w,radio,isBusy:()=>false});bridge.pump();
 if(mode==='strict'){assert.equal(messages.length,0);assert.equal(controlAuthority(w,u).owner,'tower');bridge.request(u.id);}
 assert.equal(messages.length,1);assert.equal(messages[0].speaker,'controller');
 for(let i=0;i<4;i++){assert.equal(controlAuthority(w,u).owner,'tower');assert.equal(controlAuthority(w,u).progress,i);pending.shift()();await new Promise(r=>setImmediate(r));}
 await settle(bridge);assert.deepEqual(messages.map(m=>m.speaker),['controller','pilot','pilot','commander']);assert.match(messages[1].text,/再见/);assert.equal(controlAuthority(w,u).owner,'commander');assert.equal(controlAuthority(w,u).history.at(-1).mode,mode==='strict'?'manual':'auto');assert.equal(controlAuthority(w,w.units[1]).owner,'tower');
});
test('指挥官AI核对地面任务后直接以塔台身份发令，不额外播报玩家转述',async()=>{
 const w=make(),heard=[],r=reply(w,'taxi',{runway:'09L',airportRef:'BAY',mode:'A,A1'});let received;
 await runCommandSession({world:w,reply:r,expectedRevision:w.revision,enforceAuthority:true,pause:async()=>{},radio:{phase(){},async transmit(m){heard.push(m);return {id:'radio-'+heard.length,speechText:m.text,speechLanguage:m.language};}},planPilotCommand:async({commanderMessage})=>{received=commanderMessage;assert.equal(w.units[0].surface.phase,'parked');return r;}});
 assert.equal(heard[0].label,'地面 · BAY');assert.match(heard[0].text,/BAY地面/);assert.equal(heard[0].speaker,'controller');assert.equal(heard.filter(m=>m.speaker==='controller').length,1);assert(!heard.some(m=>m.requestOnly||m.label==='玩家 → 塔台'));assert.equal(received.speaker,'controller');assert.match(received.text,/BAY地面/);assert.equal(w.units[0].surface.phase,'taxi');
});
test('严苛模式交接前不执行空中任务；请求后完成确认才允许巡航',async()=>{
 const w=make(),u=depart(w),before=w.revision,r=reply(w,'cruise',{altitudeM:6096,speedMps:180}),radio={phase(){},async transmit(){}};
 await assert.rejects(runCommandSession({world:w,reply:r,expectedRevision:w.revision,radio,enforceAuthority:true,pause:async()=>{}}),/请求交接/);assert.equal(w.revision,before);
 await transmitHandoff(w,u,radio);await runCommandSession({world:w,reply:r,expectedRevision:w.revision,radio,enforceAuthority:true,pause:async()=>{}});assert(w.revision>before);
});
test('严苛返场需手动请求；宽松返场自动完成反向交接，再由塔台安排进近',async()=>{
 for(const mode of ['strict','relaxed']){const w=make(mode,'airborne'),u=w.units[0],heard=[],radio={phase(){},async transmit(m){heard.push(m);}},r=reply(w,'approach',{airportRef:'BAY',runway:'09L'});
  if(mode==='strict'){await assert.rejects(runCommandSession({world:w,reply:r,expectedRevision:w.revision,radio,enforceAuthority:true,pause:async()=>{}}),/手动交接/);assert.equal(heard.length,0);requestHandoff(w,u,'tower');await transmitHandoff(w,u,radio);}
  await runCommandSession({world:w,reply:r,expectedRevision:w.revision,radio,enforceAuthority:true,pause:async()=>{}});assert.equal(controlAuthority(w,u).owner,'tower');assert.equal(u.surface.phase,'approach');assert.equal(heard[0].speaker,'commander');assert.equal(heard[3].speaker,'controller');assert.match(heard[1].text,/再见/);assert.equal(heard[4].speaker,'controller');assert.match(heard[4].text,/进近/);assert(!heard.some(m=>m.requestOnly));
 }
});
test('交接进度可保存恢复；未完成的最后确认不会提前授予控制权',async()=>{
 const w=make('relaxed'),u=depart(w),controller=new AbortController();let count=0;
 await assert.rejects(transmitHandoff(w,u,{phase(){},async transmit(){if(++count===3)controller.abort();}},{signal:controller.signal}),/交接已中止/);assert.equal(controlAuthority(w,u).progress,2);assert.equal(controlAuthority(w,u).owner,'tower');
 const state=decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(w))))),restored=restoreWorld(state,scenario,profiles,null),messages=[];
 await transmitHandoff(restored,restored.units[0],{phase(){},async transmit(m){messages.push(m);}});assert.equal(messages.length,2);assert.equal(controlAuthority(restored,restored.units[0]).owner,'commander');
});
test('仅设置宽松模式不会跳过教学的交接观察步骤',async()=>{
 const w=make('relaxed'),u=depart(w),messages=[],bridge=new ControlHandoffRadio({getWorld:()=>w,radio:{phase(){},async transmit(m){messages.push(m);}},isBusy:()=>false,allowAutomatic:()=>false});bridge.pump();assert.equal(messages.length,0);assert.equal(controlAuthority(w,u).owner,'tower');bridge.request(u.id);await settle(bridge);assert.equal(controlAuthority(w,u).owner,'commander');
});
