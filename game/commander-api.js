import {commandContext} from '../sim/orders.js';
import {commandUnits} from '../sim/battle-observation.js';

const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const terminal=new Set(['completed','failed','cancelled']);

// A non-blocking adapter to the normal command-radio session, not a second
// flight/task executor. No ground-truth world reference crosses this API.
export function createCommanderApi({getState,issue,cancel,isBusy,select,setRunning,focusObserved=()=>{},onInstruction=()=>{},createId=()=>crypto.randomUUID()}){
  const jobs=new Map(),active=new Map();let closed=false;
  const time=()=>getState().world.time;
  const record=job=>copy(Object.fromEntries(Object.entries(job).filter(([key])=>key!=='world')));
  function lookup(id){const job=jobs.get(id);if(!job)throw Error('未知指挥请求编号');return job;}
  function finish(job,status,message){job.status=status;job.message=message;job.finishedAt=time();if(active.get(job.unitId)===job)active.delete(job.unitId);}
  function markCommitted(job,reply){
    if(!job||terminal.has(job.status)||active.get(job.unitId)!==job||job.world!==getState().world)return;
    Object.assign(job,{status:'committed',committed:true,committedAt:time(),backendRequestId:reply.requestId??null,message:'程序已装订，等待执行反馈',
      result:copy({commanderMessage:reply.commanderMessage,plan:reply.plan,interpretation:reply.interpretation})});
  }
  const api=Object.freeze({
    submit(instruction,{unitId=null}={}){
      if(closed)throw Error('指挥接口已关闭');
      if(typeof instruction!=='string'||!instruction.trim()||instruction.length>1000)throw Error('请输入 1–1000 字的指令');
      const state=getState(),units=commandUnits(state.world),target=unitId??state.selectedId;
      if(!units.some(u=>u.id===target))throw Error('只能选择玩家方可指挥的飞机');
      const previous=active.get(target);
      if(previous&&previous.instruction===instruction.trim()&&!terminal.has(previous.status))return record(previous);
      if(previous)finish(previous,'cancelled',previous.committed?'后续通联已接管，已装订任务继续执行':'同机新指令已替代旧请求');
      // Selecting a friendly receiver does not install or execute an order.
      select(target);onInstruction(instruction.trim());
      const job={commandId:createId(),instruction:instruction.trim(),unitId:target,status:'processing',committed:false,
        message:'正在提交指挥电台',submittedAt:time(),finishedAt:null,world:state.world};
      jobs.set(job.commandId,job);active.set(target,job);
      for(const [id,old] of jobs){if(jobs.size<=32)break;if(terminal.has(old.status))jobs.delete(id);}
      const run=async()=>{
        try{
          const result=await issue(job.instruction,{source:'api',unitId:target,onCommitted:reply=>markCommitted(job,reply),
            onStatus:message=>{if(!terminal.has(job.status)&&active.get(target)===job)job.message=message;}});
          if(terminal.has(job.status))return;
          if(job.world!==getState().world){finish(job,'cancelled','战场已重置，旧请求结束');return;}
          if(!result){finish(job,'cancelled',job.committed?'通话已结束，已装订任务继续执行':'指令已取消，任务未装订');return;}
          job.committed=!!result.committed;
          job.result=copy({status:result.status,committed:job.committed,summary:result.summary,
            commanderMessage:result.reply?.commanderMessage,plan:result.reply?.plan,interpretation:result.reply?.interpretation,
            resultReview:result.reply?.resultReview});
          finish(job,'completed',result.summary);
        }catch(error){
          if(terminal.has(job.status))return;
          job.committed=job.committed||error.commandCommitted===true;
          finish(job,error.name==='AbortError'?'cancelled':'failed',error.message);
        }
      };
      void run();return record(job);
    },
    status(commandId=null,{includeObservation=true}={}){
      const state=getState();
      return {playing:state.playing===true,rate:state.rate??1,simTimeSec:state.world.time,selectedUnitId:state.selectedId,
        busy:commandUnits(state.world).some(u=>isBusy(u.id))||[...active.values()].some(job=>!job.committed),
        activeCommandId:active.get(state.selectedId)?.commandId??null,activeCommandIds:[...active.values()].map(job=>job.commandId),
        ...(commandId?{command:record(lookup(commandId))}:{commands:[...jobs.values()].slice(-8).map(record)}),
        ...(includeObservation?{observation:copy(commandContext(state.world,state.selectedId,null,state.radioStyle??'pla'))}:{})};
    },
    cancel(commandId){
      const job=lookup(commandId);
      if(terminal.has(job.status))return record(job);
      if(active.get(job.unitId)!==job)throw Error('该指令已被后续通联替代，不能取消当前通联');
      cancel(job.unitId);finish(job,'cancelled',job.committed?'通话已停止，已装订任务继续执行':'已取消，本次任务未装订');return record(job);
    },
    setRunning(running,{camera=null}={}){
      if(typeof running!=='boolean')throw Error('running 必须是布尔值');
      if(camera!==null&&camera!=='tactical')throw Error('camera 仅支持 tactical');
      setRunning(running);if(camera==='tactical')focusObserved();return api.status(null,{includeObservation:false});
    }
  });
  return {api,
    committed(reply){
      // Legacy notifications are accepted only by exact backend id. New issue()
      // callbacks close over their job, so late replies cannot mark a newer order.
      const job=[...active.values()].find(value=>reply.requestId&&value.backendRequestId===reply.requestId);
      markCommitted(job,reply);
    },
    dispose(){closed=true;for(const job of [...active.values()])api.cancel(job.commandId);}
  };
}

