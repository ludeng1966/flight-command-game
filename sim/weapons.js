import {MISSILE_MODELS,missileModel,spawnMissile,seekerObservation,lineClear,GUIDANCE_LABELS} from './missiles.js';
import {norm} from './flight.js';
import {observedContact} from './battle-observation.js';
import {notePlayerOrder} from './command-scope.js';
import {radarTarget,radarSupport} from './radar-quality.js';
import {visualObservationsV2} from './visual-observation.js';
import {parseV2Contact} from './radar-v2.js';
import {trackUsable} from './radar-quality.js';

export const WEAPON_INTENTS=['select_weapon','launch_weapon','weapons_hold','weapons_tight','weapons_free','cease_fire'];
export const WEAPON_OPERATIONS=['select','designate','launch','hold','tight','free'];
export const WEAPON_ORDER_KEYS=['operation','modelId','targetId','quantity'];
// Direct fire is explicit player authorization. An attack task also authorizes
// fire, but TIGHT requires a named target or hostile identification. ROE never
// permits friendly fire and FREE by itself never creates an attack task.
export function engagementPermission(own,contact,{authorization='autonomous',task=own.attackTask}={}){
  if(!contact)return {allowed:false,reason:'没有新鲜目标观测'};
  if(contact.classification==='friendly'||contact.id===own.id)return {allowed:false,reason:'已识别友机，禁止发射'};
  if(authorization==='direct')return {allowed:true,reason:'玩家明确发射令'};
  const named=task?.targetId===contact.id||!!task?.targetRef&&[contact.id,contact.callsign].some(v=>String(v??'').toLowerCase()===task.targetRef.toLowerCase());
  if(own.weapons?.roe==='tight'&&contact.classification!=='hostile'&&!named)return {allowed:false,reason:'严格识别规则：不明航迹需要明确点名授权'};
  if(authorization==='attack'&&task?.active)return {allowed:true,reason:named?'玩家明确指定目标':'当前攻击任务授权'};
  if(own.weapons?.roe==='hold')return {allowed:false,reason:'武器保持：等待明确发射令或攻击任务'};
  return {allowed:own.weapons?.roe==='free'||contact.classification==='hostile',reason:'按交战规则与识别结果判断'};
}
const preferred=['us_aim_120b','us_aim7p_sparrow_fa_18','us_aim9m_sidewinder','cn_pl12','su_pl5e2'];
export const F16_LOADOUT_ID='f16-4aim120b-2aim9m-v1';
export const F16_LOADOUT=Object.freeze({us_aim_120b:4,us_aim9m_sidewinder:2});
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export function createWeapons(profileId,loadout){
  const inventory=profileId==='f16'?F16_LOADOUT:loadout??{};
  if(!inventory||typeof inventory!=='object'||Array.isArray(inventory)||Object.entries(inventory).some(([id,n])=>!MISSILE_MODELS.has(id)||!Number.isInteger(n)||n<0||n>12))throw Error('导弹挂载无效');
  return {...(profileId==='f16'?{loadoutId:F16_LOADOUT_ID}:{}),inventory:{...inventory},selectedModelId:Object.keys(inventory)[0]??null,targetId:null,roe:'hold',readySec:0,ready:false,reason:'请指定目标',contacts:[],lastLaunch:null,sequence:0};
}
// Upgrade the previous five-types/two-each inventory once. Preserve rounds spent
// from that loadout, flight state, targets and missiles already in the air.
export function restoreCarrierLoadout(profileId,weapons){
  if(profileId!=='f16')return weapons;
  if(!weapons)return createWeapons('f16');
  const old=weapons.inventory,legacy=weapons.loadoutId!==F16_LOADOUT_ID&&preferred.every(id=>Object.hasOwn(old,id)&&old[id]<=2);
  weapons.inventory=Object.fromEntries(Object.entries(F16_LOADOUT).map(([id,capacity])=>[id,
    Math.max(0,Math.min(capacity,old[id]===undefined?capacity:old[id]+(legacy&&id==='us_aim_120b'?2:0)))]));
  weapons.loadoutId=F16_LOADOUT_ID;
  if(!Object.hasOwn(weapons.inventory,weapons.selectedModelId)){
    weapons.selectedModelId=Object.keys(weapons.inventory).find(id=>weapons.inventory[id]>0)??Object.keys(F16_LOADOUT)[0];
    weapons.readySec=0;weapons.ready=false;weapons.reason='挂载已统一，请确认目标';
  }
  return weapons;
}
const candidates=world=>[...world.units,...(world.radarTargets??[])];
export function launchAssessment(world,own,modelId=own.weapons?.selectedModelId,targetId=own.weapons?.targetId){
  const w=own.weapons,model=MISSILE_MODELS.get(modelId),target=radarTarget(world,own,targetId);
  const fail=reason=>({ready:false,reason,model,target});
  if(own.radar?.sensorModelVersion===2&&!([...(own.radar.contacts??[]),...(w?.contacts??[])].some(c=>c.id===targetId&&trackUsable(c,world.time))))return fail('没有可用目标观测，需重新搜索');
  if(!own.alive||own.surface?.grounded)return fail('需要存活且已离地的载机');
  if(!model||!(w?.inventory[modelId]>0))return fail('所选导弹已用尽或未挂载');
  if(!target||target.alive===false||target.id===own.id)return fail(own.radar?.sensorModelVersion===2?'当前无法完成发射，需重新观测':'请指定有效目标');
  if((target.team??target.faction??'blue')===(own.team??own.faction??'blue'))return fail('目标是友机，禁止发射');
  const modelReady=w.selectedModelId===modelId&&w.targetId===targetId&&w.readySec+1e-8>=(model.seeker.warmupSec??0);
  let observation;
  if(model.kind==='infrared'){
    observation=seekerObservation(model,own.position,norm(own.velocity),target,world.terrain,{launch:true});
    if(!observation)return fail('红外目标超出截获角、距离或被地形遮挡');
  }else{
    const r=own.radar,c=r?.contacts.find(c=>c.id===targetId);
    if(!radarSupport(own,targetId,model.kind,world.time).launchEligible)return fail(r?.sensorModelVersion===2?'需要本机有效火控航迹及兼容雷达支持':'需要本机雷达稳定锁定目标');
    const delta=c.position.map((v,i)=>v-own.position[i]),distance=Math.hypot(...delta),angle=Math.acos(Math.max(-1,Math.min(1,norm(delta).reduce((s,v,i)=>s+v*norm(own.velocity)[i],0))))*180/Math.PI;
    if(angle>(model.seeker.lockAngleDeg??30))return fail('目标超出导弹发射截获角');
    observation={position:c.position,velocity:c.velocity,rangeM:distance,trackId:targetId,measuredAt:c.observedAt};
  }
  if(!modelReady)return fail('导引头准备中');
  if(world.missiles.filter(m=>m.alive).length>=32)return fail('当前在空导弹数量已达上限');
  return {ready:true,reason:'可发射；不保证命中',model,target,observation};
}
export function stepWeapons(world,dt){
  for(const own of world.units){const w=own.weapons;if(!w)continue;
    // Visual designation is an explicit simplified optical sensor, independent of radar power.
    w.contacts=world.sensorModelVersion===2?visualObservationsV2(world,own,candidates(world),lineClear):candidates(world).filter(t=>t.id!==own.id&&t.alive!==false&&Math.hypot(...t.position.map((v,i)=>v-own.position[i]))<=11000&&
      norm(t.position.map((v,i)=>v-own.position[i])).reduce((sum,v,i)=>sum+v*norm(own.velocity)[i],0)>.5&&lineClear(world.terrain,own.position,t.position))
      .slice(0,32).map(t=>({id:t.id,callsign:t.callsign??t.id,classification:(t.team??t.faction??'blue')===(own.team??own.faction??'blue')?'friendly':'unknown',source:'visual',observedAt:world.time,position:[...t.position],velocity:[...t.velocity]}));
    const m=MISSILE_MODELS.get(w.selectedModelId);
    if(m?.kind!=='infrared'&&own.radar?.targetId&&w.targetId!==own.radar.targetId){w.targetId=own.radar.targetId;}
    const target=radarTarget(world,own,w.targetId);
    const lock=m&&target&&own.alive&&!own.surface?.grounded&&(m.kind==='infrared'?
      seekerObservation(m,own.position,norm(own.velocity),target,world.terrain,{launch:true}):own.radar?.mode!=='off');
    // Radar missile electronics can prepare before a fire-control window.
    // Launch readiness still requires fresh radarSupport in launchAssessment.
    w.readySec=(m&&m.kind!=='infrared'&&own.alive&&!own.surface?.grounded&&own.radar?.mode!=='off'||lock)?w.readySec+dt:0;
    const assessment=launchAssessment(world,own);w.ready=assessment.ready;w.reason=assessment.reason;
  }
}
export function validateWeaponOrder(world,own,o){
  if(!own?.weapons||own.alive===false)throw Error('飞机或武器系统不可用');
  if(!o||Object.keys(o).length!==4||!WEAPON_ORDER_KEYS.every(k=>Object.hasOwn(o,k))||!WEAPON_OPERATIONS.includes(o.operation))throw Error('武器口令格式无效');
  if(o.operation==='select'){
    if(!MISSILE_MODELS.has(o.modelId)||!Object.hasOwn(own.weapons.inventory,o.modelId)||o.targetId!==null||o.quantity!==null)throw Error('请选择本机挂载的具体导弹');
  }else if(o.operation==='designate'){
    if(o.modelId!==null||o.quantity!==null||typeof o.targetId!=='string'||!((own.weapons.contacts??[]).some(c=>c.id===o.targetId)||(own.radar?.contacts??[]).some(c=>c.id===o.targetId)))throw Error('目标尚未被本机发现');
  }else if(o.operation==='launch'){
    if(!Number.isInteger(o.quantity)||o.quantity<1||o.quantity>4)throw Error('单次发射数量须为1至4枚');
    const a=launchAssessment(world,own,o.modelId,o.targetId);if(!a.ready)throw Error(a.reason);
    if(own.weapons.inventory[o.modelId]<o.quantity)throw Error('剩余导弹不足');
    if(world.missiles.filter(m=>m.alive).length+o.quantity>32)throw Error('当前在空导弹数量已达上限');
  }else if(o.modelId!==null||o.targetId!==null||o.quantity!==null)throw Error('交战规则不接受额外发射参数');
  return o;
}
export function applyWeaponOrder(world,own,o,{autonomous=false}={}){
  validateWeaponOrder(world,own,o);const w=own.weapons;
  // ROE adjusts the existing mission's engagement constraints. It is not a
  // manual takeover of targeting or launch control; HOLD remains a cease-fire.
  if(!autonomous&&!['free','tight'].includes(o.operation)&&own.attackTask?.active){own.attackTask.active=false;own.attackTask.status='cancelled';own.attackTask.pending=false;}
  if(o.operation==='select'){if(w.selectedModelId!==o.modelId){w.readySec=0;w.ready=false;}w.selectedModelId=o.modelId;}
  else if(o.operation==='designate'){if(w.targetId!==o.targetId&&MISSILE_MODELS.get(w.selectedModelId)?.kind==='infrared')w.readySec=0;w.targetId=o.targetId;w.ready=false;}
  else if(o.operation==='launch'){
    const assessment=launchAssessment(world,own,o.modelId,o.targetId),ids=[];
    for(let i=0;i<o.quantity;i++){const m=spawnMissile(world,own,assessment.target,assessment.model,assessment.observation);ids.push(m.id);w.inventory[o.modelId]--;}
    w.lastLaunch={sequence:++w.sequence,modelId:o.modelId,targetId:o.targetId,quantity:o.quantity,missileIds:ids,time:world.time};
    world.weaponEvents.push({id:ids.join(','),time:world.time,type:'launch',ownerId:own.id,targetId:o.targetId,text:assessment.model.familyName+' 发射 '+o.quantity+' 枚'});
    w.ready=false;
  }else w.roe=o.operation;
  if(!autonomous)notePlayerOrder(world,[own.id]);
}
export function weaponsContext(own,time){
  const w=own.weapons;if(!w)return null;
  return {inventory:{...w.inventory},selectedModelId:w.selectedModelId,targetId:w.targetId,roe:w.roe,ready:w.ready,reason:w.reason,
    contacts:w.contacts.filter(c=>c.sensorModelVersion===2?trackUsable(c,time):time-c.observedAt<=.2).map(c=>observedContact(structuredClone(c),time,'visual')),lastLaunch:w.lastLaunch?structuredClone(w.lastLaunch):null};
}
export function parseWeaponsContext(w,time){
  if(w==null)return null;
  createWeapons('none',w.inventory);
  if(!(w.selectedModelId===null||Object.hasOwn(w.inventory,w.selectedModelId))||!(w.targetId===null||typeof w.targetId==='string'&&w.targetId.length<=64)||
    !['hold','tight','free'].includes(w.roe)||typeof w.ready!=='boolean'||typeof w.reason!=='string'||w.reason.length>160||!Array.isArray(w.contacts)||w.contacts.length>32)throw Error('武器上下文无效');
  const ids=new Set();for(const c of w.contacts){if(!c||typeof c.id!=='string'||c.id.length>64||ids.has(c.id)||typeof c.callsign!=='string'||c.callsign.length>80||!['friendly','unknown'].includes(c.classification)||!vec(c.position)||!vec(c.velocity)||!Number.isFinite(c.observedAt)||c.observedAt<0||c.observedAt>time+.001)throw Error('光学观测无效');ids.add(c.id);}
  if(w.lastLaunch!==null&&(!w.lastLaunch||!MISSILE_MODELS.has(w.lastLaunch.modelId)||!Number.isInteger(w.lastLaunch.quantity)||w.lastLaunch.quantity<1||w.lastLaunch.quantity>4||!Array.isArray(w.lastLaunch.missileIds)||w.lastLaunch.missileIds.length!==w.lastLaunch.quantity||w.lastLaunch.missileIds.some(id=>typeof id!=='string'||!/^missile-\d+$/.test(id))||!Number.isFinite(w.lastLaunch.time)||w.lastLaunch.time>time+.001||typeof w.lastLaunch.targetId!=='string'))throw Error('发射记录无效');
  return {inventory:{...w.inventory},selectedModelId:w.selectedModelId,targetId:w.targetId,roe:w.roe,ready:w.ready,reason:w.reason,
    contacts:w.contacts.map(c=>c.sensorModelVersion===2?observedContact({...parseV2Contact(c,time),source:'visual'},time,'visual'):observedContact({id:c.id,callsign:c.callsign,classification:c.classification,position:[...c.position],velocity:[...c.velocity],observedAt:c.observedAt},time,'visual')),lastLaunch:w.lastLaunch?structuredClone(w.lastLaunch):null};
}
export function weaponPhrase(o,english=false){
  const model=MISSILE_MODELS.get(o.modelId),name=model?model.id.replace(/^us_|^cn_|^su_/,'').replaceAll('_',' ').toUpperCase():o.modelId;
  if(o.operation==='select')return english?`SELECT ${name}`:`选择导弹 ${name}`;
  if(o.operation==='designate')return english?`DESIGNATE TARGET ${o.targetId}`:`指定武器目标 ${o.targetId}`;
  if(o.operation==='launch')return english?`FIRE ${o.quantity} ${name} AT TARGET ${o.targetId}`:`向目标 ${o.targetId} 发射 ${o.quantity} 枚 ${name}`;
  return english?`WEAPONS ${o.operation.toUpperCase()}`:({hold:'武器保持，仅接受明确发射令',tight:'严格识别后交战，不自动发射',free:'放宽交战规则，不自动发射'})[o.operation];
}
function resolveModel(text,unit){
  if(!text)return unit.weapons?.selectedModelId;
  const ids=Object.keys(unit.weapons?.inventory??{}),clean=s=>s.replace(/[^a-z0-9]/gi,'').toLowerCase(),ref=clean(text);
  const exact=ids.find(id=>clean(id)===ref||clean(id.replace(/^(us|cn|su)_/,''))===ref);if(exact)return exact;
  const families=ids.filter(id=>{const m=missileModel(id);return clean(m.familyName)===ref||(['红外导弹','红外制导导弹','infrared'].includes(text)&&m.kind==='infrared')||(['雷达导弹','雷达制导导弹'].includes(text)&&m.kind!=='infrared');});
  if(families.includes(unit.weapons?.selectedModelId))return unit.weapons.selectedModelId;
  if(families.length===1)return families[0];throw Error('请明确已挂载的导弹型号');
}
export function weaponTaskFor(order,context){
  const p=order.parameters,roe=({weapons_hold:'hold',weapons_tight:'tight',weapons_free:'free',cease_fire:'hold'})[order.intent];
  const allowed=order.intent==='launch_weapon'?['weapon','targetId','targetRef','quantity']:order.intent==='select_weapon'?['weapon']:roe?['mode']:[];
  // Some models repeat the intent's ROE in mode. Accept only the identical
  // setting; conflicting modes and every other unsupported constraint remain errors.
  if(roe&&p.mode!=null&&(typeof p.mode!=='string'||p.mode.trim().toLowerCase()!==roe))throw Error('交战规则意图与mode冲突，请明确同一种规则');
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!allowed.includes(k)))throw Error('武器操作请与导航、条件或其他限制分条下达');
  return order.unitIds.map(unitId=>{
    const unit=context.units.find(u=>u.id===unitId);if(!unit?.weapons)throw Error('本机武器系统未接入');
    const modelId=['select_weapon','launch_weapon'].includes(order.intent)?resolveModel(p.weapon,unit):null;
    let targetId=p.targetId;
    if(!targetId&&p.targetRef){const ref=p.targetRef.trim().toLowerCase(),matches=[...(unit.radar?.contacts??[]),...unit.weapons.contacts].filter(c=>[c.id,c.callsign].some(s=>s.toLowerCase()===ref));targetId=[...new Set(matches.map(c=>c.id))].length===1?matches[0].id:null;}
    if(p.targetRef&&!targetId)throw Error('指定目标不在本机已发现航迹中，不能改为其他目标');
    if(order.intent==='launch_weapon'){
      targetId??=unit.weapons.targetId??unit.radar?.targetId;
      if(!targetId)throw Error('请指定本机已发现的目标');
      if(!(unit.weapons.inventory[modelId]>=(p.quantity??1)))throw Error('本机所选导弹数量不足');
      // Selecting/designating is explicit state; readiness is always rechecked in the simulator.
    }
    const operation=({select_weapon:'select',launch_weapon:'launch',weapons_hold:'hold',weapons_tight:'tight',weapons_free:'free',cease_fire:'hold'})[order.intent];
    return {unitId,action:'weapon',weaponOrder:{operation,modelId,targetId:operation==='launch'?targetId:null,quantity:operation==='launch'?p.quantity??1:null}};
  });
}
export {GUIDANCE_LABELS};
