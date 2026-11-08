import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PerspectiveCamera,Vector3,Vector2,Raycaster,Ray} from '../vendor/three/three.module.js';
import {CAMERA_DISTANCE,cameraMotionScale,focusAtVisibleDepth,installCameraFocus,terrainFocusPoint} from '../three3d/camera-focus.js';
// 使用仓库实际 OrbitControls；仅为 Node 解析浏览器 import map 中的 three 路径。
const vendor=await readFile(new URL('../vendor/three/OrbitControls.js',import.meta.url),'utf8');
const threeUrl=new URL('../vendor/three/three.module.js',import.meta.url).href;
const {OrbitControls}=await import('data:text/javascript;base64,'+Buffer.from(vendor.replace("from 'three'",`from '${threeUrl}'`)).toString('base64'));
function setup(anchorAt){
  const doc=new EventTarget(),canvas=Object.assign(new EventTarget(),{ownerDocument:doc,style:{},clientWidth:1200,clientHeight:900,
    getRootNode:()=>doc,getBoundingClientRect:()=>({left:0,top:0,width:1200,height:900}),setPointerCapture(){},releasePointerCapture(){}});
  const camera=new PerspectiveCamera(52,1200/900,20,500000);camera.position.set(0,14000,14000);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  let controls;installCameraFocus({canvas,camera,getControls:()=>controls,anchorAt:(x,y)=>anchorAt(camera,x,y)});
  controls=new OrbitControls(camera,canvas);controls.enableDamping=false;controls.zoomToCursor=true;controls.minDistance=CAMERA_DISTANCE.min;controls.maxDistance=CAMERA_DISTANCE.max;
  return {camera,controls,canvas,doc};
}
function event(type,extra={}){return Object.assign(new Event(type,{cancelable:true}),{button:0,pointerType:'mouse',pointerId:1,clientX:600,clientY:450,pageX:600,pageY:450,deltaMode:0,deltaY:0,...extra});}
test('近景旋转按实际观察深度运行，小幅拖动不再绕远处旧中心飞走',()=>{
  let anchor;const s=setup(camera=>anchor??=camera.position.clone().addScaledVector(camera.getWorldDirection(new Vector3()),180));
  const position=s.camera.position.clone(),direction=s.camera.getWorldDirection(new Vector3());
  s.canvas.dispatchEvent(event('pointerdown'));
  assert.ok(Math.abs(s.camera.position.distanceTo(s.controls.target)-180)<1e-6);
  assert.ok(s.camera.position.distanceTo(position)<1e-6);assert.ok(direction.distanceTo(s.camera.getWorldDirection(new Vector3()))<1e-6);
  s.doc.dispatchEvent(event('pointermove',{clientX:606,clientY:456}));s.doc.dispatchEvent(event('pointerup'));
  assert.ok(s.camera.position.distanceTo(position)<3);
  const stopped=s.camera.position.clone();for(let i=0;i<100;i++)s.controls.update();assert.ok(s.camera.position.distanceTo(stopped)<1e-6);
  s.controls.dispose();
});
test('离中心的鼠标缩放锚点留在同一屏幕位置，距离下限阻止穿过锚点',()=>{
  let anchor;const s=setup(camera=>anchor);
  const ray=new Raycaster();ray.setFromCamera(new Vector2(.25,.15),s.camera);anchor=ray.ray.at(400,new Vector3());
  const before=anchor.clone().project(s.camera),position=s.camera.position.clone();
  s.canvas.dispatchEvent(event('wheel',{clientX:750,clientY:382.5,deltaY:-500}));s.camera.updateMatrixWorld();
  const after=anchor.clone().project(s.camera);assert.ok(Math.hypot(before.x-after.x,before.y-after.y)<1e-7);assert.ok(s.camera.position.distanceTo(position)>1);
  for(let i=0;i<100;i++)s.canvas.dispatchEvent(event('wheel',{clientX:750,clientY:382.5,deltaY:-500}));
  assert.ok(s.camera.position.distanceTo(s.controls.target)>=CAMERA_DISTANCE.min-1e-6);
  assert.ok(new Vector3().subVectors(anchor,s.camera.position).dot(s.camera.getWorldDirection(new Vector3()))>0);
  s.controls.dispose();
});
test('空白处保持既有焦点，航点编辑接管事件时不改变相机',()=>{
  const s=setup(()=>null),position=s.camera.position.clone(),target=s.controls.target.clone();
  assert.equal(focusAtVisibleDepth(s.camera,s.controls,null),false);assert.deepEqual(s.camera.position,position);
  const blocked=event('wheel',{deltaY:-100});blocked.preventDefault();
  // 相机焦点处理尊重已接管的事件；OrbitControls 的原生处理由编辑器 stopImmediatePropagation 隔离。
  const local=new EventTarget();installCameraFocus({canvas:Object.assign(local,{getBoundingClientRect:s.canvas.getBoundingClientRect}),camera:s.camera,getControls:()=>s.controls,anchorAt:()=>new Vector3()});
  local.dispatchEvent(blocked);assert.deepEqual(s.controls.target,target);s.controls.dispose();
});
test('观察中心不被远处背景拉走，地形焦点采用实际高程',()=>{
  const s=setup(()=>null),dir=s.camera.getWorldDirection(new Vector3());
  s.controls.target.copy(s.camera.position).addScaledVector(dir,200);s.controls.update();
  focusAtVisibleDepth(s.camera,s.controls,s.camera.position.clone().addScaledVector(dir,20000),{onlyNearer:true});
  assert.ok(Math.abs(s.camera.position.distanceTo(s.controls.target)-200)<1e-6);
  const point=terrainFocusPoint(new Ray(new Vector3(0,1000,0),new Vector3(0,-1,0)),{meta:{step:120},heightAt:()=>200});
  assert.ok(Math.abs(point.y-200)<.01);assert.equal(terrainFocusPoint(new Ray(new Vector3(0,1000,0),new Vector3(0,1,0)),{heightAt:()=>200},2000),null);
  assert.ok(cameraMotionScale(200).rotate<cameraMotionScale(20000).rotate);assert.ok(cameraMotionScale(100).move<150);s.controls.dispose();
});
test('跟随锁定中心时，鼠标缩放和旋转准备不会被背景重新定位',()=>{
  const s=setup(()=>null),canvas=Object.assign(new EventTarget(),{getBoundingClientRect:s.canvas.getBoundingClientRect}),target=s.controls.target.clone();let hits=0;
  installCameraFocus({canvas,camera:s.camera,getControls:()=>s.controls,anchorAt:()=>{hits++;return new Vector3(0,0,0);},isLocked:()=>true});
  canvas.dispatchEvent(event('wheel',{deltaY:-120}));canvas.dispatchEvent(event('pointerdown'));
  assert.equal(hits,0);assert.deepEqual(s.controls.target,target);s.controls.dispose();
});
