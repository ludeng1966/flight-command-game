import {energyEnvelope} from './energy.js';
export const APPROACH_TYPES=['visual','ils','rnav','overhead'];
const fix=(a,r,d,l,h,name)=>Object.assign([a.center[0]+r.direction*d,r.y+l,a.elevation+h],{fixName:name});
export function runwayProcedure(a,r){
  const threshold=r.direction===1?r.x0:r.x1,end=r.direction===1?r.x1:r.x0;
  return {id:`${a.id}-${r.designator}`,runway:r.designator,threshold:[threshold,r.y,a.elevation],headingDeg:r.headingDeg,
    localizerMHz:110.1+(r.stripId==='RW1'?.4:0),glideSlopeDeg:3,decisionHeightM:61,rvrMinimumM:550,
    sid:{id:`${a.id}${r.designator}D`,exit:[end+r.direction*6000,r.y,a.elevation+1200],transferDistanceM:6000,transferHeightM:450},
    missed:{id:`${a.id}${r.designator}M`,altitudeM:a.elevation+1500,headingDeg:r.headingDeg,
      points:[[end+r.direction*6000,r.y,a.elevation+1200],[end+r.direction*10000,r.y+4000,a.elevation+1500]]}};
}
export function arrivalProcedure(a,r,type='ils',unit){
  const p=runwayProcedure(a,r),threshold=p.threshold[0],base=threshold-a.center[0],prefix=`${a.id}${r.designator}`;
  const speed=unit?Math.max(90,energyEnvelope(unit.profile,a.elevation+500,Math.max(100,unit.speed)).safeSpeed(1)*1.13):100;
  let points;
  if(type==='overhead')points=[fix(a,r,base/r.direction-5500,0,600,prefix+' INITIAL'),fix(a,r,base/r.direction+1200,0,600,prefix+' BREAK'),
    fix(a,r,base/r.direction+1200,-4500,700,prefix+' DOWNWIND'),fix(a,r,base/r.direction-10000,-4500,650,prefix+' ABEAM'),
    fix(a,r,base/r.direction-10000,0,524,prefix+' BASE'),fix(a,r,base/r.direction-4000,0,210,prefix+' FINAL')];
  else if(type==='visual')points=[fix(a,r,base/r.direction+2000,-5000,800,prefix+' DOWNWIND'),fix(a,r,base/r.direction-10000,-5000,650,prefix+' BASE'),fix(a,r,base/r.direction-10000,0,524,prefix+' INTERCEPT'),fix(a,r,base/r.direction-4000,0,210,prefix+' FINAL')];
  else points=[fix(a,r,base/r.direction-11500,-3000,1400,prefix+' IAF'),fix(a,r,base/r.direction-9500,0,900,prefix+' IF'),
    fix(a,r,base/r.direction-8000,0,420,prefix+' FAF'),fix(a,r,base/r.direction-4000,0,210,prefix+' FINAL')];
  return {...p,type,points,targetSpeedMps:speed,decisionHeightM:type==='rnav'?120:type==='ils'?61:180,minimumVisibilityM:type==='ils'?550:type==='rnav'?1500:5000,minimumCeilingM:type==='ils'?61:type==='rnav'?120:600};
}
export function updateApproachReceiver(unit,airport,runway){
  const p=runwayProcedure(airport,runway),d=(p.threshold[0]-unit.position[0])*runway.direction,lateral=(unit.position[1]-runway.y)*runway.direction;
  const localizerDeg=Math.atan2(lateral,Math.max(1,d))*180/Math.PI,actualSlope=Math.atan2(unit.position[2]-airport.elevation,Math.max(1,d))*180/Math.PI;
  const mode=unit.surface?.approachType??'ils';
  unit.navReceiver={mode,runway:runway.designator,frequencyMHz:mode==='ils'?p.localizerMHz:null,crossTrackM:lateral,verticalDeviationM:unit.position[2]-airport.elevation-Math.max(0,d)*Math.tan(Math.PI/60),dmeM:Math.hypot(d,lateral,unit.position[2]-airport.elevation),
    localizerDeviationDeg:localizerDeg,glideSlopeDeviationDeg:actualSlope-p.glideSlopeDeg,signalValid:d>0&&d<45000&&Math.abs(localizerDeg)<35};
  return {distanceM:d,lateralM:lateral,procedure:p};
}
