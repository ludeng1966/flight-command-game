import {preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {TacticalDirector} from './tactical-director.js';
import {directOwnsFlight,guidanceContext} from '../sim/tactical-guidance.js';
import {ATTACK_METHODS,DEFENSE_METHODS,DEFENSE_SIDES,tacticalOptions} from './tactical-options.js';
import {validateCommandScope} from './structured-command.js';
import {commandUnits} from '../sim/battle-observation.js';
import {attackContacts} from '../sim/attack-task.js';
import {validateDefenseTask} from '../sim/rwr-defense.js';
import {controlAuthority,requestHandoff} from '../sim/control-authority.js';
import {notePlayerOrder,capturePlayerOrderScope,isPlayerOrderScopeCurrent,playerOrderVersion} from '../sim/command-scope.js';

const ACTIONS=new Set(['move','attack','defend','disengage','hold','return_base']);
const INSTANT=new Set(['hold','defend']);
const TERMINAL=new Set(['completed','unable','superseded']);
const LABELS={move:['转进指定空域','PROCEED TO ASSIGNED POSITION'],attack:['攻击指定航迹，最多一枚','ENGAGE ASSIGNED TRACK, ONE MISSILE MAXIMUM'],defend:['执行告警规避','DEFENDING'],disengage:['停止攻击，向指定空域脱离','DISENGAGE TO ASSIGNED POSITION'],hold:['停止继续发射','CEASE FIRE'],return_base:['返场并申请管制接管','RETURN TO BASE, REQUEST ARRIVAL']};
const plainTask=(unitId,action,values={})=>({unitId,action,altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false,...values});
const holdTask=unitId=>({unitId,action:'weapon',weaponOrder:{operation:'hold',modelId:null,targetId:null,quantity:null}});
const position=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)&&Math.abs(v[0])<=200000&&Math.abs(v[1])<=200000&&v[2]>=500&&v[2]<=15000;
const copy=value=>structuredClone(value);
const cancelled=()=>Object.assign(Error('新指令已接管，原快捷命令作废'),{code:'SUPERSEDED'});

function reasonCode(error){
  if(error?.code==='SUPERSEDED'||error?.name==='AbortError')return 'superseded';
  const text=String(error?.message??error);
  if(/塔台|交接|管制|ground|authority/.test(text))return 'authority';
  if(/告警/.test(text))return 'no_threat';
  if(/观测|友机|航迹|攻击目标/.test(text))return 'no_observation';
  return 'validation';
}
const REASONS={superseded:'SUPERSEDED BY A NEW ORDER.',authority:'UNABLE. COMPLETE THE REQUIRED CONTROL HANDOFF FIRST.',no_threat:'UNABLE. NO VALID THREAT BEARING OR SAFE DEFENSIVE FLIGHT PHASE.',no_observation:'UNABLE. TARGET IS NOT A VALID OBSERVED HOSTILE TRACK.',validation:'UNABLE. COMMAND FAILED CURRENT FLIGHT OR TASK VALIDATION.'};

// All records here are data, not promises/scopes or executable operations. Pending
// requests never enter the save, and restoring a record cannot replay a launch.
function cleanRecord(value){
  if(!value||!ACTIONS.has(value.action)||typeof value.commandId!=='string'||value.commandId.length>120||!Array.isArray(value.unitIds)||value.unitIds.length>16||value.unitIds.some(id=>typeof id!=='string')||value.point!==null&&value.point!==undefined&&!position(value.point))return null;
  const out={commandId:value.commandId,action:value.action,unitIds:value.unitIds.slice(),targetId:typeof value.targetId==='string'?value.targetId:null,point:value.point?value.point.slice():null,
    status:['queued','executing','waiting','completed','unable','superseded'].includes(value.status)?value.status:'waiting',summary:LABELS[value.action][0],summaryEn:LABELS[value.action][1],issuedAt:Number.isFinite(value.issuedAt)?value.issuedAt:0};
  try{Object.assign(out,tacticalOptions(value));}catch{return null;}
  for(const key of ['attackTaskId','stage','reason','reasonEn','orderVersion'])if(typeof value[key]==='string')out[key]=value[key].slice(0,300);
  for(const key of ['initialCompleted','routePointCount','remainingShots'])if(Number.isSafeInteger(value[key])&&value[key]>=0)out[key]=value[key];
  if(value.destinations&&typeof value.destinations==='object')out.destinations=Object.fromEntries(Object.entries(value.destinations).filter(([,p])=>position(p)).map(([id,p])=>[id,p.slice()]));
  return out;
}

