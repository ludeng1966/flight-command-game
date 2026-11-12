import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRwr} from '../sim/rwr.js';
import {spawnMissile,MISSILE_MODELS} from '../sim/missiles.js';
import {commandContext} from '../sim/orders.js';
import {visibleMissiles,MISSILE_VISUAL_MEMORY_SEC} from '../sim/missile-visibility.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const create=()=>new World({units:[
  {id:'blue-1',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,4500],heading:0,speed:250},
  {id:'red-secret',callsign:'SECRET',team:'red',profile:'f16',position:[0,12000,4500],heading:180,speed:250}
]},profiles);
const sense=(w,dt=.05)=>{w.time+=dt;stepRwr(w,dt);};
const launch=(w,kind='us_aim_120b',side=1)=>{
  const [own,target]=[w.units[side],w.units[1-side]];
  return spawnMissile(w,own,target,MISSILE_MODELS.get(kind),{position:target.position,velocity:target.velocity});
};
const view=w=>visibleMissiles(w,[w.units[0]]);
const detected=()=>{const w=create(),m=launch(w);m.active=true;sense(w);assert.equal(view(w).length,1);return {w,m};};

test('主动雷达弹必须开机且实际进入己方RWR，红外弹和发射前段不可见',()=>{
  const w=create(),m=launch(w);launch(w,'us_aim9m_sidewinder');
  sense(w);assert.deepEqual(view(w),[]);m.active=true;sense(w);
  assert.equal(w.units[0].rwr.contacts[0].signalType,'active_seeker');
  const result=view(w);assert.equal(result.length,1);assert.equal(result[0].id,m.id);
  assert.equal(result[0].source,'rwr');assert.equal(result[0].visualizationOnly,true);
  assert.equal(result[0].opacity,1);assert.equal(result[0].phase,'active');
});

test('仅开机仍不可透视：接收机关闭、无接收机、仰角、距离、地形遮挡均不显示',()=>{
  for(const change of [
    w=>{w.units[0].rwr.enabled=false;},w=>{w.units[0].rwr.available=false;},
    w=>{w.units[0].alive=false;},w=>{w.units[0].position=[0,12000,30000];},
    w=>{w.units[0].rwr.config.rangeM=1000;},w=>{w.terrain={heightAt:()=>7000};}
  ]){
    const w=create(),m=launch(w);m.active=true;change(w);sense(w);assert.deepEqual(view(w),[]);
  }
});

test('发现敌弹不会暴露发射前尾迹、机型、发射平台、命中目标和精确制导状态',()=>{
  const w=create(),m=launch(w);m.trail=[[999999,888888,777777],[0,12000,4500]];
  m.active=true;sense(w);const shown=view(w)[0];
  assert.deepEqual(shown.trail,[m.position,m.position]);
  assert.doesNotMatch(JSON.stringify(shown),/red-secret|SECRET|ownerId|targetId|modelId|observation|999999|888888|777777/);
  const snapshot=w.snapshot('blue-1',{forecast:false});assert.equal(snapshot.missiles[0].source,'rwr');
  assert.doesNotMatch(JSON.stringify(commandContext(w,'blue-1')),/gameplay_hint_not_rwr_solution|visualizationOnly|missile-1|red-secret/);
});

test('保持的RWR信号不读取新的隐藏坐标，丢信号后按最后速度移动并渐隐',()=>{
  const {w,m}=detected(),first=view(w)[0],stamp=w.time;
  m.position=[90000,80000,70000];m.velocity=[9999,8888,7777];m.active=false;m.alive=false;m.phase='hit';
  w.time+=.1;const held=view(w)[0];
  held.position.forEach((v,i)=>assert.ok(Math.abs(v-first.position[i]-first.velocity[i]*.1)<1e-8));
  w.time=stamp+1.5;const memory=view(w)[0];
  assert.equal(memory.phase,'coasting');assert.ok(memory.opacity>0&&memory.opacity<1);assert.equal(memory.alive,true);
  assert.deepEqual(memory.position,first.position.map((v,i)=>v+first.velocity[i]*1.5));
  w.missiles=[];w.time=stamp+2.5;assert.ok(view(w)[0].opacity<memory.opacity);
  w.time=stamp+MISSILE_VISUAL_MEMORY_SEC;assert.deepEqual(view(w),[]);
});

test('新RWR样本才纠正位置，多机同看一枚弹不会重复显示',()=>{
  const {w,m}=detected();w.time+=.1;m.position=[100,11700,4500];stepRwr(w,.1);
  const result=visibleMissiles(w,[w.units[0],{...w.units[0],id:'blue-2'}]);
  assert.equal(result.length,1);assert.deepEqual(result[0].position,m.position);assert.equal(result[0].opacity,1);
});

test('暂停不重复添轨迹；时间倒退、阵营切换清除旧记忆',()=>{
  const {w}=detected(),first=view(w);assert.deepEqual(view(w),first);assert.deepEqual(view(w),first);
  w.time=0;w.units[0].rwr.contacts=[];assert.deepEqual(view(w),[]);
  const fresh=detected();fresh.w.units[1].rwr.contacts=[];
  assert.equal(visibleMissiles(fresh.w,[fresh.w.units[1]])[0].ownerId,'red-secret');
  fresh.w.units[0].rwr.contacts=[];assert.deepEqual(view(fresh.w),[]);
});

test('我方导弹仍保留原有状态和弹道，不依赖己方RWR照射',()=>{
  const w=create(),m=launch(w,'us_aim9m_sidewinder',0);assert.equal(view(w)[0],m);
  m.alive=false;m.phase='hit';m.endedAt=2;assert.equal(view(w)[0],m);
});

test('导弹失去信号时显示尾迹只保留发现后的短段',()=>{
  const {w,m}=detected();for(let i=0;i<50;i++){
    w.time+=.1;m.position[1]-=50;stepRwr(w,.1);view(w);
  }
  const shown=view(w)[0];assert.ok(shown.trail.length<=28);assert.ok(shown.trail.length>10);
  assert.ok(shown.trail[0][1]<11500);assert.deepEqual(shown.trail.at(-1),shown.position);
});
