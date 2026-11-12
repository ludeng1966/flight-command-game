import {commandUnits} from '../sim/battle-observation.js';
import {directOwnsFlight} from '../sim/tactical-guidance.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {pilotContext as commandContext} from '../sim/orders.js';
import {monitorPilotExecution,applyPilotAdjustment} from '../sim/pilot-execution.js';
import {captureUnitOrderScope,isUnitOrderScopeCurrent} from '../sim/command-scope.js';

// Observe at most once a second. Healthy navigation does not send an HTTP request.
export class PilotSupervisor{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',onStatus=()=>{},onReport=()=>{},fetchImpl=fetch,now=()=>performance.now(),maxConcurrent=Infinity,prepareAdjustment=null}){
    Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,onStatus,onReport,fetchImpl,now,prepareAdjustment});if(maxConcurrent!==Infinity&&(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1))throw Error('飞行监控并发预算必须是正整数或Infinity');this.maxConcurrent=maxConcurrent;this.states=new Map();this.nextCheck=0;this.jobs=new Map();this.closed=false;
  }
  get active(){return this.jobs.values().next().value??null;}
  cancel(job){job.controller.abort();this.jobs.delete(job.unitId);}
  reset(){for(const job of this.jobs.values())this.cancel(job);this.states.clear();this.world=null;this.nextCheck=0;}
  stop(){this.closed=true;this.reset();}
  current(job){const state=this.states.get(job.unitId);return !job.controller.signal.aborted&&this.getWorld()===job.world&&
    !directOwnsFlight(job.unit)&&
    this.getPilotModel()===job.pilotModel&&this.enabled()&&this.isPlaying()&&isUnitOrderScopeCurrent(job.world,job.unit,job.scope)&&
    pilotObservation(job.world,job.unit,state?.blockedSince)?.event.key===job.eventKey;}
  tick(){
    if(this.closed)return;
    const pilotModel=this.getPilotModel();if(this.pilotModel!==pilotModel){this.reset();this.pilotModel=pilotModel;}
    if(!this.enabled()||!this.isPlaying()){for(const job of this.jobs.values())this.cancel(job);return;}
    const at=this.now();if(at<this.nextCheck)return;this.nextCheck=at+1000;
    const world=this.getWorld();if(!world)return;
    if(this.world!==world){this.reset();this.world=world;this.nextCheck=at+1000;}
    for(const unit of commandUnits(world))monitorPilotExecution(world,unit);
    for(const job of this.jobs.values())if(!this.current(job))this.cancel(job);
    for(const unit of commandUnits(world)){
      if(directOwnsFlight(unit))continue;
      if((unit.rwrDefense?.active||unit.attackTask?.active)&&unit.flightState==='normal')continue;
      let state=this.states.get(unit.id);if(!state){state={blockedSince:null,seen:new Set(),cooldownAt:0};this.states.set(unit.id,state);}
      if(!unit.navigationBlocked)state.blockedSince=null;else state.blockedSince??=world.time;
      const observation=pilotObservation(world,unit,state.blockedSince);
      const autonomous=observation?.event.reason==='execution_deviation';
      if(!observation||!autonomous&&state.seen.has(observation.event.key)||this.jobs.has(unit.id)||this.jobs.size>=this.maxConcurrent||at<state.cooldownAt)continue;
      const controller=new AbortController(),job={world,unit,revision:world.revision,scope:captureUnitOrderScope(world,unit),pilotModel,controller,unitId:unit.id,eventKey:observation.event.key,executionId:unit.pilotExecution?.id};this.jobs.set(unit.id,job);
      this.onStatus({phase:'checking',unitId:unit.id,text:observation.event.summary});
      const context=commandContext(world,unit.id),requestId=crypto.randomUUID();
      const reportCause=structuredClone({issue:observation.execution?.issue??null,urgent:observation.event.urgent===true,
        feedback:observation.execution?.feedback??null});
      void (async()=>{
        let handled=false;
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/assess',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({requestId,pilotModel,context,observation}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
          const result=await response.json();
          if(!this.current(job))return;handled=true;
          if(!response.ok)throw Error(result.error||'飞行员判断暂不可用');
          if(result.requestId!==requestId||result.revision!==context.revision||result.simTimeSec!==context.simTimeSec)throw Error('飞行员判断已经过期');
          state.seen.add(job.eventKey);if(state.seen.size>64)state.seen.delete(state.seen.values().next().value);
          let applied=null;
          if(result.assessment.decision==='adjust_plan'){
            if(!autonomous)throw Error('该事件没有改变飞行方案的权限');
            const routeReplanned=!!unit.navigationBlocked||result.assessment.adjustment.via?.length>0;
            const prepared=this.prepareAdjustment?await this.prepareAdjustment(world,unit,result.assessment.adjustment,job.executionId,controller.signal):null;if(!this.current(job)){handled=false;return;}applied=applyPilotAdjustment(world,unit,result.assessment.adjustment,job.executionId,{prepared});
            const next=unit.waypoints[0],bearing=next?(Math.atan2(next[0]-unit.position[0],next[1]-unit.position[1])*180/Math.PI+360)%360:null;
            this.onReport({world,unitId:unit.id,executionId:job.executionId,simTime:world.time,cause:reportCause,applied,
              plan:{routeReplanned,targetAltitudeM:unit.pilotExecution.targetAltitudeM,nextFix:next?{bearingDeg:bearing,altitudeM:next[2]}:null}});
          }
          if(autonomous){unit.pilotExecution.attempt++;if(!applied)unit.pilotExecution.lastError=result.assessment.message;}
          unit.pilotAssessment={...result.assessment,time:world.time,modelInvoked:result.modelInvoked};
          this.onStatus({phase:'done',unitId:unit.id,text:applied?.recovery?'已装订AI改出方案，正在增速恢复':applied?'已按实际状态调整推力与航路，继续原任务':result.assessment.message,assessment:result.assessment,applied});
        }catch(error){if(this.current(job)){handled=true;
          if(autonomous&&unit.pilotExecution?.id===job.executionId){unit.pilotExecution.lastError=error.message.slice(0,600);unit.pilotExecution.attempt++;
            this.onReport({world,unitId:unit.id,executionId:job.executionId,simTime:world.time,cause:reportCause,error:error.message});}
          this.onStatus({phase:'error',unitId:unit.id,text:error instanceof TypeError?'无法连接飞行员判断服务，程序继续飞行':error.message});
        }}
        finally{if(handled)state.cooldownAt=this.now()+15000;if(this.jobs.get(unit.id)===job)this.jobs.delete(unit.id);}
      })();
      if(this.jobs.size>=this.maxConcurrent)break;
    }
  }
}
