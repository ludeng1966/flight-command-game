import {parentPort} from 'node:worker_threads';
import {runCommandPlanning,runCommandForecast,runAdjustmentPlanning,runRoutePlanning} from '../sim/command-planning-worker.js';
import {runJob} from '../sim/planner-worker.js';
import {TerrainHeight} from '../sim/terrain.js';
let terrain=null;
parentPort.on('message',job=>{
  if(job.type==='init'){terrain=job.buffer?new TerrainHeight(job.meta,new Float32Array(job.buffer)):null;return;}
  try{const result=job.type==='prepare'?runCommandPlanning(job,terrain):job.type==='forecast'?runCommandForecast(job,terrain):job.type==='adjustment'?runAdjustmentPlanning(job,terrain):job.type==='route'?runRoutePlanning(job,terrain):runJob(job,terrain);parentPort.postMessage({id:job.id,result});}
  catch(error){parentPort.postMessage({id:job.id,error:error.message,result:{valid:false,reason:error.message,points:[],warnings:[]}});}
});
