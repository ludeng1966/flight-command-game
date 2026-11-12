// Gameplay tactical network, inspired by public LOS/TDMA principles. These
// timings/ranges are design assumptions, not Link 16 or Chinese/Russian specs.
import {communicationChannel} from './communication-channel.js';
import {combatReport,parseCombatReport} from './engagement-intent.js';
import {notePlayerOrder} from './command-scope.js';
const teamOf=u=>u.team??u.faction??'blue';
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=64;
const modes=['off','receive','transmit_receive'];
const runtime=new WeakMap(),EARTH=6371000*4/3;
export const DATALINK_DEFAULTS=Object.freeze({rangeM:180000,slotSec:.125,latencySec:.25,ownPeriodSec:1,trackPeriodSec:2,freshSec:4,expireSec:12,maxReports:8,maxContacts:128});

export function createDatalink(profileId,override,team='blue'){
  const family=profileId==='f16'?'western-training':['j11','su27'].includes(profileId)?'eastern-training':null;
  const config={available:!!family,family:family??'none',networkId:team,keyId:'training-'+team,mode:family?'transmit_receive':'off',rangeM:DATALINK_DEFAULTS.rangeM,...override};
  if(typeof config.available!=='boolean'||!['family','networkId','keyId'].every(k=>text(config[k]))||!modes.includes(config.mode)||!Number.isFinite(config.rangeM)||config.rangeM<1000||config.rangeM>400000)throw Error('数据链终端配置无效');
  return {config,contacts:[],peers:[],nextOwnAt:0,nextTrackAt:0,reportCursor:0,sent:0,received:0,dropped:0,lastReceivedAt:null};
}
export function configureDatalink(world,id,patch){
  const unit=world.units.find(u=>u.id===id);if(!unit)throw Error('飞机不存在');
  if(Object.keys(patch).some(k=>!['mode','networkId','keyId'].includes(k)))throw Error('不支持的数据链设置');
  if(!unit.datalink?.config.available)throw Error('该机没有战术数据链终端');
  unit.datalink=createDatalink(unit.profileId,{...unit.datalink.config,...patch},teamOf(unit));world.revision++;notePlayerOrder(world,[id]);
}
export function resetDatalink(unit){unit.datalink=createDatalink(unit.profileId,unit.datalink?.config,teamOf(unit));}
const receive=u=>u.alive!==false&&u.datalink?.config.available&&u.datalink.config.mode!=='off';
const transmit=u=>receive(u)&&u.datalink.config.mode==='transmit_receive';
function compatible(a,b){const x=a.datalink?.config,y=b.datalink?.config;return teamOf(a)===teamOf(b)&&x?.family===y?.family&&communicationChannel(a)===communicationChannel(b)&&x?.keyId===y?.keyId;}
export function datalinkPath(a,b,terrain){
  if(!vec(a.position)||!vec(b.position))return {valid:false,reason:'invalid_position'};
  const delta=b.position.map((v,i)=>v-a.position[i]),distance=Math.hypot(...delta),range=Math.min(a.datalink?.config.rangeM??0,b.datalink?.config.rangeM??0);
  if(distance>range)return {valid:false,reason:'range'};
  const h1=Math.max(0,a.position[2])+2,h2=Math.max(0,b.position[2])+2;
  const groundDistance=Math.hypot(delta[0],delta[1]);
  if(groundDistance>Math.sqrt(2*EARTH*h1)+Math.sqrt(2*EARTH*h2))return {valid:false,reason:'horizon'};
  // Sample the actual map profile; no repeated ray test in each physics frame.
  const samples=Math.min(1024,Math.max(2,Math.ceil(groundDistance/Math.min(500,terrain?.meta?.step??500))));
  if(terrain?.heightAt)for(let i=0;i<=samples;i++){
    const t=i/samples,ground=terrain.heightAt(a.position[0]+delta[0]*t,a.position[1]+delta[1]*t);
    const ray=a.position[2]+delta[2]*t+2,bulge=groundDistance**2*t*(1-t)/(2*EARTH);
    if(ground!==null&&ground!==undefined&&ground+bulge>=ray)return {valid:false,reason:'terrain'};
  }
  return {valid:true,reason:'clear'};
}
function sampleReport(sender,c,kind){
  const uncertainty=c.uncertainty?.positionSigmaM;
  const report={id:kind==='participant'?'PPLI:'+sender.id:'DL:'+sender.id+':'+c.id,kind,source:'datalink',sourceUnitId:sender.id,channelId:communicationChannel(sender),
    sourceCallsign:String(sender.callsign??sender.id).slice(0,80),sourceTrackId:kind==='participant'?null:c.id,
    callsign:String(c.callsign??c.id).slice(0,80),classification:kind==='participant'?'friendly':['friendly','hostile'].includes(c.classification)?c.classification:'unknown',
    observedAt:c.observedAt,position:c.position.map(v=>Math.round(v/25)*25),velocity:c.velocity.map(v=>Math.round(v)),
    positionErrorM:Math.hypot(Array.isArray(uncertainty)?Math.max(...uncertainty):kind==='participant'?15:100,25),velocityErrorMps:Math.max(2,...(c.uncertainty?.velocitySigmaMps??[])),
    fireControl:false};
  if(kind==='participant')Object.assign(report,{headingDeg:(Math.atan2(sender.velocity[0],sender.velocity[1])*180/Math.PI+360)%360,speedMps:Math.round(Math.hypot(...sender.velocity)),altitudeM:report.position[2],combat:combatReport(sender,c.observedAt),defenseActive:!!sender.rwrDefense?.active,attackActive:!!sender.attackTask?.active,tacticalGroupId:sender.tacticalGuidance?.group?.id??null});
  return report;
}
function reports(sender,now){
  const d=sender.datalink,out=[];
  if(now>=d.nextOwnAt){out.push(sampleReport(sender,{id:sender.id,callsign:sender.callsign,position:sender.position,velocity:sender.groundVelocity??sender.velocity,observedAt:now},'participant'));d.nextOwnAt=now+DATALINK_DEFAULTS.ownPeriodSec;}
  if(now>=d.nextTrackAt){
    d.nextTrackAt=now+DATALINK_DEFAULTS.trackPeriodSec;
    const latest=new Map();
    for(const c of [...(sender.radar?.contacts??[]),...(sender.weapons?.contacts??[])]){
      if(!text(c.id)||!vec(c.position)||!vec(c.velocity)||!Number.isFinite(c.observedAt)||c.observedAt>now||now-c.observedAt>DATALINK_DEFAULTS.freshSec||c.awaitingValidation||['tentative','lost'].includes(c.state))continue;
      const old=latest.get(c.id);if(!old||old.observedAt<c.observedAt)latest.set(c.id,c);
    }
    const priority=latest.get(sender.radar?.targetId);if(priority){out.push(sampleReport(sender,priority,'track'));latest.delete(priority.id);}
    const list=[...latest.values()].sort((a,b)=>a.id.localeCompare(b.id)),capacity=DATALINK_DEFAULTS.maxReports-out.length;
    for(let i=0;i<Math.min(capacity,list.length);i++)out.push(sampleReport(sender,list[(d.reportCursor+i)%list.length],'track'));
    if(list.length)d.reportCursor=(d.reportCursor+capacity)%list.length;
  }
  return out;
}

