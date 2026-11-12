export const OFFENSE_POLICIES={
  auto:{zh:'自主接战',en:'Autonomous engagement',guide:'在授权范围内自行争取机会，依据观测调整接近、支援和重新定位，保留目标、空域与弹量限制。'},
  support_exit:{zh:'支援后脱离',en:'Support then disengage',guide:'完成一次获准交战后履行实际武器支援义务，再退出重整；没有发射条件可以不发射，发射不是命中。'},
  press:{zh:'持续接敌',en:'Maintain engagement',guide:'允许继续争取交战，在原目标、弹量与任务边界内持续接敌，遇重大风险或失去目标报告改案，不无限追逐。'},
  split:{zh:'双机分工交战',en:'Engaged / supporting pair',team:true,guide:'一机交战、一机支援，明确交战与支援角色；支援承担观察、警戒及掩护，允许角色交接，不自动取得额外开火授权。'},
  bracket:{zh:'双机侧向协同',en:'Lateral coordination',team:true,guide:'对指定目标形成协同压力，保持目标关联、任务分配和相互支援；不是两条独立分叉航线，失去关联先重新建立态势。'},
  rotate:{zh:'轮换接战',en:'Alternating engagement',team:true,guide:'保持任务连续性，按双方实况交换交战与支援角色，处理一机受威胁或无法继续；角色交接不增加共享授权。'},
  banzai:{zh:'BANZAI 接敌计划',en:'BANZAI',guide:'按APP-7的launch-and-decide含义执行，完成获准交战后依据实际态势决策；不等同无条件冲锋或必须进入缠斗，原任务边界与风险约束仍有效。'},
  skate:{zh:'SKATE 脱离计划',en:'SKATE',guide:'按APP-7的launch-and-leave含义组织交战和退出，保留任务中DOR/MOR退出界限；结合本游戏武器支持与任务条件拟定、报告游戏内方案，不擅自放弃必要支援，不套现实固定距离。'},
  short_skate:{zh:'SHORT SKATE',en:'SHORT SKATE',guide:'按APP-7保留launch-and-leave与MAR/DR退出约束的区别，不能仅理解为任意缩短时间；依据游戏实况和任务拟定退出条件并报告假设，不冒充现实武器参数。'},
  fighter_sweep:{zh:'战斗机扫荡',en:'Fighter sweep',guide:'在指定任务空域内搜索并争取对空交战，保持责任空域、识别条件和已有开火授权；没有明确空域时沿原任务范围规划，不擅自扩大搜索边界。'}
};
export const DEFENSE_POLICIES={
  survival:{zh:'自保优先',en:'Survival first',guide:'优先降低本机风险，必要时中断支援并报告任务影响。'},
  support:{zh:'保持支援',en:'Preserve support',guide:'在可接受风险内保持己方导弹及友机支援；无法继续必须报告，不能忽略紧急告警。'},
  withdraw:{zh:'脱离重整',en:'Disengage and regroup',guide:'结束当前接敌，恢复态势、队形与任务状态，再评估后续行动；不自动重新授权攻击。'},
  mutual:{zh:'双机相互掩护',en:'Mutual support',team:true,guide:'一机防御时另一机执行可用观察与掩护职责，允许角色交换；两机同时受威胁时报告支援能力受限，不保证始终有支援机。'},
  protect:{zh:'保护对象优先',en:'Protected asset first',guide:'保住护航对象或责任空域，避免无边界追击导致保护任务失守；仍需本机安全规避。'},
  area_defense:{zh:'区域防空',en:'Area defence',guide:'围绕已指派责任空域组织观察与拦截，评价区域是否被有效保护，而非只统计击落；不追出原任务范围。'},
  point_defense:{zh:'要点防空',en:'Point defence',guide:'保护已指定地点或设施，保持足以履行保护职责的位置与任务连续性；没有指定保护点时说明缺少对象，不把任意敌机当作任务终点。'},
  hvaa_protection:{zh:'高价值飞机保护',en:'HVAA protection',guide:'保护已指定高价值飞机，围绕其任务进程保持有效支援；不擅自把普通友机认定为高价值对象，不因追击放弃保护。'},
  cap:{zh:'战斗空中巡逻',en:'Combat air patrol',guide:'沿任务指定巡逻空域或航路保持警戒，识别、接敌后评估并恢复巡逻，不能退化为永久追逐单个目标。'},
  barcap:{zh:'屏障空中巡逻',en:'Barrier CAP',guide:'在既定保护对象与可能来袭方向之间承担屏障巡逻，保留任务指定的屏障位置、责任区及识别授权；与一般CAP分开，不凭空猜测来袭方向。'}
};
export const DIRECT_MANEUVERS={
  turn_left:{zh:'左转机动',en:'Manoeuvre left',guide:'向左调整航路，保持原任务和方针，不把普通转向当作BREAK。'},turn_right:{zh:'右转机动',en:'Manoeuvre right',guide:'向右调整航路，保持原任务和方针，不把普通转向当作BREAK。'},
  crank_left:{zh:'左偏置支援',en:'Crank left',guide:'按CRANK的F/A-pole机动含义向左偏置，兼顾已授权武器的真实支持需求；不是NOTCH。'},crank_right:{zh:'右偏置支援',en:'Crank right',guide:'按CRANK的F/A-pole机动含义向右偏置，兼顾已授权武器的真实支持需求；不是NOTCH。'},
  notch_left:{zh:'左横切规避',en:'Notch left',guide:'按已观测辐射源向左执行横切尝试，不能保证对方是PD、已丢锁或导弹已被击败。'},notch_right:{zh:'右横切规避',en:'Notch right',guide:'按已观测辐射源向右执行横切尝试，不能保证对方是PD、已丢锁或导弹已被击败。'},
  extend:{zh:'背向脱离',en:'Extend away',guide:'按当前威胁和方针拉开，恢复能量或间隔，保留任务后续评估；与永久退出任务区别处理。'},resume:{zh:'复位原任务',en:'Resume mission',guide:'本游戏任务恢复操作：依据当前位置规划接回原任务，不飞回旧机位、不重放旧发射。'},
  climb:{zh:'爬升机动',en:'Climb'},descend:{zh:'下降机动',en:'Descend'},
  accelerate:{zh:'增速机动',en:'Accelerate'},decelerate:{zh:'减速机动',en:'Decelerate'},
  break_left:{zh:'BREAK LEFT',en:'BREAK LEFT',guide:'向左急转，要求在本机当前安全包线内争取最大可用转弯性能，不等同常规VECTOR转向；若本机条件不允许必须报告。'},break_right:{zh:'BREAK RIGHT',en:'BREAK RIGHT',guide:'向右急转，要求在本机当前安全包线内争取最大可用转弯性能，不等同常规VECTOR转向；若本机条件不允许必须报告。'},
  come_off_left:{zh:'COME OFF LEFT',en:'COME OFF LEFT',guide:'向左脱开当前局部交战，着眼恢复相互支援或解除航路冲突；目视与目标状态不足时明确报告，不自动当作全任务终止。'},come_off_right:{zh:'COME OFF RIGHT',en:'COME OFF RIGHT',guide:'向右脱开当前局部交战，着眼恢复相互支援或解除航路冲突；目视与目标状态不足时明确报告，不自动当作全任务终止。'},
  rejoin:{zh:'重建双机集合',en:'Rejoin formation'},level_off:{zh:'改平保持',en:'Level off'},
  commit:{zh:'COMMIT 接敌',en:'COMMIT',guide:'对本机当前有效观测的指定航迹建立拦截，不等同于新增武器发射许可。'},
  terminate:{zh:'TERMINATE 中止交战',en:'TERMINATE',guide:'停止本地当前交战，保留整体任务与训练进程，停止后续发射，已在空武器按真实状态继续；重新规划恢复段而非重新激活旧攻击授权。'}
};
export function guidanceContext(value){
  value??={offense:'auto',defense:'survival',revision:0,direct:null};
  const offense=['balanced','cautious'].includes(value.offense)?'auto':value.offense,defense=value.defense==='adaptive'?'survival':value.defense;
  if(!Object.hasOwn(OFFENSE_POLICIES,offense)||!Object.hasOwn(DEFENSE_POLICIES,defense)||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('战术方针无效');
  const d=value.direct;let direct=null;
  if(d){
    if(typeof d.id!=='string'||d.id.length>100||!Object.hasOwn(DIRECT_MANEUVERS,d.maneuver)||!['planning','executing','recovering','completed','unable','cancelled'].includes(d.phase))throw Error('直接机动状态无效');
    direct={id:d.id,maneuver:d.maneuver,phase:d.phase};
    for(const k of ['purposeZh','purposeEn','reasonZh','reasonEn','recoveryZh','recoveryEn'])if(d[k]!==undefined){if(typeof d[k]!=='string'||d[k].length>300)throw Error('机动说明无效');direct[k]=d[k];}
  }
  let group=null;
  if(value.group){const g=value.group;if(typeof g.id!=='string'||g.id.length>100||!Array.isArray(g.unitIds)||g.unitIds.length!==2||g.unitIds.some(id=>typeof id!=='string'||id.length>64)||!['engaged','supporting','left','right'].includes(g.role))throw Error('双机方针分工无效');group={id:g.id,unitIds:g.unitIds.slice(),role:g.role};}
  return {offense,defense,offenseIntent:OFFENSE_POLICIES[offense].guide,defenseIntent:DEFENSE_POLICIES[defense].guide,revision:value.revision,direct,group};
}
export const directOwnsFlight=u=>['planning','executing','recovering'].includes(u.tacticalGuidance?.direct?.phase);
export function deliveredPartnerState(unit,partnerId,time){
  const link=unit.datalink,channel=link?.config?.networkId??link?.networkId;
  return link?.contacts?.find(p=>p.kind==='participant'&&p.sourceUnitId===partnerId&&p.channelId===channel&&time-p.observedAt>=0&&time-p.observedAt<=3)??null;
}
export function teamGuidanceContext(context,unit){
  const partners=new Set([...(unit.tacticalGuidance?.group?.unitIds??[]),unit.flightRole?.partnerId]);
  return (unit.datalink?.contacts??[]).filter(p=>p.kind==='participant'&&p.sourceUnitId!==unit.id&&partners.has(p.sourceUnitId)&&p.channelId===unit.datalink.networkId&&context.simTimeSec-p.observedAt<=3).map(p=>({id:p.sourceUnitId,callsign:p.callsign,position:p.position,headingDeg:p.headingDeg,speedMps:p.speedMps,observedAt:p.observedAt,receivedAt:p.receivedAt,combat:p.combat??null,assignedGroup:unit.tacticalGuidance?.group?.id??null}));
}
export function validateGuidanceState(value){
  guidanceContext(value);if(!value)return;
  const r=value.resume,d=value.direct,vec=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
  if(r&&(!Array.isArray(r.points)||r.points.length>256||!r.points.every(vec)||!Number.isFinite(r.speed)||r.speed<0||!Number.isFinite(r.altitude)||!(r.heading===null||Number.isFinite(r.heading)&&r.heading>=0&&r.heading<=360)||!Array.isArray(r.orbit)||r.orbit.length!==2||!r.orbit.every(Number.isFinite)))throw Error('机动复位存档无效');
  if(d){for(const k of ['initialCompleted','pointCount'])if(d[k]!==undefined&&(!Number.isSafeInteger(d[k])||d[k]<0))throw Error('机动阶段存档无效');for(const k of ['pending','replan','defensive'])if(d[k]!==undefined&&typeof d[k]!=='boolean')throw Error('机动阶段存档无效');}
}
export const GUIDANCE_RULES=`tacticalGuidance是玩家持续方针，offenseIntent和defenseIntent是程序按已选方案提供的完整意图，必须保持其差异，不合并为默认攻击或固定横切。group是双机方案的共同编号、成员与本机分工，结合teamMembers理解协同；角色可以按实况交接但不新增目标或发射授权。结合原任务理解为何机动、如何安全执行、何时结束及如何复位；不为了复位飞回过时机位。直接机动期间不以自主攻击/搜索航路覆盖它。优先级是飞行安全/管制与授权边界、明确直接机动、方针对细节与取舍的指导、原航路；直接机动不自动更换方针。两项方针有张力时根据当前阶段解释取舍，无法兼容明确要求时报告原因而不是静默改令。新的观测、紧急威胁与飞行安全仍需判断；无法满足时明确UNABLE并说明原因。只使用游戏实测观测，不猜敌方隐藏状态，不改变目标与弹量授权。`;
