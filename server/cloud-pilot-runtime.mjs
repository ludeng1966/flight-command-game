// Implements the pilot runtime interface without starting a local model process.
export function createCloudPilotRuntime(client){
  let ready=false;
  const controller=new AbortController();
  return {
    async start(){ready=true;},
    async stop(){ready=false;controller.abort();},
    health:()=>({status:ready?'ready':'sleeping',pid:null,memory:{dedicatedMiB:0,peakDedicatedMiB:0}}),
    complete(role,messages,schema,{maxTokens=350,signal}={}){
      return client.completePilot(messages,schema,{maxTokens,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
    }
  };
}
