import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {extendRouteLoop} from '../sim/route-loop.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function setup(){const w=new World(scenario,profiles),u=w.units[0],[x,y,z]=u.position,points=[[x,y+9000,z],[x+9000,y+9000,z],[x+9000,y,z],[x,y,z]];w.units=[u];w.replaceRoute(u.id,points);w.setRouteLoop(u.id,true);return {w,u,points};}
test('闭环预先续接后续航段，不等飞到终点才掉头；新航路停止循环',()=>{
  const {w,u,points}=setup();u.waypoints.shift();extendRouteLoop(w,u);assert.equal(u.waypoints.length,4);assert.deepEqual(u.waypoints.at(-1).slice(0,3),points[0]);assert.equal(u.waypoints.at(-1).loopIndex,0);
  w.command(u.id,points[1]);assert.equal(u.routeLoop,null);
});
test('调整环形航点更新后续循环，撤销重做保留循环状态',()=>{
  const {w,u}=setup(),point=u.waypoints[0].map((v,i)=>i===2?v+100:v);w.moveWaypoint(u.id,0,point);assert.deepEqual(u.routeLoop.points[0],point);
  assert(w.undoRoute(u.id));assert(u.routeLoop);assert.notEqual(u.routeLoop.points[0][2],point[2]);assert(w.undoRoute(u.id,true));assert.deepEqual(u.routeLoop.points[0],point);
});
test('真实飞行内核连续完成两个循环，无停点或终点盘旋',()=>{
  const {w,u}=setup();for(let i=0;i<900*60&&u.alive&&u.completedWaypoints<8;i++)w.step(1/60);
  assert(u.alive);assert(u.completedWaypoints>=8,`只通过 ${u.completedWaypoints} 个航点`);assert(u.routeLoop);assert(u.waypoints.length>=3);
});
test('循环航路存档保留下一圈与航点索引',()=>{
  const {w,u}=setup(),saved=decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(w))))),restored=restoreWorld(saved,{...scenario,units:[scenario.units[0]]},profiles),r=restored.units[0];
  assert.deepEqual(r.routeLoop,u.routeLoop);assert.equal(r.waypoints[0].loopIndex,0);r.waypoints.shift();extendRouteLoop(restored,r);assert.equal(r.waypoints.length,4);assert.equal(r.waypoints.at(-1).loopIndex,0);
});
