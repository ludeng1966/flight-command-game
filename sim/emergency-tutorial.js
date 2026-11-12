// 第 4 关新形态：一次「紧急起飞 → 雷达搜索/识别 → 静默返航」任务。
// 纯状态机，不碰 DOM；真实结果由 world/unit 状态判定。
export const EMERGENCY_TUTORIAL_CHAPTERS = [
  {id:'launch',title:'紧急起飞',steps:['alert','lineup','takeoff']},
  {id:'search',title:'雷达搜索',steps:['navigate','radarPower','scanSetup','contact','multiTws']},
  {id:'identify',title:'识别与对抗',steps:['iff','lock','lost','modeRelock','nctr','rwr','silence']},
  {id:'return',title:'静默返航',steps:['return']}
];

export const EMERGENCY_TUTORIAL_STEPS = [
  {id:'alert',kind:'brief',chapter:'launch',title:'紧急起飞',after:1.2,
    text:'警报：不明目标进入 BAY 空域。你在 09L 跑道外等待点，立即起飞拦截。任务规则：先识别，不发射。'},
  {id:'lineup',kind:'goal',chapter:'launch',title:'进入跑道对正',goal:'lineup',
    text:'教官已代你请求进跑道。看飞机实际进入 09L 并对正；塔台许可未到前不会滑跑。'},
  {id:'takeoff',kind:'goal',chapter:'launch',title:'紧急起飞',goal:'takeoff',
    text:'对正后自动请求起飞。确认飞机实际离地并爬升到机场上方 300 米以上。'},
  {id:'navigate',kind:'goal',chapter:'search',title:'出航拦截',goal:'navigate',
    text:'沿蓝色航线飞向地图上的青色拦截点；到达识别空域后再开雷达，避免过早暴露。'},
  {id:'radarPower',kind:'goal',chapter:'search',title:'雷达开机',goal:'radarPower',
    text:'点底部雷达按钮或按 R/B 打开雷达屏，把雷达切到 PD 搜索。开机约 2 秒预热，预热完才开始扫描。'},
  {id:'scanSetup',kind:'goal',chapter:'search',title:'手动扫描设置',goal:'scanSetup',
    text:'打开雷达屏（B），点“窄”收窄方位扇区，再点“▲ 俯仰”把扫描中心抬高；这一步必须实际操作。'},
  {id:'contact',kind:'goal',chapter:'search',title:'发现第一条航迹',goal:'contact',
    text:'等扫描线扫到目标。雷达屏出现航迹只说明“有东西”，不代表已识别。'},
  {id:'multiTws',kind:'goal',chapter:'search',title:'双目标与 TWS',goal:'multiTws',
    text:'前方有两条航迹。打开雷达屏，Ctrl+单击两条航迹做 TWS 多目标标记；TWS 只是跟踪，不是发射。'},
  {id:'iff',kind:'goal',chapter:'identify',title:'IFF 敌我识别',goal:'iff',
    text:'教官已把 IFF 切到手动。按 I 询问，把友军和未知目标分开；未知不等于敌机。'},
  {id:'lock',kind:'goal',chapter:'identify',title:'锁定未知目标',goal:'lock',
    text:'按 R 轮换到 UNKNOWN 01，再按 E 锁定；截获需要连续回波，保持到雷达显示“已锁定”。'},
  {id:'lost',kind:'goal',chapter:'identify',title:'观察丢锁',goal:'lost',
    text:'保持观察，不要操作。目标会横切；PD 速度门可能把它当成地面杂波，航迹变灰、外推，然后掉锁。'},
  {id:'modeRelock',kind:'goal',chapter:'identify',title:'切换模式并重截获',goal:'modeRelock',
    text:'先切到 SRC（快速点按模式按钮），再切回 PD；等 UNKNOWN 01 重新出现后按 E 重新锁定。切换模式会清空旧航迹。'},
  {id:'nctr',kind:'goal',chapter:'identify',title:'NCTR 识别',goal:'nctr',
    text:'保持锁定 4 秒、35 km 内，雷达会给出型号/类别和置信度；没有 NCTR 只能看到“一个目标”。'},
  {id:'rwr',kind:'goal',chapter:'identify',title:'RWR 告警检查',goal:'rwr',
    text:'打开右上 RWR。教官会制造一个跟踪照射源；RWR 只给方位和等级，没有距离、位置或机型。'},
  {id:'silence',kind:'goal',chapter:'identify',title:'电磁静默',goal:'silence',
    text:'识别完成，进入电磁静默：雷达关机、停止主动辐射。RWR 仍接收，静默不等于隐身。'},
  {id:'return',kind:'goal',chapter:'return',title:'返航接地',goal:'return',
    text:'返航 BAY。塔台已引导到最后进近；飞机实际接地后任务完成，之后可继续滑回机位。'}
];

