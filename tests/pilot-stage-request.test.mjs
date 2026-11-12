import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {AirportRadio,airportEventIsCurrent} from '../game/airport-radio.js';import {airportRadioProcedure} from '../sim/airport-radio-procedure.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';import {commandContext} from '../sim/orders.js';import {normalizeAviationSpeech} from '../sim/aviation-speech.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const flush=()=>new Promise(r=>setImmediate(r));const run=(w,seconds,until=()=>false)=>{for(let i=0;i<seconds*60&&!until();i++)w.step(1/60);};
function make(phase='holding',mode='strict'){
 const w=new World(scenario,profiles,null,{spawnMode:'stands',mode}),u=w.units[0],atc=w.airportOps.traffic,r=w.airportOps.runway('09L');atc.state.playerDirected=true;atc.state.guidanceMode=mode==='strict'?'player':'assisted';atc.state.radioRequired=true;
 u.position=phase==='final'?[r.x0-4000,r.y,320]:[...w.airportOps.airport.nodes[phase==='lined_up'?r.entry:r.hold]];u.velocity=phase==='final'?[100,0,-5.2]:[0,0,0];u.speed=phase==='final'?100:0;u.gearDown=true;
 u.surface={phase,runway:'09L',station:'tower',grounded:phase!=='final',route:[],node:phase==='lined_up'?r.entry:r.hold,heading:Math.PI/2,depart:phase!=='final',lineUp:phase!=='final',landingRequested:phase==='final',climbAltitude:1300};
 atc.request(u,phase==='final'?'arrival':'departure',w);w.airportOps.airport.events=[];return {w,u,atc,r};
}
function radio(w,transmit){const sent=[],bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(m,options){sent.push(m);await transmit?.(m,options);}}});return {sent,bridge};}
async function drain(bridge,n=12){for(let i=0;i<n;i++){bridge.pump();await flush();}}

