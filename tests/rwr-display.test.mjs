import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../vendor/three/three.module.js';
import {rwrDisplayContacts} from '../sim/rwr-display.js';

const signal=(level='track',extra={})=>({id:'RWR-1',level,bearingDeg:0,observedAt:10,firstSeen:9,signalType:'radar',emitterKey:'radar:SECRET',position:[999,999,999],...extra});
const own=(contacts=[signal()])=>({id:'blue-1',alive:true,position:[0,0,4500],velocity:[0,250,0],rwr:{available:true,enabled:true,config:{holdSec:5},contacts}});

test('RWR表示收到的跟踪信号和近似方位，不泄露内部源身份、位置或距离',()=>{
  const data=rwrDisplayContacts(own(),10)[0];
  assert.equal(data.label,'跟踪 / 疑似锁定');assert.equal(data.clock,12);assert.equal(data.memory,false);assert.equal(data.opacity,1);
  assert.equal(data.associationText,'来源未确认');assert.match(data.meaning,/不能确定/);
  assert.equal(data.threatType,'radar_emitter');assert.equal(data.sourceModelLabel,'雷达源 · 平台未识别');
  assert.doesNotMatch(JSON.stringify(data),/SECRET|emitterKey|position|rangeM|targetId/);
  const east=own();east.velocity=[250,0,0];assert.equal(rwrDisplayContacts(east,10)[0].clock,9);
});

test('失去当前信号后明确转为记忆并渐隐；过期、关机、死亡及未来信号不画',()=>{
  const u=own(),memory=rwrDisplayContacts(u,12)[0];
  assert.equal(memory.memory,true);assert.match(memory.stateText,/未确认持续照射/);assert.ok(memory.opacity>0&&memory.opacity<1);
  assert.ok(rwrDisplayContacts(u,14)[0].opacity<memory.opacity);assert.equal(rwrDisplayContacts(u,15).length,0);
  assert.equal(rwrDisplayContacts(u,9).length,0);
  for(const patch of [{alive:false},{controllable:false},{rwr:{...u.rwr,enabled:false}},{rwr:{...u.rwr,available:false}}])assert.deepEqual(rwrDisplayContacts({...u,...patch},10),[]);
});

test('观测关联始终标疑似；同方位多航迹标歧义，主动导引头不归属敌机',()=>{
  const awareness={contacts:[{contactId:'a',callsign:'TRACK A'},{contactId:'b',callsign:'TRACK B'}],signals:[{rwrId:'RWR-1',association:{status:'possible',candidateContactIds:['a'],confidence:'low'},meaning:'收到持续跟踪信号'}]};
  assert.equal(rwrDisplayContacts(own(),10,awareness)[0].associationText,'疑似相关航迹：TRACK A（低置信度）');
  awareness.signals[0].association={status:'ambiguous',candidateContactIds:['a','b'],confidence:'unknown'};
  assert.match(rwrDisplayContacts(own(),10,awareness)[0].associationText,/来源有歧义/);
  assert.equal(rwrDisplayContacts(own([signal('launch',{signalType:'active_seeker'})]),10,awareness)[0].associationText,'来源未确认');
  const seeker=rwrDisplayContacts(own([signal('launch',{signalType:'active_seeker',modelId:'SECRET MISSILE MODEL'})]),10,awareness)[0];
  assert.equal(seeker.threatType,'missile');assert.equal(seeker.sourceModelLabel,'导弹 · 型号未知');assert.doesNotMatch(JSON.stringify(seeker),/SECRET MISSILE MODEL/);
});

const source=fs.readFileSync(new URL('../three3d/rwr-scene.js',import.meta.url),'utf8')
  .replace("from 'three'",`from '${new URL('../vendor/three/three.module.js',import.meta.url).href}'`)
  .replace("from '../sim/rwr-display.js'",`from '${new URL('../sim/rwr-display.js',import.meta.url).href}'`);
const {updateRwrScene}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function display(){
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1.6,1,100000);
  camera.position.set(0,10000,15000);camera.lookAt(0,4500,0);camera.updateMatrixWorld();
  return {scene,camera,canvas:{clientWidth:1280,clientHeight:800}};
}

