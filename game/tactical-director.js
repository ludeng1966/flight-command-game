import {deliveredPartnerState} from '../sim/tactical-guidance.js';
import {commandContext,preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {commandUnits} from '../sim/battle-observation.js';
import {OFFENSE_POLICIES,DEFENSE_POLICIES,DIRECT_MANEUVERS,guidanceContext,directOwnsFlight} from '../sim/tactical-guidance.js';
import {capturePlayerOrderScope,isPlayerOrderScopeCurrent,notePlayerOrder,playerOrderVersion} from '../sim/command-scope.js';
import {controlAuthority} from '../sim/control-authority.js';
import {attackContacts} from '../sim/attack-task.js';
import {validateDefenseTask} from '../sim/rwr-defense.js';
import {captureLoopRoute,restoreLoopRoute} from '../sim/route-loop.js';

const clone=v=>structuredClone(v),task=(unitId,action,more={})=>({unitId,action,altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false,...more});
export class TacticalDirector{
  constructor({getWorld,preparePlan=preparePilotPlan,prepareRoute=null,planManeuver=null,fetchImpl=fetch,getPilotModel=()=>'flash',onChange=()=>{},onReceipt=()=>{},onScopeChanged=()=>{},beforeCommand=()=>{}}){
    Object.assign(this,{getWorld,preparePlan,prepareRoute,fetchImpl,getPilotModel,onChange,onReceipt,onScopeChanged,beforeCommand});this.jobs=new Map();this.guards=new Map();
    this.planManeuver=planManeuver??(async(input,signal)=>{const response=await this.fetchImpl('/api/tactical/pilot/maneuver',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,pilotModel:this.getPilotModel()}),signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});const result=await response.json();if(!response.ok)throw Error(result.error??'飞行员规划连接失败');if(result.requestId!==input.requestId||result.revision!==input.context.revision||result.simTimeSec!==input.context.simTimeSec)throw Error('直接机动规划已过期');return result;});
  }
  units(ids){const world=this.getWorld(),units=commandUnits(world).filter(u=>ids.includes(u.id));if(!ids.length||new Set(ids).size!==ids.length||units.length!==ids.length||units.some(u=>!u.alive||u.surface?.grounded||controlAuthority(world,u).owner!=='commander'||controlAuthority(world,u).phase!=='owned'))throw Error('无法执行，请先完成空中指挥管制交接');return units;}
  cancelFor(ids){for(const id of ids){this.jobs.get(id)?.controller.abort();this.jobs.delete(id);const g=this.getWorld().units.find(u=>u.id===id)?.tacticalGuidance;if(g?.direct){g.direct.phase='cancelled';g.resume=null;}}}
  rebase(ids){for(const id of ids){this.guards.set(id,capturePlayerOrderScope(this.getWorld()));const u=this.getWorld().units.find(u=>u.id===id);if(directOwnsFlight(u)&&this.jobs.has(id)){this.jobs.get(id).controller.abort();this.jobs.delete(id);u.tacticalGuidance.direct.replan=true;}}}
  report(u,status,zh,en){const receipt={commandId:u.tacticalGuidance?.direct?.id??`guidance-${u.id}`,action:'guidance',unitIds:[u.id],status,committed:status!=='unable',summary:zh,summaryEn:en};this.onReceipt(receipt);this.onChange();return receipt;}
  setPolicy({unitIds,category,value}){
    const table=category==='offense'?OFFENSE_POLICIES:category==='defense'?DEFENSE_POLICIES:null;if(!table||!Object.hasOwn(table,value))throw Error('方针选择无效');
    if(table[value].team&&unitIds.length===1){const own=commandUnits(this.getWorld()).filter(u=>u.alive),unit=own.find(u=>u.id===unitIds[0]),partner=own.find(u=>u.id===unit?.flightRole?.partnerId)??(own.length===2?own.find(u=>u.id!==unitIds[0]):null);if(partner)unitIds=[unitIds[0],partner.id];}
    if(table[value].team&&unitIds.length!==2)throw Error('该双机方案需要两架可指挥飞机');
    const units=this.units(unitIds),world=this.getWorld(),missions=new Set(units.filter(u=>u.pilotMission?.orderVersion===playerOrderVersion(world,u.id)).map(u=>u.id));this.beforeCommand(unitIds,'policy');notePlayerOrder(world,unitIds);world.revision++;
    for(const u of units){const g=u.tacticalGuidance??=guidanceContext();g[category]=value;g.revision++;this.jobs.get(u.id)?.controller.abort();this.jobs.delete(u.id);this.guards.set(u.id,capturePlayerOrderScope(world));
      const normalized=guidanceContext(g);g.offense=normalized.offense;g.defense=normalized.defense;g.offenseIntent=normalized.offenseIntent;g.defenseIntent=normalized.defenseIntent;
      if(table[value].team)g.group={id:`pair-${world.revision}-${units[0].id}`,unitIds:unitIds.slice(),role:category==='offense'&&value==='bracket'?(u===units[0]?'left':'right'):(u===units[0]?'engaged':'supporting')};
      else if(!OFFENSE_POLICIES[g.offense]?.team&&!DEFENSE_POLICIES[g.defense]?.team)g.group=null;
      if(missions.has(u.id))u.pilotMission.orderVersion=playerOrderVersion(world,u.id);
      if(directOwnsFlight(u)){g.direct.phase=g.direct.phase==='recovering'?'recovering':'planning';g.direct.replan=true;}
      if(u.attackTask?.active){u.attackTask.lastDecisionAt=null;u.attackTask.decisionCount=0;}
      this.report(u,'completed',`方针收到，${table[value].zh}。`,`ROGER, ${table[value].en.toUpperCase()}.`);
    }
    this.onScopeChanged(unitIds);return {status:'completed',summary:table[value].zh,summaryEn:table[value].en};
  }
  async maneuver({unitIds,maneuver,commandId=`direct-${Date.now()}`}){
    if(!Object.hasOwn(DIRECT_MANEUVERS,maneuver))throw Error('直接机动无效');
    if(typeof commandId!=='string'||!commandId||commandId.length>60||!/^[\w-]+$/.test(commandId))throw Error('直接机动编号无效');
    const units=this.units(unitIds),world=this.getWorld();
    if(maneuver==='rejoin'&&units.some(u=>!u.formation&&!u.tacticalGuidance?.resume?.formation))throw Error('无法执行编队复位，当前没有可恢复的编队任务');
    if(maneuver==='commit'&&units.some(u=>!attackContacts(u,world.time).some(c=>c.classification!=='friendly')))throw Error('无法接敌，当前缺少可用于拦截的有效航迹');
    // Validate the complete batch before changing any unit or cancelling its work.
    for(const u of units){if(maneuver.startsWith('crank')&&!attackContacts(u,world.time).some(c=>c.classification!=='friendly'))throw Error('无法执行偏置支援，当前缺少有效目标航迹');if(maneuver.startsWith('notch')||maneuver==='extend')validateDefenseTask(world,u,{mode:'execute',maneuver:maneuver==='extend'?'extend':'notch',side:maneuver.endsWith('left')?'left':'right',headingDeg:null});if(maneuver==='resume'&&!u.tacticalGuidance?.resume)throw Error('没有待复位的任务');}
    const missions=new Set(units.filter(u=>u.pilotMission?.orderVersion===playerOrderVersion(world,u.id)).map(u=>u.id));
    this.beforeCommand(unitIds,'maneuver');notePlayerOrder(world,unitIds);
    for(const u of units){this.jobs.get(u.id)?.controller.abort();this.jobs.delete(u.id);const g=u.tacticalGuidance??=guidanceContext();
      if(missions.has(u.id))u.pilotMission.orderVersion=playerOrderVersion(world,u.id);
      if(!g.resume)g.resume={points:captureLoopRoute(u),speed:u.targetSpeed,altitude:u.targetAltitude,heading:u.headingRoute?.headingDeg??null,orbit:clone(u.orbit),formation:u.formation?clone(u.formation):null};
      g.direct={id:`${commandId}-${u.id}`,maneuver,phase:['resume','terminate'].includes(maneuver)?'recovering':'planning'};g.revision++;this.guards.set(u.id,capturePlayerOrderScope(world));
    }
    if(maneuver==='terminate'){
      const plan={status:'accepted',summary:'中止本地交战，停止后续发射',tasks:units.map(u=>({unitId:u.id,action:'weapon',weaponOrder:{operation:'hold',modelId:null,targetId:null,quantity:null}}))};
      commitPilotPlan(preparePilotPlan(world,plan,world.revision));for(const u of units)this.guards.set(u.id,capturePlayerOrderScope(world));
    }
    this.onScopeChanged(unitIds);this.onChange();
    const results=await Promise.all(units.map(u=>this.plan(u,['resume','terminate'].includes(maneuver)?'recover':'execute')));return results[0];
  }
  async plan(u,stage){
    const world=this.getWorld(),g=u.tacticalGuidance,d=g.direct,controller=new AbortController(),scope=capturePlayerOrderScope(world),job={controller,world,d,scope,model:this.getPilotModel()};this.jobs.set(u.id,job);d.replan=false;d.pending=true;
    const current=()=>this.getWorld()===world&&u.tacticalGuidance?.direct===d&&!controller.signal.aborted&&this.jobs.get(u.id)===job&&this.getPilotModel()===job.model&&isPlayerOrderScopeCurrent(world,scope,[u.id])&&u.alive&&controlAuthority(world,u).owner==='commander'&&controlAuthority(world,u).phase==='owned';
    try{
      const proposal=await this.planManeuver({requestId:`${d.id}-${stage}`,unitId:u.id,maneuver:d.maneuver,stage,context:commandContext(world,u.id),resumePoint:stage==='recover'?g.resume?.points?.[0]??null:null},controller.signal);if(!current())return {status:'superseded'};
      for(const k of ['purposeZh','purposeEn','reasonZh','reasonEn','recoveryZh','recoveryEn']){if(typeof proposal[k]!=='string'||proposal[k].length>300)throw Error('机动目的与复位说明无效');d[k]=proposal[k];}
      if(proposal.status!=='execute')throw Error(proposal.reasonZh||'无法执行本次机动');
      let tasks,recoveryCount=proposal.waypoints?.length;
      if(stage==='execute'&&(d.maneuver.startsWith('notch')||d.maneuver==='extend'))tasks=[{unitId:u.id,action:'defense',defenseOrder:{mode:'execute',maneuver:d.maneuver==='extend'?'extend':'notch',side:d.maneuver.endsWith('left')?'left':d.maneuver.endsWith('right')?'right':'auto',headingDeg:null}}];
      else{
        if(!Array.isArray(proposal.waypoints)||!proposal.waypoints.length||proposal.waypoints.length>8)throw Error('机动缺少有效航路');
        if(stage==='execute'&&/(left|right)$/.test(d.maneuver)){
          const heading=Math.atan2(u.velocity[0],u.velocity[1]),p=proposal.waypoints.at(-1),bearing=Math.atan2(p[0]-u.position[0],p[1]-u.position[1]),delta=Math.atan2(Math.sin(bearing-heading),Math.cos(bearing-heading));
          if(Math.abs(delta)<.01||d.maneuver.endsWith('left')&&delta>=0||d.maneuver.endsWith('right')&&delta<=0)throw Error('飞行员方案未满足指定转向，请重新指示');
        }
        if(stage==='execute'){
          const altitude=proposal.waypoints.at(-1)[2];
          if(d.maneuver==='climb'&&altitude<=u.position[2]||d.maneuver==='descend'&&altitude>=u.position[2]||d.maneuver==='accelerate'&&proposal.speedMps<=u.speed||d.maneuver==='decelerate'&&proposal.speedMps>=u.speed)throw Error('飞行员方案未满足指定高度或速度变化');
        }
        if(stage==='recover'&&g.resume?.points?.length&&Math.hypot(...proposal.waypoints.at(-1).map((v,i)=>v-g.resume.points[0][i]))>.5)throw Error('复位方案未接回原任务目标');
        const points=proposal.waypoints;
        tasks=points.map((p,i)=>task(u.id,'fly_to',{eastM:p[0],northM:p[1],altitudeM:p[2],speedMps:proposal.speedMps,append:i>0}));
      }
      const plan={status:'accepted',summary:'执行方针内直接机动',tasks},draft=await this.preparePlan(world,plan,world.revision,{scoped:true,unitIds:[u.id]},controller.signal);if(!current())return {status:'superseded'};
      draft.expectedRevision=world.revision;const previous=world.autonomousCommand;world.autonomousCommand=true;
      try{commitPilotPlan(draft);}finally{world.autonomousCommand=previous;}
      d.phase=stage==='recover'?'recovering':'executing';d.initialCompleted=u.completedWaypoints??0;d.pointCount=stage==='recover'?recoveryCount:u.waypoints.length;d.defensive=stage==='execute'&&tasks[0].action==='defense';d.replan=false;d.pending=false;
      this.guards.set(u.id,capturePlayerOrderScope(world));this.onScopeChanged([u.id]);
      return this.report(u,'executing',`${proposal.reasonZh} ${stage==='recover'?'正在复位。':proposal.purposeZh} ${proposal.recoveryZh}`,`${proposal.reasonEn} ${stage==='recover'?'REJOINING MISSION.':proposal.purposeEn} ${proposal.recoveryEn}`);
    }catch(error){if(!current())return {status:'superseded'};d.phase='unable';d.pending=false;return this.report(u,'unable',`无法执行${DIRECT_MANEUVERS[d.maneuver].zh}，${error.message}。`,'UNABLE TO COMPLY. REQUEST REVISED INSTRUCTIONS.');}
    finally{if(this.jobs.get(u.id)===job)this.jobs.delete(u.id);}
  }
  tick(){
    const world=this.getWorld();
    const groups=new Set();
    for(const u of commandUnits(world)){
      const g=u.tacticalGuidance,group=g?.group;if(!group||groups.has(group.id)||!['split','rotate'].includes(g.offense)&&g.defense!=='mutual')continue;groups.add(group.id);
      const pair=group.unitIds.map(id=>world.units.find(v=>v.id===id&&v.alive));if(pair.some(v=>!v||v.tacticalGuidance?.group?.id!==group.id)||pair.some(directOwnsFlight))continue;
      const engaged=pair.find(v=>v.tacticalGuidance?.group?.role==='engaged'),next=pair.find(v=>v!==engaged&&v.attackTask?.active&&!v.rwrDefense?.active);
      if(!next||!engaged)continue;
      const report=deliveredPartnerState(next,engaged.id,world.time),ack=deliveredPartnerState(engaged,next.id,world.time);
      if(report?.tacticalGroupId!==group.id||ack?.tacticalGroupId!==group.id||!(report.defenseActive===true||report.attackActive===false))continue;
      for(const member of pair){const mg=member.tacticalGuidance;if(mg?.group?.id!==group.id)continue;mg.group.role=member===next?'engaged':'supporting';mg.revision++;}
      this.report(next,'completed',`已接替交战角色，${engaged?.callsign??pair.find(v=>v!==next).callsign}转为支援，保持原攻击授权。`,'TAKING ENGAGED ROLE. WINGMAN SUPPORTING. EXISTING WEAPONS AUTHORIZATION RETAINED.');
    }
    for(const u of commandUnits(world)){
      const g=u.tacticalGuidance,d=g?.direct;if(!d||!directOwnsFlight(u))continue;
      const guard=this.guards.get(u.id);
      if(guard&&!isPlayerOrderScopeCurrent(world,guard,[u.id])||!u.alive||controlAuthority(world,u).owner!=='commander'||controlAuthority(world,u).phase!=='owned'){
        this.jobs.get(u.id)?.controller.abort();this.jobs.delete(u.id);d.phase='cancelled';g.resume=null;this.onChange();continue;
      }
      if(!guard){this.guards.set(u.id,capturePlayerOrderScope(world));if(d.phase==='planning'){d.phase='unable';d.pending=false;continue;}if(d.pending){d.pending=false;d.replan=true;}}
      if(this.jobs.has(u.id))continue;
      if(d.replan){void this.plan(u,d.phase==='recovering'?'recover':'execute');continue;}
      if(d.phase==='planning')continue;
      const done=d.defensive?!u.rwrDefense?.active:!u.waypoints.length||(u.completedWaypoints??0)>=(d.initialCompleted??0)+(d.pointCount??1);
      if(!done)continue;
      if(d.phase==='executing'){d.phase='recovering';void this.plan(u,'recover');}
      else{
        if(this.prepareRoute){void this.completeRecovery(world,u,g,d);continue;}
        // Do not restore an old position or replay an attack. Reconnect continuing tasks.
        if(g.resume?.points?.length>1){
          try{const previous=world.autonomousCommand;world.autonomousCommand=true;try{world.replaceRoute(u.id,g.resume.points.slice(1),{record:false});}finally{world.autonomousCommand=previous;}}
          catch(error){d.phase='unable';this.report(u,'unable',`无法恢复后续航路，${error.message}`,'UNABLE TO RESUME REMAINING ROUTE. REQUEST INSTRUCTIONS.');continue;}
        }else if(!g.resume?.points?.length){let restore;
          const f=g.resume?.formation,leader=f&&world.units.find(v=>v.id===f.leaderId&&v.alive);
          if(leader)restore={...task(u.id,f.intent),targetId:leader.id,formation:f.shape,side:f.side,rangeM:f.rangeM};
          else if(g.resume?.heading!=null)restore=task(u.id,'fly_heading',{headingDeg:g.resume.heading,altitudeM:g.resume.altitude,speedMps:g.resume.speed});
          else restore=task(u.id,'orbit',{eastM:g.resume?.orbit?.[0]??u.position[0],northM:g.resume?.orbit?.[1]??u.position[1],altitudeM:g.resume?.altitude??u.position[2],speedMps:g.resume?.speed??u.speed});
          try{const previous=world.autonomousCommand;world.autonomousCommand=true;try{commitPilotPlan(preparePilotPlan(world,{status:'accepted',summary:'恢复原任务',tasks:[restore]},world.revision));}finally{world.autonomousCommand=previous;}}
          catch(error){d.phase='unable';this.report(u,'unable',`无法接回原任务，${error.message}`,'UNABLE TO REJOIN ORIGINAL TASK. REQUEST INSTRUCTIONS.');continue;}
        }
        if(g.resume?.points?.loop)restoreLoopRoute(u,g.resume.points);
        d.phase='completed';g.resume=null;this.onScopeChanged([u.id],true);this.report(u,'completed','机动完成，已接回方针内原任务。','MANOEUVRE COMPLETE. RESUMING ASSIGNED MISSION.');
      }
    }
  }
  async completeRecovery(world,u,g,d){
    const controller=new AbortController(),scope=capturePlayerOrderScope(world),resume=g.resume,job={controller,world,d,scope};this.jobs.set(u.id,job);d.pending=true;
    const current=()=>!controller.signal.aborted&&this.getWorld()===world&&u.alive&&u.tacticalGuidance===g&&g.direct===d&&g.resume===resume&&isPlayerOrderScopeCurrent(world,scope,[u.id]);
    try{
      if(resume?.points?.length>1){const points=resume.points.slice(1),speed=resume.speed??u.targetSpeed,prepared=await this.prepareRoute(world,u,points,speed,controller.signal);if(!current())return;
        if(!prepared?.valid)throw Error(prepared?.reason??'后台恢复航路不可用');
        const previous=world.autonomousCommand,oldSpeed=u.targetSpeed;world.autonomousCommand=true;
        try{world.resolvePlan({...u,targetSpeed:speed},points,prepared,{resetPower:true});u.targetSpeed=speed;world.replaceRoute(u.id,points,{record:false,prepared});}catch(error){u.targetSpeed=oldSpeed;throw error;}finally{world.autonomousCommand=previous;}
      }else{let restore;const f=resume?.formation,leader=f&&world.units.find(v=>v.id===f.leaderId&&v.alive);
        if(leader)restore={...task(u.id,f.intent),targetId:leader.id,formation:f.shape,side:f.side,rangeM:f.rangeM};
        else if(resume?.heading!=null)restore=task(u.id,'fly_heading',{headingDeg:resume.heading,altitudeM:resume.altitude,speedMps:resume.speed});
        else restore=task(u.id,'orbit',{eastM:resume?.orbit?.[0]??u.position[0],northM:resume?.orbit?.[1]??u.position[1],altitudeM:resume?.altitude??u.position[2],speedMps:resume?.speed??u.speed});
        const draft=await this.preparePlan(world,{status:'accepted',summary:'恢复原任务',tasks:[restore]},world.revision,{scoped:true,unitIds:[u.id]},controller.signal);if(!current())return;
        draft.expectedRevision=world.revision;const previous=world.autonomousCommand;world.autonomousCommand=true;try{commitPilotPlan(draft);}finally{world.autonomousCommand=previous;}
      }
      if(!current())return;if(resume?.points?.loop)restoreLoopRoute(u,resume.points);d.phase='completed';g.resume=null;this.onScopeChanged([u.id],true);this.report(u,'completed','机动完成，已接回方针内原任务。','MANOEUVRE COMPLETE. RESUMING ASSIGNED MISSION.');
    }catch(error){if(current()){d.phase='unable';this.report(u,'unable',`无法接回原任务，${error.message}`,'UNABLE TO REJOIN ORIGINAL TASK. REQUEST INSTRUCTIONS.');}}
    finally{if(this.jobs.get(u.id)===job){this.jobs.delete(u.id);d.pending=false;}}
  }
  reset(){for(const job of this.jobs.values())job.controller.abort();this.jobs.clear();this.guards.clear();}
}
