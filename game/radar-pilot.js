import {autonomousManeuverPlan} from './autonomous-maneuver.js';
import {commandUnits} from '../sim/battle-observation.js';
import {directOwnsFlight} from '../sim/tactical-guidance.js';
import {pilotContext as commandContext} from '../sim/orders.js';
import {radarTaskEvent,applyRadarDecision} from '../sim/radar-task.js';
import {captureUnitOrderScope,isUnitOrderScopeCurrent} from '../sim/command-scope.js';

export class RadarPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now(),maxConcurrent=Infinity,preparePlan=null}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now,preparePlan});if(maxConcurrent!==Infinity&&(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1))throw Error('雷达模型并发预算必须是正整数或Infinity');this.maxConcurrent=maxConcurrent;this.jobs=new Map();this.active=null;this.nextCheck=0;this.nextByUnit=new Map();this.lastUnitId=null;this.closed=false;}
  cancelActive(){for(const job of this.jobs.values()){job.controller.abort();if(job.unit.radarTask===job.task)job.task.pending=false;}this.jobs.clear();this.active=null;}
  reset(){this.cancelActive();this.nextCheck=0;this.nextByUnit.clear();this.lastUnitId=null;}
  current(job){return !job.controller.signal.aborted&&this.getWorld()===job.world&&this.enabled()&&this.isPlaying()&&
    !directOwnsFlight(job.unit)&&
    job.world.time<=(job.expiresAtSimTime??Infinity)&&
    this.getPilotModel()===job.pilotModel&&isUnitOrderScopeCurrent(job.world,job.unit,job.scope)&&
    job.unit.radarTask===job.task&&job.task.active&&job.task.decisionCount===job.decisionCount;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;
    if(!this.enabled()||!this.isPlaying()){this.reset();return;}
    const world=this.getWorld(),at=this.now();
    for(const [id,job]of this.jobs)if(!this.current(job)){job.controller.abort();if(job.unit.radarTask===job.task)job.task.pending=false;this.jobs.delete(id);}
    if(this.jobs.size>=this.maxConcurrent||at<this.nextCheck)return;this.nextCheck=at+100;
    const units=commandUnits(world),start=(units.findIndex(unit=>unit.id===this.lastUnitId)+1)%Math.max(1,units.length);
    for(let i=0;i<units.length;i++){
      const unit=units[(start+i)%units.length];if(this.jobs.has(unit.id))continue;if(at<(this.nextByUnit.get(unit.id)??0))continue;
      if(directOwnsFlight(unit))continue;
      const event=radarTaskEvent(unit,world.time);if(!event)continue;
      const task=unit.radarTask,controller=new AbortController(),job={world,unit,task,taskId:task.id,revision:world.revision,scope:captureUnitOrderScope(world,unit),decisionCount:task.decisionCount,controller,pilotModel:this.getPilotModel(),controlSequence:unit.radar.controlSequence??0,
        expiresAtSimTime:world.sensorModelVersion===2?world.time+Math.min(30,Math.max(5,2*(unit.radar.scanPolicy?.barCount??4)*(unit.radar.scanPolicy?.azWidthDeg??120)/(unit.radar.config?.scanRateDegSec??60))):Infinity};
      this.jobs.set(unit.id,job);this.active=job;task.pending=true;this.lastUnitId=unit.id;this.nextByUnit.set(unit.id,at+750);
      const requestId=crypto.randomUUID(),context=commandContext(world,unit.id);
      void(async()=>{
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/radar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel:job.pilotModel,unitId:unit.id,taskId:task.id,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
          const result=await response.json();
          if(!this.current(job))return;
          if((unit.radar.controlSequence??0)!==job.controlSequence)return;
          if(!response.ok)throw Error(result.error||'雷达判断服务暂不可用');
          if(result.requestId!==requestId||result.taskId!==job.taskId||result.revision!==job.revision||result.simTimeSec!==context.simTimeSec||result.controlSequence!==job.controlSequence)throw Error('雷达判断已经过期');
          if(!result.decision)return;
          // The sensor may regain the track while the model is thinking.
          if(event.reason==='signal_lost'&&unit.radar.phase==='locked')return;
          const maneuverDraft=result.decision.operation==='maneuver'&&this.preparePlan?await this.preparePlan(world,autonomousManeuverPlan(unit.id,result.decision),world.revision,{scoped:true,unitIds:[unit.id]},controller.signal):null;if(!this.current(job))return;applyRadarDecision(world,unit,result.decision,job.taskId,result.event??event,{maneuverDraft});
        }catch(error){if(this.current(job)){task.lastError=(error instanceof TypeError?'雷达判断服务连接失败，保持当前状态':error.message).slice(0,300);task.retryCount++;task.lastDecisionAt=world.time;}}
        finally{if(this.jobs.get(unit.id)===job){if(unit.radarTask===task)task.pending=false;this.jobs.delete(unit.id);}if(this.active===job)this.active=null;}
      })();if(this.jobs.size>=this.maxConcurrent)break;
    }
  }
}
