import {basis,cross,norm,dot} from './flight.js';
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
export function aircraftBox(u){const b=basis(u),d=u.profile?.dimensions;return {position:u.position,axes:[b.forward,norm(cross(b.forward,b.up)),b.up],half:d?[d.lengthM/2,d.wingspanM/2,d.bodyHeightM/2]:[7.5,5,1.5]};}
export function terrainBodyCollision(u,before,terrain){
  if(!terrain?.collision)return null;const box=aircraftBox(u);
  const [length,span]=box.half;
  for(const [forward,side]of [[length*.93,0],[-length*.8,0],[0,span*.96],[0,-span*.96],[0,0]]){
    const offset=box.axes[0].map((v,i)=>v*forward+box.axes[1][i]*side-box.axes[2][i]*.5),start=before.map((v,i)=>v+offset[i]),end=u.position.map((v,i)=>v+offset[i]);
    const hit=terrain.collision(start,end);if(hit)return hit.map((v,i)=>v-offset[i]);
  }
  return null;
}
// 连续分离轴检测：以本物理帧姿态作保守盒体，计算相对运动的相交时间，防止高速穿透。
export function sweptBoxHit(a,b,fromA=a.position,fromB=b.position){
  const relative=subtract(fromA,fromB),velocity=subtract(subtract(a.position,fromA),subtract(b.position,fromB));
  const vv=dot(velocity,velocity),near=vv?Math.max(0,Math.min(1,-dot(relative,velocity)/vv)):0;
  if(Math.hypot(...relative.map((v,i)=>v+velocity[i]*near))>Math.hypot(...a.half)+Math.hypot(...b.half))return null;
  const axes=[...a.axes,...b.axes,...a.axes.flatMap(x=>b.axes.map(y=>cross(x,y)))];let enter=0,exit=1;
  for(const raw of axes){if(Math.hypot(...raw)<1e-7)continue;const axis=norm(raw),radius=a.half.reduce((s,h,i)=>s+h*Math.abs(dot(a.axes[i],axis)),0)+b.half.reduce((s,h,i)=>s+h*Math.abs(dot(b.axes[i],axis)),0);
    const p=dot(relative,axis),v=dot(velocity,axis);if(Math.abs(v)<1e-9){if(Math.abs(p)>radius)return null;continue;}
    let lo=(-radius-p)/v,hi=(radius-p)/v;if(lo>hi)[lo,hi]=[hi,lo];enter=Math.max(enter,lo);exit=Math.min(exit,hi);if(enter>exit)return null;
  }
  return enter;
}
export function resolveEntityCollisions(world,previous){
  const units=world.units.filter(u=>u.alive),hits=[];
  for(let i=0;i<units.length;i++){
    const u=units[i],box=aircraftBox(u);
    for(let j=i+1;j<units.length;j++){const v=units[j],t=sweptBoxHit(box,aircraftBox(v),previous.get(u.id),previous.get(v.id));if(t!==null)hits.push({t,units:[u,v],object:v.id});}
    for(const building of world.airportOps?.airport.buildings??[]){const p=[...building.center];p[2]=world.airportOps.airport.elevation+building.half[2];const obstacle={position:p,axes:[[1,0,0],[0,1,0],[0,0,1]],half:building.half};const t=sweptBoxHit(box,obstacle,previous.get(u.id));if(t!==null)hits.push({t,units:[u],object:building.id});}
  }
  hits.sort((a,b)=>a.t-b.t);
  for(const hit of hits){if(hit.units.some(u=>!u.alive))continue;for(const u of hit.units){const before=previous.get(u.id);u.position=before.map((v,i)=>v+(u.position[i]-v)*hit.t);u.lastPose=basis(u);u.alive=false;u.flightState='crashed';u.velocity=[0,0,0];u.speed=0;u.throttle=0;u.afterburner=0;u.collision={type:'entity',object:hit.object,time:world.time+hit.t*world.lastDt};world.airportOps?.release(u.id);}}
}
