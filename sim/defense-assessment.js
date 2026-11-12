import {defenseCandidateHeading} from './rwr-defense.js';
export function assessDefenseOptions(unit,time){
  const e=unit.rwrDefense?.episode;if(!e)return null;
  const heading=unit.headingDeg??(Math.atan2(unit.velocity[0],unit.velocity[1])*180/Math.PI+360)%360;
  const signals=(unit.rwr?.contacts??[]).filter(c=>time-c.observedAt<=2.5&&['track','launch'].includes(c.level));
  const options=['notch','extend'].flatMap(maneuver=>(maneuver==='notch'?['left','right']:['auto']).map(side=>{
    const headingDeg=defenseCandidateHeading(unit,e.bearingDeg,maneuver,side),turnDeg=Math.abs((headingDeg-heading+540)%360-180);
    return {maneuver,side,headingDeg,turnDeg,otherSignalAngles:signals.map(c=>({id:c.id,level:c.level,angleDeg:Math.abs((c.bearingDeg-headingDeg+540)%360-180)})),
      radarSupportRisk:unit.radar?.canIlluminate&&turnDeg>45?'转离现有照射方向可能失去支持':'仍须观察真实跟踪',limitation:maneuver==='notch'?'仅尝试径向速度门，需对方雷达/背景条件合适':'背向飞行仍受转弯时间、速度及导弹能量约束'};
  }));
  return {options,canMaintain:!!unit.rwrDefense?.active,ownMissileAssessment:unit.ownMissileAssessment??[],limitations:['告警持续不等于规避失败；不应仅因信号仍在而反向','无来袭弹距离、速度或剩余命中时间，不推算精确能量']};
}
