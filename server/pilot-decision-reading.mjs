import {createHash} from 'node:crypto';
import {MANUAL_FILE,manualReading} from './pilot-manual.mjs';
export function decisionReading(role,unit,{search=false}={}){
  if(!['attack','radar','defense'].includes(role))throw Error('未知的单机决策角色');
  const ids=['core','evidence',role];
  if(role!=='defense'&&search)ids.push('search');
  const text=manualReading(ids);
  return {text,version:createHash('sha256').update(text).digest('hex').slice(0,16),chars:text.length,
    files:ids.map(id=>({id:'decision_'+(id==='evidence'?'awareness':id),file:MANUAL_FILE,section:id,title:`单机决策：${id}`}))};
}
