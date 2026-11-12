// Bounded, non-preemptive admission: an issued operation keeps its slot; fresh
// threat decisions run before routine queued work. No game state is stored here.
export class TacticalQueueError extends Error{
  constructor(status,message){super(message);this.name='TacticalQueueError';this.status=status;}
}
export function tacticalPriority(path){
  return path.endsWith('/rwr')?4:path.endsWith('/attack')?3:
    /\/(?:interpret|plan|plan-departure|assess|radar|transcribe)$/.test(path)?2:0;
}
export class TacticalScheduler{
  constructor({concurrency=2,maxQueued=16,reservedUrgent=4,maxWaitMs=30000}={}){
    if(concurrency!==Infinity&&(!Number.isSafeInteger(concurrency)||concurrency<1)||!Number.isInteger(maxQueued)||maxQueued<1||!Number.isInteger(reservedUrgent)||reservedUrgent<0||reservedUrgent>maxQueued||!Number.isFinite(maxWaitMs)||maxWaitMs<=0)throw Error('调度队列配置无效');
    Object.assign(this,{concurrency,maxQueued,reservedUrgent,maxWaitMs});this.active=0;this.queue=[];this.closed=false;this.sequence=0;
  }
  health(){return {active:this.active,queued:this.queue.length,concurrency:this.concurrency===Infinity?0:this.concurrency,unlimited:this.concurrency===Infinity,maxQueued:this.maxQueued,urgentQueued:this.queue.filter(j=>j.priority>=3).length};}
  acquire({priority=0,signal}={}){
    if(signal?.aborted)return Promise.reject(new DOMException('请求已取消','AbortError'));
    if(this.closed)return Promise.reject(new TacticalQueueError(503,'战术服务已停止'));
    if(this.active<this.concurrency){this.active++;return Promise.resolve(this.lease());}
    const limit=priority>=3?this.maxQueued:this.maxQueued-this.reservedUrgent;
    if(this.queue.length>=limit)return Promise.reject(new TacticalQueueError(429,'战术判断队列已满，请稍后重试'));
    return new Promise((resolve,reject)=>{
      const job={priority,sequence:this.sequence++,resolve,reject,signal};
      job.cancel=()=>this.remove(job,new DOMException('请求已取消','AbortError'));
      job.timer=setTimeout(()=>this.remove(job,new TacticalQueueError(503,'战术判断等待超时，请按最新态势重试')),this.maxWaitMs);
      job.timer.unref?.();signal?.addEventListener('abort',job.cancel,{once:true});
      this.queue.push(job);this.queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
    });
  }
  cleanup(job){clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.cancel);}
  remove(job,error){const i=this.queue.indexOf(job);if(i<0)return;this.queue.splice(i,1);this.cleanup(job);job.reject(error);}
  lease(){let released=false;return ()=>{if(released)return;released=true;this.active--;this.drain();};}
  drain(){
    while(!this.closed&&this.active<this.concurrency&&this.queue.length){
      const job=this.queue.shift();this.cleanup(job);
      if(job.signal?.aborted){job.reject(new DOMException('请求已取消','AbortError'));continue;}
      this.active++;job.resolve(this.lease());
    }
  }
  close(){this.closed=true;for(const job of [...this.queue])this.remove(job,new TacticalQueueError(503,'战术服务已停止'));}
}
