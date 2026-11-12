import {getUnitSystem} from '../sim/units.js';
import {pilotExecutionMessage} from '../sim/pilot-execution-message.js';
export class PilotExecutionRadio{
  constructor({getWorld,radio,isBusy}){Object.assign(this,{getWorld,radio,isBusy});this.queue=[];this.active=false;}
  enqueue(report){this.queue=this.queue.filter(r=>r.world!==report.world||r.unitId!==report.unitId);this.queue.push({...report,simTime:report.simTime??report.world?.time,applied:report.applied?structuredClone(report.applied):null,
    cause:report.cause?structuredClone(report.cause):null,plan:report.plan?structuredClone(report.plan):null});if(this.queue.length>8)this.queue.shift();}
  pump(){
    if(this.active||this.isBusy())return;
    const world=this.getWorld();let report,unit;
    const current=(r,u)=>r.world===world&&u?.alive!==false&&u?.pilotExecution?.id===r.executionId&&Number.isFinite(r.simTime)&&world.time>=r.simTime&&world.time-r.simTime<=30&&!(u.pilotExecution.lastAppliedAt>r.simTime);
    while(this.queue.length){report=this.queue.shift();unit=world.units.find(u=>u.id===report.unitId);if(current(report,unit))break;unit=null;}
    if(!unit)return;
    const message=pilotExecutionMessage(report,unit,world.unitSystem??getUnitSystem());message.simTime??=world.time;
    this.active=true;
    Promise.resolve().then(()=>{if(this.getWorld()===world&&current(report,unit))return this.radio.transmit(message);})
      .catch(()=>{}).finally(()=>{this.active=false;});
  }
}
