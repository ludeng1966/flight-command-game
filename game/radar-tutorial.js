import {focusLive,hideLiveUnit} from '../three3d/scene.js';
import {createRadarTutorialState,enterRadarTutorialStep,tickRadarTutorial,advanceRadarTutorial,answerRadarTutorial,currentRadarTutorialStep,RADAR_TUTORIAL_STEPS} from '../sim/radar-tutorial.js';

// 节奏按每步文本长度和操作类型计算：阅读越久越充分，完成后固定停留 2.5 秒再自动下一步。
const SETTLE_SEC = 2.5;
function readSeconds(step) {
  if (!step || step.kind === 'quiz') return 0;
  const chars = String(step.text ?? '').length;
  return Math.min(8, Math.max(3, 2 + chars * .05));
}
export function initRadarTutorial({getWorld,getSelected,onSimulation=()=>{},message=()=>{}}){
  const params=new URLSearchParams(location.search);
  if(params.get('tutorial')!=='radar')return null;

  // 场景：单机 + 两个 F-16 同型练习靶（空中出生由 main 负责）
  const world=getWorld();
  if(world.units.length>1){
    // 教程只留单机：同时移除多余的单位卡片，避免残留旧呼号。
    for(const removed of world.units.splice(1)){document.getElementById(removed.id)?.remove();hideLiveUnit(removed.id);}
  }
  const alpha=world.units[0];
  // 教程期间保持直线飞行：把盘旋中心放远，避免飞机自己转弯把靶机甩出雷达扇区。
  try{const heading=Math.atan2(alpha.velocity?.[0]??0,alpha.velocity?.[1]??1);alpha.orbit=[alpha.position[0]+Math.sin(heading)*150000,alpha.position[1]+Math.cos(heading)*150000];alpha.headingTarget=null;alpha.headingRoute=null;}catch{}
  try{
    if(alpha?.radar?.available&&!world.radarTargets.length){
      world.addRadarPracticeTarget(alpha.id);
      const second=world.addRadarPracticeTarget(alpha.id);
      if(second){second.position[0]+=2600;second.position[2]+=150;}
      // 练习靶和本机同速同向：相对距离保持不变；教学雷达放宽扫描扇区/加快周转，避免等扫描时卡关。
      try{Object.assign(alpha.radar.config,{azimuthHalfDeg:80,elevationHalfDeg:50,sweepSec:1.5});}catch{}
      for(const target of world.radarTargets){target.velocity=[...alpha.velocity];target.radarRcsM2=Math.max(20,target.radarRcsM2??1);}
    }
  }catch(error){message('练习靶布置失败：'+error.message,true);}
  world.revision++;
  try{focusLive([alpha],1.15);}catch{}

  const state=createRadarTutorialState();
  enterRadarTutorialStep(state,alpha,world);

  const css=document.createElement('link');css.rel='stylesheet';css.href='./radar-tutorial.css';document.head.append(css);
  const panel=document.createElement('aside');
  panel.id='radar-tutorial';
  Object.assign(panel.style,{position:'fixed',right:'16px',top:'96px',left:'auto',transform:'none',width:'min(92vw,360px)',
    maxHeight:'42vh',overflow:'auto',zIndex:'920',padding:'10px 12px',borderRadius:'10px',
    border:'1px solid #2a4054',background:'rgba(7,16,25,.93)',backdropFilter:'blur(8px)',
    font:'12px/1.55 "Microsoft YaHei",Consolas,monospace',color:'#cfe3f5',boxShadow:'0 12px 32px rgba(0,0,0,.45)'});
  document.body.append(panel);

  const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const kicker='color:#9cdfb7;font-size:10px;letter-spacing:.14em';
  const titleStyle='margin:0 0 6px;font-size:15px;font-weight:500;color:#e8f3ff;line-height:1.4';
  const textStyle='margin:0 0 8px;color:#adc3d4;line-height:1.55';
  const btnStyle='appearance:none;border:1px solid #2a4054;background:#0b1622;color:#cfe3f5;border-radius:8px;padding:8px 10px;font:inherit;cursor:pointer;text-align:left';
  let timer=null,successHandled=false,pacingStep=null;
  const later=(fn,ms)=>{clearTimeout(timer);timer=setTimeout(fn,ms);};

  function render(){
    const step=currentRadarTutorialStep(state);
    const total=RADAR_TUTORIAL_STEPS.length;
    if(!step||state.phase==='done'){
      panel.innerHTML=`<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="${kicker}">FLIGHT SCHOOL · 第 4 关</span><span style="color:#7f97a8;font-size:10px">完成</span></div>
        <h2 style="${titleStyle}">雷达入门完成</h2>
        <p style="${textStyle}">你已经走完：开机搜索 → 发现 → 锁定 → 切模式 → 丢锁 → 重新截获 → RWR 告警 → 静默。</p>
        <div style="display:flex;flex-direction:column;gap:7px"><a style="${btnStyle};border-color:#2b6b48;background:#0f2a1d;color:#9de8bb;text-align:center;text-decoration:none" href="./training-select.html">返回关卡选择</a><button type="button" id="rt-restart" style="${btnStyle}">再练一次</button></div>`;
      panel.querySelector('#rt-restart').onclick=()=>{clearTimeout(timer);location.reload();};
      return;
    }
    const done=state.phase==='success';
    const quiz=step.kind==='quiz';
    panel.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px"><span style="${kicker}">FLIGHT SCHOOL · 第 4 关</span><span style="color:#7f97a8;font-size:10px">步骤 ${state.index+1} / ${total}</span></div>
      <progress max="${total}" value="${state.index}" style="width:100%;height:3px;margin:0 0 8px"></progress>
      <h2 style="${titleStyle}">${done?'✓ ':''}${esc(step.title)}</h2>
      <p style="${textStyle}">${esc(quiz?step.question:step.text)}</p>
      ${done?`<p style="color:#9de8bb;background:#0f2a1d;border:1px solid #2b6b48;border-radius:8px;padding:6px 9px;margin:0 0 6px">${esc(state.feedback||'这一步完成了。')}</p>`:''}
      ${quiz&&!done?`<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:6px">${step.options.map(([k,label])=>`<button type="button" data-answer="${k}" style="${btnStyle}">${esc(label)}</button>`).join('')}</div>`:''}
      ${!done&&state.feedback?`<p style="color:#e4c77e;font-size:11px;margin:0 0 6px">${esc(state.feedback)}</p>`:''}
      ${done?`<p style="color:#7f97a8;font-size:10px;margin:0 0 6px">约 ${SETTLE_SEC} 秒后自动下一步…</p>`:quiz?'':`<p style="color:#7f97a8;font-size:10px;margin:0 0 6px">${state.phase==='brief'?`约 ${readSeconds(step)} 秒后开始…`:'操作中…完成后自动暂停'}</p>`}
      <div style="display:flex;justify-content:space-between;border-top:1px solid #1b2f40;padding-top:7px;margin-top:2px;font-size:11px"><a href="./training-select.html" style="color:#7f97a8;text-decoration:none">退出教程</a><button type="button" id="rt-restart-2" style="appearance:none;border:0;background:transparent;color:#7f97a8;font:inherit;font-size:11px;cursor:pointer">重新开始</button></div>`;
    panel.querySelector('#rt-restart-2').onclick=()=>{clearTimeout(timer);location.reload();};
    for(const b of panel.querySelectorAll('[data-answer]'))b.onclick=()=>{answerRadarTutorial(state,b.dataset.answer);render();};
  }

  function beginStep(){
    successHandled=false;
    const step=currentRadarTutorialStep(state);
    if(!step||state.phase==='done'){onSimulation(false);render();return;}
    onSimulation(false);
    render();
    if(step.kind==='quiz')return; // 判断题不需要跑仿真，等玩家选择
    later(()=>{onSimulation(true);render();}, readSeconds(step) * 1000);
  }

  function autoAdvance(){
    if(advanceRadarTutorial(state,alpha,getWorld())){
      beginStep();
    }else{
      onSimulation(false);
      render();
    }
  }

  render();
  beginStep();
  let lastKey='';
  return {
    update(){
      const unit=getWorld()?.units[0];if(!unit)return;
      tickRadarTutorial(state,unit,getWorld());
      if(state.phase==='success'&&!successHandled){
        const stepAtSuccess=currentRadarTutorialStep(state);
        successHandled=true;
        onSimulation(false);
        render();
        later(autoAdvance, SETTLE_SEC * 1000);
      }
      const key=[state.index,state.phase,state.feedback].join(':');
      if(key!==lastKey){lastKey=key;render();}
    },
    get state(){return state;}
  };
}