export const EMERGENCY_LEVEL=Object.freeze({id:'emergency',number:4,title:'紧急起飞识别',entry:'holding'});
const STEPS=EMERGENCY_TUTORIAL_STEPS;
const stepAt=s=>STEPS[s.index];

export function createEmergencyTutorialState(){
  return {index:0,phase:'brief',startedAt:null,interceptPoint:null,feedback:'',hints:0,
    hostileId:null,friendlyId:null,lostBase:0,lostSeen:false,modeSeen:false,stableSec:0,lastTime:null};
}

export function enterEmergencyTutorialStep(state,unit,world){
  const step=stepAt(state);
  state.phase=step?.kind==='brief'?'brief':'working';state.startedAt=world.time;state.feedback='';state.hints=0;
  state.stableSec=0;state.lastTime=null;state.lostSeen=false;state.modeSeen=false;
  if(!step||!unit)return;
  if(step.id==='navigate'){
    const heading=Math.atan2(unit.velocity?.[0]??0,unit.velocity?.[1]??1);
    state.interceptPoint=[unit.position[0]+Math.sin(heading)*22000,unit.position[1]+Math.cos(heading)*22000,Math.max(6000,unit.position[2])];
  }
  if(step.id==='lost')state.lostBase=unit.radar?.lastLostSequence??0;
  if(step.id==='return')state.interceptPoint=null;
}

export function advanceEmergencyTutorial(state,unit,world){
  if(state.phase!=='success')return false;
  state.index++;
  if(state.index>=STEPS.length){state.phase='done';return false;}
  enterEmergencyTutorialStep(state,unit,world);return true;
}

function distanceTo(point,unit){return point?Math.hypot(unit.position[0]-point[0],unit.position[1]-point[1]):Infinity;}
function freshContacts(unit,time){const r=unit.radar;return r?r.contacts.filter(c=>time-c.observedAt<=r.config.sweepSec+.25):[];}
function contactOf(unit,id){return (unit.radar?.contacts??[]).find(c=>c.id===id)??null;}

