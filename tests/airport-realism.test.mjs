import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {commandContext} from '../sim/orders.js';import {parseAirportTraffic} from '../sim/atc-context.js';
import {applyAtcDecision} from '../sim/atc-decisions.js';import {clearanceMessage} from '../sim/atc-radio.js';import {AirportRadio} from '../game/airport-radio.js';
import {separationSeconds} from '../sim/airport-atc.js';import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {airportExitReady} from '../sim/control-authority.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const make=(spawnMode='stands')=>new World(scenario,profiles,null,{spawnMode});
const run=(w,seconds,until=()=>false)=>{for(let i=0;i<seconds*60&&!until();i++)w.step(1/60);};
const decision=(unitId,action,patch={})=>({unitId,action,runway:null,taxiways:[],headingDeg:null,altitudeM:null,speedMps:null,priority:0,approachType:null,reasonZh:'交通间隔，按新指令执行',reasonEn:'TRAFFIC SPACING, FOLLOW REVISED INSTRUCTIONS',...patch});

test('无线电发送和正确复诵前地面不移动，错误复诵不生效；无需玩家确认',async()=>{
 const w=make(),u=w.units[0],messages=[],bridge=new AirportRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(m){messages.push(m);}}});bridge.pump();await new Promise(r=>setImmediate(r));
 w.airportCommand(u.id,{intent:'taxi',runway:'09L'});const atc=w.airportOps.traffic,c=atc.current(u,'taxi'),origin=[...u.position];run(w,4);assert.deepEqual(u.position,origin);assert(!atc.acknowledge(c.id,{...c.parameters,runway:'27R'},w));
 for(let i=0;i<12&&!atc.permitted(u,'taxi');i++){bridge.pump();await new Promise(r=>setImmediate(r));}assert(atc.permitted(u,'taxi'));assert(messages.some(m=>m.readback));run(w,4);assert(u.speed>0);assert.equal(c.readbackErrors,1);
 for(const readback of [false,true]){const m=clearanceMessage(c,u,w.airportOps.airport,{readback});assert(!/[\u3400-\u9fff]/.test(m.texts.en));assert.match(m.texts.zh,/滑行|等待/);}
});
test('短五边没有租约也保护跑道，进离场和尾流采用不同间隔',()=>{
 const w=make(),[u,v]=w.units,r=w.airportOps.runway('09L');v.surface={phase:'final',runway:'09L',grounded:false,route:[]};v.position=[r.x0-1000,r.y,155];v.velocity=[100,0,-5];v.speed=100;
 assert(w.airportOps.occupied(r,w.units,u.id));assert(!w.airportOps.reserve(r,w.units,u.id));
 assert.equal(separationSeconds({category:'small_jet',operation:'departure'},u,'departure'),30);assert.equal(separationSeconds({category:'heavy',operation:'departure'},u,'departure'),120);assert.equal(separationSeconds({category:'small_jet',operation:'arrival'},u,'departure'),20);
});
test('迎面滑行实际制动、绕行，不相撞且两机均抵达目的节点',()=>{
 const w=make(),ops=w.airportOps,[u,v]=w.units,a=ops.airport;
 for(const [unit,from,to,heading]of [[u,'APRON','EAST',Math.PI/2],[v,'EAST','APRON',-Math.PI/2]]){unit.position=[...a.nodes[from]];unit.speed=0;unit.surface={grounded:true,phase:'taxi',runway:'09L',node:from,route:[to],destination:to,heading,taxiRequestedAt:0};}
 run(w,650,()=>w.units.some(u=>!u.alive)||w.units.every(u=>u.surface.phase==='parked'));assert(w.units.every(u=>u.alive));assert.equal(u.surface.node,'EAST');assert.equal(v.surface.node,'APRON');assert(w.units.every(u=>u.surface.phase==='parked'));
});
test('全场态势包含天气/路网/队列/质量/性能；模型等待和引导真正进入许可链',()=>{
 const w=make(),u=w.units[0];w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});run(w,8);applyAtcDecision(w,decision(u.id,'hold_ground'));run(w,6);assert.equal(u.speed,0);
 const snapshot=commandContext(w,u.id).airportTraffic;assert(parseAirportTraffic(snapshot,w.time,w.units.map(u=>u.id)));assert(snapshot.groundNetwork.edges.length);assert(snapshot.traffic[0].performance.groundRollM>0);assert(snapshot.traffic[0].storesMassKg>0);
 const air=make('airborne'),v=air.units[0];air.airportCommand(v.id,{intent:'land',runway:'09L'});applyAtcDecision(air,decision(v.id,'vector',{headingDeg:45,altitudeM:6500,speedMps:180}));const c=air.airportOps.traffic.current(v,'vector');assert(!v.surface.towerHold.vector);air.airportOps.traffic.acknowledge(c.id,c.parameters,air);assert(v.surface.towerHold.vector);
});
test('风、海压、跑道制动与挂载真实改变地速、指示高度和起降性能',()=>{
 const w=make('airborne'),u=w.units[0],ops=w.airportOps,r=ops.runway('09L'),dry=ops.performance(u,r,'arrival');w.setAirportWeather({runwayCondition:'wet',qnhHpa:990,windFromDeg:0,windSpeedMps:5,gustMps:5});run(w,1);
 assert(u.indicatedAltitudeM>u.position[2]+100);assert(Math.abs(u.groundVelocity[1]-u.velocity[1]+5)<.01);assert(ops.performance(u,r,'arrival').landingDistanceM>dry.landingDistanceM);w.setAltimeter(u.id,990);run(w,.1);assert(Math.abs(u.indicatedAltitudeM-u.position[2])<1);
 const mass=u.profile.mass;u.weapons.inventory.us_aim_120b--;run(w,.1);assert(u.profile.mass<mass-100);assert(u.profile.storesCd0>0);
 w.setAirportWeather({windFromDeg:270,windSpeedMps:12,gustMps:12});assert(!ops.performance(u,r,'departure').valid);
});
test('跑道关闭和风向改变触发实际取消、换跑道；通信失效停车并可恢复',()=>{
 const w=make(),u=w.units[0];w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});w.setAirportWeather({windFromDeg:270,windSpeedMps:10,gustMps:10});run(w,1);assert.match(u.surface.runway,/27/);assert(w.airportOps.traffic.state.clearances.some(c=>c.status==='cancelled'));
 run(w,8);w.declareAirportEmergency(u.id,'radio');run(w,8);assert.equal(u.speed,0);assert.equal(u.transponderCode,'7600');w.restoreAirportRadio(u.id);run(w,5);assert(!w.airportOps.traffic.state.communicationFailures.includes(u.id));
});
test('发动机失效实际失推，应急队列优先；过期模型决定拒绝装订',()=>{
 const w=make(),u=w.units[0];w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});w.declareAirportEmergency(u.id,'engine');run(w,1);assert.equal(u.profile.fuelThrustFactor,0);assert.equal(w.airportOps.traffic.state.requests.find(q=>q.id===u.surface.atcRequestId).priority,100);assert.throws(()=>applyAtcDecision(w,decision(u.id,'priority'),{requestId:'superseded'}),/已变化/);
});
test('ILS/RNAV/目视/头顶进近均从6500米实际接地脱离回机位',()=>{
 for(const mode of ['ils','rnav','visual','overhead']){const w=make('airborne'),u=w.units[0];w.airportCommand(u.id,{intent:'land',runway:'09L',mode});run(w,1300,()=>!u.alive||u.surface.phase==='parked');assert(u.alive,mode);assert.equal(u.surface.phase,'parked',mode);assert.equal(u.navReceiver.mode,mode);assert.equal(u.navReceiver.frequencyMHz!==null,mode==='ils');assert(w.airportOps.traffic.state.clearances.some(c=>c.type==='land'&&c.status==='completed'));}
});
test('单独进近请求不虚构着陆许可，最低标准以下自动复飞',()=>{
 const w=make('airborne'),u=w.units[0];w.airportCommand(u.id,{intent:'approach',runway:'09L',mode:'ils'});run(w,600,()=>u.surface.phase==='missed'||!u.alive);assert(u.alive);assert.equal(u.surface.phase,'missed');assert(!w.airportOps.traffic.state.clearances.some(c=>c.type==='land'));assert(u.surface.missedProcedure.id);
});
test('双机分批离场均存活，安全高度后实际建立长僚机编队',()=>{
 const w=make();for(const u of w.units)w.airportCommand(u.id,{intent:'takeoff',runway:'09L',mode:'section'});run(w,1400,()=>w.units.some(u=>!u.alive)||w.units.some(u=>u.surface.sectionJoined));assert(w.units.every(u=>u.alive));assert(w.units.every(u=>!u.surface.grounded));assert(w.units.some(u=>u.formation?.leaderId));
 const uses=w.airportOps.traffic.state.clearances.filter(c=>c.type==='takeoff'&&c.acknowledgedAt!=null);assert.equal(uses.length,2);assert(uses[1].acknowledgedAt>uses[0].acknowledgedAt+20);
});
test('双机返场先分离等待，再依次着陆，均到达不同机位',()=>{
 const w=make('airborne');for(const u of w.units)w.airportCommand(u.id,{intent:'land',runway:'09L',mode:'section'});run(w,2400,()=>w.units.some(u=>!u.alive)||w.units.every(u=>u.surface.phase==='parked'));assert(w.units.every(u=>u.alive));assert(w.units.every(u=>u.surface.phase==='parked'));assert.notEqual(w.units[0].surface.node,w.units[1].surface.node);
});
test('存档保留气象燃油许可，待复诵许可恢复发送而不提前移动',()=>{
 const w=make(),u=w.units[0];w.airportOps.traffic.state.radioRequired=true;w.airportCommand(u.id,{intent:'taxi',runway:'09L'});w.setAirportWeather({visibilityM:3000,runwayCondition:'wet'});const restored=restoreWorld(decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(w))))),scenario,profiles);assert.equal(restored.airportOps.airport.weather.visibilityM,3000);assert.equal(restored.units[0].fuel.massKg,u.fuel.massKg);assert(restored.airportOps.airport.events.some(e=>e.text==='恢复待确认许可'));const before=[...restored.units[0].position];run(restored,4);assert.deepEqual(restored.units[0].position,before);assert(!airportExitReady(restored,restored.units[0]));
});
