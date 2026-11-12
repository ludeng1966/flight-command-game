import {CAPABILITIES,COMMAND_CATALOG,missingCapabilities,MILITARY_PROTOCOL_VERSION} from '../sim/military-commands.js';

// Execution availability has one owner: the same catalogue used by the compiler.
// Handbooks describe meanings and procedures; they cannot enable an actuator.
export function capabilityRules(){
  const available=[],unavailable=[];
  for(const [id,entry]of Object.entries(CAPABILITIES))(entry.available?available:unavailable).push(id);
  const blocked=COMMAND_CATALOG.filter(c=>missingCapabilities(c).length).map(c=>({intent:c.id,missing:missingCapabilities(c)}));
  return `【程序能力事实，协议${MILITARY_PROTOCOL_VERSION}】${JSON.stringify({available,unavailable,blocked})}\n能力事实由程序目录生成，优先于手册中的历史描述。意图可识别不等于动作可执行；条件调度、子模式、参数与物理条件仍由编译器和执行器核验，不能仅凭能力可用就宣称成功。`;
}
export const COMMANDER_ROLE_RULES=`你是空中指挥游戏里玩家指挥员的传令接口：理解玩家意图，以指挥台身份形成命令。输出统一意图协议JSON，不直接控制飞机，不承担飞行员的中间航点和常规参数规划。
只保留玩家明确给出的任务、目标、条件与约束；未指定高度、速度、推力等参数保持null，不能把上下文中的旧目标抄成玩家硬性要求。明确保持当前值时使用当前测量值。常规飞行细节留给接令后的飞行员规划，不因此向玩家索要航点。`;
export const PILOT_ROLE_RULES=`你是接令后的飞机飞行员规划员。输入依据只有已播报的commanderMessage，不重新读取或猜测玩家原始输入。输出统一意图协议JSON，并在接口提供navigationPlans时提出真实三维中间航点。
保留通话明确的目标、条件和数值；未指定的常规飞行高度、速度、推力由你结合实况与能力规划，不能把旧目标设置当成玩家约束。保持已有三维航路、地图点高度、编队职责和机场许可限制。攻击任务的自主搜索和交战由后续攻击执行角色规划，attack未指定参数仍为null，不在接令阶段添加战术或开火步骤。程序验证可飞性并连续驾驶，你不能宣称规划已执行。`;
