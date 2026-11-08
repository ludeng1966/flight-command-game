import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {AIRCRAFT_MODELS,aircraftModelId} from '../three3d/aircraft-catalog.js';
import {loadAircraftModels,buildAircraft,disposeAircraft} from '../three3d/aircraft.js';
import {World} from '../sim/world.js';
import {captureWorld,restoreWorld} from '../sim/save-state.js';

await loadAircraftModels(async url=>({ok:true,json:async()=>JSON.parse(await fs.readFile(url,'utf8'))}));

test('四套公开外形保持米制比例，减面后机长翼展误差低于0.5%',async()=>{
  for(const [id,spec]of Object.entries(AIRCRAFT_MODELS)){
    const data=JSON.parse(await fs.readFile(new URL('../assets/aircraft/'+spec.asset+'.json',import.meta.url)));
    assert(data.triangles<data.sourceTriangles*.75);assert(data.triangles<18000);
    for(const [axis,target]of [[0,spec.wingspanM],[1,spec.heightM],[2,spec.lengthM]])assert(Math.abs(data.bounds.size[axis]/target-1)<.005,id+' axis '+axis);
    assert(data.groups.every(g=>g.positions.every(Number.isFinite)&&g.indices.every(i=>i>=0&&i<g.positions.length/3)));
  }
  assert(AIRCRAFT_MODELS.b7478.lengthM/AIRCRAFT_MODELS.f16.lengthM>5);
  assert.equal(AIRCRAFT_MODELS.j11.asset,AIRCRAFT_MODELS.su27.asset);
});

test('地图与缩略图共享几何但不共享材质，销毁缩略图不会销毁缓存',()=>{
  const first=buildAircraft('#5bff8a','f16'),second=buildAircraft('#6fe3ff','f16');
  const geometries=root=>{const out=[];root.traverse(o=>{if(o.userData.sharedGeometry)out.push(o.geometry);});return out;};
  assert.equal(geometries(first)[0],geometries(second)[0]);assert.notEqual(first.userData.materials[0],second.userData.materials[0]);
  let disposed=0;geometries(first)[0].addEventListener('dispose',()=>disposed++);disposeAircraft(first);assert.equal(disposed,0);
  assert.equal(buildAircraft('#fff','su27').userData.flame.children.length,2);
  for(const id of ['b7478','a320']){const model=buildAircraft('#fff',id);assert.equal(model.userData.flame.children.length,0);assert.equal(model.userData.gear.visible,false);}
});

test('外观选择随现有进度保存恢复，不改变气动参数、位置和速度',async()=>{
  const scenario=JSON.parse(await fs.readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await fs.readFile(new URL('../data/aircraft.json',import.meta.url)));
  const world=new World(scenario,profiles),u=world.units[0],before=structuredClone({profile:u.profile,position:u.position,velocity:u.velocity});
  u.visualModel='b7478';world.units[1].visualModel='j11';const restored=restoreWorld(captureWorld(world),scenario,profiles);
  assert.equal(aircraftModelId(restored.units[0]),'b7478');assert.equal(aircraftModelId(restored.units[1]),'j11');
  assert.deepEqual({profile:u.profile,position:u.position,velocity:u.velocity},before);
});
