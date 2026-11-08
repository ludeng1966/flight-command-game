import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3} from '../vendor/three/three.core.js';
import {mapViewHeading} from '../three3d/map-heading.js';
test('地图朝向按正北零度、顺时针计角，renderer北向为负Z',()=>{
  const angles=[[0,0,-1,0],[1,0,0,90],[0,0,1,180],[-1,0,0,270]];
  for(const[x,y,z,expected]of angles)assert.equal(mapViewHeading([x,y,z],[1,0,0]),expected);
  const deg=359*Math.PI/180;assert(Math.abs(mapViewHeading([Math.sin(deg),-.8,-Math.cos(deg)],[1,0,0])-359)<1e-9);
});
test('俯视时使用屏幕右向量，避免朝向抖动或丢失',()=>{
  assert.equal(mapViewHeading([0,-1,0],[1,0,0]),0);
  assert.equal(mapViewHeading([0,-1,0],[0,0,1]),90);
  assert.equal(mapViewHeading([0,-1,0],[-1,0,0]),180);
  assert.equal(mapViewHeading([0,-1,0],[0,0,-1]),270);
  assert.equal(mapViewHeading([0,-1,0],[0,1,0],270),270);
});
test('实际相机旋转与罗盘角一致，跟随平移不改变方向',()=>{
  const c=new PerspectiveCamera(),read=()=>{const d=c.getWorldDirection(new Vector3()),m=c.matrixWorld.elements;return mapViewHeading(d.toArray(),[m[0],m[1],m[2]]);};
  c.position.set(0,100,100);c.lookAt(0,0,0);assert.equal(read(),0);
  c.position.set(-100,100,0);c.lookAt(0,0,0);assert(Math.abs(read()-90)<1e-9);
  c.position.add(new Vector3(200,0,300));c.lookAt(200,0,300);assert(Math.abs(read()-90)<1e-9);
});
