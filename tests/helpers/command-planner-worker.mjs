import {parentPort} from 'node:worker_threads';
import {runCommandPlanning,runCommandForecast,runAdjustmentPlanning,runRoutePlanning} from '../../sim/command-planning-worker.js';
import {TerrainHeight} from '../../sim/terrain.js';
let terrain=null;
parentPort.on('message',job=>{
  if(job.type==='init'){terrain=job.buffer?new TerrainHeight(job.meta,new Float32Array(job.buffer)):null;return;}
  try{parentPort.postMessage({id:job.id,result:job.type==='forecast'?runCommandForecast(job,terrain):job.type==='adjustment'?runAdjustmentPlanning(job,terrain):job.type==='route'?runRoutePlanning(job,terrain):runCommandPlanning(job,terrain)});}
  catch(error){parentPort.postMessage({id:job.id,error:error.message});}
});
