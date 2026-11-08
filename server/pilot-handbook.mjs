import {readFileSync} from 'node:fs';
import {needsFormationReading} from '../sim/formation-doctrine.js';
import {appendAviationReading} from './aviation-terms.mjs';

export const HANDBOOK=Object.freeze([
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
]);
export function readPilotFile(id){
  const entry=HANDBOOK.find(item=>item.id===id);if(!entry)throw Error('没有这份飞行员手册');
  return {...entry,text:readFileSync(new URL('../data/pilot-handbook/'+entry.file,import.meta.url),'utf8')};
}
export function pilotReading(instruction='',{compact=false}={}){
  const tactical=/(接敌|拦截|追击|机动|偏置|防御|脱离|威胁|导弹|开火|FOX|COMMIT|INTERCEPT|CRANK|NOTCH|DRAG|EXTEND|DEFEND|WEAPONS)/i.test(instruction);
  const ids=tactical?['role','terms','actions']:['role','data'];
  if(/告警|辐射|规避|横切|防御|脱离|RWR|WARNING|NOTCH|DRAG|DEFEND/i.test(instruction))ids.push('rwr');
  if(/导弹|发射|武器|引导|照射|AIM|PL.?12|PL.?5|MISSILE|FIRE|LAUNCH|WEAPONS|FOX/i.test(instruction))ids.push('weapons');
  if(!compact)ids.push('planning');
  if(needsFormationReading(instruction))ids.push(compact?'formation_compact':'formation');
  if(/机场|跑道|滑行|起飞|降落|着陆|复飞|起落架|襟翼|进近|塔台|离场|排序|放行|许可|TAXI|TAKEOFF|LANDING|GO AROUND|RUNWAY|APPROACH|ATIS|QNH|GROUND|TOWER|DEPARTURE|SEQUENCE|CLEARANCE|HOLD POSITION/i.test(instruction))ids.push(compact?'airport_compact':'airport');
  const files=ids.map(readPilotFile);
  return appendAviationReading({files:files.map(({id,file,title})=>({id,file,title})),text:files.map(entry=>`【参考文件：${entry.file}】\n${entry.text}`).join('\n\n')},instruction,{compact});
}
