import test from 'node:test';import assert from 'node:assert/strict';
import {simplifySketch,snapSketchPoint,continueSketchRoute} from '../game/route-sketch.js';
import {chooseWindowPlacement} from '../game/window-placement.js';

test('从旧航段续绘保留前缀、接入真实空间点，并替换后续航段',()=>{
  const a=[0,2000,6000],b=[3000,5000,7000],c=[7000,9000,6500],unit={waypoints:[a,b,c]};
  const join=[1500,3500,6500],stroke=[join,[3500,3500,6700],[6000,6000,6900]],options={prefix:[a],join};
  const route=continueSketchRoute(unit,stroke,options);
  assert.deepEqual(route,[a,join,...stroke.slice(1)]);assert.equal(route[0],a);assert(!route.includes(b)&&!route.includes(c));
  unit.waypoints.shift();assert.deepEqual(continueSketchRoute(unit,stroke,options),[join,...stroke.slice(1)]);
  assert.deepEqual(continueSketchRoute(unit,stroke),stroke.slice(1),'从飞机重绘仍替换全航路');
});
test('手绘直线去掉抖动点，保留真实转角与闭环',()=>{
  assert.equal(simplifySketch([[0,0,1000],[100,1,1000],[200,-2,1000],[300,0,1000]],5).length,2);
  const ring=[[0,0,1000],[100,0,1000],[100,100,1000],[0,100,1000],[0,0,1000]];assert.deepEqual(simplifySketch(ring,5),ring);
});
test('光标靠近已有点优先吸附；直线吸附保持三维高度',()=>{
  const project=p=>({x:p[0],y:p[1],visible:true}),target=[100,100,1300];
  const point=snapSketchPoint([104,102,1600],{targets:[target],project,screen:{x:104,y:102}});assert.deepEqual(point.point,target);assert.equal(point.kind,'point');
  const line=snapSketchPoint([310,4,1500],{anchor:[0,0,1000],project,screen:{x:310,y:4}});assert.equal(line.kind,'line');assert.equal(line.point[2],1500);
});
test('新窗口优先避开飞机与航路，无遮挡时保留原位置',()=>{
  const rect={x:400,y:100,width:300,height:350},bounds={width:1280,height:720};
  assert.deepEqual(chooseWindowPlacement(rect,bounds,[]),rect);
  const result=chooseWindowPlacement(rect,bounds,[{x:450,y:150,w:100,h:100,weight:8},{x:600,y:100,w:25,h:420,weight:2}]);assert(result.x+result.width<=450||result.x>=625);
});
