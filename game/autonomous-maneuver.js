// The model request and CPU route trial have separate lifetimes. During both,
// aircraft keep flying; the caller rechecks per-aircraft authority on return.
export function autonomousManeuverPlan(unitId,d){
  return {status:'accepted',summary:d.message,tasks:[{unitId,action:'fly_heading',altitudeM:d.altitudeM,speedMps:d.speedMps,headingDeg:d.headingDeg,eastM:null,northM:null,distanceM:null,append:false}]};
}
