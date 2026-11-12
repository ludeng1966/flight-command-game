import {pickUnit,pointOnTerrain} from '../three3d/scene.js';
import {HEIGHT_BANDS,heightForMode,bandLabel,modalAltitudeText,orderSummary,patrolPoints,COMMAND_MODES,commandModeLabel,previewLabel,formatPreviewDistance} from './click-fly-model.js';

export function initClickFly({getWorld,getSelected,getSelectedIds=()=>[getSelected()],onChange=()=>{},message=()=>{},isRouteEdit=()=>false}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='./click-fly.css';document.head.append(css);
  const bar=document.createElement('section');
  bar.id='click-fly';
  bar.innerHTML=`<div class="cf-title"><b>点哪飞哪</b><span id="cf-hint">左键执行 · 右键追加</span></div>
    <div class="cf-modes" role="group" aria-label="指令类型">${COMMAND_MODES.map((m)=>`<button type="button" data-cmd="${m.id}" title="${m.hint}">${m.label}</button>`).join('')}</div>
    <div class="cf-alt" role="group" aria-label="目标高度">${Object.keys(HEIGHT_BANDS).map(k=>`<button type="button" data-band="${k}">${bandLabel(k)}</button>`).join('')}<button type="button" data-band="current">当前</button></div>
    <label class="cf-custom">自定义<input id="cf-altitude" type="number" min="300" max="15000" step="100" placeholder="高度 m"></label>
    <span id="cf-status" role="status"></span>`;
  document.body.append(bar);
  const status=$('#cf-status'),custom=$('#cf-altitude');
  function $(s){return bar.querySelector(s);}

  let mode='current',customAltitude=null,pointer=null,cmd='move',preview=null;
  function setPreview(next){preview=next;if(next)paint();}
  function setMode(next){mode=next;customAltitude=null;custom.value='';setPreview(null);paint();}
  function setCommand(next){cmd=next;setPreview(null);paint();}
  function paint(){
    for(const b of bar.querySelectorAll('[data-band]'))b.dataset.active=String(b.dataset.band===mode&&customAltitude===null);
    for(const b of bar.querySelectorAll('[data-cmd]'))b.dataset.active=String(b.dataset.cmd===cmd);
    const u=unit(),selected=targets().length;
    const clickHint=cmd==='patrol'?'左键设巡逻区':cmd==='rtb'?'左键请求返场':'左键覆盖 · 右键追加';
    $('#cf-hint').textContent=u&&!u.surface?.grounded?`${commandModeLabel(cmd)} · ${selected>1?selected+' 架 · ':''}${clickHint}`:'空中才生效';
    status.dataset.error='false';
    status.textContent=preview?`${commandModeLabel(cmd)} → ${preview.label}`:(customAltitude!==null?`高度 ${customAltitude} m`:`${commandModeLabel(cmd)} · ${modalAltitudeText(mode,u?.position?.[2]??0)}`);
  }
  function unit(){return getWorld()?.units.find(u=>u.id===getSelected())??null;}
  function targets(){const w=getWorld();const list=(getSelectedIds()??[]).map(id=>w?.units.find(u=>u.id===id)).filter(u=>u&&u.alive!==false&&!u.surface?.grounded);return list.length?list:(unit()?[unit()]:[]);}
  function targetAltitude(){const u=unit();return customAltitude!==null?customAltitude:heightForMode(mode,u?.position?.[2]??0);}

  bar.addEventListener('click',e=>{const b=e.target.closest('[data-cmd]');if(b)setCommand(b.dataset.cmd);const alt=e.target.closest('[data-band]');if(alt)setMode(alt.dataset.band);});
  custom.addEventListener('input',()=>{const v=Number(custom.value);customAltitude=Number.isFinite(v)&&v>0?Math.min(15000,Math.max(300,v)):null;paint();});

  function worldPoint(x,y,altitude){
    // 先拾取光标下方的地形，再垂直向上放到目标高度；不再用高空水平面。
    const ground=pointOnTerrain(x,y);
    return ground?[ground[0],ground[1],Math.max(altitude,ground[2]+300)]:null;
  }
  function issue(x,y,append){
    const w=getWorld(),list=targets();
    if(!w||!list.length)return;
    if(isRouteEdit()){message('先退出航线设置，再使用点哪飞哪',true);return;}
    const altitude=targetAltitude();
    if(cmd==='rtb'){setPreview(null);for(const u of list)returnToBase(w,u,altitude);onChange();return;}
    const point=worldPoint(x,y,altitude);
    if(!point){message('目标点不可达',true);return;}
    try{
      for(const u of list){
        if(cmd==='patrol'){
          const heading=Math.atan2(u.velocity?.[0]??0,u.velocity?.[1]??1);
          const points=patrolPoints([point[0],point[1]],heading,altitude);
          points.forEach((p,i)=>{w.command(u.id,p,i>0,undefined,{keepTask:true});});
          w.setRouteLoop(u.id,true);
        }else{
          w.command(u.id,point,append,undefined,{keepTask:true});
          if(cmd==='attack_move'){try{if(u.radar&&u.radar.mode==='off')w.radarCommand(u.id,{operation:'mode',mode:'pd',targetId:null});}catch{}}
        }
      }
      const count=list.length>1?` · ${list.length} 架`:''; 
      const warnings=list.length&&w.threatWarnings?w.threatWarnings(list[0].waypoints??[]):[];
      message(`${commandModeLabel(cmd)}${cmd==='attack_move'?'（保持攻击任务与雷达）':''}${cmd==='patrol'?'（环行巡逻）':''}${count} · ${orderSummary(append,altitude)}${warnings.length?' · ⚠ 进入威胁区：'+warnings.join('、')+'（不自动避让）':''}`);
      setPreview(null);onChange();
    }catch(error){message(error.message||'航路不可执行',true);}
  }
  function returnToBase(w,u,altitude){
    try{
      w.airportCommand(u.id,{intent:'approach',runway:'09L',airportId:'BAY',taxiways:[],gate:null,altitudeM:altitude,mode:null});
      message('返场：已请求加入 BAY 机场 09L 进近');
      return;
    }catch(error){
      const airport=w.airportOps?.airport,center=airport?.center??[-18000,0],elevation=(airport?.elevation??0)+1500;
      try{
        w.command(u.id,[center[0],center[1],Math.max(altitude,elevation)],false,undefined,{keepTask:true});
        message('返场：机场暂未批准进近，先飞往机场空域');
      }catch(inner){message(inner.message||'返场失败',true);}
    }
  }
  const canvas=document.querySelector('#scene');
  canvas.addEventListener('pointermove',e=>{
    const w=getWorld(),u=unit();
    if(!w||!u||u.alive===false||u.surface?.grounded||isRouteEdit()||cmd==='rtb'){setPreview(null);return;}
    const altitude=targetAltitude(),point=worldPoint(e.clientX,e.clientY,altitude);
    if(!point){setPreview(null);return;}
    const distanceM=Math.hypot(point[0]-u.position[0],point[1]-u.position[1]);
    setPreview({from:[...u.position],to:point,kind:cmd,distanceM,speedMps:u.speed??u.targetSpeed??0,
      label:cmd==='patrol'?`巡逻区 · ${formatPreviewDistance(distanceM)}`:previewLabel(distanceM,u.speed??0,altitude)});
  });
  canvas.addEventListener('pointerleave',()=>setPreview(null));

  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  let leftStart=null,lastRightAt=0,lastContextAt=0;
  document.addEventListener('pointerdown',e=>{
    if(e.target!==canvas)return;
    if(e.button===0)leftStart=[e.clientX,e.clientY];
    else if(e.button===2)pointer=[e.clientX,e.clientY];
  },true);
  document.addEventListener('pointerup',e=>{
    if(e.target!==canvas)return;
    if(e.button===0){
      const start=leftStart;leftStart=null;
      if(!start||dist([e.clientX,e.clientY],start)>6)return; // 拖动=旋转视角
      if(isRouteEdit())return;
      if(pickUnit(e.clientX,e.clientY))return; // 点到飞机=选择，由主流程处理
      if(!unit())return;
      issue(e.clientX,e.clientY,false);
    }else if(e.button===2){
      if(performance.now()-lastContextAt<200)return;
      const start=pointer;pointer=null;
      if(!start||dist([e.clientX,e.clientY],start)>6)return; // 右键拖动=视角旋转
      if(isRouteEdit())return; // 航线设置模式交给航路编辑器
      lastRightAt=performance.now();
      issue(e.clientX,e.clientY,true);
    }
  },true);
  // 有些环境右键只发 contextmenu、不发 pointerup；用 contextmenu 兜底，且与 pointerup 去重。
  document.addEventListener('contextmenu',e=>{
    if(e.target!==canvas||isRouteEdit())return;
    e.preventDefault();
    if(performance.now()-lastRightAt<200)return;
    if(pointer&&dist([e.clientX,e.clientY],pointer)>6){pointer=null;return;}
    pointer=null;lastContextAt=performance.now();
    if(unit())issue(e.clientX,e.clientY,true);
  },true);
  paint();
  // 底栏会随通联记录变高：把点击飞行面板抬到它上方，避免两个界面叠在一起。
  function liftAboveRadio(){
    const radio=document.querySelector('#radio-console');
    const height=radio&&radio.offsetHeight>0?Math.min(280,Math.ceil(radio.getBoundingClientRect().height)):0;
    bar.style.bottom=`${74+height+(height?8:0)}px`;
    // 左侧单位/RWR 面板展开时，点击飞行面板让到面板右边，避免整块压住 RWR。
    const stage=document.querySelector('#stage');
    const aside=document.querySelector('#unit-panel')?.closest('aside');
    const asideRect=aside?.getBoundingClientRect();
    if(stage&&!stage.classList.contains('panels-hidden')&&asideRect&&asideRect.width>0)bar.style.left=`${Math.ceil(asideRect.right)+8}px`;
    else bar.style.left='16px';
  }
  return {update(){liftAboveRadio();paint();},setMode,getPreview(){return preview;}};
}
