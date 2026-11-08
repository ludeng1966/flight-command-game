// Observes the real simulation; never flies, teleports, or grants airport clearance.
export const TRAINING_STAGES=['departure','cruise','waypoint','recovery'];
export function navigationGeometry(radialDeg,horizontalNm,relativeHeightFt){
  if(![radialDeg,horizontalNm,relativeHeightFt].every(Number.isFinite)||horizontalNm<0||relativeHeightFt<0)throw Error('请输入有效的方位、水平距离与相对台高');
  const radial=(radialDeg%360+360)%360,r=radial*Math.PI/180,d=horizontalNm*1852;
  return {eastM:Math.sin(r)*d,northM:Math.cos(r)*d,radialDeg:horizontalNm===0?null:radial,
    inboundDeg:horizontalNm===0?null:(radial+180)%360,outboundDeg:horizontalNm===0?null:radial,
    dmeNm:Math.hypot(d,relativeHeightFt*.3048)/1852};
}
export class FlightTrainingSession{
  constructor(world,unitId,{mode='guided',startingAirborne=false}={}){
    const u=world.units.find(u=>u.id===unitId);
    if(!u?.alive||(startingAirborne?u.surface?.grounded:u.surface?.phase!=='parked'||!u.surface.grounded))throw Error(startingAirborne?'本关需要空中起始场景':'请从机位停放状态开始训练');
    this.startingAirborne=startingAirborne;
    this.world=world;this.unitId=unitId;this.unit=u;this.mode=mode;this.startedAt=world.time;
    this.status='active';this.completed={};this.evidence={};this.cruiseSeconds=0;this.lastTime=world.time;
    this.airport=world.airportOps?.airport;this.sceneResetCount=u.sceneResetCount??0;
    this.flags={};this.lastCompleted=u.completedWaypoints??0;this.lastPhase='parked';
    this.lastWaypoints=new Set(u.waypoints??[]);this.lastHeading=!!u.headingRoute;
  }
  get stage(){return TRAINING_STAGES.find(s=>!(this.startingAirborne&&s==='departure')&&!this.completed[s])??'complete';}
  finishStage(stage,data){if(this.completed[stage])return;this.completed[stage]=this.world.time;this.evidence[stage]=data;}
  invalidate(reason){this.status='invalid';this.reason=reason;}
  fail(reason){if(this.status==='active'){this.status='failed';this.reason=reason;}}
  tick(world=this.world){
    if(this.status!=='active')return;
    if(world!==this.world||!world.units.includes(this.unit)){this.invalidate('模拟已重新开始，请重新开始本轮训练');return;}
    const u=this.unit,t=world.time,dt=t-this.lastTime;this.lastTime=t;
    if(!u.alive){this.status='failed';this.reason='训练机已损坏，本轮未通过；可重新开局练习';return;}
    const phase=u.surface?.phase??'airborne';
    if((u.sceneResetCount??0)!==this.sceneResetCount){this.invalidate('检测到地面出生重置，本轮实飞记录已结束');return;}
    if(dt<0||dt>2){this.invalidate('模拟时间出现跳变，请重新开始本轮训练');return;}
    if(phase==='taxi')this.flags.taxi=true;
    if(phase==='takeoff_roll')this.flags.roll=true;
    if(!u.surface?.grounded&&['climb','airborne'].includes(phase)&&this.flags.taxi&&this.flags.roll)this.flags.departed=true;
    const normalAirborne=!u.surface?.grounded&&['climb','airborne'].includes(phase);
    if(this.flags.departed&&normalAirborne&&u.position[2]>=(this.airport?.elevation??0)+300)this.finishStage('departure',{at:t,altitudeM:u.position[2]});
    if((this.completed.departure||this.startingAirborne)&&!this.completed.cruise){
      const target=u.headingRoute?.targetAltitudeM??u.holdAltitude;
      const stable=normalAirborne&&!u.navigationBlocked&&u.position[2]>=1500&&u.speed>=120&&u.speed<=230&&
        Math.abs(u.position[2]-target)<=150&&Math.abs(u.speed-u.targetSpeed)<=15&&(u.flightState??'normal')==='normal'&&Math.abs(u.bank)<(this.startingAirborne?Math.PI/4:Math.PI/12);
      this.cruiseSeconds=stable?this.cruiseSeconds+dt:0;
      if(this.cruiseSeconds>=10)this.finishStage('cruise',{at:t,altitudeM:u.position[2],speedMps:u.speed,stableSeconds:this.cruiseSeconds});
    }
    const completed=u.completedWaypoints??0;
    if(this.completed.cruise&&!this.completed.waypoint&&normalAirborne&&completed>this.lastCompleted&&!this.lastHeading){
      const passed=[...this.lastWaypoints].find(p=>!u.waypoints.includes(p));
      if(passed)this.finishStage('waypoint',{at:t,completedWaypoints:completed,point:passed.slice(0,3)});
    }
    if(this.completed.waypoint){
      if(phase==='rollout')this.flags.landed=true;
      if(phase==='exit'&&this.flags.landed)this.flags.exited=true;
      if(phase==='parked'&&u.surface?.grounded&&u.speed<.5&&this.flags.landed&&this.flags.exited){
        this.finishStage('recovery',{at:t,stand:u.surface.node});this.status='passed';
      }
    }
    this.lastCompleted=completed;this.lastWaypoints=new Set(u.waypoints??[]);this.lastHeading=!!u.headingRoute;this.lastPhase=phase;
  }
  result(){return {mode:this.mode,status:this.status,unitId:this.unitId,startedAt:this.startedAt,endedAt:this.world.time,completed:{...this.completed},evidence:structuredClone(this.evidence),reason:this.reason??null};}
}
