// Persistent, observed-only intent. No world units, bindings or enemy truth here.
import {trackUsable} from './radar-quality.js';
import {directOwnsFlight} from './tactical-guidance.js';
export const ENGAGEMENT_PHASES=['preparing','acquiring','aligning','waiting','defending','supporting','blocked','released','expired'];
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export function parseEngagementIntent(v,time){
  if(v==null)return null;
  if(typeof v.targetId!=='string'||v.targetId.length>64||typeof v.modelId!=='string'||v.modelId.length>100||!Number.isInteger(v.quantity)||v.quantity<1||v.quantity>4||
    !Number.isFinite(v.issuedAt)||v.issuedAt<0||v.issuedAt>time+.001||!Number.isFinite(v.expiresAt)||v.expiresAt<=v.issuedAt||v.expiresAt>v.issuedAt+60||
    !ENGAGEMENT_PHASES.includes(v.phase)||!(v.lastReason===null||typeof v.lastReason==='string'&&v.lastReason.length<=300)||
    !Number.isFinite(v.nextCheckAt)||v.nextCheckAt<0||!(v.firstReadyAt===null||Number.isFinite(v.firstReadyAt)&&v.firstReadyAt>=v.issuedAt&&v.firstReadyAt<=time+.001)||
    !(v.launchedAt===null||Number.isFinite(v.launchedAt)&&v.launchedAt>=v.issuedAt&&v.launchedAt<=time+.001))throw Error('持续接战意图无效');
  return structuredClone(v);
}
export function engagementContact(unit,time){
  const id=unit.attackTask?.engagement?.targetId;
  return [...(unit.radar?.contacts??[]),...(unit.weapons?.contacts??[])].find(c=>c.id===id&&c.classification!=='friendly'&&trackUsable(c,time));
}
export function engagementGuidance(unit){
  const t=unit.attackTask,e=t?.engagement,time=Math.max(unit.radar?.lastSenseAt??0,(e?.nextCheckAt??e?.issuedAt??0)-.05);
  if(!t?.active||!e||time>=e.expiresAt&&e.phase!=='supporting'||['released','expired','blocked'].includes(e.phase)||unit.rwrDefense?.active||directOwnsFlight(unit)||unit.formation||unit.navigationBlocked||t.headingDeg!==null)return null;
  const c=engagementContact(unit,time);if(!c)return null;
  const age=Math.max(0,time-c.observedAt),v=c.sensorModelVersion===2?c.velocityEstimateMps:c.velocity;
  // A few seconds of local lead; never extrapolate the duration of cloud thinking.
  const lead=Math.min(3,Math.hypot(...c.position.map((n,i)=>n-unit.position[i]))/Math.max(100,unit.speed??250)*.05);
  const aim=c.position.map((n,i)=>n+(v?.[i]??0)*Math.min(4,age+lead));
  return {headingDeg:(Math.atan2(aim[0]-unit.position[0],aim[1]-unit.position[1])*180/Math.PI+360)%360,
    altitudeM:t.altitudeM??unit.holdAltitude??unit.position[2],speedMps:t.speedMps??unit.targetSpeed,engagement:true};
}
export function combatReport(unit,time){
  const t=unit.attackTask,e=t?.engagement,airborne=t?.firedMissileIds.some(id=>t.flightResults[id]?.alive!==false);if(!t?.active||!e||time>=e.expiresAt&&!airborne)return null;
  const c=engagementContact(unit,time);if(!c)return null;
  return {taskId:t.id,issuedAt:e.issuedAt,expiresAt:airborne?time+3:e.expiresAt,phase:e.phase,defending:!!unit.rwrDefense?.active,
    groupId:unit.tacticalGuidance?.group?.id??null,role:unit.tacticalGuidance?.group?.role??null,
    airborne,
    target:{position:c.position.map(n=>Math.round(n/25)*25),velocity:c.velocity.map(n=>Math.round(n)),observedAt:c.observedAt}};
}
export function parseCombatReport(v,time){
  if(v==null)return null;
  if(typeof v.taskId!=='string'||v.taskId.length>100||!Number.isFinite(v.issuedAt)||v.issuedAt<0||v.issuedAt>time||!Number.isFinite(v.expiresAt)||v.expiresAt<=v.issuedAt||v.expiresAt>time+60||
    !ENGAGEMENT_PHASES.includes(v.phase)||typeof v.defending!=='boolean'||typeof v.airborne!=='boolean'||!(v.groupId===null||typeof v.groupId==='string'&&v.groupId.length<=100)||
    ![null,'engaged','supporting','left','right'].includes(v.role)||!vector(v.target?.position)||!vector(v.target?.velocity)||!Number.isFinite(v.target.observedAt)||v.target.observedAt<0||v.target.observedAt>time)throw Error('共享接战状态无效');
  return {taskId:v.taskId,issuedAt:v.issuedAt,expiresAt:v.expiresAt,phase:v.phase,defending:v.defending,airborne:v.airborne,groupId:v.groupId,role:v.role,target:{position:[...v.target.position],velocity:[...v.target.velocity],observedAt:v.target.observedAt}};
}
export function cooperativeReleaseGate(unit,time){
  const t=unit.attackTask,e=t?.engagement,c=engagementContact(unit,time),group=unit.tacticalGuidance?.group;
  if(!e||!c)return {allowed:false,reason:'等待本机新鲜目标观测'};
  if(['split','rotate'].includes(unit.tacticalGuidance?.offense)&&group?.role==='supporting')return {allowed:false,reason:'承担支援职责，等待明确角色交接'};
  const link=unit.datalink,cfg=link?.config??link;
  if(!cfg?.available||cfg.mode!=='transmit_receive')return {allowed:true};
  // Use reports that actually arrived; never insert a fixed communication wait
  // into a short fire-control window or manufacture an acknowledgement.
  for(const p of link.contacts??[]){const peer=p.combat;
    if(p.kind!=='participant'||p.channelId!==(cfg.networkId??link.networkId)||time-p.observedAt>3||!peer||time>=peer.expiresAt||peer.defending&&!peer.airborne||['expired','blocked'].includes(peer.phase))continue;
    if(group&&peer.groupId!==group.id)continue;
    const target=peer.target,age=Math.max(0,time-target.observedAt);if(age>3)continue;
    const peerPos=target.position.map((v,i)=>v+target.velocity[i]*age),localPos=c.position.map((v,i)=>v+c.velocity[i]*Math.max(0,time-c.observedAt));
    if(Math.hypot(...localPos.map((v,i)=>v-peerPos[i]))>1500)continue;
    const candidates=new Set([...(unit.radar?.contacts??[]),...(unit.weapons?.contacts??[])].filter(k=>k.classification!=='friendly'&&trackUsable(k,time)&&time-k.observedAt<=3&&Math.hypot(...k.position.map((v,i)=>v+k.velocity[i]*Math.max(0,time-k.observedAt)-peerPos[i]))<=1500).map(k=>k.id));
    if(candidates.size!==1||!candidates.has(e.targetId))continue; // nearby targets are not a confirmed cross-terminal identity
    // A received in-flight report wins regardless of launch priority. Without
    // one, use a stable ID tie-break; never inspect the partner's hidden task.
    if(peer.airborne||peer.role!=='supporting'&&p.sourceUnitId.localeCompare(unit.id)<0)return {allowed:false,reason:peer.airborne?'同频道友机已发射，维持支援并等待结果':'同频道友机优先接战，本机准备并掩护'};
  }
  return {allowed:true};
}
