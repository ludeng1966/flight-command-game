import {strongestRwr,RWR_LEVELS,rwrEvent,angleDifference} from './rwr.js';
export const DEFENSE_MODES=['auto','report_only'];
export const DEFENSE_ORDER_KEYS=['mode','maneuver','side','headingDeg'];
export const DEFENSE_SCHEMA={type:'object',additionalProperties:false,required:DEFENSE_ORDER_KEYS,properties:{mode:{enum:['auto','report_only','execute']},maneuver:{enum:[null,'notch','extend']},side:{enum:['auto','left','right']},headingDeg:{type:['number','null'],minimum:0,maximum:360}}};
export function createRwrDefense(){return {mode:'auto',lockDelaySec:8,launchDelaySec:4,controlSequence:0,episode:null,active:null,manual:null,suspended:false,modelReview:null};}
const heading=u=>(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360;
const usable=u=>u.alive!==false&&!u.surface?.grounded&&!['final','approach'].includes(u.surface?.phase)&&u.flightState==='normal'&&
  (u.surface?.phase!=='climb'||u.position[2]-(u.terrain?.heightAt?.(u.position[0],u.position[1])??0)>=300);
export function defenseHeading(unit,bearing,maneuver,side='auto'){
  if(maneuver==='extend')return (bearing+180)%360;
  const current=heading(unit),options=[(bearing+90)%360,(bearing+270)%360];
  if(side!=='auto')return options.find(h=>{const delta=((h-current+540)%360)-180;return side==='right'?delta>=0:delta<0;})??options[0];
  return options.sort((a,b)=>angleDifference(a,current)-angleDifference(b,current))[0];
}
export function notePlayerDefenseOrder(world,unit){
  if(world.autonomousCommand)return;
  const d=unit?.rwrDefense;if(!d)return;
  const wasActive=!!d.active;d.controlSequence++;d.active=null;d.manual=null;d.modelReview=null;
  if(d.episode)d.episode.playerOverride=true;
  if(wasActive)rwrEvent(unit,world.time,'player_control','收到玩家新指令，停止自主规避，执行新任务');
  // Resume navigation by recomputing it from the real post-manoeuvre position.
  if(wasActive)unit.navigationKey=null;
}
export function configureDefense(world,unit,{mode,lockDelaySec,launchDelaySec}){
  const d=unit?.rwrDefense;if(!d||!unit.rwr?.available)throw Error('本机没有雷达告警接收器');
  if(mode!==undefined&&!DEFENSE_MODES.includes(mode)||lockDelaySec!==undefined&&(!Number.isFinite(lockDelaySec)||lockDelaySec<1||lockDelaySec>30)||launchDelaySec!==undefined&&(!Number.isFinite(launchDelaySec)||launchDelaySec<1||launchDelaySec>30))throw Error('告警等待时间须为1至30秒');
  notePlayerDefenseOrder(world,unit);Object.assign(d,Object.fromEntries(Object.entries({mode,lockDelaySec,launchDelaySec}).filter(([,v])=>v!==undefined)));
  if(mode==='auto'&&d.episode){d.episode.playerOverride=false;d.episode.autoAt=world.time+(d.episode.level==='launch'?d.launchDelaySec:d.lockDelaySec);}
  rwrEvent(unit,world.time,'policy',d.mode==='report_only'?'告警只报告，不自主规避':'告警后先等待玩家指令，再按设置延迟自主规避');
  world.revision++;
}
export function stepRwrDefense(world){
  for(const u of world.units){const d=u.rwrDefense;if(!d)continue;d.suspended=!!world.playerCommandPending;
    const c=strongestRwr(u,world.time),fresh=c&&world.time-c.observedAt<.35;
    if(!u.rwr?.available||!u.rwr.enabled||!usable(u)){if(d.active){d.active=null;u.navigationKey=null;}continue;}
    if(c&&RWR_LEVELS[c.level]>=2){
      const key=c.id+':'+c.epoch;
      // A lower-priority indication cannot reset a higher-priority player's decision.
      if((!d.episode||d.episode.key!==key)&&(!d.episode||RWR_LEVELS[c.level]>=RWR_LEVELS[d.episode.level]||world.time-d.episode.lastSeen>5)){
        d.episode={key,contactId:c.id,epoch:c.epoch,level:c.level,bearingDeg:c.bearingDeg,firstSeen:world.time,lastSeen:c.observedAt,
          autoAt:world.time+(c.level==='launch'?d.launchDelaySec:d.lockDelaySec),playerOverride:false,reviewed:false};d.modelReview=null;
        rwrEvent(u,world.time,'assessment',`${c.level==='launch'?'疑似雷达导弹发射':'持续雷达跟踪'}，${d.mode==='report_only'?'当前只报告，按玩家任务飞行':`先报告并等待指令；${c.level==='launch'?d.launchDelaySec:d.lockDelaySec}秒后可自主规避`}`,{episodeKey:key,level:c.level,bearingDeg:c.bearingDeg});
      }
      if(d.episode?.contactId===c.id){d.episode.bearingDeg=c.bearingDeg;d.episode.lastSeen=c.observedAt;}
    }
    const e=d.episode;
    if(d.suspended){if(e)e.autoAt=world.time+(e.level==='launch'?d.launchDelaySec:d.lockDelaySec);continue;}
    if(d.active){
      if(d.active.manual&&world.time>=d.active.until||!d.active.manual&&(!e||e.playerOverride||world.time-e.lastSeen>5||d.mode!=='auto')){
        d.active=null;u.navigationKey=null;rwrEvent(u,world.time,'resume','本次规避结束，接回原任务；信号消失不等于导弹已被击败');
      }else if(!d.active.manual&&e){d.active.headingDeg=defenseHeading(u,e.bearingDeg,d.active.maneuver,d.active.side);}
    }
    if(!e||d.active||e.playerOverride||d.mode!=='auto'||world.time<e.autoAt||!fresh||c.id!==e.contactId)continue;
    const recommendation=d.modelReview?.episodeKey===e.key?d.modelReview:null;
    const maneuver=recommendation?.maneuver??'notch',side=recommendation?.side??'auto';
    d.active={episodeKey:e.key,maneuver,side,headingDeg:defenseHeading(u,e.bearingDeg,maneuver,side),altitudeM:u.position[2],startedAt:world.time,manual:false,
      decidedBy:recommendation?'pilot_model':'local_rule'};
    rwrEvent(u,world.time,'evading',`等待期间未收到玩家新指令，开始${maneuver==='notch'?'横切规避':'背向脱离'}，保留原任务`);
  }
}
export function defenseGuidance(unit){const d=unit.rwrDefense;return d&&d.active&&usable(unit)?d.active:null;}
export function validateDefenseOrder(o){
  if(!o||Object.keys(o).length!==4||!DEFENSE_ORDER_KEYS.every(k=>Object.hasOwn(o,k))||!['auto','report_only','execute'].includes(o.mode)||![null,'notch','extend'].includes(o.maneuver)||!['auto','left','right'].includes(o.side)||!(o.headingDeg===null||Number.isFinite(o.headingDeg)&&o.headingDeg>=0&&o.headingDeg<=360))throw Error('自卫规避指令格式无效');
  if(o.mode!=='execute'&&(o.maneuver!==null||o.side!=='auto'||o.headingDeg!==null))throw Error('防御策略不能附带立即机动参数');return o;
}
export function validateDefenseTask(world,unit,o){
  validateDefenseOrder(o);if(!unit?.rwr?.available||unit.alive===false)throw Error('本机无可用RWR自卫系统');
  if(o.mode==='execute'&&(!usable(unit)||!Number.isFinite(o.headingDeg)&&!strongestRwr(unit,world.time)))throw Error('当前没有可用告警方向或安全机动阶段，请明确规避航向');
}
export function applyDefenseTask(world,unit,o){
  validateDefenseTask(world,unit,o);const d=unit.rwrDefense;
  notePlayerDefenseOrder(world,unit);
  if(o.mode!=='execute'){d.mode=o.mode;if(o.mode==='auto'&&d.episode){d.episode.playerOverride=false;d.episode.autoAt=world.time+(d.episode.level==='launch'?d.launchDelaySec:d.lockDelaySec);}rwrEvent(unit,world.time,'policy',o.mode==='report_only'?'告警只报告，不自主规避':'恢复告警后延迟自主规避');return;}
  const c=strongestRwr(unit,world.time),maneuver=o.maneuver??'notch';
  d.active={episodeKey:d.episode?.key??'manual',maneuver,side:o.side,headingDeg:o.headingDeg??defenseHeading(unit,c.bearingDeg,maneuver,o.side),altitudeM:unit.position[2],startedAt:world.time,until:world.time+20,manual:true,decidedBy:'player'};
}
export function defenseContext(unit){
  const d=unit.rwrDefense;if(!d)return null;
  return structuredClone({mode:d.mode,lockDelaySec:d.lockDelaySec,launchDelaySec:d.launchDelaySec,controlSequence:d.controlSequence,
    episode:d.episode,active:d.active,suspended:d.suspended});
}
export function parseDefenseContext(d,time){
  if(d==null)return null;
  if(!DEFENSE_MODES.includes(d.mode)||!['lockDelaySec','launchDelaySec'].every(k=>Number.isFinite(d[k])&&d[k]>=1&&d[k]<=30)||!Number.isSafeInteger(d.controlSequence)||d.controlSequence<0||typeof d.suspended!=='boolean')throw Error('防御策略上下文无效');
  if(d.episode){const e=d.episode;if(typeof e.key!=='string'||e.key.length>100||!/^RWR-\d+$/.test(e.contactId)||!['track','launch'].includes(e.level)||!Number.isInteger(e.epoch)||e.epoch<1||!['bearingDeg','firstSeen','lastSeen','autoAt'].every(k=>Number.isFinite(e[k])&&e[k]>=0)||e.bearingDeg>=360||e.firstSeen>time+.001||e.lastSeen>time+.001||typeof e.playerOverride!=='boolean'||typeof e.reviewed!=='boolean')throw Error('告警处置状态无效');}
  if(d.active){const a=d.active;if(!['notch','extend'].includes(a.maneuver)||!['auto','left','right'].includes(a.side)||!['headingDeg','altitudeM','startedAt'].every(k=>Number.isFinite(a[k]))||a.headingDeg<0||a.headingDeg>360||a.startedAt>time+.001||typeof a.manual!=='boolean')throw Error('规避状态无效');}
  return {mode:d.mode,lockDelaySec:d.lockDelaySec,launchDelaySec:d.launchDelaySec,controlSequence:d.controlSequence,suspended:d.suspended,
    episode:d.episode?Object.fromEntries(['key','contactId','epoch','level','bearingDeg','firstSeen','lastSeen','autoAt','playerOverride','reviewed'].map(k=>[k,d.episode[k]])):null,
    active:d.active?Object.fromEntries(['episodeKey','maneuver','side','headingDeg','altitudeM','startedAt','until','manual','decidedBy'].filter(k=>d.active[k]!==undefined).map(k=>[k,d.active[k]])):null};
}
export function defenseTaskFor(order,context){
  const p=order.parameters,allowed=['mode','side','headingDeg'];
  if(![null,'auto','execute','report_only','hold','cancel','off'].includes(p.mode)||![null,'auto','left','right'].includes(p.side))throw Error('未支持的告警策略或规避方向');
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!allowed.includes(k)))throw Error('当前自卫支持横切或背向规避，请将额外飞行限制单独下达');
  const mode=['report_only','hold','cancel','off'].includes(p.mode)?'report_only':p.mode==='auto'?'auto':'execute';
  return order.unitIds.map(unitId=>{if(!context.units.find(u=>u.id===unitId)?.rwr?.available)throw Error('本机未配置雷达告警接收器');return {unitId,action:'defense',defenseOrder:{mode,maneuver:mode==='execute'?(order.intent==='drag'?'extend':'notch'):null,side:mode==='execute'?p.side??'auto':'auto',headingDeg:mode==='execute'?p.headingDeg:null}};});
}
export function defensePhrase(o,en=false){return o.mode==='auto'?(en?'ENABLE DELAYED SELF DEFENSE':'恢复告警后延迟自主规避'):o.mode==='report_only'?(en?'REPORT WARNINGS ONLY, NO AUTONOMOUS EVASION':'告警只报告，不自主规避'):
  (en?`${o.maneuver==='extend'?'EXTEND AWAY':'NOTCH'} ${o.side.toUpperCase()}${o.headingDeg!==null?', HEADING '+o.headingDeg:''}`:`${o.side==='left'?'向左':o.side==='right'?'向右':''}${o.maneuver==='extend'?'背向脱离':'横切规避'}${o.headingDeg!==null?'，航向'+o.headingDeg+'度':''}`);}