export function stepDatalinks(world){
  const now=world.time;let state=runtime.get(world);
  if(!state||now<state.time){state={nextAt:now,time:now,slot:0,queue:[]};runtime.set(world,state);}
  if(now+1e-8<state.nextAt)return;
  state.nextAt=now+DATALINK_DEFAULTS.slotSec;state.time=now;
  const units=new Map(world.units.map(u=>[u.id,u]));
  for(const u of units.values())if(u.datalink){
    if(!receive(u)){u.datalink.contacts=[];u.datalink.peers=[];continue;}
    u.datalink.contacts=u.datalink.contacts.filter(c=>now-c.observedAt<DATALINK_DEFAULTS.expireSec);
    u.datalink.peers=u.datalink.peers.filter(c=>now-c.receivedAt<4);
  }
  const pending=[];
  for(const packet of state.queue){
    if(packet.due>now){pending.push(packet);continue;}
    const a=units.get(packet.sender),b=units.get(packet.receiver);
    if(!a||!b||!transmit(a)||!receive(b)||a.datalink!==packet.senderTerminal||b.datalink!==packet.receiverTerminal||!compatible(a,b)||!datalinkPath(a,b,world.terrain).valid){if(b?.datalink)b.datalink.dropped++;continue;}
    const d=b.datalink;d.received++;d.lastReceivedAt=now;
    d.peers=d.peers.filter(p=>p.id!==a.id);d.peers.push({id:a.id,callsign:a.callsign??a.id,receivedAt:now});
    const merged=new Map(d.contacts.map(c=>[c.id,c]));
    for(const report of packet.reports){
      if(now-report.observedAt>=DATALINK_DEFAULTS.expireSec)continue;
      const old=merged.get(report.id);
      if(!old||old.observedAt<report.observedAt)merged.set(report.id,{...report,position:[...report.position],velocity:[...report.velocity],receivedAt:now});
    }
    d.contacts=[...merged.values()].sort((a,b)=>b.observedAt-a.observedAt).slice(0,DATALINK_DEFAULTS.maxContacts);
  }
  state.queue=pending;
  // One sender per slot per compatible network; no implicit relay/echo of RX data.
  const groups=new Map();
  for(const u of units.values())if(transmit(u)){
    const c=u.datalink.config,key=JSON.stringify([teamOf(u),c.family,c.networkId,c.keyId]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(u);
  }
  for(const group of groups.values()){
    const sender=group[state.slot%group.length],payload=reports(sender,now);if(!payload.length)continue;
    sender.datalink.sent++;
    for(const receiver of units.values()){
      if(receiver===sender||!receive(receiver)||!compatible(sender,receiver))continue;
      if(!datalinkPath(sender,receiver,world.terrain).valid){receiver.datalink.dropped++;continue;}
      if(state.queue.length>=4096){receiver.datalink.dropped++;continue;}
      state.queue.push({sender:sender.id,receiver:receiver.id,senderTerminal:sender.datalink,receiverTerminal:receiver.datalink,due:now+DATALINK_DEFAULTS.latencySec,reports:payload});
    }
  }
  state.slot++;
}

export function datalinkContext(unit,time){
  const d=unit.datalink;if(!d)return null;
  return {available:d.config.available,mode:d.config.mode,family:d.config.family,networkId:d.config.networkId,
    status:!d.config.available?'unavailable':d.config.mode==='off'?'off':d.lastReceivedAt!==null&&time-d.lastReceivedAt<4?'connected':'isolated',
    peers:d.peers.filter(p=>time-p.receivedAt<4).map(p=>({...p})),sent:d.sent,received:d.received,dropped:d.dropped,
    channelId:communicationChannel(unit),contacts:receive(unit)?d.contacts.filter(c=>time-c.observedAt<DATALINK_DEFAULTS.expireSec).map(c=>{
      const ageSec=Math.max(0,time-c.observedAt);return {...c,position:[...c.position],velocity:[...c.velocity],ageSec,quality:ageSec<=DATALINK_DEFAULTS.freshSec?'fresh':'coasting',positionErrorM:Math.hypot(c.positionErrorM,c.velocityErrorMps*ageSec,1.5*ageSec*ageSec)};
    }):[],limitations:['共享航迹仅供态势与搜索提示；不能直接锁定或制导','不同来源未做可靠关联，不自动合并为同一目标','无自动中继、网关、卫星或协同交战能力']};
}

export function parseDatalinkContext(value,time){
  if(value==null)return null;
  if(typeof value.available!=='boolean'||!modes.includes(value.mode)||!['family','networkId'].every(k=>text(value[k]))||!['unavailable','off','connected','isolated'].includes(value.status)||!Array.isArray(value.contacts)||value.contacts.length>128)throw Error('数据链上下文无效');
  const contacts=value.contacts.map(c=>{
    if(!c||typeof c.id!=='string'||c.id.length>200||!['participant','track'].includes(c.kind)||!text(c.sourceUnitId)||!(c.sourceTrackId===null||text(c.sourceTrackId))||!vec(c.position)||!vec(c.velocity)||!Number.isFinite(c.observedAt)||c.observedAt<0||c.observedAt>time||!Number.isFinite(c.receivedAt)||c.receivedAt<c.observedAt||c.receivedAt>time||!Number.isFinite(c.positionErrorM)||c.positionErrorM<0||!Number.isFinite(c.velocityErrorMps)||c.velocityErrorMps<0||!['friendly','unknown','hostile'].includes(c.classification))throw Error('数据链航迹无效');
    const ageSec=time-c.observedAt;
    return {id:c.id,kind:c.kind,source:'datalink',sourceUnitId:c.sourceUnitId,sourceCallsign:String(c.sourceCallsign??'').slice(0,80),sourceTrackId:c.sourceTrackId,callsign:String(c.callsign??c.id).slice(0,80),classification:c.classification,position:[...c.position],velocity:[...c.velocity],observedAt:c.observedAt,receivedAt:c.receivedAt,ageSec,quality:ageSec<=4?'fresh':'coasting',positionErrorM:c.positionErrorM,velocityErrorMps:c.velocityErrorMps,fireControl:false,channelId:typeof c.channelId==='string'&&c.channelId.length<=64?c.channelId:value.networkId,
      ...(c.kind==='participant'?{...(typeof c.defenseActive==='boolean'?{defenseActive:c.defenseActive}:{}),...(typeof c.attackActive==='boolean'?{attackActive:c.attackActive}:{}),tacticalGroupId:typeof c.tacticalGroupId==='string'&&c.tacticalGroupId.length<=100?c.tacticalGroupId:null,combat:parseCombatReport(c.combat,time),altitudeM:c.position[2],speedMps:Number.isFinite(c.speedMps)&&c.speedMps>=0&&c.speedMps<=1500?c.speedMps:Math.hypot(...c.velocity),headingDeg:Number.isFinite(c.headingDeg)&&c.headingDeg>=0&&c.headingDeg<360?c.headingDeg:(Math.atan2(c.velocity[0],c.velocity[1])*180/Math.PI+360)%360}:{})};
  }).filter(c=>c.ageSec<12);
  return {available:value.available,mode:value.mode,family:value.family,networkId:value.networkId,channelId:value.networkId,status:value.status,contacts:value.available&&value.mode!=='off'?contacts:[]};
}