export function tickEmergencyTutorial(state,unit,world){
  const step=stepAt(state);if(!step||!unit||state.phase==='success'||state.phase==='done')return state;
  const now=world.time,ground=unit.surface?.grounded===true,phase=unit.surface?.phase;
  if(state.phase==='brief'){if(now-state.startedAt>=(step.after??1))state.phase='success';return state;}
  const r=unit.radar,contacts=freshContacts(unit,now),dt=state.lastTime==null?.05:Math.max(0,now-state.lastTime),target=contactOf(unit,state.hostileId);
  let passed=false;
  switch(step.goal){
    case 'lineup': passed=['lined_up','takeoff_roll'].includes(phase)||!ground; break;
    case 'takeoff': passed=!ground&&unit.position[2]>=(world.airportOps?.airport?.elevation??0)+300; break;
    case 'navigate': passed=distanceTo(state.interceptPoint,unit)<=4000; break;
    case 'radarPower': passed=r?.mode==='pd'; break;
    case 'scanSetup': passed=!!r&&(r.scanHalfDeg??r.config.azimuthHalfDeg)<r.config.azimuthHalfDeg-1e-9&&Math.abs(r.scanElevationCenterDeg??0)>=5; break;
    case 'contact': passed=contacts.length>=1; break;
    case 'multiTws': passed=contacts.length>=2&&(r?.twsTrackedIds??[]).length>=2; break;
    case 'iff': passed=r?.iffMode==='manual'&&contacts.some(c=>c.classification==='friendly')&&contacts.some(c=>c.classification==='unknown'); break;
    case 'lock': passed=r?.targetId===state.hostileId&&r?.phase==='locked'; break;
    case 'lost':
      if(r?.phase==='coasting')state.lostSeen=true;
      passed=state.lostSeen||(r?.lastLostSequence??0)>(state.lostBase??0); break;
    case 'modeRelock':
      if(r?.mode==='pulse')state.modeSeen=true;
      if(state.modeSeen&&r?.mode==='pd'&&r.targetId===state.hostileId&&r.phase==='locked')state.stableSec+=dt;
      else state.stableSec=0;
      passed=state.modeSeen&&state.stableSec>=1; break;
    case 'nctr': passed=!!target?.identification; break;
    case 'rwr': passed=(unit.rwr?.contacts??[]).some(c=>now-c.observedAt<=2.5); break;
    case 'silence': passed=r?.silent===true; break;
    case 'return': passed=ground&&['rollout','exit','taxi','waiting_gate','parked'].includes(phase); break;
  }
  state.lastTime=now;
  if(passed){state.phase='success';state.feedback='';}
  else if(now-state.startedAt>15&&state.hints<3){state.hints++;state.feedback=hintFor(step.goal,state,unit);}
  return state;
}

export function currentEmergencyTutorialStep(state){return stepAt(state);}
export function currentEmergencyChapter(state){
  const step=stepAt(state);if(!step)return null;
  const index=EMERGENCY_TUTORIAL_CHAPTERS.findIndex(c=>c.id===step.chapter);
  return index<0?null:{index,chapter:EMERGENCY_TUTORIAL_CHAPTERS[index]};
}
function hintFor(goal,state,unit){
  const r=unit?.radar;
  switch(goal){
    case 'lineup': return '提示：等待塔台许可进入跑道；飞机到对正位才继续。';
    case 'takeoff': return '提示：听起飞许可，观察实际离地和高度。';
    case 'navigate': return '提示：向青色拦截点出航，接近后再开雷达。';
    case 'radarPower': return '提示：点雷达模式按钮切到 PD；预热约 2 秒。';
    case 'scanSetup': return '提示：按 B 开雷达屏，点“窄”和“▲ 俯仰”，两步都必须做。';
    case 'contact': return '提示：等扫描线扫过目标；需要时收窄扇区或调整俯仰。';
    case 'multiTws': return '提示：雷达屏里 Ctrl+单击两条航迹；两条都要出现 TWS 框。';
    case 'iff': return '提示：点 IFF 到“手动”，再按 I 问询。';
    case 'lock': return `提示：用 R 选中 UNKNOWN 01${state.hostileId?'' : '（目标尚未标记）'}，再按 E；保持到“已锁定”。`;
    case 'lost': return '提示：保持观察，等目标横切；盯住雷达屏的灰色外推和掉锁提示。';
    case 'modeRelock': return '提示：快速点模式按钮切 SRC，再切回 PD；等 UNKNOWN 01 出现后按 E。';
    case 'nctr': return '提示：保持锁定并靠近到 35 km 内，等 4 秒 NCTR 积累。';
    case 'rwr': return '提示：点右上 RWR 打开平面屏；关注方位和等级，不看距离。';
    case 'silence': return '提示：点雷达栏的“静默”，或按住模式按钮选电磁静默。';
    case 'return': return '提示：按塔台引导返航，等飞机实际接地。';
    default: return '';
  }
}
