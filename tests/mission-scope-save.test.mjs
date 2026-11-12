import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {notePlayerOrder,playerOrderVersion} from '../sim/command-scope.js';
import {pilotObservation} from '../sim/pilot-watch.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO',profile:'f16',position:[2000,0,6500],heading:0,speed:250}]};
const create=()=>new World(scenario,profiles);
const roundtrip=value=>decodeState(JSON.parse(JSON.stringify(encodeState(value))));
function assign(world,id='blue-2'){
  const unit=world.units.find(u=>u.id===id);
  unit.pilotMission={id:'mission-1',intent:'intercept',timing:'now',condition:null,parameters:{targetRef:'contact-1'},
    revision:world.revision,orderVersion:playerOrderVersion(world,id)};return unit;
}

test('valid mission survives save/load with rebased manual scope despite unrelated global revision advancement',()=>{
  const world=create();notePlayerOrder(world,['blue-2']);notePlayerOrder(world,['blue-2']);const unit=assign(world);
  notePlayerOrder(world,['blue-1']);world.revision+=7;
  const oldMission=structuredClone(unit.pilotMission),saved=roundtrip(captureWorld(world));
  assert.deepEqual(unit.pilotMission,oldMission);assert.equal(saved.units[1].pilotMissionOrderVersion,'0:2');
  const restored=restoreWorld(saved,scenario,profiles),bravo=restored.units[1];
  assert.equal(bravo.pilotMission.orderVersion,playerOrderVersion(restored,bravo.id));assert.equal(bravo.pilotMissionOrderVersion,undefined);
  assert.equal(pilotObservation(restored,bravo).event.reason,'tactical_mission');
  notePlayerOrder(restored,[bravo.id]);assert.equal(pilotObservation(restored,bravo),null);
});

test('manual replacement and global changes cannot resurrect an old mission through autosave',()=>{
  for(const global of [false,true]){
    const world=create(),unit=assign(world);notePlayerOrder(world,global?null:[unit.id]);
    assert.equal(pilotObservation(world,unit),null);const saved=roundtrip(captureWorld(world));
    assert.equal(saved.units[1].pilotMission,null);
    const restored=restoreWorld(saved,scenario,profiles);assert.equal(restored.units[1].pilotMission,null);
  }
});

test('legacy current missions are retained, legacy stale missions and mismatched markers are dropped',()=>{
  for(const valid of [true,false]){
    const world=create(),unit=assign(world),saved=roundtrip(captureWorld(world));
    delete saved.units[1].pilotMissionOrderVersion;delete saved.units[1].pilotMission.orderVersion;
    if(!valid)saved.revision++;
    const restored=restoreWorld(saved,scenario,profiles);
    if(valid)assert.equal(pilotObservation(restored,restored.units[1]).event.reason,'tactical_mission');
    else assert.equal(restored.units[1].pilotMission,null);
  }
  const world=create();assign(world);const saved=roundtrip(captureWorld(world));saved.units[1].pilotMissionOrderVersion='0:999';
  assert.equal(restoreWorld(saved,scenario,profiles).units[1].pilotMission,null);
});
