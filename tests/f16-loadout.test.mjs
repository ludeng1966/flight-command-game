import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {createWeapons,F16_LOADOUT,F16_LOADOUT_ID} from '../sim/weapons.js';
import {commandContext} from '../sim/orders.js';import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));
const copy=value=>decodeState(JSON.parse(JSON.stringify(encodeState(value))));

test('所有F-16无论阵营和旧场景配置都统一4枚AIM-120B、2枚AIM-9M，库存独立',()=>{
  const scene=structuredClone(scenario);scene.units[0].loadout={cn_pl12:10};scene.units[1].team='red';
  const w=new World(scene,profiles);
  for(const u of w.units){assert.deepEqual(u.weapons.inventory,F16_LOADOUT);assert.equal(u.weapons.loadoutId,F16_LOADOUT_ID);}
  w.units[0].weapons.inventory.us_aim_120b--;
  assert.equal(w.units[1].weapons.inventory.us_aim_120b,4);assert.equal(F16_LOADOUT.us_aim_120b,4);
  const context=commandContext(w,w.units[0].id);assert.deepEqual(Object.keys(context.units[0].weapons.inventory),Object.keys(F16_LOADOUT));
});

test('演练补弹遵守4+2容量并禁止加入其他弹型，拒绝时不改变库存',()=>{
  const w=new World(scenario,profiles),u=w.units[0];u.weapons.inventory.us_aim_120b=0;u.weapons.inventory.us_aim9m_sidewinder=1;
  w.reloadPracticeMissile(u.id,'us_aim_120b');assert.equal(u.weapons.inventory.us_aim_120b,4);assert.equal(u.weapons.inventory.us_aim9m_sidewinder,1);
  w.reloadPracticeMissile(u.id,'us_aim9m_sidewinder');assert.deepEqual(u.weapons.inventory,F16_LOADOUT);
  const before=structuredClone(u.weapons),revision=w.revision;
  for(const id of ['cn_pl12','su_pl5e2','us_aim7p_sparrow_fa_18'])assert.throws(()=>w.reloadPracticeMissile(u.id,id),/固定挂载/);
  assert.deepEqual(u.weapons,before);assert.equal(w.revision,revision);
});

test('旧五类混装存档迁移保留已耗弹量和飞行进度，移除不兼容弹并重置无效选弹',()=>{
  const w=new World(scenario,profiles),u=w.units[0];w.time=123;
  u.weapons=createWeapons('legacy',{us_aim_120b:1,us_aim7p_sparrow_fa_18:2,us_aim9m_sidewinder:0,cn_pl12:2,su_pl5e2:2});
  u.weapons.selectedModelId='cn_pl12';u.weapons.ready=true;u.weapons.readySec=5;u.weapons.targetId='existing-target';
  const position=[...u.position],v=[...u.velocity],restored=restoreWorld(copy(captureWorld(w)),scenario,profiles),r=restored.units[0];
  assert.deepEqual(r.weapons.inventory,{us_aim_120b:3,us_aim9m_sidewinder:0});assert.equal(r.weapons.loadoutId,F16_LOADOUT_ID);
  assert.equal(r.weapons.selectedModelId,'us_aim_120b');assert.equal(r.weapons.ready,false);assert.equal(r.weapons.readySec,0);assert.equal(r.weapons.targetId,'existing-target');
  assert.equal(restored.time,123);assert.deepEqual(r.position,position);assert.deepEqual(r.velocity,v);
  const again=restoreWorld(copy(captureWorld(restored)),scenario,profiles);assert.deepEqual(again.units[0].weapons.inventory,r.weapons.inventory);
});

test('新配置存档不重复补弹；尚无武器数据的旧存档得到标准挂载',()=>{
  const w=new World(scenario,profiles);w.units[0].weapons.inventory.us_aim_120b=2;w.units[0].weapons.inventory.us_aim9m_sidewinder=1;
  assert.deepEqual(restoreWorld(copy(captureWorld(w)),scenario,profiles).units[0].weapons.inventory,{us_aim_120b:2,us_aim9m_sidewinder:1});
  const saved=copy(captureWorld(w));delete saved.units[0].weapons;
  assert.deepEqual(restoreWorld(saved,scenario,profiles).units[0].weapons.inventory,F16_LOADOUT);
  saved.units[0].weapons=null;assert.deepEqual(restoreWorld(saved,scenario,profiles).units[0].weapons.inventory,F16_LOADOUT);
});
