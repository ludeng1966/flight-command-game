// Read-only facts for the task card. This observer never commands the aircraft.
// Session-local history is deliberately separate from command/model context.
const sessions=new WeakMap();
export const TASK_STABLE_SECONDS=8;
export const ATTACK_PHASES={searching:'搜索与识别',preparing:'导引头准备',engaging:'截获目标',supporting:'导弹在空 · 维持支持',completed:'命中确认',aborted:'任务中止',exhausted:'额度用尽',cancelled:'任务已停止'};
export const confirmedAttackHit=task=>!!task?.engagedTargetId&&Object.values(task.flightResults??{}).some(f=>f.phase==='hit'&&f.hitTargetId===task.engagedTargetId);
const angle=(a,b)=>Math.abs(((a-b+540)%360)-180);
const samePoint=(a,b)=>a&&b&&a.length>=3&&b.length>=3&&Math.hypot(...a.slice(0,3).map((v,i)=>v-b[i]))<1;
const timeOf=world=>Number.isFinite(world.time)?world.time:0;
function session(world){let s=sessions.get(world);if(!s){s={units:new Map(),events:[],keys:new Set(),lastTime:null};sessions.set(world,s);}return s;}
function remember(s,event){
  if(s.keys.has(event.id))return;s.keys.add(event.id);s.events.push(event);
  while(s.events.length>192)s.events.shift();
  while(s.keys.size>2048)s.keys.delete(s.keys.values().next().value);
}
function facts(world,u){
  const rows=[],add=(source,id,e,evidence,taskId=null)=>{if(Number.isFinite(e.time)&&typeof e.text==='string')rows.push({id:`${u.id}:${source}:${id}`,unitId:u.id,source,taskId,time:e.time,summary:e.text,evidence});};
  for(const r of world.commandLog??[]){
    const orders=r.interpretation?.orders??[],own=orders.filter(o=>o.unitIds?.includes(u.id));
    if(!own.length&&(orders.length||world.units.length!==1))continue;
    add('指令',r.requestId??`${r.time}:${r.interpretation?.summary}`,{time:r.time,text:r.interpretation?.summary??'指挥任务'},'命令记录，不代表已完成',r.requestId??null);
  }
  for(const e of world.airportOps?.airport.events??[])if(e.unitId===u.id)add('机场',e.sequence??`${e.time}:${e.type}:${e.text}`,e,'机场程序事件');
  for(const e of u.radar?.events??[])if(!e.type?.startsWith('attack_'))add('雷达',e.sequence,e,e.type==='pilot_decision'?'飞行员判断，效果待观测':'本机雷达状态记录');
  for(const e of u.attackTask?.events??[])add('攻击',`${u.attackTask.id}:${e.sequence}`,e,e.type==='hit'?'导弹仿真碰撞确认':e.type==='launch'?'实际发射记录，命中另行确认':['miss','exhausted'].includes(e.type)?'已发射导弹状态记录':'任务操作记录，效果以实测为准',u.attackTask.id);
  // Do not reveal an adversary's launch merely because the simulation knows it.
  // Own launches and an actual impact on this aircraft are observable outcomes.
  for(const e of world.weaponEvents??[])if(e.ownerId===u.id||e.type==='hit'&&e.targetId===u.id)add('武器实测',`${e.id}:${e.type}:${e.time}`,e,e.type==='hit'?'导弹仿真实际碰撞':'本机实际发射记录');
  for(const e of u.rwr?.events??[])add('告警',e.sequence,e,['assessment','judgment'].includes(e.type)?'基于告警的判断，未确认导弹结果':'RWR与防御状态记录');
  const e=u.pilotExecution;
  if(e?.lastAdjustment&&Number.isFinite(e.lastAppliedAt))add('执行',`${e.id}:adjust:${e.lastAppliedAt}`,{time:e.lastAppliedAt,text:'执行方案已修订，保留原任务目标'},'已安装的推力与航路方案',e.id);
  return rows;
}
function transition(s,u,state,status,time,summary,evidence){
  if(state.status===status)return;state.status=status;state.changedAt=time;
  remember(s,{id:`${u.id}:执行:${state.id}:${status}:${time}`,unitId:u.id,source:'执行',taskId:state.id,time,summary,evidence});
}
export function monitorTaskFeedback(world){
  const s=session(world),now=timeOf(world);
  if(s.lastTime!==null&&now<s.lastTime){s.units.clear();s.events=[];s.keys.clear();}
  if(s.lastTime!==null&&now>=s.lastTime&&now-s.lastTime<.25)return;s.lastTime=now;
  for(const u of world.units){
    for(const event of facts(world,u))remember(s,event);
    const e=u.pilotExecution;if(!e?.id)continue;
    let state=s.units.get(u.id);
    if(state?.id!==e.id){
      if(state&&!['achieved','aborted','superseded'].includes(state.status))transition(s,u,state,'superseded',now,'原飞行任务已被新任务替代','执行任务编号发生变化');
      const goals=(u.waypoints??[]).filter(w=>!w.pilotTemporary).map(w=>w.slice(0,3));
      state={id:e.id,status:null,startedAt:now,stableSince:null,goals,initialCompleted:u.completedWaypoints??0,routePassed:false,
        headingDeg:u.headingRoute?.headingDeg??(Number.isFinite(u.headingTarget)?u.headingTarget*180/Math.PI:null),
        continuous:!!u.headingRoute?.continuous||!!u.routeLoop,altitudeM:e.targetAltitudeM,speedMps:e.targetSpeedMps};
      s.units.set(u.id,state);transition(s,u,state,'executing',now,'飞行任务已装订，观察实际执行','执行任务编号与原始目标');
    }
    if(u.alive===false){transition(s,u,state,'aborted',now,'本机失效，飞行任务中止','飞机存活状态');continue;}
    if(state.status==='achieved')continue;
    if(u.navigationBlocked){state.stableSince=null;transition(s,u,state,'blocked',now,'航路受阻：'+u.navigationBlocked,'实时航路校验结果');continue;}
    if(state.status==='blocked')transition(s,u,state,'executing',now,'航路恢复，继续原任务','实时航路阻断已解除');
    const originals=(u.waypoints??[]).filter(w=>!w.pilotTemporary);
    if(state.goals.length&&!state.continuous&&originals.length===0&&(u.completedWaypoints??0)>state.initialCompleted&&samePoint(u.previousWaypoint,state.goals.at(-1)))state.routePassed=true;
    const heading=Array.isArray(u.velocity)?(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360:null;
    const hasParameters=Number.isFinite(state.altitudeM)&&Number.isFinite(state.speedMps);
    const stable=hasParameters&&!u.surface?.grounded&&!u.rwrDefense?.active&&!u.pilotPowerPlan?.active&&(!u.flightState||u.flightState==='normal')&&
      Math.abs(u.position[2]-state.altitudeM)<=50&&Math.abs(u.speed-state.speedMps)<=5/3.6&&
      (!Number.isFinite(state.headingDeg)||state.routePassed||heading!==null&&angle(heading,state.headingDeg)<=3)&&
      (!state.goals.length||state.continuous||state.routePassed);
    state.stableSince=stable?(state.stableSince??now):null;
    if(stable&&now-state.stableSince>=TASK_STABLE_SECONDS)transition(s,u,state,'achieved',now,
      state.routePassed?'原定航路已实际通过，飞行参数稳定达标':'原定飞行参数稳定达标，继续保持任务',
      `连续${TASK_STABLE_SECONDS}秒：高度误差≤50米、速度误差≤5公里每小时${Number.isFinite(state.headingDeg)&&!state.routePassed?'、航向误差≤3度':''}${state.routePassed?'；最后原定航点已有实际通过记录':''}`);
  }
}
export function taskTimeline(world,u,{limit=24}={}){
  const unique=new Map((sessions.get(world)?.events??[]).filter(e=>e.unitId===u.id).map(e=>[e.id,e]));
  for(const e of facts(world,u))unique.set(e.id,e);
  return [...unique.values()].sort((a,b)=>b.time-a.time||a.id.localeCompare(b.id)).slice(0,limit);
}
export function taskFeedback(world,u){
  const now=timeOf(world),d=u.rwrDefense,t=u.attackTask,e=u.pilotExecution,state=sessions.get(world)?.units.get(u.id),control=u.controlAuthority;
  const owner=control?.owner??(u.surface?.grounded?'tower':'commander');
  const result={kind:'flight',phase:'执行中',objective:null,reason:null,result:'尚未确认任务达成',waiting:'等待实测达到原定目标',
    controller:(owner==='tower'?'塔台':'空中指挥')+(control?.phase==='transferring'?' · 正在交接':''),executionId:e?.id??null};
  if(u.alive===false)return {...result,phase:'任务中止',reason:'本机失效',result:'飞机损坏',waiting:'等待重新安排任务'};
  if(d?.active)return {...result,kind:'defense',objective:d.active.maneuver==='extend'?'背向脱离，保留原任务':'横切规避，保留原任务',phase:'防御机动中',
    controller:result.controller+' · '+(d.active.manual?'玩家指定规避':'飞行员自卫'),reason:d.active.manual?'已装订玩家规避命令':d.episode?.level==='launch'?'收到疑似发射告警':'收到持续跟踪告警',
    result:'规避已开始，未确认威胁解除',waiting:'等待告警变化并复核原任务恢复条件'};
  if(d?.episode&&!d.episode.playerOverride&&now-d.episode.lastSeen<=2.5)return {...result,kind:'defense',phase:'告警处置',reason:d.episode.level==='launch'?'疑似雷达导弹信号':'持续雷达跟踪信号',
    result:'告警不等于命中或导弹已被击败',waiting:d.mode==='report_only'?'仅报告，等待玩家指令':`等待玩家指令；自主规避剩余${Math.max(0,Math.ceil(d.episode.autoAt-now))}秒`};
  const lastAttackTime=Math.max(t?.issuedAt??0,t?.events?.at(-1)?.time??0);
  if(t&&(t.active||!Number.isFinite(e?.startedAt)||e.startedAt<lastAttackTime||e.startedAt===lastAttackTime&&t.status!=='cancelled')){
    const hit=confirmedAttackHit(t),remaining=Math.max(0,(t.shotLimit??0)-(t.firedMissileIds?.length??0));
    const target=t.targetRef??t.engagedTargetId??t.targetId??'待识别目标';
    const waiting=!t.active?'等待后续任务':u.surface?.grounded?'等待离地':t.pending?'等待飞行员判断，现有飞行继续':t.status==='supporting'?'维持所需雷达支持，等待导弹结果':!u.radar?.contacts?.length?'等待本机获得有效目标观测':!u.weapons?.ready?u.weapons?.reason??'等待武器发射条件':'等待飞行员复核发射条件';
    return {...result,kind:'attack',objective:(t.active?'攻击任务：':'最近攻击：')+target,phase:t.pending?'飞行员判断中':t.status==='completed'&&!hit?'结果待核实':ATTACK_PHASES[t.status]??'攻击任务',reason:t.lastError??(t.lastDecision?`最近判断：${t.lastDecision.message}`:'已收到攻击授权'),
      result:hit?'指定目标命中已由导弹仿真确认':t.status==='exhausted'?'发射额度用尽，未确认摧毁':t.firedMissileIds?.length?`已发射${t.firedMissileIds.length}枚，未确认命中`:'尚无本任务发射记录',waiting,remainingShots:remaining};
  }
  if(u.surface?.grounded)return {...result,kind:'airport',phase:'地面运行',reason:u.surface.message??null,result:'按当前机场程序执行',waiting:'等待当前地面阶段完成与有效许可'};
  if(state&&e&&state.id===e.id){
    result.phase={executing:'执行中',achieved:'参数稳定达标',blocked:'执行受阻',aborted:'任务中止',superseded:'已被新任务替代'}[state.status]??'执行中';
    if(state.status==='achieved'){result.result=state.routePassed?'原定航路已实际通过，参数稳定达标':'原定飞行参数已连续稳定达标';result.waiting='继续保持已装订任务';}
    else if(state.stableSince!==null)result.waiting=`目标参数已进入范围，稳定观察${Math.min(TASK_STABLE_SECONDS,Math.floor(now-state.stableSince))}/${TASK_STABLE_SECONDS}秒`;
  }
  result.reason=u.navigationBlocked??({energy_shortfall:'当前能量不足，正在调整执行方案',progress_stalled:'接近原定航点的进度停滞',route_blocked:'原航路受阻'}[e?.issue])??u.surface?.message??null;
  return result;
}
