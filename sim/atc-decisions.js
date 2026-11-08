import {APPROACH_TYPES,arrivalProcedure} from './airport-procedures.js';
import {runwayWeatherLimits} from './airport-weather.js';
import {evaluateDeparturePlan} from './departure-plan.js';
export const ATC_ACTIONS=['continue','hold_ground','priority','change_runway','change_taxi','vector','change_approach','go_around'];
export function validateAtcDecisions(decisions,unitIds){
  if(!Array.isArray(decisions)||decisions.length>8)throw Error('塔台决策数量无效');
  for(const d of decisions)if(!d||!unitIds.includes(d.unitId)||!ATC_ACTIONS.includes(d.action)||
    !(d.runway===null||typeof d.runway==='string'&&/^\d{2}[LRC]?$/.test(d.runway))||!Array.isArray(d.taxiways)||d.taxiways.length>12||d.taxiways.some(v=>typeof v!=='string'||v.length>16)||
    !(d.headingDeg===null||Number.isFinite(d.headingDeg)&&d.headingDeg>=0&&d.headingDeg<=360)||!(d.altitudeM===null||Number.isFinite(d.altitudeM)&&d.altitudeM>=150&&d.altitudeM<=15000)||
    !(d.speedMps===null||Number.isFinite(d.speedMps)&&d.speedMps>=70&&d.speedMps<=400)||!Number.isInteger(d.priority)||d.priority<0||d.priority>100||
    !(d.approachType===null||APPROACH_TYPES.includes(d.approachType))||typeof d.reasonZh!=='string'||!d.reasonZh||d.reasonZh.length>180||typeof d.reasonEn!=='string'||!d.reasonEn||d.reasonEn.length>500||/[\u3400-\u9fff]/.test(d.reasonEn))throw Error('塔台决策格式无效');
  return decisions;
}
export function applyAtcDecision(world,d,{requestId=null}={}){
  const ops=world.airportOps,u=world.units.find(u=>u.id===d.unitId),s=u?.surface;
  if(!ops||!u?.alive||!s)throw Error('管制对象已失效');
  if(requestId&&s.atcRequestId!==requestId)throw Error('管制任务已变化，旧塔台决定作废');
  const q=ops.traffic.state.requests.find(q=>q.id===s.atcRequestId);
  if(d.action==='continue')return;
  if(d.action==='priority'){
    if(!q)throw Error('该机不在进离场队列');q.priority=s.emergency||u.fuel?.status==='emergency'?100:d.priority;
  }else if(d.action==='hold_ground'){
    if(!s.grounded||s.phase==='takeoff_roll')throw Error('只能对尚未滑跑的地面飞机保持等待');
    s.atcHoldUntil=world.time+30;
  }else if(d.action==='go_around'){
    if(s.grounded||!['approach','final'].includes(s.phase))throw Error('该机当前不在进近阶段');ops.goAround(u,world,d.reasonZh);
  }else if(d.action==='change_runway'){
    if(!d.runway||s.phase==='takeoff_roll'||s.phase==='lined_up'||s.runwayLocked)throw Error('当前阶段不能改跑道');
    const r=ops.runway(d.runway);if(!runwayWeatherLimits(ops.airport.weather,r,u.profile).valid)throw Error('新跑道气象条件不符合本机限制');
    const order={intent:s.grounded?s.depart?'takeoff':'taxi':'land',runway:d.runway,airportId:ops.airport.id,taxiways:d.taxiways,gate:s.arrivalGate??null,altitudeM:s.climbAltitude??null,mode:s.grounded?s.originalMode??null:d.approachType??s.approachType??null};
    const power=s.grounded&&u.departurePowerPlan?evaluateDeparturePlan(world,u,order,u.departurePowerPlan):null;
    if(s.grounded&&u.departurePowerPlan&&!power)throw Error('新跑道无法满足原推力要求');ops.apply(u,order,world,power);
  }else if(d.action==='change_taxi'){
    if(!s.grounded||s.phase!=='taxi'||!s.node)throw Error('当前阶段不能修改滑行路线');
    const result=ops.taxiRoute(s.node,s.destination,d.taxiways,'strict');
    s.route=result.path.slice(1);ops.traffic.issue(u,'taxi',{runway:s.runway,route:result.path,limit:s.destination},world,{reasonZh:d.reasonZh,reasonEn:d.reasonEn,station:'ground'});
  }else if(d.action==='vector'){
    if(s.grounded||s.phase==='final'||d.headingDeg===null||d.altitudeM===null||d.speedMps===null)throw Error('引导参数或飞行阶段无效');
    const check=world.terrain?.checkPoint?.([u.position[0],u.position[1],d.altitudeM]);if(check&&!check.valid)throw Error(check.reason);
    ops.traffic.issue(u,'vector',{headingDeg:d.headingDeg,altitudeM:d.altitudeM,speedMps:d.speedMps},world,{reasonZh:d.reasonZh,reasonEn:d.reasonEn,station:'approach'});
  }else if(d.action==='change_approach'){
    if(s.grounded||s.phase==='final'||!d.approachType)throw Error('当前阶段不能变更进近程序');
    const p=arrivalProcedure(ops.airport,ops.runway(d.runway??s.runway),d.approachType,u);
    if(ops.airport.weather.visibilityM<p.minimumVisibilityM||ops.airport.weather.ceilingM<p.minimumCeilingM)throw Error('天气低于所选进近程序最低标准');
    ops.apply(u,{intent:'land',runway:d.runway??s.runway,mode:d.approachType,taxiways:[],airportId:ops.airport.id,gate:s.arrivalGate??null,altitudeM:null},world);
  }
  ops.notice(u,world,d.reasonZh,d.reasonEn,s.station??'tower');ops.traffic.state.revision++;
  ops.traffic.state.decisions.push({unitId:u.id,action:d.action,at:world.time,reasonZh:d.reasonZh,reasonEn:d.reasonEn});if(ops.traffic.state.decisions.length>32)ops.traffic.state.decisions.shift();
}
