import fs from 'node:fs';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {World} from '../sim/world.js';
import {stepRadars,applyRadarOrder} from '../sim/radar.js';
import {stepRwr} from '../sim/rwr.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const result={node:process.version,cpu:os.cpus()[0].model,seed:41,dt:.05,terrain:'flat synthetic heightAt=0',gcAvailable:typeof global.gc==='function',scope:'sensor + track + RWR only; excludes rendering, AI and flight physics',runs:[]};
for(const sensorModelVersion of (process.argv.includes('--v2-only')?[2]:[1,2]))for(const count of (process.argv.includes('--32-only')?[32]:[16,32])){
 const units=Array.from({length:count},(_,i)=>({id:'blue-'+i,callsign:'B'+i,profile:'f16',team:'blue',position:[(i%8)*1000,Math.floor(i/8)*1000,6000],heading:0,speed:250}));
 const w=new World({sensorModelVersion,sensorSeed:41,units},profiles,{heightAt:()=>0,meta:{step:250}});
 for(const u of w.units){u.sensorPose={forward:[0,1,0],up:[0,0,1]};applyRadarOrder(w,u,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});}
 w.radarTargets=Array.from({length:64},(_,i)=>({id:'tgt-'+i,team:'red',position:[(i%8-3.5)*2500,10000+Math.floor(i/8)*2500,6000+(i%3-1)*700],velocity:[0,-120,0],velocityFrame:'world',alive:true,radarRcsM2:3}));
 global.gc?.();const samples=[],radar=[],rwr=[],heapBefore=process.memoryUsage().heapUsed;
 for(let i=0;i<500;i++){
  w.time+=.05;for(const t of w.radarTargets)t.position[1]-=6;
  const start=performance.now();stepRadars(w,.05);const split=performance.now();stepRwr(w,.05);const end=performance.now();
  if(i>=100){samples.push(end-start);radar.push(split-start);rwr.push(end-split);}
 }
 global.gc?.();const stats=xs=>{const sorted=xs.sort((a,b)=>a-b),round=n=>Math.round(n*1000)/1000;return {p50Ms:round(sorted[Math.floor(sorted.length*.5)]),p95Ms:round(sorted[Math.floor(sorted.length*.95)]),maxMs:round(sorted.at(-1))};};
 result.runs.push({sensorModelVersion,aircraft:count,targets:64,steps:400,total:stats(samples),radar:stats(radar),rwr:stats(rwr),heapGrowthMB:Math.round((process.memoryUsage().heapUsed-heapBefore)/10485.76)/100,tracks:w.units.reduce((n,u)=>n+u.radar.contacts.length,0)});
}
console.log(JSON.stringify(result,null,2));
