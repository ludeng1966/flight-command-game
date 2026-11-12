const canonical=value=>String(value??'').replace(/[\s_-]/g,'').toLowerCase();
const generalSearch=new Set(['','前方','前方空域','前方空域敌机','前方目标','前方敌机','敌机','敌方飞机','敌方目标','发现的敌机','发现的目标','搜索到的敌机','搜索到的目标','目标',
  'ahead','front','forward','forwardairspace','enemyaircraft','detectedenemyaircraft','discoveredenemyaircraft','detectedtargets']);

// Prove overlap only from an identical target or a general forward search.
// Different named targets/directions must never be silently discarded.
export function sensorTaskCoveredByAttack(sensor,attack){
  if(!sensor||!attack)return false;
  if(sensor.targetId||attack.targetId)return !!sensor.targetId&&sensor.targetId===attack.targetId;
  const sensorRef=canonical(sensor.targetRef),attackRef=canonical(attack.targetRef);
  if(sensorRef&&attackRef&&sensorRef===attackRef)return true;
  return sensor.goal==='search'&&generalSearch.has(sensorRef)&&generalSearch.has(attackRef);
}
