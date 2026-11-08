import {commandContext} from '../sim/orders.js';
import {attackTaskEvent,attackObservation,applyAttackDecision} from '../sim/attack-task.js';
export class AttackPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now()}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now});this.active=null;this.nextCheck=0;this.closed=false;}
  reset(){this.active?.controller.abort();if(this.active&&this.active.unit.attackTask===this.active.task)this.active.task.pending=false;this.active=null;this.nextCheck=0;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;if(!this.enabled()||!this.isPlaying()){this.reset();return;}
    const world=this.getWorld(),at=this.now();if(this.active&&(this.active.world!==world||this.active.revision!==world.revision||this.active.unit.attackTask!==this.active.task||!this.active.task.active))this.reset();
    if(this.active||at<this.nextCheck)return;this.nextCheck=at+750;
    for(const unit of world.units){const event=attackTaskEvent(unit,world.time);if(!event)continue;
      const task=unit.attackTask,controller=new AbortController(),job={world,unit,task,revision:world.revision,decisionCount:task.decisionCount,pilotModel:this.getPilotModel(),controller};this.active=job;task.pending=true;
      const requestId=crypto.randomUUID(),context=commandContext(world,unit.id),observation=attackObservation(world,unit);
      void(async()=>{
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/attack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel:job.pilotModel,unitId:unit.id,taskId:task.id,context,observation}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});const result=await response.json();
          if(controller.signal.aborted||this.getWorld()!==world||world.revision!==job.revision||unit.attackTask!==task||!task.active||this.getPilotModel()!==job.pilotModel)return;
          if(!response.ok)throw Error(result.error||'攻击判断服务暂不可用');
          if(result.requestId!==requestId||result.taskId!==task.id||result.revision!==job.revision||result.simTimeSec!==context.simTimeSec||result.decisionCount!==job.decisionCount)throw Error('攻击判断已经过期');
          if(result.decision)applyAttackDecision(world,unit,result.decision,task.id,job.decisionCount);
        }catch(error){if(!controller.signal.aborted&&unit.attackTask===task&&task.active){task.lastError=(error instanceof TypeError?'飞行员判断连接失败，保持现有状态':error.message).slice(0,300);task.retryCount++;task.lastDecisionAt=world.time;}}
        finally{if(this.active===job){if(unit.attackTask===task)task.pending=false;this.active=null;}}
      })();break;
    }
  }
}
