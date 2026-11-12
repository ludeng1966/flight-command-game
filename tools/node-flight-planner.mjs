import {Worker} from 'node:worker_threads';
// Browser-shaped worker adapter, so live headless evaluation runs the same
// background planners as the game rather than blocking in World.step.
export function createFlightWorker(){
  const worker=new Worker(new URL('./flight-planning-worker.mjs',import.meta.url),{execArgv:[]});
  const adapter={postMessage:(job,transfer=[])=>worker.postMessage(job,transfer),terminate:()=>worker.terminate(),onmessage:null,onerror:null};
  worker.on('message',data=>adapter.onmessage?.({data}));worker.on('error',error=>adapter.onerror?.(error));return adapter;
}
