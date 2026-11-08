import fs from 'node:fs';
import {World} from '../sim/world.js';
import {thrustAt,hasAfterburner} from '../sim/flight.js';
const profiles=JSON.parse(fs.readFileSync('data/aircraft.json')),base=JSON.parse(fs.readFileSync('data/scenarios/demo.json')),results=[];
for(const id of ['f16','j11','su27','a320','b7478']){
  const s=structuredClone(base);delete s.airport;s.units=s.units.slice(0,1);s.units[0].profile=id;s.units[0].position=[0,0,8000];s.units[0].heading=0;s.units[0].speed=230;
  const w=new World(s,profiles),u=w.units[0],goals=[[0,30000,8500],[18000,65000,9000]],before=performance.now(),plan=w.planRoute(u.id,goals);
  let peakG=0,peakBank=0,minSpeed=Infinity,peakAfterburner=0;
  if(plan.valid){w.replaceRoute(u.id,goals,{prepared:{...plan,seed:{position:[...u.position],velocity:[...u.velocity],bank:u.bank,speed:u.speed,targetSpeed:u.targetSpeed,key:JSON.stringify(goals)}}});
    for(let i=0;i<800*60&&u.alive&&u.completedWaypoints<2;i++){w.step(1/60);peakG=Math.max(peakG,u.loadFactor);peakBank=Math.max(peakBank,Math.abs(u.bank)*180/Math.PI);minSpeed=Math.min(minSpeed,u.speed);peakAfterburner=Math.max(peakAfterburner,u.afterburner);}}
  const result={id,valid:plan.valid,reason:plan.reason,planningMs:Math.round(performance.now()-before),lengthM:plan.routeLength,completed:u.completedWaypoints,seconds:w.time,alive:u.alive,flightState:u.flightState,peakG,peakBank,minSpeed,peakAfterburner,massKg:u.profile.mass,fuelKg:u.fuel.massKg};results.push(result);console.log(JSON.stringify(result));
}
fs.writeFileSync('.game-server/aircraft-profile-flight-checks.json',JSON.stringify(results,null,2));if(results.some(r=>!r.valid||r.completed!==2||!r.alive))process.exitCode=1;
