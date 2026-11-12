import {commandPlanningSnapshot,hydrateCommandDraft} from '../sim/command-planning-worker.js';
import {commandUnits} from '../sim/battle-observation.js';
import {preparePilotPlan} from '../sim/orders.js';
import {capturePlayerOrderScope,assertPlayerOrderScope} from '../sim/command-scope.js';
const cancelled=()=>new DOMException('后台指令规划已取消','AbortError');
// CPU-heavy safety trials stay off the animation/physics thread. No synchronous fallback.
export class CommandPlanner{
  constructor(terrain,{workerFactory=()=>new Worker(new URL('../sim/command-planning-worker.js',import.meta.url),{type:'module'}),maxWorkers=2,timeoutMs=30000}={}){if(!Number.isSafeInteger(maxWorkers)||maxWorkers<1)throw Error('后台计算并发预算必须是正整数');if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('后台计算超时必须是正数');Object.assign(this,{terrain,workerFactory,maxWorkers,timeoutMs});this.sequence=0;this.jobs=new Map();this.queue=[];this.running=0;}
  prepare(world,plan,expectedRevision,options={},signal){
    // These tasks perform bounded validation only; starting a terrain worker
    // adds latency without doing any route trial. Both sides use this path.
    if(plan.tasks.every(task=>['attack_task','sensor_task','radar','weapon','defense','report_status','pause','resume'].includes(task.action))){
      try{if(signal?.aborted)throw cancelled();return Promise.resolve(preparePilotPlan(world,plan,expectedRevision,options));}
      catch(error){return Promise.reject(error);}
    }
    return this.request('prepare',world,{plan,expectedRevision,options},signal);
  }
  forecast(world,timing,signal,options={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    if(!timing.playing)return Promise.resolve({...timing,forecasts:[{outputSec:0,simTimeSec:world.time,units:commandUnits(world).map(u=>({id:u.id,position:[...u.position],velocity:[...u.velocity],alive:u.alive!==false}))}]});
    return this.request('forecast',world,{timing,options},signal);
  }
  adjustment(world,unit,adjustment,executionId,signal){return this.request('adjustment',world,{unitId:unit.id,adjustment,executionId,options:{scoped:true,unitIds:[unit.id]}},signal);}
  route(world,unit,points,targetSpeed,signal){return this.request('route',world,{unitId:unit.id,points,targetSpeed,options:{scoped:true,unitIds:[unit.id]}},signal);}
  request(type,world,data,signal){
    const expectedRevision=data.expectedRevision??world.revision;
    if(signal?.aborted)return Promise.reject(cancelled());
    if(world.revision!==expectedRevision)return Promise.reject(Error('指令已经被新操作替代'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,scope=capturePlayerOrderScope(world);let worker=null,started=false,timer=null;
      const unitIds=data.options?.unitIds??(data.plan?[...new Set(data.plan.tasks.map(t=>t.unitId).filter(Boolean))]:commandUnits(world).map(u=>u.id));
      const finish=(error,result)=>{if(!this.jobs.has(id))return;this.jobs.delete(id);this.queue=this.queue.filter(job=>job.id!==id);signal?.removeEventListener('abort',abort);clearTimeout(timer);worker?.terminate();if(started)this.running--;error?reject(error):resolve(result);queueMicrotask(()=>this.pump());};
      const abort=()=>finish(cancelled());
      const start=()=>{
        try{
          if(signal?.aborted)throw cancelled();
          if(data.options?.scoped)assertPlayerOrderScope(world,scope,unitIds);else if(world.revision!==expectedRevision)throw Error('排队期间已有新操作，旧任务已作废');
          worker=this.workerFactory();started=true;this.running++;timer=setTimeout(()=>finish(Error('后台计算超时，保持当前航路并等待重新规划')),this.timeoutMs);timer.unref?.();
          worker.onmessage=event=>{if(event.data.id!==id)return;
            try{
              if(event.data.error)throw Error(event.data.error);
              if(data.options?.scoped)assertPlayerOrderScope(world,scope,unitIds);else if(world.revision!==expectedRevision)throw Error('后台规划期间已有新操作，旧任务已作废');
              const result=['forecast','adjustment','route'].includes(type)?event.data.result:hydrateCommandDraft(world,data.plan,event.data.result);
              if(type==='prepare'&&data.options?.scoped)result.expectedRevision=world.revision;
              finish(null,result);
            }catch(error){finish(error);}
          };
          worker.onerror=()=>finish(Error('后台指令规划不可用，请重新下令'));
          const buffer=this.terrain?.heights?.slice().buffer;worker.postMessage({type:'init',meta:this.terrain?.meta??null,buffer:buffer??null},buffer?[buffer]:[]);
          // Sample at dispatch, not queue insertion; motion during the wait is real.
          worker.postMessage({type,id,snapshot:commandPlanningSnapshot(world),...data,expectedRevision:data.options?.scoped?world.revision:expectedRevision});
        }catch(error){finish(error);}
      };
      const job={id,start,finish};this.jobs.set(id,job);this.queue.push(job);signal?.addEventListener('abort',abort,{once:true});this.pump();
    });
  }
  pump(){while(this.running<this.maxWorkers&&this.queue.length){const job=this.queue.shift();if(this.jobs.has(job.id))job.start();}}

  cancel(error=cancelled()){
    for(const job of [...this.jobs.values()])job.finish(error);
  }
}
