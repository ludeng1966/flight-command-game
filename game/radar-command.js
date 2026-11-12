import {radarView,RADAR_REASONS,RADAR_MODES} from '../sim/radar.js';

const $ = (s) => document.querySelector(s);
const fmt = (m) => m >= 1000 ? `${(m / 1000).toFixed(0)} km` : `${m.toFixed(0)} m`;
const PHASES = {off:'关闭',silent:'电磁静默',warming:'预热中',standby:'地面待机',search:'扇区搜索',acquiring:'截获中',locked:'已锁定',coasting:'回波丢失 · 外推'};
const MODE_LABEL = {pd:'PD',pulse:'SRC'};

export function initRadarCommand({getWorld,getSelected,getSelectedIds=()=>[getSelected()],onChange=()=>{}}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='./radar-command.css';document.head.append(css);

  const bar=document.createElement('section');
  bar.id='radar-command';
  bar.innerHTML=`<div class="rc-mode-wrap"><button type="button" id="rc-mode" aria-haspopup="true" aria-expanded="false"><span class="rc-kicker">雷达</span><b id="rc-mode-label">关闭</b><small id="rc-mode-sub">点按切换 · 按住选模式</small></button><div id="rc-radial" role="menu" hidden></div></div>
    <button type="button" id="rc-lock">锁定 <kbd>E</kbd></button>
    <button type="button" id="rc-silence">静默</button>
    <button type="button" id="rc-iff" title="点击切换自动/手动/关闭；手动时按 I 问询">IFF 自动</button>
    <button type="button" id="rc-scope" aria-pressed="false">雷达屏 <kbd>B</kbd></button>
    <span id="rc-target" role="status">R 轮换目标</span>`;
  document.body.append(bar);
  const menu=document.createElement('section');
  menu.id='radar-scope-panel';menu.hidden=true;
  menu.innerHTML=`<header><b>雷达屏 · <span id="rc-scope-unit"></span></b><span id="rc-scope-mode"></span><button type="button" id="rc-scope-close" aria-label="收起雷达屏">×</button></header><canvas id="rc-scope-canvas" width="560" height="230" aria-label="雷达方位距离显示"></canvas><div id="rc-scope-controls"><button type="button" id="rc-scan-left" title="扫描中心左移 15°">◀ 扇区</button><button type="button" id="rc-scan-right" title="扫描中心右移 15°">扇区 ▶</button><button type="button" id="rc-scan-narrow" title="扫描扇区减半">窄</button><button type="button" id="rc-scan-up" title="扫描俯仰上移 10°">▲ 俯仰</button><button type="button" id="rc-scan-down" title="扫描俯仰下移 10°">▼ 俯仰</button><button type="button" id="rc-scan-wide" title="扫描扇区加倍">宽</button><button type="button" id="rc-range-cycle" title="切换显示距离档">60 km</button><button type="button" id="rc-tws" aria-pressed="false" title="多目标关注：Ctrl+单击航迹切换">多目标</button></div><p id="rc-scope-hint">单击选中 · 双击锁定 · Ctrl+单击多目标 · B 收起</p>`;
  document.body.append(menu);

  const modeBtn=$('#rc-mode'),radial=$('#rc-radial'),lockBtn=$('#rc-lock'),silenceBtn=$('#rc-silence'),iffBtn=$('#rc-iff'),scopeBtn=$('#rc-scope'),target=$('#rc-target'),scopePanel=$('#radar-scope-panel'),scopeCanvas=$('#rc-scope-canvas');
  // 快捷条本身有 transform，fixed 子元素会被它当作坐标系；把圆盘挂到 body 才按视口定位。
  document.body.append(radial);
  let scopeOpen=false,selectedContactId=null,twsOn=false,twsIds=new Set(),scopeRangeM=null,radialOpen=false,radialPointer=null,radialOrigin=null,radialPointerId=null,pressAt=0;
  const unit=()=>{const w=getWorld();return w?.units.find(u=>u.id===getSelected());};
  const units=()=>{const w=getWorld();return (getSelectedIds()??[getSelected()]).map(id=>w?.units.find(u=>u.id===id)).filter(u=>u&&u.alive!==false&&u.radar?.available);};
  const radar=()=>unit()?.radar??null;
  const fresh=(u=unit())=>{const r=u?.radar,w=getWorld();if(!r||!w)return[];return r.contacts.filter(c=>w.time-c.observedAt<=r.config.sweepSec+.25).sort((a,b)=>a.rangeM-b.rangeM);};
  const displayRange=()=>{const r=radar();return r?(scopeRangeM??r.config.rangeM):60000;};
  function applyAll(order,label){
    const list=units();if(!list.length)return;let ok=0,error='';
    for(const u of list){try{getWorld().radarCommand(u.id,order);ok++;}catch(e){error=e.message;}}
    onChange();
    if(ok>1)flash(`${label}：${ok} 架`);else if(ok===0&&error)flash(error);
  }
  function radarMode(mode){applyAll({operation:'mode',mode,targetId:null},mode==='off'?'关闭':mode==='pulse'?'SRC':'PD');selectedContactId=null;}
  function toggleSilence(){
    const list=units();if(!list.length)return;const next=!list[0].radar.silent;
    for(const u of list){try{getWorld().radarSilence(u.id,next);}catch(e){flash(e.message);}}
    selectedContactId=null;onChange();flash(next?'已进入电磁静默':'已解除电磁静默');
  }
  function cycleIff(){
    const list=units();if(!list.length)return;const order=['auto','manual','off'];
    const next=order[(order.indexOf(list[0].radar.iffMode??'auto')+1)%order.length];
    for(const u of list){try{getWorld().iffMode(u.id,next);}catch(e){flash(e.message);}}
    onChange();flash(`IFF：${next==='auto'?'自动问询':next==='manual'?'手动问询（按 I）':'关闭'}`);
  }
  function interrogate(){
    const u=unit();if(!u)return;
    if(u.radar.iffMode!=='manual'){flash('先切到手动问询（点 IFF）');return;}
    try{getWorld().iffInterrogate(u.id);flash('IFF 问询完成');onChange();}catch(e){flash(e.message);}
  }
  function cycleTarget(){const list=fresh();if(!list.length){selectedContactId=null;flash('本机没有新鲜雷达航迹');return;}const index=list.findIndex(c=>c.id===selectedContactId);const next=list[(index+1)%list.length];selectedContactId=next.id;onChange();flash(`已选中 ${next.callsign??next.id} · ${fmt(next.rangeM)}`);}
  function toggleLock(){
    const list=units();if(!list.length)return;let count=0;
    for(const u of list){
      const r=u.radar;
      if(r.targetId){try{getWorld().radarCommand(u.id,{operation:'unlock',mode:null,targetId:null});count++;}catch{}continue;}
      const contacts=fresh(u);if(!contacts.length)continue;
      const id=u.id===getSelected()&&selectedContactId&&contacts.some(c=>c.id===selectedContactId)?selectedContactId:contacts[0].id;
      try{getWorld().radarCommand(u.id,{operation:'lock',mode:null,targetId:id});count++;}catch(e){flash(e.message);}
    }
    if(count)onChange();
  }
  function flash(text){target.textContent=text;target.dataset.error='true';clearTimeout(flash.timer);flash.timer=setTimeout(()=>{target.dataset.error='false';update();},2600);}

  // 圆盘：按住展开 → 移动方向 → 松开选择；快速点按 = 切换 PD/SRC。
  const items=[{key:'pd',label:'PD 搜索',hint:'脉冲多普勒'},{key:'pulse',label:'SRC 脉冲',hint:'脉冲搜索'},{key:'silent',label:'电磁静默',hint:'关雷达+断通信'},{key:'off',label:'关闭雷达',hint:'不再辐射'}];
  let activeIndex=0;
  function openRadial(){
    radialOpen=true;modeBtn.setAttribute('aria-expanded','true');
    const rect=modeBtn.getBoundingClientRect();
    radial.hidden=false;radial.style.left=`${rect.left+rect.width/2}px`;radial.style.top=`${rect.top}px`;
    radial.innerHTML=items.map((item,i)=>`<button type="button" role="menuitem" data-index="${i}"><b>${item.label}</b><small>${item.hint}</small></button>`).join('');
    activeIndex=-1; // 长按刚打开时停在中心，不预选任何方向
    radial.dataset.center='true';
    highlightRadial();
  }
  function closeRadial(){radialOpen=false;radial.hidden=true;modeBtn.setAttribute('aria-expanded','false');}
  function highlightRadial(){radial.dataset.center=String(activeIndex<0);[...radial.querySelectorAll('button')].forEach((b,i)=>b.classList.toggle('active',i===activeIndex));}
  function chooseRadial(item){closeRadial();if(item.key==='silent')toggleSilence();else radarMode(item.key==='off'?'off':item.key);}
  function radialFromPointer(x,y){
    if(!radialOrigin)return -1;
    const dx=x-radialOrigin.x,dy=y-radialOrigin.y;
    if(Math.hypot(dx,dy)<18)return -1; // 原地点击不选方向，交给“点按切换”
    // 上=PD，右=SRC，下=静默，左=关闭；方向以按下点为原点
    const angle=Math.atan2(dx,-dy);return ((Math.round(angle/(Math.PI/2))+4)%4);
  }
  modeBtn.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();pressAt=performance.now();radialOrigin={x:e.clientX,y:e.clientY};radialPointer={x:e.clientX,y:e.clientY};radialPointerId=e.pointerId;openRadial();});
  // 拖出按钮后 pointerup 不一定回到按钮：拖动/松手统一挂在 window 上。
  const radialEnd=e=>{
    if(!radialOpen||(radialPointerId!==null&&e.pointerId!==radialPointerId))return;
    radialPointer=null;radialPointerId=null;
    const i=radialFromPointer(e.clientX,e.clientY);radialOrigin=null;closeRadial();
    if(i>=0){chooseRadial(items[i]);return;}
    if(performance.now()-pressAt<350){const r=radar();if(!r)return;if(r.mode==='off'||r.silent)radarMode('pd');else if(r.mode==='pd')radarMode('pulse');else if(r.mode==='pulse')radarMode('pd');}
  };
  window.addEventListener('pointermove',e=>{if(!radialOpen||(radialPointerId!==null&&e.pointerId!==radialPointerId))return;radialPointer={x:e.clientX,y:e.clientY};const i=radialFromPointer(e.clientX,e.clientY);if(i!==activeIndex){activeIndex=i;highlightRadial();}});
  window.addEventListener('pointerup',radialEnd);
  window.addEventListener('pointercancel',()=>{if(!radialOpen)return;radialOpen=false;radialPointer=null;radialPointerId=null;radialOrigin=null;radial.hidden=true;modeBtn.setAttribute('aria-expanded','false');});

  lockBtn.addEventListener('click',toggleLock);
  silenceBtn.addEventListener('click',toggleSilence);
  iffBtn.addEventListener('click',cycleIff);
  scopeBtn.addEventListener('click',()=>{scopeOpen=!scopeOpen;scopePanel.hidden=!scopeOpen;scopeBtn.setAttribute('aria-pressed',String(scopeOpen));if(scopeOpen)draw();});
  $('#rc-scope-close').addEventListener('click',()=>{scopeOpen=false;scopePanel.hidden=true;scopeBtn.setAttribute('aria-pressed','false');});
  function manualScan(delta,halfWidthDeg){
    const u=unit(),r=radar();if(!u||!r)return;
    const half=halfWidthDeg??r.scanHalfDeg??r.config.azimuthHalfDeg,center=(r.scanCenterDeg??0)+delta;
    try{getWorld().radarScanCommand(u.id,{centerDeg:center,halfWidthDeg:half,elevationCenterDeg:(r.scanElevationCenterDeg??0)+(delta===0?0:0)});onChange();}catch(e){flash(e.message);}
    update();draw();
  }
  $('#rc-scan-left').onclick=()=>manualScan(-15);
  $('#rc-scan-right').onclick=()=>manualScan(15);
  $('#rc-scan-narrow').onclick=()=>{const r=radar();if(r)manualScan(0,Math.max(r.config.beamHalfDeg*2,(r.scanHalfDeg??r.config.azimuthHalfDeg)/2));};
  $('#rc-scan-wide').onclick=()=>{const r=radar();if(r)manualScan(0,Math.min(r.config.azimuthHalfDeg,(r.scanHalfDeg??r.config.azimuthHalfDeg)*2));};
  const elevationScan=(delta)=>{const u=unit(),r=radar();if(!u||!r)return;try{const maxEl=r.config.elevationHalfDeg,desired=(r.scanElevationCenterDeg??0)+delta,half=Math.max(r.config.beamHalfDeg*2,Math.min(r.scanElevationHalfDeg??maxEl,maxEl-Math.abs(desired)));getWorld().radarScanCommand(u.id,{centerDeg:r.scanCenterDeg??0,halfWidthDeg:r.scanHalfDeg??r.config.azimuthHalfDeg,elevationCenterDeg:desired,elevationHalfWidthDeg:half});onChange();}catch(e){flash(e.message);}update();draw();};
  $('#rc-scan-up').onclick=()=>elevationScan(10);
  $('#rc-scan-down').onclick=()=>elevationScan(-10);
  $('#rc-range-cycle').onclick=()=>{const r=radar();if(!r)return;const presets=[30000,60000,90000,120000],current=displayRange();let next=presets.find(v=>v>current);if(!next)next=presets[0];scopeRangeM=next;update();draw();};
  $('#rc-tws').onclick=()=>{const u=unit();twsOn=!twsOn;if(!twsOn){try{getWorld().setRadarTws(u.id,[]);onChange();}catch(error){flash(error.message);}}$('#rc-tws').setAttribute('aria-pressed',String(twsOn));update();draw();};

  scopeCanvas.addEventListener('click',e=>{const hit=hitContact(e);if(!hit)return;if(e.ctrlKey||e.metaKey){
    const u=unit(),w=getWorld(),view=radarView(u,w.time),next=new Set(view?.twsTrackedIds??[]);
    if(next.has(hit.id))next.delete(hit.id);else next.add(hit.id);
    try{getWorld().setRadarTws(u.id,[...next]);twsOn=true;onChange();}catch(error){flash(error.message);}
    update();draw();return;}selectedContactId=hit.id;update();draw();});
  scopeCanvas.addEventListener('dblclick',e=>{const hit=hitContact(e);if(hit){selectedContactId=hit.id;toggleLock();draw();}});
  scopeCanvas.addEventListener('mousemove',e=>{const u=unit(),r=radar();if(!u||!r)return;const rect=scopeCanvas.getBoundingClientRect(),x=(e.clientX-rect.left)*(scopeCanvas.width/rect.width),y=(e.clientY-rect.top)*(scopeCanvas.height/rect.height);const left=64,right=scopeCanvas.width-16,top=18,bottom=scopeCanvas.height-34,display=displayRange();const az=((x-left)/(right-left))*2*r.config.azimuthHalfDeg-r.config.azimuthHalfDeg,range=((bottom-y)/(bottom-top))*display;const hit=hitContact(e);$('#rc-scope-hint').textContent=hit?`${hit.callsign??hit.id} · ${Math.round(hit.azimuthDeg)}° / ${fmt(hit.rangeM)} · 单击选中 · 双击锁定`:`光标 ${az.toFixed(0)}° / ${fmt(Math.max(0,range))} · 单击选中 · 双击锁定`;});
  function hitContact(e){
    const r=radar(),w=getWorld();if(!r)return null;
    const rect=scopeCanvas.getBoundingClientRect(),x=(e.clientX-rect.left)*(scopeCanvas.width/rect.width),y=(e.clientY-rect.top)*(scopeCanvas.height/rect.height);
    let best=null,bestD=18;
    for(const c of radarView(unit(),w.time)?.contacts??[]){const p=plotPoint(c);if(!p)continue;const d=Math.hypot(p.x-x,p.y-y);if(d<bestD){best=c;bestD=d;}}
    return best;
  }

  document.addEventListener('keydown',e=>{
    if(e.repeat||e.ctrlKey||e.altKey||e.metaKey)return;
    const el=e.target;if(el?.matches?.('input,textarea,select,[contenteditable="true"]'))return;
    if(e.code==='KeyR'){e.preventDefault();cycleTarget();}
    else if(e.code==='KeyE'){e.preventDefault();toggleLock();}
    else if(e.code==='KeyB'){e.preventDefault();scopeBtn.click();}
    else if(e.code==='KeyI'){e.preventDefault();interrogate();}
  });

  function plotPoint(c){
    const u=unit(),r=radar();if(!u||!r)return null;
    // 直接用雷达自己的相对方位/距离，保证 B 显与雷达扇区一致
    const az=c.azimuthDeg;
    const display=displayRange();
    if(!Number.isFinite(az)||Math.abs(az)>r.config.azimuthHalfDeg||c.rangeM>display)return null;
    const left=64,right=scopeCanvas.width-16,top=18,bottom=scopeCanvas.height-34;
    return {x:left+(az+r.config.azimuthHalfDeg)/(2*r.config.azimuthHalfDeg)*(right-left),y:bottom-Math.min(1,c.rangeM/display)*(bottom-top)};
  }
  function draw(){
    if(!scopeOpen)return;
    const w=getWorld(),u=unit(),r=radar();if(!w||!u||!r)return;
    const ctx=scopeCanvas.getContext('2d'),W=scopeCanvas.width,H=scopeCanvas.height,left=64,right=W-16,top=18,bottom=H-34;
    ctx.clearRect(0,0,W,H);ctx.fillStyle='#061511';ctx.fillRect(0,0,W,H);ctx.font='13px Consolas,monospace';
    ctx.strokeStyle='#23483d';ctx.fillStyle='#83ad9c';ctx.lineWidth=1;
    const display=displayRange();
    for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(fmt(display*i/4),4,y-4);}
    const viewForScan=radarView(u,w.time),scanCenter=viewForScan?.scanCenterDeg??0,scanHalf=viewForScan?.scanHalfDeg??r.config.azimuthHalfDeg;
    const xAt=az=>left+(az+r.config.azimuthHalfDeg)/(2*r.config.azimuthHalfDeg)*(right-left);
    const wedge=[];
    for(let i=0;i<=20;i++){const az=scanCenter-scanHalf+2*scanHalf*i/20;wedge.push({x:xAt(az),y:top});}
    ctx.fillStyle='rgba(113,207,160,.07)';ctx.strokeStyle='rgba(113,207,160,.45)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(xAt(scanCenter),bottom);for(const p of wedge)ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();
    ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(xAt(scanCenter-scanHalf),bottom);ctx.lineTo(xAt(scanCenter-scanHalf),top);ctx.moveTo(xAt(scanCenter+scanHalf),bottom);ctx.lineTo(xAt(scanCenter+scanHalf),top);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#8aa79a';ctx.font='10px Consolas,monospace';ctx.fillText(`SCAN ${Math.round(scanCenter-scanHalf)}°~${Math.round(scanCenter+scanHalf)}°`,xAt(scanCenter-scanHalf)+3,top+11);

    for(const az of [-60,-30,0,30,60]){const x=left+(az+r.config.azimuthHalfDeg)/(2*r.config.azimuthHalfDeg)*(right-left);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.fillText(`${az}°`,x-14,H-8);}
    if((r.phase==='search'||r.phase==='warming')&&r.config.scanType!=='aesa'){const view=radarView(u,w.time),az=r.phase==='search'?(view?.scanAzimuthDeg??0):0;const x=left+(az+r.config.azimuthHalfDeg)/(2*r.config.azimuthHalfDeg)*(right-left);ctx.strokeStyle=r.phase==='warming'?'#5f8f7d':'#71cfa0';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.fillText('SCAN',x+3,top+12);}
    for(const c of r.contacts){const p=plotPoint(c);if(!p)continue;const sel=c.id===selectedContactId,tracked=c.id===r.targetId,tws=twsOn&&twsIds.has(c.id);ctx.strokeStyle=tracked?'#ffc97d':sel?'#9de8bb':tws?'#8fc2ff':'#8a9b96';ctx.lineWidth=tracked||sel?2.5:1.5;ctx.strokeRect(p.x-5,p.y-5,10,10);if(tracked)ctx.strokeRect(p.x-9,p.y-9,18,18);if(tws){ctx.setLineDash([3,3]);ctx.strokeRect(p.x-8,p.y-8,16,16);ctx.setLineDash([]);}ctx.fillStyle=ctx.strokeStyle;ctx.fillText(c.callsign??c.id,p.x+8,p.y+4);if(tws)ctx.fillText('TWS',p.x+8,p.y+16);}
    ctx.fillStyle='#b5d9c8';ctx.fillText(PHASES[r.phase]??r.phase,left+4,14);
  }

  function update(){
    const w=getWorld(),u=unit(),r=radar();
    if(!w||!u||!r){bar.hidden=true;return;}
    bar.hidden=false;
    const mode=r.mode==='off'?(r.silent?'静默':'关闭'):(MODE_LABEL[r.mode]??r.mode.toUpperCase());
    $('#rc-mode-label').textContent=`${mode} · ${PHASES[r.phase]??r.phase}`;
    $('#rc-mode-sub').textContent=r.phase==='warming'?`预热 ${(r.warmingSec??0).toFixed(1)} 秒`:'点按切换 · 按住选模式';
    lockBtn.textContent=r.targetId?'解锁 E':'锁定 E';
    lockBtn.dataset.active=String(!!r.targetId);
    silenceBtn.dataset.active=String(r.silent===true);
    silenceBtn.textContent=r.silent?'解除静默':'静默';
    iffBtn.textContent=`IFF ${r.iffMode==='manual'?'手动':r.iffMode==='off'?'关闭':'自动'}`;
    const list=fresh();if(selectedContactId&&!list.some(c=>c.id===selectedContactId))selectedContactId=null;
    const selected=list.find(c=>c.id===selectedContactId)??list.find(c=>c.id===r.targetId);
    target.dataset.error='false';
    const selectedUnits=units().length;
    target.textContent=selected?`${selectedUnits>1?selectedUnits+' 架 · ':''}目标 ${selected.callsign??selected.id} · ${fmt(selected.rangeM)} · R 轮换`:`${selectedUnits>1?selectedUnits+' 架 · ':''}${list.length?list.length+' 条航迹 · R 轮换目标':'R 轮换目标'}`;
    $('#rc-scope-unit').textContent=u.callsign??u.id;
    $('#rc-scope-mode').textContent=`${mode} · ${PHASES[r.phase]??r.phase}`;
    const view=radarView(u,w.time);
    twsIds=new Set(view?.twsTrackedIds??[]);if(twsIds.size)twsOn=true;
    $('#rc-range-cycle').textContent=fmt(displayRange());
    $('#rc-tws').setAttribute('aria-pressed',String(twsOn));
    $('#rc-scope-hint').textContent=`扇区 ${(view?.scanCenterDeg??0).toFixed(0)}°±${(view?.scanHalfDeg??r.config.azimuthHalfDeg).toFixed(0)}° · 俯仰 ${(view?.scanElevationCenterDeg??0).toFixed(0)}°±${(view?.scanElevationHalfDeg??r.config.elevationHalfDeg).toFixed(0)}° · Ctrl+单击多目标${twsIds.size?` · TWS ${twsIds.size}`:''}`;
    draw();
  }
  function getRadarFocus(){
    const u=unit(),r=radar();if(!u||!r)return null;
    return {unitId:u.id,selectedContactId,targetId:r.targetId};
  }
  update();
  return {update,getRadarFocus};
}
