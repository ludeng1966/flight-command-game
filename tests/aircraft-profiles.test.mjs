import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {aeroAt,atmosphere,thrustAt,hasAfterburner,stepFlight} from '../sim/flight.js';
import {energyEnvelope} from '../sim/energy.js';
import {performanceAt} from '../sim/performance.js';
import {runJob} from '../sim/planner-worker.js';
import {plannerUnit} from '../game/planner-client.js';
import {captureWorld,restoreWorld} from '../sim/save-state.js';
import {AutoSave} from '../game/autosave.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));
function worldFor(id){const s=structuredClone(scenario);delete s.airport;s.units=s.units.slice(0,1);Object.assign(s.units[0],{profile:id,position:[0,0,8000],heading:0,speed:230});return new World(s,profiles);}

test('战雷F-16与J-11采用各自源数据，J-11两台发动机只累计一次',()=>{
  assert.equal(profiles.f16.engineCount,1);assert.equal(profiles.j11.engineCount,2);assert.equal(profiles.j11.emptyMassKg,16900);
  assert(Math.abs(profiles.f16.area-27.9)<1e-8);assert(Math.abs(profiles.j11.area-61.98)<1e-8);
  assert.equal(profiles.f16.clMax,1.7);assert.equal(profiles.j11.clMax,1.55);assert.equal(profiles.j11.provenance.sourceFile,'gamedata/flightmodels/fm/j_11.blkx');
  for(const p of [profiles.f16,profiles.j11]){
    assert.match(p.provenance.sha256,/^[0-9a-f]{64}$/);assert(hasAfterburner(p));
    for(const h of [0,6000,12000])for(const v of [100,200,350])assert(thrustAt(p,h,v,1)>thrustAt(p,h,v));
    for(const m of [.85,1,1.1,1.4]){const v=m*atmosphere(6500).soundSpeed,a=aeroAt(p,6500,v-.0001),b=aeroAt(p,6500,v+.0001);assert(Math.abs(a.cd0-b.cd0)<.0001);}
  }
  assert(thrustAt(profiles.j11,0,0)>130000&&thrustAt(profiles.j11,0,0)<180000);
});

test('客机按独立质量与极线维持参考巡航，无加力且襟翼影响实际升力',()=>{
  for(const id of ['a320','b7478']){
    const p=profiles[id],v=p.cruise.mach*atmosphere(p.cruise.altitudeM).soundSpeed,perf=performanceAt(p,{altitudeM:p.cruise.altitudeM,speedMps:v,afterburner:1});
    assert(perf.levelSustainable);assert(p.mass>60000);assert.equal(perf.afterburner,0);assert.equal(hasAfterburner(p),false);
    assert.equal(thrustAt(p,0,0,1),thrustAt(p,0,0,0));assert.equal(p.maxG,2.5);
    assert(aeroAt(p,0,80,{flaps:'landing'}).clMax>aeroAt(p,0,80).clMax);
    assert(performanceAt(p,{altitudeM:100,speedMps:80,flaps:'landing'}).stallSpeedMps<performanceAt(p,{altitudeM:100,speedMps:80}).stallSpeedMps);
  }
  assert.equal(profiles.a320.area,122.4);assert.equal(profiles.a320.spanM,34.1);assert.equal(profiles.b7478.engineCount,4);
});

test('更换机型同时切换物理配置和碰撞尺度，保持真实运动状态并拒绝旧机型预案',()=>{
  const w=worldFor('f16'),u=w.units[0],point=[0,20000,8000],plan=runJob({type:'plan',unit:plannerUnit(u,true),route:[point]},null),position=[...u.position],velocity=[...u.velocity];
  w.setAircraftType(u.id,'b7478');assert.equal(u.profileId,'b7478');assert.equal(u.profile.area,554);assert.equal(u.visualModel,'b7478');assert(u.fuel.capacityKg>180000);assert.equal(Object.keys(u.weapons.inventory).length,0);
  assert.deepEqual(u.position,position);assert.deepEqual(u.velocity,velocity);assert.throws(()=>w.resolvePlan(u,[point],plan),/机型已变化/);
  const s=structuredClone(scenario);delete s.airport;s.units=s.units.slice(0,1);Object.assign(s.units[0],{profile:'f16',position:[0,0,8000],heading:0,speed:230});
  const restored=restoreWorld(captureWorld(w),s,profiles).units[0];assert.equal(restored.profileId,'b7478');assert.equal(restored.profile.mass,u.profile.mass);assert.equal(restored.profile.area,554);
});

test('客机转向受30度坡度限制，物理积分也不能被高G指令绕过',()=>{
  for(const id of ['a320','b7478']){
    const w=worldFor(id),u=w.units[0];u.headingTarget=Math.PI;let peak=0;
    for(let i=0;i<75*60;i++){w.step(1/60);peak=Math.max(peak,Math.abs(u.bank));assert(!u.stalled);assert(u.loadFactor<=2.5+1e-8);assert.equal(u.afterburner,0);}
    assert(peak<=Math.PI/6+1e-6);assert(peak>.4);
    u.cl=10;u.control={bank:0,cl:100,maxG:9,throttle:1,afterburner:1};stepFlight(u,1/60);assert(u.loadFactor<=2.5+1e-8);
  }
});

test('J-11与747按独立气动连续通过转弯爬升航点',()=>{
  for(const id of ['j11','b7478']){
    const w=worldFor(id),u=w.units[0],route=[[0,30000,8500],[18000,65000,9000]],plan=runJob({type:'plan',unit:plannerUnit(u,true),route},null);
    assert(plan.valid,plan.reason);w.replaceRoute(u.id,route,{prepared:plan});
    for(let i=0;i<600*60&&u.completedWaypoints<2;i++){w.step(1/60);assert(u.alive);assert(!u.stalled);}
    assert.equal(u.completedWaypoints,2);assert.equal(u.flightState,'normal');
  }
});

test('只迁移明确登记的旧气动存档指纹，新存档写入当前版本',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const old=new AutoSave({storage,fingerprint:'old',capture:()=>({world:{revision:1}}),restore(){}});old.load();old.save();
  let restored=false;const next=new AutoSave({storage,fingerprint:'current',compatibleFingerprints:['old'],capture:()=>({world:{revision:2}}),restore(){restored=true;}});
  assert(next.load().restored);assert(restored);next.save();assert([...values.values()].some(v=>JSON.parse(v).fingerprint==='current'));
});

test('旧外观专用存档迁移为对应机型，已坠毁的飞机仍可恢复且不会复活',()=>{
  for(const alive of [true,false]){
    const w=worldFor('f16'),u=w.units[0];u.visualModel='a320';u.alive=alive;if(!alive){u.velocity=[0,0,0];u.speed=0;u.flightState='crashed';}
    const saved=captureWorld(w);delete saved.units[0].aircraftTypeVersion;const before=structuredClone({position:u.position,velocity:u.velocity});
    const s=structuredClone(scenario);delete s.airport;s.units=s.units.slice(0,1);Object.assign(s.units[0],{profile:'f16',position:[0,0,8000],heading:0,speed:230});
    const restored=restoreWorld(saved,s,profiles).units[0];assert.equal(restored.profileId,'a320');assert.equal(restored.profile.area,122.4);assert.equal(restored.alive,alive);assert.deepEqual({position:restored.position,velocity:restored.velocity},before);
  }
});
