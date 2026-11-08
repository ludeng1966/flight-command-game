// 航向意图编译为 ENU 三维航路；实际运动仍由 Pilot / Flight 计算。
export function headingPoints(origin,headingDeg,altitudeM,distanceM=20000){
  const angle=headingDeg*Math.PI/180,count=Math.max(1,Math.ceil(distanceM/5000));
  return Array.from({length:count},(_,i)=>{
    const f=(i+1)/count,d=distanceM*f;
    return [origin[0]+Math.sin(angle)*d,origin[1]+Math.cos(angle)*d,origin[2]+(altitudeM-origin[2])*f];
  });
}
export function planHeadingRoute(world,unit,headingDeg,altitudeM,distanceM=null){
  let reason='无法建立航向航路';
  // 只对未给距离的持续航向缩短前视窗口；明确给出的航段不静默裁剪。
  for(const span of distanceM===null?[20000,10000,5000,2000]:[distanceM]){
    const points=headingPoints(unit.position,headingDeg,altitudeM,span);
    const check=world.checkRoute(unit.id,points);
    if(check.valid)return {points,headingDeg:headingDeg%360,targetAltitudeM:altitudeM,continuous:distanceM===null,blockedReason:null};
    reason=check.reason;
  }
  throw Error(reason);
}
export function extendHeadingRoute(world,unit){
  const route=unit.headingRoute;
  if(!unit.alive||!route?.continuous||unit.waypoints.length>=2)return;
  const origin=unit.waypoints.at(-1)||unit.position;
  const extra=headingPoints(origin,route.headingDeg,route.targetAltitudeM,10000);
  const check=world.checkRoute(unit.id,[...unit.waypoints,...extra]);
  if(!check.valid){route.continuous=false;route.blockedReason=`航路停止延伸：${check.reason}`;return;}
  for(const point of extra){point.number=unit.nextWaypointNumber++;unit.waypoints.push(point);}
}