export class TacticalCommands{
  constructor({getWorld,preparePlan=preparePilotPlan,prepareRoute=null,beforeCommand=()=>{},onChange=()=>{},onReceipt=()=>{},planManeuver=null,fetchImpl=fetch,getPilotModel=()=>'flash'}){
    Object.assign(this,{getWorld,preparePlan,prepareRoute,beforeCommand,onChange,onReceipt});
    this.world=null;this.pending=new Map();this.guards=new Map();this.seen=new Map();this.lastReceipt=null;this._state();
    this.director=new TacticalDirector({getWorld,preparePlan,beforeCommand,onChange,onReceipt,planManeuver,fetchImpl,getPilotModel,onScopeChanged:(ids,restored)=>{this._bind(ids);if(restored)for(const id of ids){const s=this._unitState(id),u=this.world.units.find(u=>u.id===id);if(s.current&&['move','disengage','return_base'].includes(s.current.action)){s.current.initialCompleted=u.completedWaypoints??0;s.current.routePointCount=u.waypoints.length;}}}});
  }
  _state(){
    const world=this.getWorld();
    if(this.world!==world){this.reset();this.world=world;}
    if(!world.tacticalCommands||world.tacticalCommands.version!==1){world.tacticalCommands={version:1,sequence:0,units:{}};}
    const saved=world.tacticalCommands;
    if(!saved.units||typeof saved.units!=='object'||Array.isArray(saved.units))saved.units={};
    if(!Number.isSafeInteger(saved.sequence)||saved.sequence<0)saved.sequence=0;
    for(const id of Object.keys(saved.units)){
      if(!commandUnits(world).some(u=>u.id===id)){delete saved.units[id];continue;}
      const s=saved.units[id];if(!s||typeof s!=='object'){delete saved.units[id];continue;}
      if(!this.guards.has(id)){
        s.current=cleanRecord(s.current);s.queue=Array.isArray(s.queue)?s.queue.slice(0,16).map(cleanRecord).filter(Boolean):[];
        s.interrupt=cleanRecord(s.interrupt);this._bind([id]);
      }
    }
    return saved;
  }
  _unitState(id){const s=this._state();return s.units[id]??= {current:null,queue:[],interrupt:null,reason:null};}
  _bind(ids){for(const id of ids)this.guards.set(id,capturePlayerOrderScope(this.world));}
  _receipt(request,status,extra={}){
    let label=LABELS[request.action]??['快捷命令','TACTICAL ORDER'];
    const method=request.action==='attack'?ATTACK_METHODS[request.attackMethod]:request.action==='defend'?DEFENSE_METHODS[request.defenseMethod]:null;
    if(method){const side=request.action==='defend'&&request.defenseMethod==='notch'?DEFENSE_SIDES[request.defenseSide]:null;label=[`${method.zh}${side?' · '+side.zh:''}`,`${method.en}${side?' · '+side.en:''}`];}
    const prefix={planning:['正在规划','PLANNING'],queued:['已排队','QUEUED'],executing:['已装订','ORDER ACCEPTED'],waiting:['等待许可','STANDBY'],completed:['已完成','COMPLETE'],unable:['无法执行','UNABLE'],superseded:['已被新命令替代','SUPERSEDED']}[status];
    const summary=extra.summary??`${prefix[0]}：${label[0]}`,summaryEn=extra.summaryEn??`${prefix[1]}. ${label[1]}.`;
    const receipt={commandId:request.commandId,action:request.action,unitIds:request.unitIds.slice(),attackMethod:request.attackMethod,defenseMethod:request.defenseMethod,defenseSide:request.defenseSide,status,committed:status==='executing'||status==='waiting'||status==='completed',summary,summaryEn,texts:{zh:summary,en:summaryEn},...extra};
    receipt.texts={zh:receipt.summary,en:receipt.summaryEn};this.lastReceipt=receipt;this.onReceipt(receipt);this.onChange();return receipt;
  }
  _normalize(input){
    if(!input||!ACTIONS.has(input.action))throw Error('未知快捷命令');
    const world=this.getWorld(),own=new Map(commandUnits(world).filter(u=>u.alive!==false).map(u=>[u.id,u]));
    let ids=[...new Set(input.unitIds??[])];if(!ids.length||ids.length>16||ids.some(id=>!own.has(id)))throw Error('只能向存活的己方可指挥飞机下令');
    if(input.action==='attack')ids=ids.slice(0,1);
    const request={action:input.action,unitIds:ids,targetId:input.targetId??null,point:input.point?Array.from(input.point):null,append:!!input.append&&!INSTANT.has(input.action),commandId:input.commandId??`tactical-${++this._state().sequence}`,issuedAt:world.time};
    Object.assign(request,tacticalOptions(input));
    if(typeof request.commandId!=='string'||!request.commandId||request.commandId.length>120)throw Error('快捷命令编号无效');
    if(['move','disengage'].includes(request.action)&&!position(request.point))throw Error('必须指定有效的三维飞行目的地');
    if(request.action==='attack'&&(typeof request.targetId!=='string'||!request.targetId))throw Error('请点选有效的敌方观测航迹');
    if(request.action==='return_base'&&!world.airportOps)throw Error('当前场景没有可返场机场');
    if(request.action==='return_base'){
      const a=world.airportOps.airport,u=own.get(ids[0]),dx=u.position[0]-a.center[0],dy=u.position[1]-a.center[1],d=Math.hypot(dx,dy)||1;
      request.point=[a.center[0]+(d>1?dx/d:1)*10000,a.center[1]+(d>1?dy/d:0)*10000,Math.max(500,a.elevation+900,Math.min(u.targetAltitude??u.position[2],a.elevation+8000))];
    }
    if(request.point){const lead=own.get(ids[0]);request.destinations=Object.fromEntries(ids.map(id=>[id,request.point.map((v,k)=>v+(id===lead.id?0:own.get(id).position[k]-lead.position[k]))]));}
    return request;
  }
  _authority(request){
    const world=this.getWorld();
    for(const id of request.unitIds){
      const u=commandUnits(world).find(u=>u.id===id&&u.alive!==false);if(!u)throw Error('受令飞机失效或不属于当前阵营');
      const c=controlAuthority(world,u);
      if(request.action==='hold')continue; // Cease fire does not grant navigation/airport authority.
      if(request.action==='return_base'){
        if(u.surface?.grounded)throw Error('该机已在地面，无需返场');
        if(c.phase==='transferring')throw Error('管制交接进行中，等待接管完成');
        continue;
      }
      if(c.owner!=='commander'||c.phase!=='owned')throw Error('塔台仍负责该机，请先完成空中指挥交接');
    }
  }
  _plan(request){
    const world=this.getWorld();this._authority(request);
    let tasks;
    if(request.action==='attack'){
      const u=world.units.find(u=>u.id===request.unitIds[0]),contact=attackContacts(u,world.time).find(c=>c.id===request.targetId&&c.classification!=='friendly');
      if(!contact)throw Error('攻击目标不在受令机的当前有效观测内');
      tasks=[{unitId:u.id,action:'attack_task',attackOrder:{targetId:contact.id,targetRef:contact.id,weaponRef:ATTACK_METHODS[request.attackMethod].weaponRef,shotLimit:1,altitudeM:null,speedMps:null,headingDeg:null}}];
    }else if(request.action==='defend')tasks=request.unitIds.map(unitId=>{
      const task={unitId,action:'defense',defenseOrder:{mode:'execute',maneuver:request.defenseMethod,side:request.defenseMethod==='extend'?'auto':request.defenseSide,headingDeg:null}};
      validateDefenseTask(world,world.units.find(u=>u.id===unitId),task.defenseOrder);return task;
    });
    else if(request.action==='hold')tasks=request.unitIds.map(holdTask);
    else{
      tasks=request.unitIds.map(unitId=>{const p=request.destinations[unitId];return plainTask(unitId,'fly_to',{eastM:p[0],northM:p[1],altitudeM:p[2]});});
      // Cease fire and escape route commit as one validated transaction.
      if(request.action==='disengage')tasks=[...request.unitIds.map(holdTask),...tasks];
    }
    const plan={status:'accepted',summary:LABELS[request.action][0],tasks};validateCommandScope(world,plan);return plan;
  }
  issue(input){
    if(['offense_policy','defense_policy','maneuver'].includes(input?.action)){
      const rejected=error=>{const receipt={status:'unable',action:'guidance',unitIds:input.unitIds??[],summary:error.message,summaryEn:'UNABLE TO COMPLY. CHECK CONTROL AUTHORITY AND CURRENT OBSERVATIONS.',committed:false};this.onReceipt(receipt);return receipt;};
      try{return Promise.resolve(input.action==='maneuver'?this.director.maneuver(input):this.director.setPolicy({...input,category:input.action==='offense_policy'?'offense':'defense'})).catch(rejected);}catch(error){return Promise.resolve(rejected(error));}
    }
    let request;
    try{this._state();request=this._normalize(input);}catch(error){
      const fallback={action:ACTIONS.has(input?.action)?input.action:'move',unitIds:Array.isArray(input?.unitIds)?input.unitIds.filter(id=>typeof id==='string'):[],commandId:typeof input?.commandId==='string'?input.commandId:'invalid'};
      return Promise.resolve(this._receipt(fallback,'unable',{reason:error.message,reasonCode:reasonCode(error),summary:error.message,summaryEn:REASONS[reasonCode(error)]}));
    }
    if(this.seen.has(request.commandId))return this.seen.get(request.commandId);
    const promise=this._issue(request);this.seen.set(request.commandId,promise);while(this.seen.size>64)this.seen.delete(this.seen.keys().next().value);return promise;
  }
  async _issue(request,{queued=false}={}){
    const world=this.getWorld();let job;
    try{
      let plan=this._plan(request);
      if(request.append&&!queued){
        for(const id of request.unitIds){const s=this._unitState(id);if(s.queue.length>=16)throw Error('该机后续任务已满，请先删除不需要的任务');}
        if(request.unitIds.some(id=>{const s=this._unitState(id);return s.current&&!TERMINAL.has(s.current.status)||this.pending.has(id);})){
          for(const id of request.unitIds){const record=cleanRecord({...request,unitIds:[id],status:'queued'});this._unitState(id).queue.push(record);}
          return this._receipt(request,'queued',{committed:false});
        }
      }
      // Complete validation precedes cancellation so a typo cannot cancel a valid mission.
      for(const id of request.unitIds){const previous=this.pending.get(id);previous?.controller.abort();}
      this.beforeCommand(request.unitIds.slice(),request.action);notePlayerOrder(world,request.unitIds);
      if(request.action==='hold')this.director.rebase(request.unitIds);else this.director.cancelFor(request.unitIds);
      job={world,request,controller:new AbortController(),scope:capturePlayerOrderScope(world)};
      for(const id of request.unitIds){this.pending.set(id,job);const s=this._unitState(id);if(!queued&&!INSTANT.has(request.action))s.queue=[];}
      this._receipt(request,'planning',{committed:false});
      const assertCurrent=()=>{
        if(this.getWorld()!==world||job.controller.signal.aborted||request.unitIds.some(id=>this.pending.get(id)!==job)||!isPlayerOrderScopeCurrent(world,job.scope,request.unitIds))throw cancelled();
        this._authority(request);validateCommandScope(world,plan);
      };
      let draft,result;
      for(let attempt=0;attempt<3;attempt++){
        assertCurrent();plan=this._plan(request);
        draft=await this.preparePlan(world,plan,world.revision,{scoped:true,unitIds:request.unitIds},job.controller.signal);assertCurrent();
        draft.expectedRevision=world.revision;
        const defenses=request.action==='hold'?request.unitIds.map(id=>[id,world.units.find(u=>u.id===id).rwrDefense?.active]):[];
        try{result=commitPilotPlan(draft);for(const [id,active]of defenses)if(active)world.units.find(u=>u.id===id).rwrDefense.active=active;break;}
        catch(error){if(error.code!=='FLIGHT_STATE_CHANGED'||attempt===2)throw error;}
      }
      for(const id of request.unitIds){
        const u=world.units.find(u=>u.id===id),s=this._unitState(id),record=cleanRecord({...request,unitIds:[id],status:request.action==='hold'?'completed':'executing'});
        if(request.action==='defend')s.interrupt=record;
        else if(request.action==='hold'){
          s.queue=s.queue.filter(r=>r.action!=='attack');
          if(!s.current||s.current.action==='attack'||TERMINAL.has(s.current.status))s.current=record;
        }else{
          record.initialCompleted=u.completedWaypoints??0;record.routePointCount=u.waypoints.length;
          if(request.action==='attack'){record.attackTaskId=u.attackTask.id;record.remainingShots=1;}
          if(request.action==='return_base')record.stage='return_navigation';
          s.current=record;
        }
        s.reason=null;
      }
      if(request.action==='hold')this.director.rebase(request.unitIds);
      this._bind(request.unitIds);
      return this._receipt(request,request.action==='hold'?'completed':'executing',{result,primaryUnitId:request.unitIds[0]});
    }catch(failure){
      const error=job&&(job.controller.signal.aborted||this.getWorld()!==world||request.unitIds.some(id=>this.pending.get(id)!==job))?cancelled():failure;
      const code=reasonCode(error),status=code==='superseded'?'superseded':'unable';
      if(job&&this.getWorld()===world&&request.unitIds.every(id=>this.pending.get(id)===job))this._bind(request.unitIds);
      return this._receipt(request,status,{committed:false,reason:error.message,reasonCode:code,summary:error.message,summaryEn:REASONS[code]});
    }finally{
      if(job)for(const id of request.unitIds)if(this.pending.get(id)===job)this.pending.delete(id);
      this.onChange();
    }
  }
  _finish(id,status,reason=null){
    const s=this._unitState(id),r=s.current;if(!r)return;r.status=status;if(reason){s.reason=reason;r.reason=reason;}
    this._receipt(r,status,reason?{reason,summary:reason}:{});
  }
  _returnProgress(world,u,s){
    const r=s.current,c=controlAuthority(world,u);
    if(u.surface?.grounded){this._finish(u.id,'completed');return;}
    if(r.stage==='return_navigation'&&u.waypoints.length)return;
    r.stage='handoff';r.status='waiting';
    const zh='已到返场等待空域，等待塔台接管、指定跑道和进近许可',en='HOLDING FOR ARRIVAL. AWAIT CONTROL HANDOFF, RUNWAY ASSIGNMENT AND APPROACH CLEARANCE.';
    if(s.reason!==zh){s.reason=zh;r.reason=zh;r.reasonEn=en;this._receipt(r,'waiting',{summary:zh,summaryEn:en});}
    if(c.owner==='commander'&&c.phase==='owned'){requestHandoff(world,u,'tower');this._bind([u.id]);}
    // Strict-mode phase authorizations always remain with the player.
    if(world.executionMode!=='relaxed'||c.owner!=='tower'||c.phase!=='owned'||this.pending.has(u.id))return;
    r.stage='arrival_request';
    const runway=world.airportOps.runway(u.surface?.runway).designator;
    const order={unitId:u.id,action:'airport',airportOrder:{intent:'approach',airportId:world.airportOps.airport.id,runway,taxiways:[],gate:null,altitudeM:null,mode:'ils'}};
    try{const plan={status:'accepted',summary:'请求返场进近',tasks:[order]};validateCommandScope(world,plan);commitPilotPlan(preparePilotPlan(world,plan,world.revision));r.stage='approach';r.status='executing';s.reason=null;this._bind([u.id]);}
    catch(error){r.stage='handoff';s.reason=error.message;}
  }
  tick(){
    this.director.tick();
    const state=this._state(),world=this.getWorld();
    for(const [id,s]of Object.entries(state.units)){
      const u=world.units.find(u=>u.id===id);if(!u||this.pending.has(id))continue;
      if(directOwnsFlight(u))continue;
      const guard=this.guards.get(id);
      if(guard&&!isPlayerOrderScopeCurrent(world,guard,[id])){
        s.queue=[];s.interrupt=null;
        if(s.current&&!TERMINAL.has(s.current.status))this._finish(id,'superseded','新的玩家命令已接管，原快捷任务和后续队列已取消');
        this._bind([id]);continue;
      }
      if(s.interrupt&&!u.rwrDefense?.active)s.interrupt=null;
      const r=s.current;
      if(r&&!TERMINAL.has(r.status)){
        if(u.alive===false){s.queue=[];this._finish(id,'unable','飞机失效，后续任务停止');continue;}
        if(r.action==='attack'){
          const attack=u.attackTask;r.remainingShots=Math.max(0,1-(attack?.firedMissileIds?.length??0));
          if(!attack||attack.id!==r.attackTaskId){s.queue=[];this._finish(id,'superseded','攻击任务已被替代');continue;}
          if(!attack.active){if(attack.status==='completed'||attack.status==='exhausted')this._finish(id,'completed');else{s.queue=[];this._finish(id,'unable','攻击任务已中止，后续任务等待重新下令');}}
        }else if(r.action==='return_base'){
          if(r.stage==='return_navigation'&&(!u.waypoints.length&&(u.completedWaypoints??0)>=(r.initialCompleted??0)+(r.routePointCount??1)))this._returnProgress(world,u,s);
          else if(r.stage!=='return_navigation')this._returnProgress(world,u,s);
        }else if(['move','disengage'].includes(r.action)&&!u.waypoints.length&&(u.completedWaypoints??0)>=(r.initialCompleted??0)+(r.routePointCount??1))this._finish(id,'completed');
      }
      if((!s.current||TERMINAL.has(s.current.status))&&s.queue.length&&!s.interrupt){
        const next=s.queue.shift();void this._issue({...next,append:false},{queued:true});
      }
    }
  }
  clearQueued(unitId,commandId=null){
    const s=this._state().units[unitId];if(!s)return;
    s.queue=commandId?s.queue.filter(r=>r.commandId!==commandId):[];this.onChange();
  }
  snapshot(unitIds=[]){
    const state=this._state(),ids=unitIds.length?unitIds:commandUnits(this.getWorld()).map(u=>u.id);
    return {units:ids.map(unitId=>{const s=state.units[unitId],unit=this.world.units.find(u=>u.id===unitId);return {unitId,guidance:guidanceContext(unit?.tacticalGuidance),current:s?.current?copy(s.current):null,queue:copy(s?.queue??[]),interrupt:s?.interrupt?copy(s.interrupt):null,status:this.pending.has(unitId)?'planning':s?.current?.status??'idle',reason:s?.reason??null};}),
      pending:[...new Set(this.pending.values())].map(j=>({commandId:j.request.commandId,unitIds:j.request.unitIds.slice(),action:j.request.action,status:'planning'})),lastReceipt:this.lastReceipt};
  }
  // Pagehide/disposal cancels only work that has not committed. Saved missions survive.
  reset(){this.director?.reset();for(const job of new Set(this.pending.values()))job.controller.abort();this.pending.clear();this.guards.clear();this.seen.clear();this.lastReceipt=null;}
}