export async function registerCommanderTools(api,{modelContext=globalThis.document?.modelContext??globalThis.navigator?.modelContext,signal}={}){
  if(typeof modelContext?.registerTool!=='function')return {available:false,registered:[]};
  const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
  const commandId={type:'string',minLength:1,description:'submit 返回的指挥请求编号'};
  const invoke=fn=>async(input={},options={})=>{
    options.signal?.throwIfAborted();
    try{return {content:[{type:'text',text:JSON.stringify(fn(input))}]};}
    catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:error.message})}]};}
  };
  const tools=[
    {name:'issue_commander_order',description:'通过游戏原有指挥电台下达自然语言指令，立即返回请求编号。随后查询 commander_status；submitted/processing 不代表任务已执行。',
      inputSchema:object({instruction:{type:'string',minLength:1,maxLength:1000},unitId:{type:'string',description:'玩家方受令机编号；省略时采用当前选中飞机'}},['instruction']),
      execute:invoke(({instruction,unitId})=>api.submit(instruction,{unitId})),annotations:{readOnlyHint:false}},
    {name:'commander_status',description:'查询指挥请求、实际装订反馈和玩家方态势。态势仅包含本方飞机及传感器观测，不提供敌方隐藏状态。',
      inputSchema:object({commandId,includeObservation:{type:'boolean',default:true}}),
      execute:invoke(({commandId,includeObservation=true})=>{if(typeof includeObservation!=='boolean')throw Error('includeObservation 必须是布尔值');return api.status(commandId,{includeObservation});}),annotations:{readOnlyHint:true}},
    {name:'cancel_commander_order',description:'取消尚未装订的指令，或停止已装订指令的通话。已装订的飞行任务继续执行。',
      inputSchema:object({commandId},['commandId']),execute:invoke(({commandId})=>api.cancel(commandId)),annotations:{readOnlyHint:false}},
    {name:'set_simulation_running',description:'继续或暂停当前游戏仿真；不会生成战术命令或改变倍速。',
      inputSchema:object({running:{type:'boolean'},camera:{type:'string',enum:['tactical'],description:'聚焦本方飞机和已观测目标'}},['running']),execute:invoke(({running,camera})=>api.setRunning(running,{camera})),annotations:{readOnlyHint:false}}
  ];
  const registered=[];
  for(const tool of tools){await modelContext.registerTool(tool,signal?{signal}:undefined);registered.push(tool.name);}
  return {available:true,registered};
}
