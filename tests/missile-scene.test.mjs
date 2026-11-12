import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three/three.module.js';

const source=fs.readFileSync(new URL('../three3d/missile-scene.js',import.meta.url),'utf8')
  .replace("from 'three'",`from '${new URL('../vendor/three/three.module.js',import.meta.url).href}'`);
const {updateMissileScene}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('可见敌弹显示标记和RWR标签，记忆态同步透明度，消失时移除标签并释放资源',()=>{
  const previous=globalThis.document,labels=[];
  globalThis.document={createElement:()=>({style:{},remove(){labels.splice(labels.indexOf(this),1);}})};
  try{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1.6,1,100000);
    camera.position.set(0,10000,15000);camera.lookAt(0,4500,0);camera.updateMatrixWorld();
    const canvas={clientWidth:1280,clientHeight:800,parentNode:{querySelector:()=>null,appendChild:el=>labels.push(el)}};
    const missile={id:'m1',source:'rwr',position:[0,0,4500],velocity:[0,-1000,0],trail:[[0,100,4500],[0,0,4500]],alive:true,phase:'active',opacity:1};
    updateMissileScene(scene,camera,canvas,{time:1,missiles:[missile]});
    assert.equal(labels.length,1);assert.equal(labels[0].hidden,false);assert.equal(labels[0].textContent,'导弹 · RWR');
    assert.equal(scene.children.length,3);assert.ok(scene.children.every(o=>o.visible));
    missile.phase='coasting';missile.opacity=.3;
    updateMissileScene(scene,camera,canvas,{time:2,missiles:[missile]});
    assert.equal(labels[0].style.opacity,'0.3');assert.equal(labels[0].textContent,'导弹 · 信号记忆');
    assert.ok(scene.children.every(o=>o.material.opacity>0&&o.material.opacity<=.3));
    let disposed=0;for(const child of scene.children){child.geometry.addEventListener('dispose',()=>disposed++);child.material.addEventListener('dispose',()=>disposed++);}
    updateMissileScene(scene,camera,canvas,{time:5,missiles:[]});
    assert.equal(scene.children.length,0);assert.equal(labels.length,0);assert.equal(disposed,6);
  }finally{globalThis.document=previous;}
});
