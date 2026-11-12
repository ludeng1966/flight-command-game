import {strongestRwr,RWR_LEVELS,rwrEvent,angleDifference} from './rwr.js';
import {notePlayerOrder} from './command-scope.js';
export const DEFENSE_MODES=['auto','report_only'];
export const DEFENSE_ORDER_KEYS=['mode','maneuver','side','headingDeg'];
export const DEFENSE_SCHEMA={type:'object',additionalProperties:false,required:DEFENSE_ORDER_KEYS,properties:{mode:{enum:['auto','report_only','execute']},maneuver:{enum:[null,'notch','extend']},side:{enum:['auto','left','right']},headingDeg:{type:['number','null'],minimum:0,maximum:360}}};
export function createRwrDefense(){return {mode:'auto',lockDelaySec:0,launchDelaySec:0,flightOrderPriority:false,controlSequence:0,episode:null,active:null,manual:null,suspended:false,modelReview:null};}
const heading=u=>(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360;
const usable=u=>u.alive!==false&&!u.surface?.grounded&&!['final','approach'].includes(u.surface?.phase)&&u.flightState==='normal'&&
  (u.surface?.phase!=='climb'||u.position[2]-(u.terrain?.heightAt?.(u.position[0],u.position[1])??0)>=300);
export function defenseHeading(unit,bearing,maneuver,side='auto'){
  if(maneuver==='extend')return (bearing+180)%360;
  const current=heading(unit),options=[(bearing+90)%360,(bearing+270)%360];
  if(side!=='auto')return options.find(h=>{const delta=((h-current+540)%360)-180;return side==='right'?delta>=0:delta<0;})??options[0];
  return options.sort((a,b)=>angleDifference(a,current)-angleDifference(b,current))[0];
}
const wrap=n=>(n%360+360)%360;
// Keep the chosen side of the emitter, rather than reinterpreting left/right
// from a moving nose every frame (which can flip the target heading by 180°).
export function defenseCandidateHeading(unit,bearing,maneuver,side='auto'){
  const active=unit.rwrDefense?.active;
  if(active&&!active.manual&&active.maneuver===maneuver&&active.side===side&&Number.isFinite(active.bearingOffsetDeg))return wrap(bearing+active.bearingOffsetDeg);
  return defenseHeading(unit,bearing,maneuver,side);
}
export function applyDefenseRecommendation(unit,decision){
  const d=unit.rwrDefense,a=d?.active,e=d?.episode;
  if(!a||a.manual||!e)return false;
  if(decision.maneuver==='maintain'){a.decidedBy='pilot_model';return true;}
  const target=defenseCandidateHeading(unit,e.bearingDeg,decision.maneuver,decision.side);
  Object.assign(a,{maneuver:decision.maneuver,side:decision.side,headingDeg:target,bearingOffsetDeg:wrap(target-e.bearingDeg),decidedBy:'pilot_model'});return true;
}
export function defenseReviewSignature(unit,time){
  const signals=(unit.rwr?.contacts??[]).filter(c=>RWR_LEVELS[c.level]>=2&&time-c.observedAt<=2.5)
    .map(c=>`${c.id}:${c.epoch}:${c.level}:${Math.round(c.bearingDeg/30)%12}`).sort();
  const active=unit.rwrDefense?.active;
  return JSON.stringify([signals,active?[active.maneuver,active.side]:null]);
}
// Inference remains event driven and bounded. A continuing warning alone is
// not a failed manoeuvre; periodically reassess its geometry/energy instead.
export function defenseReviewEvent(unit,time){
  const d=unit.rwrDefense,e=d?.episode;
  if(unit.alive===false||!unit.rwr?.available||!unit.rwr.enabled||!d||d.mode!=='auto'||d.suspended||d.active?.manual||!e||e.playerOverride||
    !unit.rwr.contacts.some(c=>c.id===e.contactId&&c.epoch===e.epoch&&RWR_LEVELS[c.level]>=2&&time-c.observedAt<=2.5)||time<(e.reviewRetryAt??0))return null;
  const signature=defenseReviewSignature(unit,time),elapsed=time-(e.reviewedAt??e.firstSeen);
  const reason=!e.reviewed?'new_warning':elapsed>=3&&signature!==e.reviewSignature?'signals_changed':elapsed>=12?'periodic_review':null;
  return reason?{reason,signature}:null;
}
export function notePlayerDefenseOrder(world,unit){
  if(world.autonomousCommand)return;
  const d=unit?.rwrDefense;if(!d)return;
  const wasActive=!!d.active;d.controlSequence++;d.flightOrderPriority=true;d.active=null;d.manual=null;d.modelReview=null;
  if(d.episode)d.episode.playerOverride=true;
  if(wasActive)rwrEvent(unit,world.time,'player_control','收到玩家新指令，停止自主规避，执行新任务');
  // Resume navigation by recomputing it from the real post-manoeuvre position.
  if(wasActive)unit.navigationKey=null;
}
export function configureDefense(world,unit,{mode,lockDelaySec,launchDelaySec}){
  const d=unit?.rwrDefense;if(!d||!unit.rwr?.available)throw Error('本机没有雷达告警接收器');
  if(mode!==undefined&&!DEFENSE_MODES.includes(mode)||lockDelaySec!==undefined&&(!Number.isFinite(lockDelaySec)||lockDelaySec<0||lockDelaySec>30)||launchDelaySec!==undefined&&(!Number.isFinite(launchDelaySec)||launchDelaySec<0||launchDelaySec>30))throw Error('告警策略参数无效');
  notePlayerDefenseOrder(world,unit);Object.assign(d,Object.fromEntries(Object.entries({mode,lockDelaySec,launchDelaySec}).filter(([,v])=>v!==undefined)));
  d.lockDelaySec=0;d.launchDelaySec=0;
  if(mode==='auto'){d.flightOrderPriority=false;if(d.episode){d.episode.playerOverride=false;d.episode.autoAt=world.time;}}
  rwrEvent(unit,world.time,'policy',d.mode==='report_only'?'告警只报告，不自主规避':'威胁下立即自主规避；与明确飞行指令冲突时指令优先');
  world.revision++;notePlayerOrder(world,[unit.id]);
}
export function stepRwrDefense(world){
  for(const u of world.units){const d=u.rwrDefense;if(!d)continue;
    // Legacy delay settings are retained only for save compatibility.
    d.lockDelaySec=0;d.launchDelaySec=0;if(d.episode)d.episode.autoAt=Math.min(d.episode.autoAt,world.time);
    // Typing, speech and slow planning have no authority until an order commits.
    // Keep the original warning deadline; an installed player order still wins.
    d.suspended=false;
    let c=strongestRwr(u,world.time);
    const current=d.episode&&(u.rwr?.contacts??[]).find(c=>c.id===d.episode.contactId&&c.epoch===d.episode.epoch&&c.level===d.episode.level&&world.time-c.observedAt<=2.5);
    // Sampling order is not a new tactical episode. Retain a recent source
    // until its level changes, a higher-level signal arrives or it goes stale.
    if(current&&(!c||RWR_LEVELS[current.level]>=RWR_LEVELS[c.level]))c=current;
    const fresh=c&&world.time-c.observedAt<.35;
    if(!u.rwr?.available||!u.rwr.enabled||!usable(u)){if(d.active){d.active=null;u.navigationKey=null;}continue;}
    if(c&&RWR_LEVELS[c.level]>=2){
      const key=c.id+':'+c.epoch;
      // A lower-priority indication cannot reset a higher-priority player's decision.
      if((!d.episode||d.episode.key!==key)&&(!d.episode||RWR_LEVELS[c.level]>=RWR_LEVELS[d.episode.level]||world.time-d.episode.lastSeen>5)){
        const deadline=world.time;
        d.episode={key,contactId:c.id,epoch:c.epoch,level:c.level,bearingDeg:c.bearingDeg,firstSeen:world.time,lastSeen:c.observedAt,
          autoAt:deadline,playerOverride:d.flightOrderPriority===true,reviewed:false};d.modelReview=null;
        if(d.active&&!d.active.manual){const a=d.active,options=a.maneuver==='extend'?[wrap(c.bearingDeg+180)]:[wrap(c.bearingDeg+90),wrap(c.bearingDeg+270)];
          const target=options.sort((x,y)=>angleDifference(x,a.headingDeg)-angleDifference(y,a.headingDeg))[0];a.episodeKey=key;a.bearingOffsetDeg=wrap(target-c.bearingDeg);}
        rwrEvent(u,world.time,'assessment',`${c.level==='launch'?'疑似雷达导弹发射':'持续雷达跟踪'}，${d.mode==='report_only'?'当前只报告，按玩家任务飞行':d.flightOrderPriority?'规避与明确飞行指令冲突，优先执行指令':'立即自主规避并报告'}`,{episodeKey:key,level:c.level,bearingDeg:c.bearingDeg});
      }
      if(d.episode?.contactId===c.id){d.episode.bearingDeg=c.bearingDeg;d.episode.lastSeen=c.observedAt;}
    }
    const e=d.episode;
    if(d.active){
      if(d.active.manual&&world.time>=d.active.until||!d.active.manual&&(!e||e.playerOverride||world.time-e.lastSeen>5||d.mode!=='auto')){
        if(d.active.manual&&world.time>=d.active.until){d.flightOrderPriority=false;if(e)e.playerOverride=false;}
        d.active=null;u.navigationKey=null;rwrEvent(u,world.time,'resume','本次规避结束，接回原任务；信号消失不等于导弹已被击败');
      }else if(!d.active.manual&&e){const a=d.active;a.bearingOffsetDeg??=wrap(a.headingDeg-e.bearingDeg);a.headingDeg=wrap(e.bearingDeg+a.bearingOffsetDeg);}
    }
    if(!e||d.active||e.playerOverride||d.mode!=='auto'||world.time<e.autoAt||!fresh||c.id!==e.contactId)continue;
    const recommendation=d.modelReview?.episodeKey===e.key?d.modelReview:null;
    const maneuver=['notch','extend'].includes(recommendation?.maneuver)?recommendation.maneuver:'notch',side=recommendation?.side??'auto';
    const target=defenseHeading(u,e.bearingDeg,maneuver,side);
    d.active={episodeKey:e.key,maneuver,side,headingDeg:target,bearingOffsetDeg:wrap(target-e.bearingDeg),altitudeM:u.position[2],startedAt:world.time,manual:false,
      decidedBy:recommendation?'pilot_model':'local_rule'};
    rwrEvent(u,world.time,'evading',`检测到威胁，开始${maneuver==='notch'?'横切规避':'背向脱离'}，保留原任务`,{level:e.level,bearingDeg:e.bearingDeg,episodeKey:e.key});
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
  if(o.mode!=='execute'){d.mode=o.mode;if(o.mode==='auto'){d.flightOrderPriority=false;if(d.episode){d.episode.playerOverride=false;d.episode.autoAt=world.time;}}rwrEvent(unit,world.time,'policy',o.mode==='report_only'?'告警只报告，不自主规避':'恢复威胁下立即自主规避');return;}
  const c=strongestRwr(unit,world.time),maneuver=o.maneuver??'notch';
  d.active={episodeKey:d.episode?.key??'manual',maneuver,side:o.side,headingDeg:o.headingDeg??defenseHeading(unit,c.bearingDeg,maneuver,o.side),altitudeM:unit.position[2],startedAt:world.time,until:world.time+20,manual:true,decidedBy:'player'};
}
export function defenseContext(unit){
  const d=unit.rwrDefense;if(!d)return null;
  return structuredClone({mode:d.mode,lockDelaySec:d.lockDelaySec,launchDelaySec:d.launchDelaySec,controlSequence:d.controlSequence,
    episode:d.episode,active:d.active,suspended:d.suspended,flightOrderPriority:d.flightOrderPriority===true});
}
export function parseDefenseContext(d,time){
  if(d==null)return null;
  if(d.flightOrderPriority!==undefined&&typeof d.flightOrderPriority!=='boolean')throw Error('飞行指令优先级无效');
  if(!DEFENSE_MODES.includes(d.mode)||!['lockDelaySec','launchDelaySec'].every(k=>Number.isFinite(d[k])&&d[k]>=0&&d[k]<=30)||!Number.isSafeInteger(d.controlSequence)||d.controlSequence<0||typeof d.suspended!=='boolean')throw Error('防御策略上下文无效');
  if(d.episode){const e=d.episode;if(typeof e.key!=='string'||e.key.length>100||!/^RWR-\d+$/.test(e.contactId)||!['track','launch'].includes(e.level)||!Number.isInteger(e.epoch)||e.epoch<1||!['bearingDeg','firstSeen','lastSeen','autoAt'].every(k=>Number.isFinite(e[k])&&e[k]>=0)||e.bearingDeg>=360||e.firstSeen>time+.001||e.lastSeen>time+.001||typeof e.playerOverride!=='boolean'||typeof e.reviewed!=='boolean')throw Error('告警处置状态无效');}
  if(d.episode){const e=d.episode;for(const k of ['reviewedAt','reviewRetryAt'])if(e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0||k==='reviewedAt'&&e[k]>time+.001))throw Error('告警复核时间无效');if(e.reviewSignature!==undefined&&(typeof e.reviewSignature!=='string'||e.reviewSignature.length>4096))throw Error('告警复核状态无效');}
  if(d.active){const a=d.active;if(!['notch','extend'].includes(a.maneuver)||!['auto','left','right'].includes(a.side)||!['headingDeg','altitudeM','startedAt'].every(k=>Number.isFinite(a[k]))||a.headingDeg<0||a.headingDeg>360||a.startedAt>time+.001||typeof a.manual!=='boolean'||a.bearingOffsetDeg!==undefined&&(!Number.isFinite(a.bearingOffsetDeg)||a.bearingOffsetDeg<0||a.bearingOffsetDeg>=360))throw Error('规避状态无效');}
  return {mode:d.mode,lockDelaySec:0,launchDelaySec:0,controlSequence:d.controlSequence,suspended:d.suspended,flightOrderPriority:d.flightOrderPriority===true,
    episode:d.episode?Object.fromEntries(['key','contactId','epoch','level','bearingDeg','firstSeen','lastSeen','autoAt','playerOverride','reviewed','reviewedAt','reviewSignature','reviewRetryAt'].filter(k=>d.episode[k]!==undefined).map(k=>[k,d.episode[k]])):null,
    active:d.active?Object.fromEntries(['episodeKey','maneuver','side','headingDeg','bearingOffsetDeg','altitudeM','startedAt','until','manual','decidedBy'].filter(k=>d.active[k]!==undefined).map(k=>[k,d.active[k]])):null};
}
export function defenseTaskFor(order,context){
  const p=order.parameters,allowed=['mode','side','headingDeg'];
  if(![null,'auto','execute','report_only','hold','cancel','off'].includes(p.mode)||![null,'auto','left','right'].includes(p.side))throw Error('未支持的告警策略或规避方向');
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!allowed.includes(k)))throw Error('当前自卫支持横切或背向规避，请将额外飞行限制单独下达');
  const mode=['report_only','hold','cancel','off'].includes(p.mode)?'report_only':p.mode==='auto'?'auto':'execute';
  return order.unitIds.map(unitId=>{if(!context.units.find(u=>u.id===unitId)?.rwr?.available)throw Error('本机未配置雷达告警接收器');return {unitId,action:'defense',defenseOrder:{mode,maneuver:mode==='execute'?(order.intent==='drag'?'extend':'notch'):null,side:mode==='execute'?p.side??'auto':'auto',headingDeg:mode==='execute'?p.headingDeg:null}};});
}
export function defensePhrase(o,en=false){return o.mode==='auto'?(en?'ENABLE IMMEDIATE SELF DEFENSE':'恢复威胁下立即自主规避'):o.mode==='report_only'?(en?'REPORT WARNINGS ONLY, NO AUTONOMOUS EVASION':'告警只报告，不自主规避'):
  (en?`${o.maneuver==='extend'?'EXTEND AWAY':'NOTCH'} ${o.side.toUpperCase()}${o.headingDeg!==null?', HEADING '+o.headingDeg:''}`:`${o.side==='left'?'向左':o.side==='right'?'向右':''}${o.maneuver==='extend'?'背向脱离':'横切规避'}${o.headingDeg!==null?'，航向'+o.headingDeg+'度':''}`);}
