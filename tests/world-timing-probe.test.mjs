import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {captureWorld} from '../sim/save-state.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
test('optional combat timing probe observes stages without changing deterministic world state',()=>{
 const scenario={sensorModelVersion:2,units:[{id:'a',callsign:'A',profile:'f16',position:[0,0,6500],heading:0,speed:250}]};
 const a=new World(scenario,profiles),b=new World(scenario,profiles),samples=[];let clock=0;
 const probe={now:()=>++clock,sample:(stage,elapsed)=>samples.push({stage,elapsed})};
 for(let i=0;i<120;i++){a.step(1/60);b.step(1/60,probe);}
 assert.deepEqual(captureWorld(a),captureWorld(b));assert.equal(samples.length,480);
 assert.deepEqual([...new Set(samples.map(s=>s.stage))].sort(),['datalink','radar','rwr','weapons']);assert.ok(samples.every(s=>s.elapsed>0));
});
