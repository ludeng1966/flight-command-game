// Presentation of received signals only. A marker radius is layout, never range.
const ranks={search:1,track:2,launch:3};
const colors={search:'#8aa79a',track:'#ffd38c',launch:'#ff6c77'};
const labelFor=contact=>contact.level==='launch'?(contact.signalType==='active_seeker'?'主动导引头信号':'发射级信号'):contact.level==='track'?'跟踪 / 疑似锁定':'搜索辐射';
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
export function rwrDisplayContacts(unit,time,awareness=unit?.tacticalAwareness){
  const r=unit?.rwr;
  if(!r||r.available===false||r.enabled===false||unit.alive===false||unit.controllable===false||!Number.isFinite(time))return [];
  const holdSec=Number.isFinite(r.config?.holdSec)?r.config.holdSec:5;
  const heading=vector(unit.velocity)?Math.atan2(unit.velocity[0],unit.velocity[1])*180/Math.PI:0;
  return (r.contacts??[]).filter(c=>Object.hasOwn(ranks,c.level)&&Number.isFinite(c.bearingDeg)&&Number.isFinite(c.observedAt)&&c.observedAt<=time&&time-c.observedAt<holdSec)
    .map(c=>{
      const ageSec=Math.max(0,time-c.observedAt),memory=ageSec>.35,bearingDeg=(c.bearingDeg%360+360)%360;
      const signal=awareness?.signals?.find(signal=>signal.rwrId===c.id),association=signal?.association;
      const candidates=association?.status!=='unassociated'&&c.signalType!=='active_seeker'?(association?.candidateContactIds??[]).map(id=>awareness.contacts?.find(contact=>contact.contactId===id)?.callsign??id):[];
      const associationText=candidates.length?`疑似相关航迹：${candidates.join(' / ')}（${candidates.length>1?'来源有歧义':'低置信度'}）`:'来源未确认';
      // Signal class is observable; neither the emitter's platform/model nor a
      // missile model is identified by this receiver's current public contract.
      const threatType=c.signalType==='active_seeker'?'missile':'radar_emitter',sourceModelLabel=threatType==='missile'?'导弹 · 型号未知':'雷达源 · 平台未识别';
      return {id:c.id,level:c.level,signalType:c.signalType,threatType,sourceModelLabel,bearingDeg,clock:Math.round(((bearingDeg-heading+360)%360)/30)%12||12,
        ageSec,memory,opacity:memory?Math.max(0,1-(ageSec-.35)/Math.max(.01,holdSec-.35)):1,
        label:labelFor(c),color:colors[c.level],associationText,
        stateText:memory?'信号记忆 · 未确认持续照射':'正在接收',
        // Preserve only explicitly public assessment prose, never the emitter key.
        meaning:signal?.meaning??(c.level==='track'?'可能正在被持续跟踪；不能确定对方锁定对象':c.level==='launch'?'收到发射级辐射；不等于已知导弹距离或命中时间':'收到搜索辐射；不能据此确认对方攻击意图')};
    }).sort((a,b)=>ranks[b.level]-ranks[a.level]||a.ageSec-b.ageSec);
}
