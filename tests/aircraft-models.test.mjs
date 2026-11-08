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

test('实际座舱朝 -Z、垂尾位于 +Z，喷焰留在机尾一侧',async()=>{
  for(const [id,spec]of Object.entries(AIRCRAFT_MODELS)){
    const data=JSON.parse(await fs.readFile(new URL('../assets/aircraft/'+spec.asset+'.json',import.meta.url)));
    // Inspect physical landmarks, not the forward metadata: a reversed mesh can still claim -Z.
    const body=data.groups.filter(g=>!g.gear).flatMap(g=>Array.from({length:g.positions.length/3},(_,i)=>g.positions.slice(i*3,i*3+3)));
    const glass=data.groups.filter(g=>g.material==='glass').flatMap(g=>g.positions.filter((_,i)=>i%3===2));
    const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
    assert(glass.length>0);assert(mean(glass)<-spec.lengthM*.05,id+' cockpit ahead');
    const top=Math.max(...body.map(p=>p[1])),bottom=Math.min(...body.map(p=>p[1]));
    const tail=body.filter(p=>p[1]>top-(top-bottom)*.2);
    assert(mean(tail.map(p=>p[2]))>spec.lengthM*.15,id+' vertical tail behind');
    const model=buildAircraft('#fff',id);
    for(const jet of model.userData.flame.children)assert(jet.position.z>0,id+' exhaust behind');
    disposeAircraft(model);
  }
});

test('地图与缩略图共享几何但不共享材质，销毁缩略图不会销毁缓存',()=>{
  const first=buildAircraft('#5bff8a','f16'),second=buildAircraft('#6fe3ff','f16');
  const geometries=root=>{const out=[];root.traverse(o=>{if(o.userData.sharedGeometry)out.push(o.geometry);});return out;};
  assert.equal(geometries(first)[0],geometries(second)[0]);assert.notEqual(first.userData.materials[0],second.userData.materials[0]);
  let disposed=0;geometries(first)[0].addEventListener('dispose',()=>disposed++);disposeAircraft(first);assert.equal(disposed,0);
  assert.equal(buildAircraft('#fff','su27').userData.flame.children.length,2);
  for(const id of ['b7478','a320']){const model=buildAircraft('#fff',id);assert.equal(model.userData.flame.children.length,0);assert.equal(model.userData.gear.visible,false);}
});

test('机型选择随现有进度保存恢复，外形与气动保持一致而不瞬移或补速',async()=>{
  const scenario=JSON.parse(await fs.readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await fs.readFile(new URL('../data/aircraft.json',import.meta.url)));
  const world=new World(scenario,profiles),u=world.units[0],before=structuredClone({position:u.position,velocity:u.velocity});
  world.setAircraftType(u.id,'b7478');world.setAircraftType(world.units[1].id,'j11');const restored=restoreWorld(captureWorld(world),scenario,profiles);
  assert.equal(aircraftModelId(restored.units[0]),'b7478');assert.equal(aircraftModelId(restored.units[1]),'j11');
  assert.equal(restored.units[0].profile.area,554);assert.equal(restored.units[1].profile.engineCount,2);assert.deepEqual({position:u.position,velocity:u.velocity},before);
});
