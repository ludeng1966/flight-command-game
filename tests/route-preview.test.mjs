import test from 'node:test';
import assert from 'node:assert/strict';
import {RoutePreview,estimateRoute} from '../game/route-preview.js';
import {PathFade} from '../three3d/path-fade.js';

const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function clock(){
  let time=0,id=0;const timers=new Map();
  return {now:()=>time,schedule:(run,delay)=>{timers.set(++id,{at:time+delay,run});return id;},unschedule:id=>timers.delete(id),async advance(ms){
    const end=time+ms;
    for(;;){const next=[...timers.entries()].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      timers.delete(next[0]);time=next[1].at;next[1].run();await flush();
    }time=end;await flush();
  }};
}

test('连续拖动时持续计算而非等停手，最多一个在途请求并最终只显示最新结果',async()=>{
  const t=clock(),calls=[],shown=[];let active=0,peak=0;
  const planner={cancel(){},request(channel,unit,route){calls.push({at:t.now(),route});peak=Math.max(peak,++active);return new Promise(resolve=>t.schedule(()=>{active--;resolve({valid:true,points:route});},75));}};
  const preview=new RoutePreview({planner,channel:'edit',getUnit:()=>({}),onResult:r=>shown.push(r),...t});
  for(let i=0;i<90;i++){preview.update([[i*100,2000,6500+i]]);await t.advance(16);}
  assert(calls.length>=9&&calls.length<=12);assert(calls[1].at<200);assert.equal(peak,1);
  await t.advance(500);assert.deepEqual(shown.at(-1).points,[[8900,2000,6589]]);assert(shown.every(result=>result.points[0][0]===8900));preview.stop();
});

test('取消、地下隐藏和重新进入同一位置都不会显示迟到结果',async()=>{
  const t=clock(),pending=[],shown=[],planner={cancel(){},request(channel,unit,route){return new Promise(resolve=>pending.push({route,resolve}));}};
  const preview=new RoutePreview({planner,channel:'preview',getUnit:()=>({}),onResult:r=>shown.push(r),...t}),route=[[500,1000,7000]];
  preview.update(route);preview.clear();preview.update(route);pending[0].resolve({valid:true,points:[[0,0,0]]});await flush();await t.advance(150);
  assert.equal(shown.length,0);assert.equal(pending.length,2);preview.stop();pending[1].resolve({valid:true,points:route});await flush();assert.equal(shown.length,0);
});

test('瞬时预估经过新高度和所有目标，采样数有上限，不修改真实飞机',()=>{
  const unit={position:[0,0,6500],velocity:[0,180,0]},before=structuredClone(unit),route=[[1000,6000,7000],[7000,12000,7600]];
  const points=estimateRoute(unit,route);assert.deepEqual(unit,before);assert.deepEqual(points[0],unit.position);assert.deepEqual(points.at(-1),route.at(-1));
  assert(points.some(p=>p.every((v,k)=>v===route[0][k])));assert(points.length<=97);assert(points.every(p=>p.every(Number.isFinite)));
});

function fading(){let writes=0;return {fade:new PathFade(()=>({visible:false,material:{opacity:0}}),()=>writes++),writes:()=>writes};}
test('路径更新交叉淡化不清空旧线，密集回包也不降低总亮度或插值几何',()=>{
  const {fade,writes}=fading(),first=[[0,0,0],[1000,1000,7000]];fade.set(first);for(let i=0;i<60;i++)fade.frame(1/60,.8);
  let minimum=1;
  for(let i=0;i<120;i++){
    if(i%3===0)fade.set([[0,0,0],[1000+i,1000,7000]]);
    fade.frame(1/60,.8);minimum=Math.min(minimum,fade.slots.reduce((n,s)=>n+s.object.material.opacity,0));
  }
  assert(minimum>.799);assert.equal(fade.slots.length,3);assert.equal(writes(),41);assert.deepEqual(first,[[0,0,0],[1000,1000,7000]]);
});

test('淡化在30/60/120FPS下等时，减少动态效果时直接显示结果',()=>{
  const values=[30,60,120].map(fps=>{const {fade}=fading();fade.set([[0,0,0],[1,1,1]]);for(let i=0;i<fps/5;i++)fade.frame(1/fps);return fade.slots.reduce((n,s)=>n+s.weight,0);});
  assert(Math.max(...values)-Math.min(...values)<1e-12);
  const {fade}=fading();fade.set([[0,0,0],[1,1,1]]);fade.frame(0,1,true);assert.equal(fade.slots.reduce((n,s)=>n+s.weight,0),1);fade.clear(true);assert(fade.slots.every(s=>!s.object.visible));
});
