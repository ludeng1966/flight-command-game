import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import {updateDatalinkScene} from '../three3d/datalink-scene.js';
test('shared observations are bounded generic symbols, extrapolated only from the reported velocity',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(52,1,1,500000);camera.position.set(0,10000,10000);camera.lookAt(0,6000,0);camera.updateMatrixWorld();
  const sample={id:'DL:a:T1',kind:'track',sourceUnitId:'a',position:[100,200,6000],velocity:[20,0,0],observedAt:0,quality:'fresh'};
  const snapshot={time:1,selectedId:'b',units:[{id:'b',datalink:{contacts:[sample]}},{id:'a'}]};
  updateDatalinkScene(scene,camera,{clientHeight:900},snapshot);
  const line=scene.children[0],geometry=line.geometry;assert(line.isLineSegments);assert.equal(geometry.drawRange.count,8);
  const xs=Array.from(geometry.getAttribute('position').array.slice(0,24)).filter((_,i)=>i%3===0);
  assert(Math.abs(xs.reduce((a,b)=>a+b,0)/8-120)<.001);
  snapshot.units[0].datalink.contacts.push({...sample,id:'PPLI:a',kind:'participant'});
  updateDatalinkScene(scene,camera,{clientHeight:900},snapshot);assert.equal(geometry.drawRange.count,8);assert.equal(line.geometry,geometry);
  snapshot.time=13;updateDatalinkScene(scene,camera,{clientHeight:900},snapshot);assert.equal(line.visible,false);
});
