import test from 'node:test';
import assert from 'node:assert/strict';
import {missionBrief} from '../game/mission-report.js';
import {airportRoutePoints,createAirport} from '../sim/airport.js';
test('任务简报从实际飞机和航路生成，不以接令代替任务完成',()=>{
  const u={id:'a',callsign:'ALPHA 01',alive:true,position:[0,0,1000],speed:180,waypoints:[[3000,4000,1000]],completedWaypoints:2};
  u.waypoints[0].number=3;const w={units:[u],commandLog:[{time:10,interpretation:{summary:'飞往航点'}}]};
  const result=missionBrief(w,'a');assert.equal(result.objective,'飞往航点 3');assert.equal(result.rangeM,5000);assert.equal(result.remaining,1);assert.equal(result.completed,2);assert.equal(result.recent[0].summary,'飞往航点');
  u.waypoints=[];u.surface={phase:'parked',grounded:true};assert.equal(missionBrief(w,'a').objective,'在机位等待指挥');
  u.alive=false;assert.match(missionBrief(w,'a').caution,/无法继续/);
});
test('跑道对正不显示起飞滑跑；空中任务接管后不残留旧离场爬升目标',()=>{
  const a=createAirport(),r=a.runways[0],u={position:[r.x0,r.y,101.6],waypoints:[],holdAltitude:1300,surface:{phase:'lined_up',grounded:true,route:[],runway:r.designator,climbAltitude:1300}};
  assert.deepEqual(airportRoutePoints(u,a),[]);u.surface.phase='takeoff_roll';assert.equal(airportRoutePoints(u,a)[0].routeLabel,'起飞滑跑');
  u.surface.phase='climb';u.surface.grounded=false;u.surface.depart=true;assert.equal(airportRoutePoints(u,a)[0].routeLabel,'离场爬升');u.holdAltitude=6096;assert.deepEqual(airportRoutePoints(u,a),[]);
});
