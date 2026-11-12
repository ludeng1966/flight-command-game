import {commandContext} from '../sim/orders.js';
import {applyRadarOrder} from '../sim/radar.js';
import {AttackPilot} from './attack-pilot.js';
import {RwrPilot} from './rwr-pilot.js';
import {capturePlayerOrderScope,assertPlayerOrderScope} from '../sim/command-scope.js';
import {createSilentCommandRadio,duelDecisionPlan,runStructuredCommand} from './structured-command.js';

const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const newReport=()=>({blueCommander:'Codex（本对话助手）',redCommander:'qwen3.7-flash',pilot:'qwen3.7-flash',clockRate:1,orders:[],commands:[],requests:[],events:[],frames:[]});

export function initDuel({getWorld,isPlaying,setPlaying,getCommandOptions=()=>({}),fetchImpl=fetch,document:doc=globalThis.document,
  createAttackPilot=options=>new AttackPilot(options),createRwrPilot=options=>new RwrPilot(options),createId=()=>crypto.randomUUID()}){
  const evidence=doc.createElement('script');evidence.type='application/json';evidence.id='duel-evidence';doc.body.append(evidence);
  let base=null,red=null,redRevision=0,attack,rwr,radio,next=1,job=null,started=false,ended=false,closed=false,epoch=0,report=newReport(),sampled=-1;
  const seen=new Set();
  const save=()=>{evidence.textContent=JSON.stringify(report);};
  const log=(side,text)=>{report.orders.push({time:base.time,side,text:copy(text)});save();};
  function stopPilots(){job?.abort();job=null;attack?.stop();rwr?.stop();}
  function initialize(){
    stopPilots();base=getWorld();redRevision=0;epoch++;next=1;started=false;ended=false;sampled=-1;seen.clear();report=newReport();
    red=new Proxy(base,{get:(target,key,receiver)=>key==='playerTeam'?'red':key==='revision'?redRevision:Reflect.get(target,key,receiver),
      set:(target,key,value,receiver)=>{if(key==='revision'){redRevision=value;return true;}return Reflect.set(target,key,value,receiver);}});
    // Symmetric readiness only; actual combat tasks use the shared session.
    for(const unit of base.units){unit.headingTarget=Math.atan2(unit.velocity[0],unit.velocity[1]);applyRadarOrder(base,unit,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});}
    const options={getWorld:()=>red,isPlaying:()=>started&&!ended&&!closed&&isPlaying(),fetchImpl:traceFetch('red')};
    attack=createAttackPilot(options);rwr=createRwrPilot(options);
    radio=createSilentCommandRadio({getTime:()=>base.time,onEvent:event=>recordCommand({side:'red',...event})});save();
  }
  function ensureCurrent(){if(!closed&&base!==getWorld())initialize();}
  function recordRequest(entry){
    ensureCurrent();if(closed||entry.world&&entry.world!==base)return null;
    const {world,...fields}=entry,value={side:fields.side??'blue',time:fields.issuedAt??fields.time??base.time,...copy(fields)};
    report.requests.push(value);save();return value;
  }
  function recordCommand(entry){
    ensureCurrent();if(closed||entry.world&&entry.world!==base)return;
    const {world,...fields}=entry;report.commands.push({time:base.time,wallTimeMs:performance.now(),side:fields.side??'blue',...copy(fields)});save();
  }
  function traceFetch(side,transport=fetchImpl){
    return async(url,options)=>{
      ensureCurrent();const current=base,currentEpoch=epoch,issuedWallMs=performance.now();
      const entry=recordRequest({side,url,input:typeof options?.body==='string'?JSON.parse(options.body):null,issuedAt:base.time,issuedWallMs,world:current});
      try{const response=await transport(url,options);if(entry){entry.response=await response.clone().json();entry.returnedAt=current.time;entry.stage='returned';}return response;}
      catch(error){if(entry){entry.error=error.message;entry.returnedAt=current.time;entry.stage='failed';}throw error;}
      finally{if(entry){entry.returnedWallMs=performance.now();entry.elapsedMs=entry.returnedWallMs-issuedWallMs;}if(epoch===currentEpoch)save();}
    };
  }
  const requestRed=traceFetch('red');
  function tick(){
    if(closed)return;ensureCurrent();
    if(ended){if(isPlaying())setPlaying(false);return;}
    const world=base,blue=world.units.filter(u=>u.team==='blue'&&u.alive).length,reds=world.units.filter(u=>u.team==='red'&&u.alive).length;let sampledNow=false,weaponChanged=false;
    for(const event of world.weaponEvents){const key=event.id+event.type;if(!seen.has(key)){seen.add(key);report.events.push(copy(event));weaponChanged=true;}}
    if(world.time-sampled>=1){sampled=world.time;sampledNow=true;report.frames.push({time:world.time,units:world.units.map(u=>({id:u.id,alive:u.alive,position:[...u.position],attack:u.attackTask?.status,defending:!!u.rwrDefense.active}))});}
    if(!blue||!reds||world.time>=180){
      ended=true;setPlaying(false);stopPilots();report.result={time:world.time,blueSurvivors:blue,redSurvivors:reds,
        result:!blue&&!reds?'双方损失':!blue?'红方胜':!reds?'蓝方胜':'时间到，双方仍有飞机存活',weaponEvents:copy(world.weaponEvents)};
      log('裁判',report.result.result);return;
    }
    // Judge evidence can become large. Regular frames flush once per simulated
    // second; weapon/command/request events still flush immediately.
    if(!started){if(!isPlaying()){if(sampledNow||weaponChanged)save();return;}started=true;log('裁判','通过正式指挥链开始对局');}
    attack.tick();rwr.tick();if(sampledNow||weaponChanged)save();
    if(!isPlaying()||job||world.time<next)return;
    next=world.time+12;const controller=job=new AbortController(),currentEpoch=epoch,context=commandContext(red,'red-1'),requestId=createId();let scope=capturePlayerOrderScope(red);
    const current=()=>{if(controller.signal.aborted||ended||closed||epoch!==currentEpoch||getWorld()!==world)throw new DOMException('对局请求已结束','AbortError');};
    recordCommand({side:'red',stage:'issued',commandId:requestId,simTimeSec:context.simTimeSec});
    void(async()=>{
      try{
        const response=await requestRed('/api/tactical/duel/commander',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
        const data=await response.json();current();if(!response.ok)throw Error(data.error||'红方指挥服务不可用');
        if(data.requestId!==requestId||data.simTimeSec!==context.simTimeSec||data.revision!==context.revision)throw Error('指挥响应不匹配');
        recordCommand({side:'red',stage:'decision',commandId:requestId,decision:data.decision});
        const {plan,unchanged}=duelDecisionPlan(red,data.decision);
        if(!plan){recordCommand({side:'red',stage:'unchanged',commandId:requestId,unitIds:unchanged});return;}
        const ids=plan.tasks.map(task=>task.unitId),assertScope=()=>{current();assertPlayerOrderScope(red,scope,ids);};assertScope();
        const reply={requestId,revision:context.revision,simTimeSec:context.simTimeSec,plan};
        const provided=getCommandOptions('red')??{},onCommitted=provided.onCommitted;
        const result=await runStructuredCommand({...provided,world:red,reply,expectedRevision:red.revision,selectedUnitId:plan.tasks[0].unitId,radio,
          executionGuard:{assertCurrent:assertScope},
          signal:controller.signal,assertCurrent:()=>{current();provided.assertCurrent?.();},assertWorldCurrent:current,
          onCommitted:(result,draft)=>{current();scope=capturePlayerOrderScope(red);recordCommand({side:'red',stage:'committed',commandId:requestId,reply,result});onCommitted?.(result,draft);}});
        current();recordCommand({side:'red',stage:'completed',commandId:requestId,result});log('Flash红方',data.decision.reason);
      }catch(error){if(epoch===currentEpoch&&!controller.signal.aborted&&!closed){recordCommand({side:'red',stage:'failed',commandId:requestId,error:error.message});log('红方指挥错误',error.message);}}
      finally{if(job===controller)job=null;if(epoch===currentEpoch)save();}
    })();
  }
  return {tick,recordRequest,recordCommand,traceFetch,
    recordBlue(reply){ensureCurrent();if(closed)return;recordCommand({side:'blue',stage:'committed',commandId:reply.requestId,reply});log('Codex电台',{commanderMessage:reply.commanderMessage,plan:reply.plan,interpretation:reply.interpretation});},
    get ended(){ensureCurrent();return ended;},
    canResume(){ensureCurrent();return !closed&&!ended&&base.time<180&&['blue','red'].every(team=>base.units.some(u=>u.team===team&&u.alive));},
    dispose(){closed=true;stopPilots();}
  };
}
