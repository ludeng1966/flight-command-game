import {autonomousManeuverPlan} from './autonomous-maneuver.js';
import {commandUnits} from '../sim/battle-observation.js';
import {pilotContext as commandContext} from '../sim/orders.js';
import {attackTaskEvent,attackObservation,applyAttackDecision,recordAttackRejection} from '../sim/attack-task.js';
import {captureUnitOrderScope,isUnitOrderScopeCurrent} from '../sim/command-scope.js';
export class AttackPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now(),maxConcurrent=Infinity,preparePlan=null}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now,preparePlan});this.jobs=new Map();if(maxConcurrent!==Infinity&&(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1))throw Error('攻击模型并发预算必须是正整数或Infinity');this.maxConcurrent=maxConcurrent;this.latencySec=3;this.nextCheck=0;this.nextByUnit=new Map();this.lastUnitId=null;this.closed=false;}
  get active(){return this.jobs.values().next().value??null;}
  cancelActive(job=null){for(const pending of job?[job]:[...this.jobs.values()]){pending.controller.abort();if(pending.unit.attackTask===pending.task)pending.task.pending=false;this.jobs.delete(pending.unit.id);}}
  reset(){this.cancelActive();this.nextCheck=0;this.nextByUnit.clear();this.lastUnitId=null;}
  current(job){return !job.controller.signal.aborted&&this.getWorld()===job.world&&this.enabled()&&this.isPlaying()&&
    this.getPilotModel()===job.pilotModel&&isUnitOrderScopeCurrent(job.world,job.unit,job.scope)&&
    job.unit.attackTask===job.task&&job.task.active&&job.task.decisionCount===job.decisionCount;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;if(!this.enabled()||!this.isPlaying()){this.reset();return;}
    const world=this.getWorld(),at=this.now();for(const job of this.jobs.values())if(!this.current(job))this.cancelActive(job);
    if(this.jobs.size>=this.maxConcurrent||at<this.nextCheck)return;this.nextCheck=at+100;
    const units=commandUnits(world),start=(units.findIndex(unit=>unit.id===this.lastUnitId)+1)%Math.max(1,units.length);
    for(let i=0;i<units.length;i++){const unit=units[(start+i)%units.length];if(this.jobs.has(unit.id)||at<(this.nextByUnit.get(unit.id)??0))continue;const event=attackTaskEvent(unit,world.time);if(!event)continue;
      const task=unit.attackTask,controller=new AbortController(),job={world,unit,task,revision:world.revision,scope:captureUnitOrderScope(world,unit),decisionCount:task.decisionCount,pilotModel:this.getPilotModel(),controller};job.startedAt=at;this.jobs.set(unit.id,job);task.pending=true;this.lastUnitId=unit.id;this.nextByUnit.set(unit.id,at+750);
      const requestId=crypto.randomUUID(),context=commandContext(world,unit.id),observation={...attackObservation(world,unit),decisionLatencySec:this.latencySec};
      void(async()=>{
        let attemptedOperation=null;
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/attack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel:job.pilotModel,unitId:unit.id,taskId:task.id,context,observation}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});const result=await response.json();
          if(!this.current(job))return;
          if(!response.ok)throw Error(result.error||'攻击判断服务暂不可用');
          if(result.requestId!==requestId||result.taskId!==task.id||result.revision!==job.revision||result.simTimeSec!==context.simTimeSec||result.decisionCount!==job.decisionCount)throw Error('攻击判断已经过期');
          this.latencySec=.7*this.latencySec+.3*Math.min(60,Math.max(0,(this.now()-job.startedAt)/1000));
          if(result.decision){attemptedOperation=result.decision.operation;const maneuverDraft=attemptedOperation==='maneuver'&&this.preparePlan?await this.preparePlan(world,autonomousManeuverPlan(unit.id,result.decision),world.revision,{scoped:true,unitIds:[unit.id]},controller.signal):null;if(!this.current(job))return;applyAttackDecision(world,unit,result.decision,task.id,job.decisionCount,{maneuverDraft});}
        }catch(error){if(this.current(job))recordAttackRejection(world,unit,error instanceof TypeError?'飞行员判断连接失败，保持现有状态':error,attemptedOperation);}
        finally{if(this.jobs.get(unit.id)===job){if(unit.attackTask===task)task.pending=false;this.jobs.delete(unit.id);}}
      })();if(this.jobs.size>=this.maxConcurrent)break;
    }
  }
}
