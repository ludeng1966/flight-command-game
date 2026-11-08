// Canonical vocabulary shared by model interpretation and the command display.
// These describe intent; they do not enable formation or combat execution.
export const FORMATIONS=Object.freeze([
  {id:'echelon',label:'梯队',minUnits:2,aliases:['梯队','左梯队','右梯队','echelon','echelon left','echelon right']},
  {id:'trail',label:'纵队',minUnits:2,aliases:['纵队','前后纵队','跟进队形','trail','line astern','in trail']},
  {id:'line_abreast',label:'横队',minUnits:2,aliases:['横队','左右横队','并列横队','line abreast','LAB']},
  {id:'combat_spread',label:'战斗疏开',minUnits:2,aliases:['战斗疏开','战术疏开','combat spread']},
  {id:'wedge',label:'楔形队',minUnits:2,aliases:['楔形','楔形队','楔形编队','wedge']},
  {id:'fighting_wing',label:'战斗翼队',minUnits:2,aliases:['战斗翼队','战斗僚机队形','fighting wing']},
  {id:'finger_four',label:'四指队形',minUnits:4,aliases:['四指','四指队形','四指编队','finger four','finger-four','fingertip four']}
]);
export const COOPERATION_MODES=Object.freeze([
  {id:'mutual_support',label:'相互支援',aliases:['相互支援','互相支援','互相掩护','相互掩护','mutual support']},
  {id:'loose_deuce',label:'双机自由配合',aliases:['双机自由配合','松散双机','自由双机','loose deuce']},
  {id:'thach_weave',label:'萨奇剪',aliases:['萨奇剪','萨奇交叉掩护','撒奇剪','thach weave','thach-weave']}
]);
export const FORMATION_ROLES=Object.freeze([
  {id:'lead',label:'长机',aliases:['长机','领队','leader','lead']},
  {id:'wingman',label:'僚机',aliases:['僚机','wingman']},
  {id:'engaged',label:'交战机',aliases:['交战机','engaged fighter','engaged']},
  {id:'free',label:'自由机',aliases:['自由机','free fighter','free']}
]);
const key=value=>typeof value==='string'?value.trim().toLowerCase().replace(/[-_\s]+/g,' '):'';
const canonical=(value,entries)=>entries.find(e=>[e.id,...e.aliases].some(a=>key(a)===key(value)))?.id??value;
export function normalizeFormationParameters(parameters={}){
  const p={...parameters};
  if(p.formation)p.formation=canonical(p.formation,FORMATIONS);
  if(p.mode)p.mode=canonical(p.mode,COOPERATION_MODES);
  if(p.role)p.role=canonical(p.role,FORMATION_ROLES);
  if(p.side)p.side=({左:'left',右:'right',左侧:'left',右侧:'right',left:'left',right:'right'})[p.side.toLowerCase()]??p.side;
  return p;
}
export const doctrineLabel=(entries,value)=>entries.find(e=>e.id===value)?.label??value;
export function needsFormationReading(instruction=''){
  if(/编队|队形|梯队|横队|纵队|楔形|四指|疏开|翼队|长机|僚机|集合|跟随|掩护|护航|夹击|协同|相互支援|互相支援|双机自由配合|自由双机|松散双机|交战机|自由机|萨奇|撒奇/i.test(instruction))return true;
  const normalized=instruction.replace(/[_-]/g,' ');
  return /\b(formation|echelon|trail|line abreast|LAB|combat spread|wedge|fighting wing|finger four|fingertip four|wingman|join up|follow|cover|escort|bracket|cooperate|mutual support|loose deuce|thach weave|assign role)\b/i.test(normalized);
}
