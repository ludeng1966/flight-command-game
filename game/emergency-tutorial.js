import {focusLive,hideLiveUnit} from '../three3d/scene.js';
import {
  createEmergencyTutorialState,enterEmergencyTutorialStep,tickEmergencyTutorial,advanceEmergencyTutorial,
  currentEmergencyTutorialStep,currentEmergencyChapter,EMERGENCY_TUTORIAL_STEPS
} from '../sim/emergency-tutorial.js';

const SETTLE_SEC = 2.5;
function readSeconds(step) {
  if (!step) return 0;
  const chars = String(step.text ?? '').length;
  return Math.min(8, Math.max(3, 2 + chars * .05));
}

// 第 4 关：地面紧急起飞 → 出航 → 雷达识别 → RWR → 返航。
export function initEmergencyTutorial({getWorld,getSelected,onSimulation=()=>{},message=()=>{}}){
  if(new URLSearchParams(location.search).get('tutorial')!=='emergency')return null;
  const world=getWorld();
  if(world.units.length>1)for(const removed of world.units.splice(1)){document.getElementById(removed.id)?.remove();hideLiveUnit(removed.id);}
  const alpha=world.units[0];
  if(!alpha)return null;

  const airport=world.airportOps?.airport;
  const runway=airport?.runways?.find(r=>r.designator==='09L')??airport?.runways?.[0];
  if(airport&&runway){
    alpha.position=[...airport.nodes[runway.hold]];
    alpha.velocity=[0,0,0];alpha.speed=0;alpha.bank=0;alpha.cl=0;alpha.throttle=0;alpha.afterburner=0;alpha.gearDown=true;alpha.flaps='takeoff';
    alpha.surface={phase:'holding',grounded:true,node:runway.hold,runway:runway.designator,heading:runway.headingDeg*Math.PI/180,route:[],station:'ground',message:'09L跑道外等待'};
    alpha.waypoints=[];alpha.headingRoute=null;alpha.headingTarget=null;alpha.orbit=[alpha.position[0]+4000,alpha.position[1]];
  }
  alpha.rwr??={contacts:[]};
  world.revision++;
  const state=createEmergencyTutorialState();
  enterEmergencyTutorialStep(state,alpha,world);
  try{focusLive([{position:[...alpha.position]}],.8);}catch{}

  const css=document.createElement('link');css.rel='stylesheet';css.href='./radar-tutorial.css';document.head.append(css);
  const panel=document.createElement('aside');panel.id='radar-tutorial';
  Object.assign(panel.style,{position:'fixed',right:'16px',top:'96px',left:'auto',transform:'none',width:'min(92vw,380px)',
    maxHeight:'44vh',overflow:'auto',zIndex:'920',padding:'10px 12px',borderRadius:'10px',
    border:'1px solid #2a4054',background:'rgba(7,16,25,.93)',backdropFilter:'blur(8px)',
    font:'12px/1.55 "Microsoft YaHei",Consolas,monospace',color:'#cfe3f5',boxShadow:'0 12px 32px rgba(0,0,0,.45)'});
  document.body.append(panel);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const titleStyle='margin:0 0 6px;font-size:15px;font-weight:500;color:#e8f3ff;line-height:1.4';
  const textStyle='margin:0 0 8px;color:#adc3d4;line-height:1.55';
  const btnStyle='appearance:none;border:1px solid #2a4054;background:#0b1622;color:#cfe3f5;border-radius:8px;padding:8px 10px;font:inherit;cursor:pointer;text-align:left';
  let timer=null,successHandled=false,actionDone=false;
  const later=(fn,ms)=>{clearTimeout(timer);timer=setTimeout(fn,ms);};

  function ensureTargets(){
    if(!airport)return;
    if((world.radarTargets??[]).length>=2&&state.hostileId&&state.friendlyId)return;
    try{
      const heading=Math.atan2(alpha.velocity?.[0]??0,alpha.velocity?.[1]??1),sin=Math.sin(heading),cos=Math.cos(heading);
      const altitude=Math.max(3000,alpha.position[2]);
      const unknown=world.addRadarPracticeTarget(alpha.id);
      unknown.position=[alpha.position[0]+sin*18000,alpha.position[1]+cos*18000,altitude];
      unknown.velocity=[...alpha.velocity];unknown.radarRcsM2=20;unknown.team='practice';
      unknown.callsign='UNKNOWN 01';unknown.aircraftType='F-16 同型靶';unknown.aircraftCategory='战斗机';
      const friendly=world.addRadarPracticeTarget(alpha.id);
      friendly.position=[alpha.position[0]+sin*21000+cos*3500,alpha.position[1]+cos*21000-sin*3500,altitude+200];
      friendly.velocity=[...alpha.velocity];friendly.radarRcsM2=20;friendly.team='blue';
      friendly.callsign='FRIEND 02';friendly.aircraftType='F-16 友军';friendly.aircraftCategory='战斗机';
      state.hostileId=unknown.id;state.friendlyId=friendly.id;
      // 教学雷达放宽扫描扇区/加快周转，避免等扫描时卡关；第 6 步仍要求玩家手动收窄并抬高。
      Object.assign(alpha.radar.config,{azimuthHalfDeg:80,elevationHalfDeg:50,sweepSec:1.5});
      alpha.radar.scanCenterDeg=0;alpha.radar.scanHalfDeg=80;alpha.radar.scanElevationCenterDeg=0;alpha.radar.scanElevationHalfDeg=30;
    }catch(error){message('识别目标布置失败：'+error.message,true);}
  }
  // 教程返航收尾：直接放在短五边最后进近，避免完整进场程序把教程拖成十几分钟。
  function stageReturnApproach(){
    if(!airport||!runway)return;
    const direction=runway.direction??1,thresholdX=direction===1?runway.x0:runway.x1;
    const finalX=thresholdX-direction*4000,heading=runway.headingDeg*Math.PI/180;
    alpha.position=[finalX,runway.y,(airport.elevation??0)+250];
    alpha.velocity=[Math.sin(heading)*100,Math.cos(heading)*100,-4];alpha.speed=100;
    alpha.surface={phase:'final',grounded:false,runway:runway.designator,heading,route:[],station:'tower',message:'最后进近，塔台已许可着陆',clearances:null,landCleared:true};
    alpha.waypoints=[];alpha.headingTarget=null;alpha.headingRoute=null;alpha.gearDown=true;alpha.flaps='landing';
    world.revision++;
  }
  function doStepAction(step){
    if(!step||actionDone)return;
    actionDone=true;
    try{
      if(step.id==='lineup')world.airportCommand(alpha.id,{intent:'line_up',runway:runway?.designator??'09L'});
      else if(step.id==='takeoff')world.airportCommand(alpha.id,{intent:'takeoff',runway:runway?.designator??'09L'});
      else if(step.id==='navigate'){const p=state.interceptPoint;if(p)world.command(alpha.id,[p],false);}
      else if(step.id==='radarPower')ensureTargets();
      else if(step.id==='iff')world.iffMode(alpha.id,'manual');
      else if(step.id==='lost'&&state.hostileId)world.setRadarPracticeAspect?.(alpha.id,state.hostileId,'crossing');
      else if(step.id==='modeRelock'&&state.hostileId)world.setRadarPracticeAspect?.(alpha.id,state.hostileId,'headon');
      else if(step.id==='rwr')world.addRwrPracticeEmitter?.(alpha.id,'track');
      else if(step.id==='return')stageReturnApproach();
    }catch(error){message(error.message,true);}
  }
  function render(){
    const step=currentEmergencyTutorialStep(state),total=EMERGENCY_TUTORIAL_STEPS.length,chapter=currentEmergencyChapter(state);
    if(!step||state.phase==='done'){
      panel.innerHTML=`<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#9cdfb7;font-size:10px;letter-spacing:.14em">FLIGHT SCHOOL · 第 4 关</span><span style="color:#7f97a8;font-size:10px">完成</span></div>
        <h2 style="${titleStyle}">紧急起飞识别完成</h2>
        <p style="${textStyle}">你完成了：紧急起飞 → 雷达搜索/TWS → IFF → 锁定/丢锁/重截获 → NCTR → RWR → 静默返航。</p>
        <a style="${btnStyle};text-align:center;border-color:#2b6b48;background:#0f2a1d;color:#9de8bb;text-decoration:none;display:block" href="./training-select.html">返回关卡选择</a>`;
      return;
    }
    const done=state.phase==='success',read=readSeconds(step);
    panel.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px"><span style="color:#9cdfb7;font-size:10px;letter-spacing:.14em">FLIGHT SCHOOL · 第 4 关${chapter?` · 第${chapter.index+1}章 ${esc(chapter.chapter.title)}`:''}</span><span style="color:#7f97a8;font-size:10px">步骤 ${state.index+1} / ${total}</span></div>
      <progress max="${total}" value="${state.index}" style="width:100%;height:3px;margin:0 0 8px"></progress>
      <h2 style="${titleStyle}">${done?'✓ ':''}${esc(step.title)}</h2>
      <p style="${textStyle}">${esc(step.text)}</p>${step.id==='navigate'?'<p id="et-nav-cue" style="color:#65e6ff;font-size:11px;margin:0 0 6px">拦截点计算中…</p>':''}
      ${done?`<p style="color:#9de8bb;background:#0f2a1d;border:1px solid #2b6b48;border-radius:8px;padding:6px 9px;margin:0 0 6px">${esc(state.feedback||'这一步完成了。')}</p><p style="color:#7f97a8;font-size:10px;margin:0 0 6px">约 ${SETTLE_SEC} 秒后自动下一步…</p>`:`<p style="color:#7f97a8;font-size:10px;margin:0 0 6px">${state.phase==='brief'?`约 ${read} 秒后开始…`:'操作中…完成后自动暂停'}</p>`}
      <div style="display:flex;justify-content:space-between;border-top:1px solid #1b2f40;padding-top:7px;margin-top:2px;font-size:11px"><a href="./training-select.html" style="color:#7f97a8;text-decoration:none">退出教程</a><button type="button" id="et-restart" style="appearance:none;border:0;background:transparent;color:#7f97a8;font:inherit;font-size:11px;cursor:pointer">重新开始</button></div>`;
    panel.querySelector('#et-restart').onclick=()=>{clearTimeout(timer);location.reload();};
  }
  function syncTutorialMarker(step){
    const w=getWorld();
    if(step?.id==='navigate'&&state.interceptPoint)w.tutorialMarker={position:[...state.interceptPoint],label:'拦截点'};
    else delete w.tutorialMarker;
  }
  function beginStep(){
    successHandled=false;actionDone=false;
    const step=currentEmergencyTutorialStep(state);
    syncTutorialMarker(step);
    if(!step||state.phase==='done'){delete getWorld().tutorialMarker;onSimulation(false);render();return;}
    onSimulation(false);render();
    if(step.kind==='brief')later(()=>{onSimulation(true);render();},readSeconds(step)*1000);
    else{doStepAction(step);later(()=>{onSimulation(true);render();},readSeconds(step)*1000);}
  }
  function autoAdvance(){
    if(advanceEmergencyTutorial(state,alpha,getWorld()))beginStep();
    else{delete getWorld().tutorialMarker;onSimulation(false);render();}
  }
  render();beginStep();
  let lastKey='';
  return {
    update(){
      const unit=getWorld()?.units[0];if(!unit)return;
      tickEmergencyTutorial(state,unit,getWorld());
      if(state.index>=4&&!state.hostileId&&unit.position[2]>=500)ensureTargets();
      const cue=panel.querySelector('#et-nav-cue');
      if(cue&&state.interceptPoint){
        const dx=state.interceptPoint[0]-unit.position[0],dy=state.interceptPoint[1]-unit.position[1];
        const range=Math.hypot(dx,dy),bearing=(Math.atan2(dx,dy)*180/Math.PI+360)%360;
        cue.textContent=`拦截点：距离 ${(range/1000).toFixed(1)} km · 方位 ${Math.round(bearing).toString().padStart(3,'0')}°`;
      }
      if(state.phase==='success'&&!successHandled){successHandled=true;onSimulation(false);render();later(autoAdvance,SETTLE_SEC*1000);}
      const key=[state.index,state.phase,state.feedback].join(':');
      if(key!==lastKey){lastKey=key;render();}
    },
    get state(){return state;}
  };
}
