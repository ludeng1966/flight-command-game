import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3} from '../vendor/three/three.module.js';
import {AircraftCameraFollower,aircraftVisualScale} from '../three3d/camera-tracking.js';
const point=u=>new Vector3(u.position[0],u.position[2],-u.position[1]);
function setup(){
  const camera=new PerspectiveCamera(52,16/9,20,500000);camera.position.set(0,20000,14000);
  const controls={target:new Vector3(),zoomToCursor:true,enablePan:true,update(){camera.lookAt(this.target);camera.updateMatrixWorld();}};controls.update();
  return {camera,controls,follower:new AircraftCameraFollower(camera,controls)};
}
test('跟随以飞机为轨道中心，保持距离与世界方向，不改变飞机状态',()=>{
  const {camera,controls,follower}=setup(),u={id:'alpha',position:[1000,2000,6500],alive:true},before=JSON.stringify(u);
  const offset=camera.position.clone().sub(controls.target),orientation=camera.quaternion.clone();
  assert.equal(follower.start(u),true);assert.deepEqual(controls.target,point(u));assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-8);assert.equal(JSON.stringify(u),before);
  u.position=[1600,1400,6800];u.bank=1;follower.update([u]);
  assert.deepEqual(controls.target,point(u));assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-8);assert.ok(camera.quaternion.angleTo(orientation)<1e-7);
  const screen=point(u).project(camera);assert.ok(Math.hypot(screen.x,screen.y)<1e-8);
});
test('跟随期间调整距离与环绕角后，飞机运动不会重置玩家视角',()=>{
  const {camera,controls,follower}=setup(),u={id:'alpha',position:[0,0,6500],alive:true};follower.start(u);
  camera.position.copy(controls.target).add(new Vector3(120,80,-150));controls.update();const offset=camera.position.clone().sub(controls.target);
  for(let i=0;i<100;i++){u.position[0]+=25;u.position[1]+=10;follower.update([u]);}
  assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-7);assert.ok(Math.abs(camera.position.distanceTo(controls.target)-Math.hypot(120,80,150))<1e-7);
});
test('切换飞机、停止跟随与目标失效都正确恢复自由视角',()=>{
  const {camera,controls,follower}=setup(),a={id:'alpha',position:[0,0,6500]},b={id:'bravo',position:[2000,3000,7000]};
  follower.start(a);const offset=camera.position.clone().sub(controls.target);follower.start(b);
  assert.equal(follower.unitId,'bravo');assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-8);assert.equal(controls.enablePan,false);
  const stopped=camera.position.clone();follower.stop();b.position[0]+=500;follower.update([b]);assert.deepEqual(camera.position,stopped);assert.equal(controls.zoomToCursor,true);assert.equal(controls.enablePan,true);
  follower.start(a);follower.update([]);assert.equal(follower.unitId,null);
  follower.start(a);a.alive=false;follower.update([a]);assert.equal(follower.unitId,null);assert.equal(follower.start(a),false);
});
test('模型拉近时恢复1:1，远景辨识尺寸取决于投影与窗口高度',()=>{
  const camera=new PerspectiveCamera(52,16/9,20,500000);camera.position.set(0,0,0);camera.lookAt(0,0,-1);camera.updateMatrixWorld();
  const scales=[24000,10000,1000,300,100].map(d=>aircraftVisualScale(camera,new Vector3(0,0,-d),900));
  assert.ok(scales[0]>scales[1]&&scales[1]>scales[2]&&scales[2]>1);assert.equal(scales[3],1);assert.equal(scales[4],1);
  const renderedPixels=15*scales[0]*900/(2*24000*Math.tan(52*Math.PI/360));assert.ok(Math.abs(renderedPixels-42)<1e-8);
  const normal=aircraftVisualScale(camera,new Vector3(0,0,-24000),900),taller=aircraftVisualScale(camera,new Vector3(0,0,-24000),1800);assert.ok(Math.abs(normal-2*taller)<1e-8);
  camera.zoom=2;assert.ok(Math.abs(aircraftVisualScale(camera,new Vector3(0,0,-24000),900)-normal/2)<1e-8);
});
test('1:1阈值连续过渡，不把模型缩小到真实比例以下',()=>{
  const camera=new PerspectiveCamera(52,1,20,500000);camera.lookAt(0,0,-1);camera.updateMatrixWorld();
  const threshold=15*900/(2*42*Math.tan(52*Math.PI/360));
  const before=aircraftVisualScale(camera,new Vector3(0,0,-threshold-.001),900),after=aircraftVisualScale(camera,new Vector3(0,0,-threshold+.001),900);
  assert.ok(Math.abs(before-after)<.00001);assert.equal(after,1);
});
