// Offline main-thread scheduling benchmark. No network or paid AI calls.
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {FrameStepper} from '../game/frame-stepper.js';
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url));
const terrain=new TerrainHeight(read('../terrain/air_skyscraper_city_height.json'),new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)));
const profiles=read('../data/aircraft.json'),scenario=read('../data/scenarios/demo.json');
function sample(background){
  const world=new World(scenario,profiles,terrain),u=world.units[0],times=[];
  u.waypoints=[[u.position[0],u.position[1]+20000,6500]];u.navLegs=[[u.position.slice(),u.waypoints[0]]];u.navigationKey=world.routeKey(u);
  let jobs=0;if(background)world.deferNavigation=()=>jobs++;
  for(let i=0;i<40;i++){u.navigationCheckAt=0;const start=performance.now();world.ensureNavigation(u);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);return {mainThreadP50Ms:times[20],mainThreadP95Ms:times[38],backgroundJobs:jobs};
}
let clock=0,count=0;const budget=new FrameStepper({now:()=>clock});
budget.advance(.15,8,()=>{count++;clock+=2;});
console.log(JSON.stringify({scope:'CPU scheduling only; not a browser FPS measurement',synchronousSafety:sample(false),workerDispatch:sample(true),overload:{pendingPhysicsSteps:72,executedBeforeYield:count,mainThreadMs:clock,remainingSimSeconds:budget.acc}},null,2));
