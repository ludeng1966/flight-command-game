import {commandPlanningSnapshot,hydrateCommandDraft} from '../sim/command-planning-worker.js';
const cancelled=()=>new DOMException('后台指令规划已取消','AbortError');
// CPU-heavy safety trials stay off the animation/physics thread. No synchronous fallback.
export class CommandPlanner{
  constructor(terrain,{workerFactory=()=>new Worker(new URL('../sim/command-planning-worker.js',import.meta.url),{type:'module'})}={}){Object.assign(this,{terrain,workerFactory});this.sequence=0;this.pending=null;this.worker=null;}
  start(){
    if(this.worker)return;
    const worker=this.worker=this.workerFactory();
    worker.onmessage=event=>{const p=this.pending;if(!p||event.data.id!==p.id)return;this.pending=null;p.signal?.removeEventListener('abort',p.abort);
      if(event.data.error){p.reject(Error(event.data.error));return;}
      if(p.world.revision!==p.revision){p.reject(Error('后台规划期间已有新操作，旧任务已作废'));return;}
      p.resolve(p.type==='forecast'?event.data.result:hydrateCommandDraft(p.world,p.plan,event.data.result));};
    worker.onerror=()=>this.cancel(Error('后台指令规划不可用，请重新下令'));
    const buffer=this.terrain?.heights?.slice().buffer;worker.postMessage({type:'init',meta:this.terrain?.meta??null,buffer:buffer??null},buffer?[buffer]:[]);
  }
  prepare(world,plan,expectedRevision,options={},signal){
    return this.request('prepare',world,{plan,expectedRevision,options},signal);
  }
  forecast(world,timing,signal){
    if(!timing.playing)return Promise.resolve({...timing,forecasts:[{outputSec:0,simTimeSec:world.time,units:world.units.map(u=>({id:u.id,position:[...u.position],velocity:[...u.velocity],alive:u.alive!==false}))}]});
    return this.request('forecast',world,{timing},signal);
  }
  request(type,world,data,signal){
    const expectedRevision=data.expectedRevision??world.revision;
    if(signal?.aborted)return Promise.reject(cancelled());
    if(world.revision!==expectedRevision)return Promise.reject(Error('指令已经被新操作替代'));
    if(this.pending)this.cancel();
    this.start();
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,abort=()=>this.cancel();this.pending={id,type,world,plan:data.plan,revision:expectedRevision,signal,abort,resolve,reject};signal?.addEventListener('abort',abort,{once:true});
      try{this.worker.postMessage({type,id,snapshot:commandPlanningSnapshot(world),...data});}catch(error){this.cancel(error);}
    });
  }
  cancel(error=cancelled()){
    const p=this.pending;this.pending=null;this.worker?.terminate();this.worker=null;
    if(p){p.signal?.removeEventListener('abort',p.abort);p.reject(error);}
  }
}