test('等待点主动申请进入跑道：报告未播完不放行，批准后仍须许可播报及复诵',async()=>{
 const {w,u,atc}=make(),pending=[],{bridge,sent}=radio(w,(m)=>new Promise(resolve=>pending.push({m,resolve})));w.step(1/60);bridge.pump();assert.equal(sent[0].speaker,'pilot');assert.match(sent[0].texts.zh,/等待点.*请求进入跑道/);assert.match(sent[0].texts.en,/HOLDING SHORT.*REQUEST LINE UP AND WAIT/);
 atc.authorize(u,'line_up',w);run(w,5);assert.equal(u.surface.phase,'holding');assert(!atc.current(u,'line_up'));assert.equal(u.speed,0);pending.shift().resolve();await flush();run(w,.5);assert(atc.current(u,'line_up'));bridge.pump();assert.equal(sent.at(-1).speaker,'controller');assert.equal(u.surface.phase,'holding');pending.shift().resolve();await flush();assert(sent.at(-1).readback);run(w,2);assert.equal(u.surface.phase,'holding');pending.shift().resolve();await flush();assert(atc.permitted(u,'line_up'));run(w,100,()=>u.surface.phase==='lined_up');assert.equal(u.surface.phase,'lined_up');assert.equal(u.surface.pilotStageRequests.takeoff.status,'pending');
});
test('完成对正主动请求起飞，未批准保持停止；重复帧不重复申请',async()=>{
 const {w,u,atc}=make('lined_up'),{bridge,sent}=radio(w);run(w,10);await drain(bridge);assert.equal(u.surface.pilotStageRequests.takeoff.status,'reported');assert.equal(u.speed,0);assert(!atc.current(u,'takeoff'));assert.equal(sent.filter(m=>m.requestedClearance==='takeoff').length,1);assert.match(sent[0].texts.zh,/已对正.*请求起飞许可/);run(w,10);await drain(bridge);assert.equal(sent.filter(m=>m.requestedClearance==='takeoff').length,1);
 atc.authorize(u,'takeoff',w);run(w,.5);await drain(bridge);run(w,100,()=>!u.surface.grounded);assert(!u.surface.grounded);
});
test('宽松模式先听飞行员申请，再自动签发许可；未发送申请不自动放行',async()=>{
 const {w,u,atc}=make('lined_up','relaxed'),{bridge,sent}=radio(w);run(w,8);assert(!atc.current(u,'takeoff'));assert.equal(u.surface.phase,'lined_up');await drain(bridge);run(w,.5);await drain(bridge);assert(atc.permitted(u,'takeoff'));assert.deepEqual(sent.filter(m=>m.requestedClearance==='takeoff'||m.clearanceId).map(m=>m.speaker),['pilot','controller','pilot']);run(w,5);assert(u.speed>0);
});
test('最后进近主动申请着陆，继续飞行等待；没有语音许可到决断高度复飞',async()=>{
 const {w,u,atc}=make('final'),{bridge,sent}=radio(w),x=u.position[0];u.surface.playerAuthorizations={land:true};w.step(1/60);await drain(bridge);assert.match(sent[0].texts.zh,/最后进近.*请求着陆许可/);assert.match(sent[0].texts.en,/FINAL RUNWAY 09L, REQUEST LANDING CLEARANCE/);run(w,5);assert(u.position[0]>x+300);assert.equal(u.surface.phase,'final');assert(!atc.current(u,'land'));run(w,80,()=>u.surface.phase==='missed'||!u.alive);assert(u.alive);assert.equal(u.surface.phase,'missed');assert.equal(airportEventIsCurrent(w,w.airportOps.airport.events.find(e=>e.kind==='pilot_request'),u),false);
});
test('宽松着陆许可也在最后进近报告后签发，不在远端进近提前放行',async()=>{
 const {w,u,atc}=make('final','relaxed'),{bridge,sent}=radio(w);w.step(1/60);assert(!atc.current(u,'land'));await drain(bridge);run(w,.5);await drain(bridge);assert(atc.permitted(u,'land'));assert.deepEqual(sent.filter(m=>m.requestedClearance==='land'||m.clearanceId).map(m=>m.speaker),['pilot','controller','pilot']);run(w,120,()=>u.surface.grounded||!u.alive);assert(u.alive);assert(u.surface.grounded);
});
test('已有有效着陆许可只报告最后进近，不重复申请或否认已获许可',async()=>{
 const {w,u,atc}=make('final'),c=atc.issue(u,'land',{runway:'09L'},w);atc.acknowledge(c.id,c.parameters,w);w.step(1/60);const event=w.airportOps.airport.events.find(e=>e.kind==='pilot_request'),message=airportRadioProcedure(event,u,w.airportOps.airport);assert.match(message.texts.zh,/已获着陆许可/);assert.doesNotMatch(message.texts.en,/REQUEST/);assert.equal(message.speaker,'pilot');
});
test('待发申请读档后补发，已经报告的不重播；过期阶段不播放，快照供自然应答定位',async()=>{
 const {w,u}=make();w.step(1/60);const restored=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles),{bridge,sent}=radio(restored);await drain(bridge);assert.equal(sent.filter(m=>m.requestedClearance==='line_up').length,1);const requests=commandContext(restored,'blue-2').airportTraffic.pendingPilotRequests;assert.equal(requests.length,1);assert.equal(requests[0].unitId,u.id);assert.equal(requests[0].clearance,'line_up');
 const again=restoreWorld(decodeState(encodeState(captureWorld(restored))),scenario,profiles),next=radio(again);run(again,5);await drain(next.bridge);assert.equal(next.sent.filter(m=>m.requestedClearance==='line_up').length,0);
});
test('请求通联双语完整，跑道按术语读法处理，机场内部节点不送入播报',()=>{
 for(const phase of ['holding','lined_up','final']){const {w}=make(phase);w.step(1/60);const e=w.airportOps.airport.events.find(e=>e.kind==='pilot_request'),m=airportRadioProcedure(e,w.units[0],w.airportOps.airport);assert(!/[\u3400-\u9fff]/.test(m.texts.en));assert.doesNotMatch(JSON.stringify(m),/H09L|R09L|APRON/);assert.match(normalizeAviationSpeech(m.texts.zh,'zh-CN'),/洞九左/);assert.match(normalizeAviationSpeech(m.texts.en,'en-US'),/ZERO NINER LEFT/);}
});
test('返场任务已接收而着陆许可待申请，不误报装订失败或已经获准着陆',()=>{
 const w=new World(scenario,profiles),u=w.units[0];w.airportOps.traffic.state.guidanceMode='player';w.airportCommand(u.id,{intent:'land',runway:'09L',mode:'ils'});const plan={status:'accepted',summary:'返场着陆任务',tasks:[{unitId:u.id,action:'airport',airportOrder:{intent:'land',airportId:'BAY',runway:'09L',mode:'ils',taxiways:[],gate:null,altitudeM:null}}]},receipt=captureCommandResult(w),fact=inspectCommandResult(commandContext(w,u.id),plan,null,receipt)[0];assert.equal(fact.expectedVerdict,'executing');assert.equal(receipt.units[0].surface.landCleared,false);assert.equal(receipt.units[0].surface.landingRequested,true);
});
