import {commandContext} from '../sim/orders.js';
import {radarTaskEvent,applyRadarDecision} from '../sim/radar-task.js';

export class RadarPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now()}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now});this.active=null;this.nextCheck=0;this.closed=false;}
  reset(){this.active?.controller.abort();if(this.active&&this.active.unit.radarTask?.id===this.active.taskId)this.active.unit.radarTask.pending=false;this.active=null;this.nextCheck=0;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;
    if(!this.enabled()||!this.isPlaying()){this.reset();return;}
    const world=this.getWorld(),at=this.now();
    if(this.active&&(this.active.world!==world||world.revision!==this.active.revision||this.active.unit.radarTask?.id!==this.active.taskId||!this.active.unit.radarTask.active)){this.reset();}
    if(this.active||at<this.nextCheck)return;this.nextCheck=at+750;
    for(const unit of world.units){
      const event=radarTaskEvent(unit,world.time);if(!event)continue;
      const task=unit.radarTask,controller=new AbortController(),job={world,unit,taskId:task.id,revision:world.revision,controller,pilotModel:this.getPilotModel(),controlSequence:unit.radar.controlSequence??0};
      this.active=job;task.pending=true;
      const requestId=crypto.randomUUID(),context=commandContext(world,unit.id);
      void(async()=>{
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/radar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel:job.pilotModel,unitId:unit.id,taskId:task.id,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
          const result=await response.json();
          if(controller.signal.aborted||this.getWorld()!==world||world.revision!==job.revision||unit.radarTask!==task||!task.active||this.getPilotModel()!==job.pilotModel)return;
          if((unit.radar.controlSequence??0)!==job.controlSequence)return;
          if(!response.ok)throw Error(result.error||'雷达判断服务暂不可用');
          if(result.requestId!==requestId||result.taskId!==job.taskId||result.revision!==job.revision||result.simTimeSec!==context.simTimeSec||result.controlSequence!==job.controlSequence)throw Error('雷达判断已经过期');
          if(!result.decision)return;
          // The sensor may regain the track while the model is thinking.
          if(event.reason==='signal_lost'&&unit.radar.phase==='locked')return;
          applyRadarDecision(world,unit,result.decision,job.taskId,result.event??event);
        }catch(error){if(!controller.signal.aborted&&unit.radarTask===task&&task.active){task.lastError=(error instanceof TypeError?'雷达判断服务连接失败，保持当前状态':error.message).slice(0,300);task.retryCount++;task.lastDecisionAt=world.time;}}
        finally{if(this.active===job){if(unit.radarTask===task)task.pending=false;this.active=null;}}
      })();break;
    }
  }
}
