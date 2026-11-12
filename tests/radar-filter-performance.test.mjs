import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeFilter,predictFilter,correctFilter,correctSearchFilter} from '../sim/radar-filter.js';
import {beamGate,inBeam} from '../sim/radar-beam.js';
import {radarGeometry,RADAR_DEFAULTS} from '../sim/radar.js';
test('scalar EKF remains equivalent to the retained batch update, including correlated state covariance',()=>{
 for(let n=0;n<100;n++){
  const initial=initializeFilter([n*17,8000+n*5,5700],-100,[0,1,0],0,150);
  for(let i=0;i<6;i++)for(let j=0;j<6;j++)initial.P[i][j]+=(i+1)*(j+1)*.4;
  predictFilter(initial,1+n*.01);
  const a=structuredClone(initial),b=structuredClone(initial),m={z:[8100+n,.01,.08,-130],R:[[2500,0,0,0],[0,.00001,0,0],[0,0,.00001,0],[0,0,0,9]],observerPosition:[0,0,5000],observerVelocity:[0,250,0]};
  const correlated=structuredClone(m);correlated.R[0][1]=correlated.R[1][0]=1e-20; // Exercises the independent batch/Joseph path.
  assert.ok(correctFilter(a,m));assert.ok(correctFilter(b,correlated));
  for(let i=0;i<6;i++){assert.ok(Math.abs(a.x[i]-b.x[i])<1e-6);for(let j=0;j<6;j++)assert.ok(Math.abs(a.P[i][j]-b.P[i][j])<1e-6);}
 }
});
test('search pair prediction equals full matrix prediction for the retained axis blocks',()=>{
 const a=initializeFilter([100,8000,5000],-100,[0,1,0],0,150);correctSearchFilter(a,{position:[110,8010,5005]},2500);
 const b=structuredClone(a);b.filterMode='full_ekf';predictFilter(a,.25);predictFilter(b,.25);
 assert.deepEqual(a.x,b.x);for(let i=0;i<6;i++)for(let j=0;j<6;j++)assert.ok(Math.abs(a.P[i][j]-b.P[i][j])<1e-9);
 assert.ok(a.P.every((row,i)=>row[i]>0));
});
test('dot-product beam gate agrees with exact angle/gimbal tests across rotated sensor poses',()=>{
 let seed=17;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
 for(let poseIndex=0;poseIndex<12;poseIndex++){
  const h=random()*6.28,p=(random()-.5),b=(random()-.5)*2,f=[Math.sin(h)*Math.cos(p),Math.cos(h)*Math.cos(p),Math.sin(p)],right=[Math.cos(h),-Math.sin(h),0];
  const up0=[-Math.sin(h)*Math.sin(p),-Math.cos(h)*Math.sin(p),Math.cos(p)],up=up0.map((v,i)=>v*Math.cos(b)+right[i]*Math.sin(b));
  const own={position:[100,200,6000],velocity:[0,0,0],sensorPose:{forward:f,up}},beam={from:{az:-35,el:-8},to:{az:10,el:-8}},gate=beamGate(own.position,own.sensorPose,beam,3,RADAR_DEFAULTS);
  for(let i=0;i<500;i++){
   const target={position:[(random()-.5)*40000,(random()-.5)*40000,6000+(random()-.5)*20000],velocity:[0,0,0]},g=radarGeometry(own,target);
   const exact=g.azimuthDeg>=-38&&g.azimuthDeg<=13&&g.elevationDeg>=-11&&g.elevationDeg<=-5;
   assert.equal(inBeam(gate,...target.position),exact);
  }
 }
});
