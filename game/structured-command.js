import {commandUnits} from '../sim/battle-observation.js';
import {attackContacts} from '../sim/attack-task.js';
import {preparePilotPlan,validatePlan} from '../sim/orders.js';
import {runCommandSession} from './command-session.js';

// Both text interpretation and strategy proposals converge on this boundary.
export function validateCommandScope(world,plan){
  const own=commandUnits(world),ids=new Set(own.map(u=>u.id));
  if(!plan||!Array.isArray(plan.tasks))throw Error('结构化指挥计划无效');
  if(plan.tasks.some(task=>task?.unitId!=null&&!ids.has(task.unitId)))throw Error('只能向当前阵营可指挥飞机下令');
  validatePlan(plan,own);
  const observed=new Set(own.filter(u=>u.alive!==false).flatMap(u=>attackContacts(u,world.time)).filter(c=>c.classification!=='friendly').map(c=>c.id));
  for(const task of plan.tasks){const target=task.action==='attack_task'?task.attackOrder.targetId:null;if(target!=null&&!observed.has(target))throw Error('明确攻击目标不在当前己方有效观测内');}
  return plan;
}
export async function runStructuredCommand(options){
  const {world,reply,preparePlan=preparePilotPlan,...rest}=options;
  validateCommandScope(world,reply?.plan);
  return runCommandSession({responsive:true,enforceAuthority:true,...rest,world,reply,
    preparePlan:(live,plan,...args)=>{validateCommandScope(live,plan);return preparePlan(live,plan,...args);}});
}

// Convert only; real execution must pass through runStructuredCommand.
export function duelDecisionPlan(world,decision){
  if(!decision||!Array.isArray(decision.orders)||!decision.orders.length||decision.orders.length>2)throw Error('指挥分工无效');
  const own=commandUnits(world),seen=new Set(),tasks=[],unchanged=[];
  for(const order of decision.orders){
    const unit=own.find(u=>u.id===order?.unitId&&u.alive!==false);
    if(!unit||seen.has(unit.id)||!['attack','defend','search'].includes(order.posture))throw Error('指挥分工对象或动作无效');
    seen.add(unit.id);
    if(order.posture==='defend'){
      if(order.targetId!==null)throw Error('防御指令不接受目标参数');
      if(unit.rwrDefense?.active){unchanged.push(unit.id);continue;}
      tasks.push({unitId:unit.id,action:'defense',defenseOrder:{mode:'execute',maneuver:'notch',side:'auto',headingDeg:null}});
    }else{
      if(order.posture==='attack'&&(typeof order.targetId!=='string'||!order.targetId)||order.posture==='search'&&order.targetId!==null)throw Error('攻击目标参数无效');
      const targetId=order.posture==='attack'?order.targetId:null;
      if(unit.attackTask?.active&&(order.posture==='search'||unit.attackTask.targetId===targetId)){unchanged.push(unit.id);continue;}
      tasks.push({unitId:unit.id,action:'attack_task',attackOrder:{targetId,targetRef:targetId,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null}});
    }
  }
  if(!tasks.length)return {plan:null,unchanged};
  const plan={status:'accepted',summary:typeof decision.reason==='string'&&decision.reason.trim()?decision.reason.trim().slice(0,160):'根据己方观测调整分工',tasks};
  validateCommandScope(world,plan);return {plan,unchanged};
}

// Preserve the radio lifecycle without exposing opponent orders to the player.
export function createSilentCommandRadio({getTime=()=>0,onEvent=()=>{}}={}){
  let sequence=0;
  const publish=(message,{signal}={})=>{
    signal?.throwIfAborted();
    const record={...message,id:`opponent-radio-${++sequence}`,time:getTime(),delivery:'silent'};
    onEvent({stage:'radio',record});return {record,completion:Promise.resolve(record)};
  };
  return {publish,transmit:async(message,options)=>publish(message,options).record,phase:(phase,message)=>onEvent({stage:'phase',phase,message})};
}
