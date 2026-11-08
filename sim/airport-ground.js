import {brakingDeceleration} from './airport-weather.js';
const range=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export const taxiEdgeKey=(a,b)=>[a,b].sort().join('|');
const taxiing=u=>u.alive&&u.surface?.grounded&&['taxi','lineup_taxi','exit'].includes(u.surface.phase)&&u.surface.route?.length;
const rank=u=>(u.surface?.emergency?-1e9:0)+(u.surface?.phase==='exit'?-1e8:0)+(u.surface?.atcGroundOrder??0)*1e6+(u.surface?.taxiRequestedAt??0);
export function prepareGroundTraffic(ops,world){
  const a=ops.airport,units=world.units.filter(taxiing).sort((u,v)=>rank(u)-rank(v)||u.id.localeCompare(v.id));
  ops.groundSlots??={};
  ops.groundNodeSlots??={};
  for(const [node,id]of Object.entries(ops.groundNodeSlots))if(!units.some(u=>u.id===id&&u.surface.route[0]===node))delete ops.groundNodeSlots[node];
  for(const node of new Set(units.map(u=>u.surface.route[0]))){
    if(ops.groundNodeSlots[node])continue;
    const candidates=units.filter(u=>u.surface.route[0]===node).sort((u,v)=>{
      const du=range(u.position,a.nodes[node]),dv=range(v.position,a.nodes[node]);
      return du<90||dv<90?du-dv:rank(u)-rank(v)||u.id.localeCompare(v.id);
    });if(candidates[0])ops.groundNodeSlots[node]=candidates[0].id;
  }
  for(const [key,id]of Object.entries(ops.groundSlots)){
    const u=units.find(u=>u.id===id);if(!u||taxiEdgeKey(u.surface.node,u.surface.route[0])!==key)delete ops.groundSlots[key];
  }
  for(const u of units){
    const s=u.surface,from=a.nodes[s.node],next=s.route[0],target=a.nodes[next];if(!from||!target)continue;
    const key=taxiEdgeKey(s.node,next),atNode=range(u.position,from)<18;
    const opponent=units.find(v=>v!==u&&v.surface.node===next&&v.surface.route[0]===s.node);
    if(opponent&&atNode&&(rank(u)>rank(opponent)||rank(u)===rank(opponent)&&u.id>opponent.id)){
      if(world.time>=(s.rerouteAt??0)){s.rerouteAt=world.time+10;ops.rerouteGround?.(u,world,[key]);}
      continue;
    }
    if(ops.groundSlots[key]&&ops.groundSlots[key]!==u.id)continue;
    const blockedNode=world.units.some(v=>v!==u&&v.alive&&v.surface?.grounded&&range(v.position,target)<28&&!(s.formationGroup&&v.surface?.formationGroup===s.formationGroup));
    if(!atNode||!blockedNode)ops.groundSlots[key]=u.id;
  }
  // Already opposing aircraft on a segment must brake before the combined
  // stopping distance. If neither can vacate, ground control requests a tow back
  // to a junction; it never teleports or makes a jet reverse under engine power.
  for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++){
    const u=units[i],v=units[j],su=u.surface,sv=v.surface;
    if(su.node!==sv.route[0]||sv.node!==su.route[0]||range(u.position,v.position)>160||u.speed>.2||v.speed>.2||su.tow||sv.tow)continue;
    const retreat=rank(u)<rank(v)||rank(u)===rank(v)&&u.id<v.id?v:u;
    const target=a.nodes[retreat.surface.node];if(target&&range(retreat.position,target)>20){
      retreat.surface.tow={target:[...target],node:retreat.surface.node};
      ops.notice(retreat,world,'地面交通冲突，地勤拖回路口后重新滑行','GROUND TRAFFIC CONFLICT. TOWING BACK TO JUNCTION, THEN REVISED TAXI ROUTE.','ground');
    }
  }
}
export function groundSpeedLimit(ops,u,world,target){
  const s=u.surface,a=ops.airport,brake=Math.max(.5,brakingDeceleration(a.weather)*.57),from=a.nodes[s.node],key=taxiEdgeKey(s.node,s.route[0]);
  let limit=10,reason=null;
  if(from&&range(u.position,from)<18&&(ops.groundSlots[key]!==u.id||ops.groundNodeSlots[s.route[0]]!==u.id)){limit=0;reason='等待滑行路段通行权';}
  const heading=s.heading,f=[Math.sin(heading),Math.cos(heading)];
  for(const v of world.units){
    if(v===u||!v.alive||!v.surface?.grounded)continue;
    const dx=v.position[0]-u.position[0],dy=v.position[1]-u.position[1],along=dx*f[0]+dy*f[1],lateral=Math.abs(dx*f[1]-dy*f[0]);
    if(along<=0||lateral>22)continue;
    const vh=v.surface.heading??0,opposing=Math.cos(heading-vh)<-.5;
    const closing=Math.max(0,u.speed-(v.speed??0)*Math.cos(heading-vh)),margin=25+closing*.8;
    const stop=u.speed*u.speed/(2*brake)+(opposing?(v.speed??0)**2/(2*brake):0)+margin;
    if(along<stop+8){limit=opposing?0:Math.min(limit,Math.sqrt(2*brake*Math.max(0,along-margin)));reason='交通在前方，保持间隔';}
  }
  // Reserve intersecting movements, including nodes shared by different edges.
  const destination=s.route[0];
  if(range(u.position,target)<Math.max(40,u.speed*u.speed/(2*brake)+35))for(const v of world.units){
    if(v===u||!taxiing(v)||v.surface.route[0]!==destination)continue;
    if(ops.groundNodeSlots[destination]!==u.id){limit=0;reason='路口让行';}
  }
  if(reason){s.groundWaitSince??=world.time;s.message=reason;
    if(world.time-(s.groundWaitReportedAt??-Infinity)>25){s.groundWaitReportedAt=world.time;ops.notice(u,world,reason+'，地面正在安排通行','HOLD POSITION, GROUND TRAFFIC. AWAIT TAXI INSTRUCTIONS.','ground');}
  }else s.groundWaitSince=null;
  return {limit,brake,reason};
}
