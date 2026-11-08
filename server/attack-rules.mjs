import {attackMissionTaskFor} from '../sim/attack-task.js';
export const ATTACK_TASK_RULES=`攻击任务已支持先搜索后交战。“攻击前方目标”“攻击搜索发现的目标”等描述足以接收attack，targetRef保留目标描述，targetId可为null。不需要预先有目标编号、回波、雷达锁定或已选导弹，也无需再次向玩家索要搜索/开火许可；本次攻击指令即为该任务的授权，友机仍禁止攻击。没有回波是执行中的搜索状态，不是指令不明。只解释任务，不把它展开成手动操作。
attack.parameters只保留原话明确给出的目标、武器、数量与飞行要求；未指定的数值都必须null。禁止把context.position、headingDeg、targetAltitudeM或targetSpeedMps抄成玩家命令；eastM/northM等当前飞机坐标不是目标位置。飞行员的自主机动会在后续执行阶段判断，不能伪装为玩家硬性限制。summary只转达攻击任务，不自行请求目标编号、锁定或搜索许可。参考资料中未接入攻击、攻击必须先有编号等旧描述不适用于当前系统。`;
export function verifyAttackTaskInterpretation(value,instruction,context){
  const positive=/攻击|\battack\b/i.test(instruction)&&!/不要.*攻击|禁止.*攻击|停止.*攻击|取消.*攻击|\b(?:stop|cancel|do not|don't).*attack/i.test(instruction);
  if(positive&&value.status==='needs_clarification'&&!/友机|禁止|未挂载|没有可用.*(?:武器|导弹)|弹量不足/.test(value.summary))throw Error('攻击任务允许先搜索，不需要已有目标编号或锁定。请接收attack并把已有目标描述保留为targetRef，未指定参数为null，不再向玩家索要雷达或选弹设置。');
  for(const o of value.orders??[])if(o.intent==='attack'){
    for(const [field,pattern]of [['altitudeM',/高度|海拔|\baltitude\b/i],['speedMps',/速度|空速|\bspeed\b/i],['headingDeg',/航向|\bheading\b|\bcourse\b/i]])if(o.parameters[field]!==null&&!pattern.test(instruction))throw Error('攻击任务未指定'+field+'，不得复制本机现有参数，必须保持null并留给执行阶段自主判断。');
    if(o.unitIds.every(id=>Object.values(context.units.find(u=>u.id===id)?.weapons?.inventory??{}).some(n=>n>0)))attackMissionTaskFor(o,context);
  }
}
