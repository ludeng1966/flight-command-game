import {trackUsable} from './radar-quality.js';
// Search memory contains measurements from this aircraft only. It supplies
// evidence and alternatives to the pilot model; it never chooses a flight plan.
const SECTORS=12,FRESH_SEC=2.25,MEMORY_SEC=45;
const finite=Number.isFinite;
const wrap=n=>(n%360+360)%360;
const heading=u=>wrap(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI);
const difference=(a,b)=>Math.abs((a-b+540)%360-180);
const round=n=>Math.round(n*100)/100;
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(finite);
const canonical=s=>String(s??'').replace(/[^a-z0-9\u3400-\u9fff]/gi,'').toLowerCase();
function contactsFor(unit,task,time){
  const candidates=[...(unit.radar?.contacts??[]),...(unit.weapons?.contacts??[])].filter(c=>finite(c.observedAt)&&c.observedAt<=time&&trackUsable(c,time)&&vector(c.position)&&vector(c.velocity));
  const targetId=task.engagedTargetId??task.targetId;
  const named=task.targetRef&&candidates.find(c=>[c.id,c.callsign].some(s=>canonical(s)===canonical(task.targetRef)));
  return candidates.filter(c=>targetId?c.id===targetId:named?c.id===named.id:c.classification!=='friendly').sort((a,b)=>b.observedAt-a.observedAt);
}
function copyContact(c){return {id:c.id,callsign:c.callsign??c.id,classification:c.classification??'unknown',position:[...c.position],velocity:[...c.velocity],observedAt:c.observedAt,source:c.source==='weapon'?'weapon':'radar'};}
export function createSearchState(time){return {startedAt:time,lastSampleAt:time,missingSince:time,lastContact:null,sectorScanSec:Array(SECTORS).fill(0),scanSinceLegSec:0,lastScanHeadingDeg:null,lastManeuverAt:null,lastManeuverHeadingDeg:null,legSequence:0,consecutiveWaits:0};}
export function parseSearchState(value,time){
  if(value==null)return null;
  const stamp=v=>finite(v)&&v>=0&&v<=time+.001,nullableStamp=v=>v===null||stamp(v),angle=v=>v===null||finite(v)&&v>=0&&v<360;
  if(!stamp(value.startedAt)||!stamp(value.lastSampleAt)||value.lastSampleAt<value.startedAt||!nullableStamp(value.missingSince)||!nullableStamp(value.lastManeuverAt)||
    !angle(value.lastScanHeadingDeg)||!angle(value.lastManeuverHeadingDeg)||!finite(value.scanSinceLegSec)||value.scanSinceLegSec<0||value.scanSinceLegSec>120||
    !Array.isArray(value.sectorScanSec)||value.sectorScanSec.length!==SECTORS||value.sectorScanSec.some(n=>!finite(n)||n<0||n>120)||
    !['legSequence','consecutiveWaits'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0))throw Error('搜索进度状态无效');
  const c=value.lastContact;
  if(c!==null&&(!c||typeof c.id!=='string'||!c.id||c.id.length>64||typeof c.callsign!=='string'||c.callsign.length>80||!['friendly','unknown','hostile'].includes(c.classification)||!vector(c.position)||!vector(c.velocity)||!stamp(c.observedAt)||!['radar','weapon'].includes(c.source)))throw Error('搜索历史观测无效');
  // Explicit reconstruction prevents save/context metadata from becoming truth.
  return {startedAt:value.startedAt,lastSampleAt:value.lastSampleAt,missingSince:value.missingSince,lastContact:c&&time-c.observedAt<=MEMORY_SEC?copyContact(c):null,
    sectorScanSec:[...value.sectorScanSec],scanSinceLegSec:value.scanSinceLegSec,lastScanHeadingDeg:value.lastScanHeadingDeg,lastManeuverAt:value.lastManeuverAt,
    lastManeuverHeadingDeg:value.lastManeuverHeadingDeg,legSequence:value.legSequence,consecutiveWaits:value.consecutiveWaits};
}
export function updateSearchState(unit,task,time){
  if(!task?.active)return;
  const s=task.searchState??(task.searchState=createSearchState(Math.min(time,task.issuedAt??time)));
  // Only adjacent simulation samples count as measured scanning. Loading an old
  // save or jumping the clock must not invent minutes of swept airspace.
  const dt=Math.min(.25,Math.max(0,time-s.lastSampleAt));s.lastSampleAt=time;
  const contact=contactsFor(unit,task,time)[0];
  if(contact){s.lastContact=copyContact(contact);s.missingSince=null;s.scanSinceLegSec=0;s.consecutiveWaits=0;}
  else if(s.missingSince===null)s.missingSince=s.lastContact?.observedAt??time;
  if(s.lastContact&&time-s.lastContact.observedAt>MEMORY_SEC)s.lastContact=null;
  const r=unit.radar;
  if(r?.available&&r.mode!=='off'&&r.phase==='search'&&(r.sensorModelVersion!==2||r.emissions?.some(e=>e.job==='search'))){
    const scanAzimuth=r.config&&finite(r.scanPhase)?-r.config.azimuthHalfDeg+2*r.config.azimuthHalfDeg*r.scanPhase:r.scanAzimuthDeg;
    if(finite(scanAzimuth)){
      const beamHeading=wrap(heading(unit)+scanAzimuth),index=Math.floor(wrap(beamHeading+15)/30);
      s.sectorScanSec[index]=Math.min(120,s.sectorScanSec[index]+dt);s.lastScanHeadingDeg=beamHeading;
      if(!contact)s.scanSinceLegSec=Math.min(120,s.scanSinceLegSec+dt);
    }
  }
  return s;
}
export function noteSearchManeuver(task,headingDeg,time){
  const s=task.searchState??(task.searchState=createSearchState(time));
  s.lastManeuverAt=time;s.lastManeuverHeadingDeg=wrap(headingDeg);s.scanSinceLegSec=0;s.legSequence++;s.consecutiveWaits=0;
}
export function noteSearchWait(task){if(task.searchState)task.searchState.consecutiveWaits++;}
function supporting(unit,task){return [task,unit.attackTask].some(t=>(t?.firedMissileIds??[]).some(id=>t.flightResults?.[id]?.alive!==false))||(unit.missileTelemetry??[]).some(m=>m.alive!==false);}
export function searchAssessment(unit,task,time){
  const s=task?.searchState??createSearchState(Math.min(time,task?.issuedAt??time)),currentHeadingDeg=heading(unit),contacts=contactsFor(unit,task??{},time);
  const hasContact=contacts.length>0,noContactSec=hasContact?0:Math.max(0,time-(s.missingSince??s.lastContact?.observedAt??s.startedAt));
  const freshThreat=unit.rwr?.enabled&&(unit.rwr.contacts??[]).some(c=>['track','launch'].includes(c.level)&&finite(c.observedAt)&&c.observedAt<=time&&time-c.observedAt<=2.5);
  const defense=!!unit.rwrDefense?.active||!!freshThreat,inFlight=supporting(unit,task),constrained=task?.headingDeg!=null||task?.allowSearchManeuver===false||!!unit.formation;
  const turning=s.lastManeuverHeadingDeg!==null&&difference(currentHeadingDeg,s.lastManeuverHeadingDeg)>15;
  const mustChangeSearch=!hasContact&&!defense&&!inFlight&&!constrained&&!turning&&noContactSec>=15&&s.scanSinceLegSec>=12&&time-(s.lastManeuverAt??s.startedAt)>=12;
  const phase=defense?'defense':inFlight?'support':hasContact?'contact':turning?'turning':mustChangeSearch?'search_turn':'scan';
  const last=s.lastContact&&time-s.lastContact.observedAt<=MEMORY_SEC?s.lastContact:null;
  const lastKnown=last?{...copyContact(last),ageSec:round(time-last.observedAt),historical:true,uncertainty:'后续机动未知；仅作为重捕搜索线索，不是当前航迹'}:null;
  const sectors=s.sectorScanSec.map((seconds,index)=>({headingDeg:index*30,scannedSec:round(seconds)}));
  const covered=h=>s.sectorScanSec.reduce((sum,seconds,index)=>sum+(difference(h,index*30)<=60?seconds:0),0);
  const options=[];
  if(!hasContact&&!defense&&!inFlight&&!constrained){
    if(!mustChangeSearch)options.push({kind:'continue_scan',headingDeg:round(task?.headingDeg??s.lastManeuverHeadingDeg??currentHeadingDeg),coveredSec:round(covered(currentHeadingDeg)),reason:turning?'先完成已选择的搜索转向，再观察实际扫描':'当前方向尚可继续积累实际扫描；保留传感器工作'});
    if(task?.headingDeg==null&&!turning){
      if(last){
        const age=Math.min(10,Math.max(0,time-last.observedAt)),position=last.position.map((p,i)=>p+last.velocity[i]*age),h=wrap(Math.atan2(position[0]-unit.position[0],position[1]-unit.position[1])*180/Math.PI);
        if(!mustChangeSearch||difference(h,currentHeadingDeg)>=30)options.push({kind:'reacquire_last_seen',headingDeg:round(h),coveredSec:round(covered(h)),reason:'根据历史观测最多外推10秒的重捕线索；目标可能已机动或离开'});
      }
      const alternatives=[-60,60,-120,120,180].map(offset=>wrap(currentHeadingDeg+offset)).sort((a,b)=>covered(a)-covered(b)||difference(a,currentHeadingDeg)-difference(b,currentHeadingDeg));
      for(const h of alternatives.slice(0,3))options.push({kind:'search_leg',headingDeg:round(h),coveredSec:round(covered(h)),reason:'改变机头以覆盖较少扫描的扇区；这是可选搜索方向，不代表该方向存在敌机'});
    }
  }
  return {phase,currentHeadingDeg:round(currentHeadingDeg),noContactSec:round(noContactSec),scanningSec:round(s.scanSinceLegSec),lastScanHeadingDeg:s.lastScanHeadingDeg===null?null:round(s.lastScanHeadingDeg),
    legSequence:s.legSequence,consecutiveWaits:s.consecutiveWaits,lastKnown,sectors,options,mustChangeSearch,
    constraints:{headingDeg:task?.headingDeg??null,formation:!!unit.formation,defensePriority:defense,ownWeaponInFlight:inFlight},
    limitations:['扫描时间仅为本机真实波束扫过的累计时间，不保证无目标','历史航迹不能作为当前锁定或发射依据','方向方案须由模型选择，程序不自动追踪未观测敌机']};
}
