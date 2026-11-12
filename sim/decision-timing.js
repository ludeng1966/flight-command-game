// Wall-clock latency is distinct from simulation time. Paused flight never advances.
export class DecisionLatency{
  constructor(){this.samples=[];}
  record(seconds){if(Number.isFinite(seconds)&&seconds>0){this.samples.push(Math.min(60,seconds));if(this.samples.length>8)this.samples.shift();}}
  timing(clock){
    const playing=clock?.playing===true,rate=clock?.rate??1;
    if(!playing)return {playing:false,rate,estimatedOutputSec:0,recentOutputSec:[],horizonsSec:[0]};
    const estimate=this.samples.length?this.samples.reduce((a,b)=>a*.6+b*.4):5;
    return {playing:true,rate,estimatedOutputSec:estimate,recentOutputSec:[...this.samples],horizonsSec:[...new Set([.75,1,1.5].map(f=>Math.round(Math.max(.5,Math.min(60,estimate*f))*10)/10))]};
  }
}
export const sameDecisionClock=(a,b)=>a?.playing===b?.playing&&(!a?.playing||a.rate===b.rate);
