import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FrameStepper} from '../game/frame-stepper.js';
import {World} from '../sim/world.js';
import {runJob} from '../sim/planner-worker.js';
import {plannerUnit} from '../game/planner-client.js';
import {AutoSave} from '../game/autosave.js';

test('catch-up yields after its time budget and always uses 1/60 physics steps',()=>{
  let clock=0,elapsed=0;const s=new FrameStepper({now:()=>clock});
  const step=h=>{assert.equal(h,1/60);elapsed+=h;clock+=2;};
  assert.equal(s.advance(.1,8,step),3);assert(elapsed<.1);assert(s.acc>0);
  for(let i=0;i<30;i++)s.advance(0,8,step);
  assert(Math.abs(elapsed-.8)<1e-9);assert(s.acc<1e-9);
  s.advance(.1,8,step);s.advance(.1,8,step,()=>false);assert.equal(s.acc,0);
});

test('normal rendering keeps simulation speed; overload backlog stays bounded',()=>{
  const s=new FrameStepper({now:()=>0});let elapsed=0;
  for(let i=0;i<60;i++)s.advance(1/60,8,h=>elapsed+=h);
  assert(Math.abs(elapsed-8)<1e-9);
  const busy=new FrameStepper({now:()=>0,maxSteps:1});
  for(let i=0;i<300;i++)busy.advance(.15,8,()=>{});
  assert(busy.acc<2);
});

test('periodic safety validation is dispatched to worker without synchronous terrain tracing',()=>{
  const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
  const scenario={units:[{id:'a',profile:'f16',position:[0,0,6500],heading:0,speed:220}]};
  const world=new World(scenario,profiles),u=world.units[0];u.waypoints=[[0,30000,6500]];u.navLegs=[[u.position.slice(),u.waypoints[0]]];u.navigationKey=world.routeKey(u);u.navigationCheckAt=0;
  let dispatched=0;world.terrain={heightAt(){throw Error('main-thread forecast');}};
  world.deferNavigation=(unit,options)=>{assert.equal(unit,u);assert.equal(options.checkOnly,true);dispatched++;};
  world.ensureNavigation(u);assert.equal(dispatched,1);
  const result=runJob({type:'check',unit:plannerUnit(u,true),route:u.waypoints},null);
  assert.equal(result.valid,true);assert(result.points.length>1);
});

test('input autosaves coalesce and capture current state at idle; final flush cancels stale work',()=>{
  let at=1000,revision=1,captures=0;const jobs=[],store=new Map();
  const save=new AutoSave({storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},fingerprint:'test',now:()=>at,schedule:run=>jobs.push(run),capture:()=>{captures++;return {world:{revision}};},restore(){}});
  save.load();save.requestSave();save.requestSave();assert.equal(jobs.length,1);assert.equal(captures,0);
  revision=2;jobs.shift()();assert.equal(save.lastRevision,2);assert.equal(captures,1);
  at+=300;save.requestSave();save.save();jobs.shift()();assert.equal(captures,2);
});
