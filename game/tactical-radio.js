// A receipt reports acceptance, never a launch, hit, or completed manoeuvre.
import {ATTACK_METHODS,DEFENSE_METHODS,DEFENSE_SIDES} from './tactical-options.js';
const phrases={
  move:['正在转进指定空域。','PROCEEDING TO ASSIGNED AREA.'],
  attack:['攻击授权收到，最多一枚，等待合适发射条件。','ATTACK AUTHORIZATION RECEIVED, ONE MISSILE MAXIMUM. AWAITING FIRING CONDITIONS.'],
  defend:['正在执行告警规避。','DEFENDING.'],
  disengage:['停止攻击，正在向指定空域脱离。','DISENGAGING TO ASSIGNED AREA.'],
  hold:['停止继续发射，在空导弹状态另行报告。','CEASE FIRE. MISSILES ALREADY IN FLIGHT REMAIN ACTIVE.'],
  return_base:['返场任务收到，按管制程序申请进近。','RECOVERY TASK RECEIVED. REQUESTING APPROACH IN ACCORDANCE WITH ATC CLEARANCES.']
};
export function tacticalReceiptMessages(world,receipt){
  if(receipt.action==='guidance'&&receipt.summary&&receipt.summaryEn)return (receipt.unitIds??[]).flatMap(id=>{const unit=world.units.find(u=>u.id===id);return unit?[{speaker:'pilot',unitId:id,unitIds:[id],commandId:receipt.commandId,label:`飞行员 · ${unit.callsign}`,text:`${unit.callsign}，${receipt.summary}`,texts:{zh:`${unit.callsign}，${receipt.summary}`,en:`${unit.callsign}, ${receipt.summaryEn}`},language:'zh-CN',simTime:world.time}]:[];});
  const failed=['unable','rejected','failed','blocked','error'].includes(receipt.status);
  const initial=['committed','applied'].includes(receipt.status)||receipt.committed&&receipt.status==='executing';
  const hold=receipt.action==='hold'&&receipt.committed&&receipt.status==='completed';
  const arrival=receipt.action==='return_base'&&receipt.committed&&receipt.status==='waiting';
  if(!failed&&!initial&&!hold&&!arrival)return [];
  const phrase=arrival?['已到返场等待空域，等待塔台接管及进近许可。','HOLDING FOR ARRIVAL. REQUEST TOWER HANDOFF AND APPROACH CLEARANCE.']:phrases[receipt.action];if(!phrase&&!failed)return [];
  return (receipt.unitIds??[]).flatMap(id=>{
    const unit=world.units.find(u=>u.id===id);if(!unit)return [];
    let zh=failed?`无法执行本次指令，${receipt.reason??receipt.summary??'请检查指令状态'}。`:phrase[0];
    let en=failed?'UNABLE TO COMPLY. CHECK COMMAND STATUS.':phrase[1];
    if(!failed&&receipt.action==='attack'&&ATTACK_METHODS[receipt.attackMethod]){const method=ATTACK_METHODS[receipt.attackMethod];zh=`${method.zh}，${zh}`;en=`${method.en.toUpperCase()}. ${en}`;}
    if(!failed&&receipt.action==='defend'&&DEFENSE_METHODS[receipt.defenseMethod]){const method=DEFENSE_METHODS[receipt.defenseMethod],side=receipt.defenseMethod==='notch'?DEFENSE_SIDES[receipt.defenseSide]:null;zh=`执行${method.zh}${side?'，'+side.zh:''}。`;en=`${method.en.toUpperCase()}${side?', '+side.en.toUpperCase():''}. DEFENDING.`;}
    return [{speaker:'pilot',unitId:id,unitIds:[id],commandId:receipt.commandId,label:`飞行员 · ${unit.callsign}`,
      text:`${unit.callsign}，${zh}`,texts:{zh:`${unit.callsign}，${zh}`,en:`${unit.callsign}, ${en}`},language:'zh-CN',simTime:world.time}];
  });
}
