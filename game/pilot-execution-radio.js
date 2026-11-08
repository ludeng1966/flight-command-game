import {getUnitSystem} from '../sim/units.js';
import {pilotExecutionMessage} from '../sim/pilot-execution-message.js';
export class PilotExecutionRadio{
  constructor({getWorld,radio,isBusy}){Object.assign(this,{getWorld,radio,isBusy});this.queue=[];this.active=false;}
  enqueue(report){this.queue.push({...report,applied:report.applied?structuredClone(report.applied):null,
    cause:report.cause?structuredClone(report.cause):null,plan:report.plan?structuredClone(report.plan):null});if(this.queue.length>8)this.queue.shift();}
  pump(){
    if(this.active||this.isBusy())return;
    const world=this.getWorld();let report,unit;
    while(this.queue.length){report=this.queue.shift();unit=world.units.find(u=>u.id===report.unitId);if(report.world===world&&unit?.pilotExecution?.id===report.executionId)break;unit=null;}
    if(!unit)return;
    const message=pilotExecutionMessage(report,unit,world.unitSystem??getUnitSystem());message.simTime??=world.time;
    this.active=true;
    Promise.resolve().then(()=>this.radio.transmit(message))
      .catch(()=>{}).finally(()=>{this.active=false;});
  }
}
