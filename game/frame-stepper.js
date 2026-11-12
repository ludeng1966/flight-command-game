// Keep the 60 Hz physics clock, but never let catch-up work monopolize a frame.
// Short overruns carry forward; long suspension/overload slows simulation rather
// than increasing the integration step or building an unbounded backlog.
export class FrameStepper {
  constructor({now=()=>performance.now(),budgetMs=6,maxSteps=120}={}){
    Object.assign(this,{now,budgetMs,maxSteps});this.acc=0;
  }
  reset(){this.acc=0;}
  advance(dt,rate,step,isPlaying=()=>true){
    if(!isPlaying()){this.reset();return 0;}
    this.acc=Math.min(this.acc+Math.max(0,dt)*rate,Math.max(.25,.25*rate));
    const started=this.now();let count=0;
    while(this.acc+1e-12>=1/60&&isPlaying()){
      step(1/60);this.acc=Math.max(0,this.acc-1/60);count++;
      if(count>=this.maxSteps||this.now()-started>=this.budgetMs)break;
    }
    return count;
  }
}
