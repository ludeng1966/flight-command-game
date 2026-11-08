const same=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))<1;
export function configureRouteLoop(world,id,enabled=true){
  const u=world.units.find(v=>v.id===id);if(!enabled){u.routeLoop=null;return;}
  let points=u.waypoints.map(p=>p.slice(0,3));if(points.length>3&&same(points[0],points.at(-1)))points=points.slice(1);
  if(points.filter((p,i)=>!points.slice(0,i).some(other=>same(p,other))).length<3)throw Error('环形航路至少需要三个不同的航点');
  u.routeLoop={points,nextIndex:0};
  for(const p of u.waypoints)p.loopIndex=points.findIndex(other=>same(p,other));
  u.routeLoop.nextIndex=(u.waypoints.at(-1).loopIndex+1)%points.length;
}
export function extendRouteLoop(world,u){
  const loop=u.routeLoop;if(!loop||!u.alive)return;
  if(!u.waypoints.length||u.waypoints.some(p=>!Number.isInteger(p.loopIndex))){u.routeLoop=null;return;}
  if(u.surface?.grounded){u.routeLoop=null;return;}
  if(u.surface?.phase==='climb')return;
  if(u.surface&&u.surface.phase!=='airborne'){u.routeLoop=null;return;}
  while(u.waypoints.length<loop.points.length){const p=loop.points[loop.nextIndex].slice(),check=world.checkRoute(u.id,[...u.waypoints,p]);if(!check.valid){u.routeLoop=null;u.navigationMessage='循环航路已停止：'+check.reason;return;}p.loopIndex=loop.nextIndex;p.number=u.nextWaypointNumber++;u.waypoints.push(p);loop.nextIndex=(loop.nextIndex+1)%loop.points.length;}
}
export function captureLoopRoute(u){const points=u.waypoints.map(p=>p.slice(0,3));if(u.routeLoop)points.loop=structuredClone(u.routeLoop);return points;}
export function restoreLoopRoute(u,points){u.routeLoop=points.loop?structuredClone(points.loop):null;if(u.routeLoop)for(const p of u.waypoints)p.loopIndex=u.routeLoop.points.findIndex(other=>same(p,other));}
