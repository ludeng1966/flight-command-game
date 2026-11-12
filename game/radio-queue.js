const cancelled=()=>new DOMException('通联已取消','AbortError');

// Ordinary speech may be dropped on preemption. Protocol exchanges can retry
// once, but never indefinitely keep a command waiting behind repeated alerts.
export class RadioQueue{
  constructor({interrupt=()=>{},limit=32}={}){this.interrupt=interrupt;this.limit=limit;this.waiting=[];this.active=null;this.sequence=0;}
  enqueue(run,{signal,priority=0,isCurrent=()=>true,preemptPolicy='restart',maxRestarts=1,metadata=null}={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    if(this.waiting.length>=this.limit)return Promise.reject(Error('电台队列已满，保留当前任务'));
    return new Promise((resolve,reject)=>{
      const current=()=>{try{return !!isCurrent();}catch{return false;}};
      const job={run,signal,priority,isCurrent:current,preemptPolicy,maxRestarts:Number.isFinite(maxRestarts)?Math.max(0,Math.min(1,Math.floor(maxRestarts))):0,restarts:0,metadata,resolve,reject,sequence:++this.sequence,done:false,preempted:false};
      job.cancel=()=>{if(job.done)return;this.waiting=this.waiting.filter(item=>item!==job);if(this.active===job){job.controller.abort();this.interrupt();}this.finish(job,cancelled());};
      signal?.addEventListener('abort',job.cancel,{once:true});this.waiting.push(job);
      if(this.active&&priority>this.active.priority&&!this.active.preempted){this.active.preempted=true;this.active.controller.abort();this.interrupt();}
      this.pump();
    });
  }
  finish(job,error,value){if(job.done)return;job.done=true;job.signal?.removeEventListener('abort',job.cancel);error?job.reject(error):job.resolve(value);}
  pump(){
    if(this.active)return;
    this.waiting.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
    const job=this.waiting.shift();if(!job)return;
    if(job.done||job.signal?.aborted||!job.isCurrent()){this.finish(job,cancelled());this.pump();return;}
    this.active=job;job.controller=new AbortController();job.preempted=false;
    const signal=job.signal?AbortSignal.any([job.signal,job.controller.signal]):job.controller.signal;
    const retry=()=>{
      if(!job.preempted||job.done||job.signal?.aborted)return false;
      if(job.preemptPolicy==='restart'&&job.restarts<job.maxRestarts&&job.isCurrent()){job.restarts++;this.waiting.push(job);}
      else this.finish(job,cancelled());
      return true;
    };
    Promise.resolve().then(()=>job.run(signal)).then(value=>{
      if(!retry())this.finish(job,null,value);
    },error=>{if(!retry())this.finish(job,error);})
      .finally(()=>{if(this.active===job)this.active=null;this.pump();});
  }
  cancel(matches=()=>true){const jobs=[...this.waiting,...(this.active?[this.active]:[])].filter(job=>matches(job.metadata));for(const job of jobs)job.cancel();}
  has(matches=()=>true){return [...this.waiting,...(this.active?[this.active]:[])].some(job=>!job.done&&matches(job.metadata));}
}
