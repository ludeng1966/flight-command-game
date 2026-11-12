import {readFileSync} from 'node:fs';
import {needsFormationReading} from '../sim/formation-doctrine.js';
import {appendAviationReading,searchAviationTerms} from './aviation-terms.mjs';
import {COMMAND_CATALOG,commandById} from '../sim/military-commands.js';
import {MANUAL_FILE,manualSection} from './pilot-manual.mjs';

const manualAliases={decision_core:'core',decision_attack:'attack',decision_radar:'radar',decision_defense:'defense',decision_search:'search',decision_awareness:'evidence',decision_datalink:'evidence',
  commander_role:'commander',role:'pilot',data:'data',terms:'orders',actions:'orders',planning:'navigation',tactical_awareness:'evidence',radar_search:'orders',rwr:'orders',weapons:'orders',formation:'formation',formation_compact:'formation'};

export const HANDBOOK=Object.freeze([
  {id:'decision_index',file:'22_决策阅读入口.txt',title:'按角色与问题选择决策资料'},
  ...['core','attack','radar','defense','search','datalink','awareness'].map(id=>({id:'decision_'+id,file:MANUAL_FILE,title:`单机执行：${id}`})),
  {id:'radar_search',file:'21_雷达搜索与航迹.txt',title:'雷达搜索、覆盖与航迹质量'},
  {id:'tactical_awareness',file:'20_态势判断与能量.txt',title:'态势判断、观测边界与能量'},
  {id:'commander_role',file:'19_指挥解释职责.txt',title:'指挥解释职责'},
  {id:'rwr',file:'17_告警与自卫.txt',title:'雷达告警与玩家优先的自卫'},
  {id:'weapons',file:'16_导弹与引导.txt',title:'导弹与引导'},
  {id:'airport',file:'10_机场运行.txt',title:'机场运行'},
  {id:'airport_compact',file:'18_机场运行速记.txt',title:'机场运行速记（2B）'},
  {id:'start',file:'00_先读这里.txt',title:'先读这里'},
  {id:'result',file:'09_检查结果再复述.txt',title:'检查结果再复述'},
  {id:'units',file:'10_单位怎么读.txt',title:'单位怎么读'},
  {id:'planning',file:'12_谁来规划航路.txt',title:'谁来规划航路'},
  {id:'aviation_terms',file:'13_航空术语速查.txt',title:'航空术语速查与游戏含义'},
  {id:'aviation_faa',file:'14_FAA航空术语简释.txt',title:'FAA完整航空词库中文简释'},
  {id:'aviation_brevity',file:'15_ALSSA简语简释.txt',title:'ALSSA公开简语中文简释'},
  {id:'role',file:'01_你负责什么.txt',title:'你负责什么'},
  {id:'data',file:'02_数据怎么看.txt',title:'数据怎么看'},
  {id:'terms',file:'03_常用口令.txt',title:'常用口令'},
  {id:'actions',file:'04_动作怎么选.txt',title:'动作怎么选'},
  {id:'examples',file:'05_简单例子.txt',title:'简单例子'},
  {id:'intervention',file:'06_什么时候需要你.txt',title:'什么时候需要你'},
  {id:'formation',file:'07_编队与协同.txt',title:'编队与协同'},
  {id:'formation_compact',file:'08_编队协同速记.txt',title:'编队协同速记（2B）'}
].map(entry=>manualAliases[entry.id]?{...entry,file:MANUAL_FILE,section:manualAliases[entry.id]}:entry.id==='decision_index'?{...entry,file:MANUAL_FILE}:entry));
export function readPilotFile(id){
  const entry=HANDBOOK.find(item=>item.id===id);if(!entry)throw Error('没有这份飞行员手册');
  return {...entry,text:entry.section?manualSection(entry.section):readFileSync(new URL('../data/pilot-handbook/'+entry.file,import.meta.url),'utf8')};
}
// Structured intents and their required capabilities select procedures first.
// Before interpretation, vocabulary matches are routing hints, never a command
// parser or permission to execute the guessed task.
export function readingTopics(instruction='',{intents=[]}={}){
  const found=new Set(intents.filter(id=>commandById(id)));
  for(const entry of searchAviationTerms(instruction,{limit:40}))if(entry.intent)found.add(entry.intent);
  for(const c of COMMAND_CATALOG)if(new RegExp('(?:^|[^a-z_])'+c.id+'(?:$|[^a-z_])','i').test(instruction))found.add(c.id);
  for(const [pattern,id]of [[/攻击|\battack\b/i,'attack'],[/搜索|\bsearch\b/i,'search'],[/跟踪|\btrack\b/i,'track_target'],[/告警|辐射|规避|横切|防御|RWR|WARNING|NOTCH|DRAG|DEFEND/i,'defend']])if(pattern.test(instruction))found.add(id);
  const commands=[...found].map(commandById),capabilities=new Set(commands.flatMap(c=>c.requires));
  return {intents:[...found],commands,capabilities};
}
export function pilotReading(instruction='',{compact=false,role='pilot',intents=[]}={}){
  const topics=readingTopics(instruction,{intents}),hasCapability=(...ids)=>ids.some(id=>topics.capabilities.has(id));
  const tactical=topics.commands.some(c=>['combat','weapons','sensors'].includes(c.group))||hasCapability('radar_tasking','attack_tasking')||/(接敌|拦截|追击|机动|偏置|防御|脱离|威胁|导弹|开火|FOX|COMMIT|INTERCEPT|CRANK|NOTCH|DRAG|EXTEND|DEFEND|WEAPONS)/i.test(instruction);
  const roleId=role==='commander'?'commander_role':'role',ids=tactical?[roleId,'terms','actions']:[roleId,'data'];
  if(tactical&&!compact)ids.push('tactical_awareness');
  if(hasCapability('radar_tasking','sensors','attack_tasking')||/雷达|搜索|扫描|RADAR|TWS|STT/i.test(instruction))ids.push('radar_search');
  if(hasCapability('rwr_defense')||/告警|辐射|规避|横切|防御|脱离|RWR|WARNING|NOTCH|DRAG|DEFEND/i.test(instruction))ids.push('rwr');
  if(hasCapability('weapons','attack_tasking')||/导弹|发射|武器|引导|照射|AIM|PL.?12|PL.?5|MISSILE|FIRE|LAUNCH|WEAPONS|FOX/i.test(instruction))ids.push('weapons');
  if(!compact)ids.push('planning');
  if(hasCapability('formation','protection_flight','formation_tactics')||needsFormationReading(instruction))ids.push(compact?'formation_compact':'formation');
  if(hasCapability('airfields','ground','takeoff','landing','airframe')||/机场|跑道|滑行|起飞|降落|着陆|复飞|起落架|襟翼|进近|塔台|离场|排序|放行|许可|TAXI|TAKEOFF|LANDING|GO AROUND|RUNWAY|APPROACH|ATIS|QNH|GROUND|TOWER|DEPARTURE|SEQUENCE|CLEARANCE|HOLD POSITION/i.test(instruction))ids.push(compact?'airport_compact':'airport');
  const files=[...new Set(ids)].map(readPilotFile),seen=new Set(),unique=files.filter(entry=>{const key=entry.section??entry.file;if(seen.has(key))return false;seen.add(key);return true;});
  return appendAviationReading({files:files.map(({id,file,title,section})=>({id,file,title,...(section?{section}:{})})),text:unique.map(entry=>entry.text).join('\n\n')},[instruction,...topics.intents].join(' '),{compact});
}