test('地图只画箭头与刻度，不创建文字框；只依赖本机RWR且失去信号后渐隐',()=>{
  const previous=globalThis.document;globalThis.document={createElement:()=>assert.fail('地图威胁标记不应创建DOM文字框')};
  try{
    const {scene,camera,canvas}=display(),unit=own();
    updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit]});
    assert.equal(scene.children.length,2);assert.ok(scene.children.every(object=>object.isMesh||object.isLineSegments));
    const arrow=scene.children.find(object=>object.isMesh),vertices=arrow.geometry.attributes.position.array;
    assert.equal(arrow.geometry.attributes.position.count,3);assert.ok(vertices[2]<vertices[5]&&vertices[2]<vertices[8],'北向告警箭头尖端指向地图正北（负Z）');
    const original=[...scene.children[0].geometry.attributes.position.array];
    updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit,{id:'SECRET',position:[999999,999999,0],radar:{targetId:unit.id}}]});
    assert.deepEqual([...scene.children[0].geometry.attributes.position.array],original);
    updateRwrScene(scene,camera,canvas,{time:12,selectedId:unit.id,units:[unit]});assert.ok(arrow.material.opacity>0&&arrow.material.opacity<1);
    let disposed=0;for(const object of scene.children){object.geometry.addEventListener('dispose',()=>disposed++);object.material.addEventListener('dispose',()=>disposed++);}
    updateRwrScene(scene,camera,canvas,{time:15,selectedId:unit.id,units:[unit]});assert.equal(scene.children.length,0);assert.equal(disposed,4);
  }finally{globalThis.document=previous;}
});

test('地图限制三条高优先级信号，换选中机时释放旧方向标记',()=>{
  const {scene,camera,canvas}=display();
  const unit=own(['search','track','launch','track'].map((level,i)=>signal(level,{id:'RWR-'+i,bearingDeg:i*30})));
  updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit]});assert.equal(scene.children.filter(object=>object.isMesh).length,3);
  const searchColor=new THREE.Color(rwrDisplayContacts(own([signal('search')]),10)[0].color);
  assert.ok(!scene.children.some(object=>object.material.color.equals(searchColor)));
  updateRwrScene(scene,camera,canvas,{time:10,selectedId:'blue-2',units:[unit,{...own([]),id:'blue-2'}]});assert.equal(scene.children.length,0);
  updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit]});assert.equal(scene.children.length,6);
  updateRwrScene(scene,camera,canvas,{time:0,selectedId:unit.id,units:[own([])]});assert.equal(scene.children.length,0,'重开同编号飞机仍清理旧局信号');
});

test('同方位的低等级信号不能盖住发射级箭头；同一信号升级时更新绘制优先级',()=>{
  const {scene,camera,canvas}=display(),unit=own(['launch','track','search'].map((level,i)=>signal(level,{id:'RWR-'+i})));
  updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit]});
  const colors=rwrDisplayContacts(unit,10),byLevel=level=>scene.children.filter(object=>object.material.color.equals(new THREE.Color(colors.find(c=>c.level===level).color)));
  const launch=byLevel('launch'),track=byLevel('track'),search=byLevel('search');
  assert.ok(Math.min(...launch.map(o=>o.renderOrder))>Math.max(...track.map(o=>o.renderOrder)));
  assert.ok(Math.min(...track.map(o=>o.renderOrder))>Math.max(...search.map(o=>o.renderOrder)));
  assert.deepEqual([...launch.find(o=>o.isMesh).geometry.attributes.position.array],[...track.find(o=>o.isMesh).geometry.attributes.position.array]);
  const originalSearch=[...search];unit.rwr.contacts[2].level='launch';
  updateRwrScene(scene,camera,canvas,{time:10,selectedId:unit.id,units:[unit]});
  assert.ok(originalSearch.every(o=>o.material.color.equals(launch[0].material.color)));
  assert.ok(Math.min(...originalSearch.map(o=>o.renderOrder))>Math.max(...track.map(o=>o.renderOrder)));
});
