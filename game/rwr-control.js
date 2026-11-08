import {RWR_LABELS,rwrContext,bearingClock,RWR_LEVELS} from '../sim/rwr.js';
import {configureDefense} from '../sim/rwr-defense.js';
export function initRwrControl({getWorld,getSelected,onChange,beforeCommand=()=>{}}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='./rwr.css';document.head.append(css);
  const panel=document.createElement('details');panel.id='rwr-control';panel.open=true;
  panel.innerHTML=`<summary>雷达告警接收器 · RWR</summary><div class="rwr-head"><strong id="rwr-state" role="status">暂无告警</strong><span>被动接收</span></div>
    <canvas id="rwr-scope" width="360" height="260" aria-label="雷达告警方位，圆环不代表距离"></canvas>
    <output id="rwr-contacts"></output><p id="rwr-action" role="status"></p>
    <label>告警处置<select id="rwr-policy"><option value="auto">先报告，等待后自主规避</option><option value="report_only">只报告，按玩家指令飞行</option></select></label>
    <div class="rwr-delays"><label>持续跟踪等待<input id="rwr-lock-delay" type="number" min="1" max="30" step="1" value="8"> 秒</label><label>发射告警等待<input id="rwr-launch-delay" type="number" min="1" max="30" step="1" value="4"> 秒</label></div>
    <p id="rwr-message" role="status"></p><details class="rwr-practice"><summary>告警演练</summary><p>生成持续120秒的定向辐射源，不产生导弹。用于检查告警、等待和规避流程。</p><div class="rwr-buttons"><button data-rwr-practice="search">搜索辐射</button><button data-rwr-practice="track">跟踪照射</button><button data-rwr-practice="illumination">发射照射</button><button data-rwr-practice="active">主动导引头</button><button id="rwr-clear">清除演练源</button></div></details>
    <p class="rwr-help">只显示近似辐射方位与告警等级，没有距离或命中倒计时。被动红外弹不触发RWR发射告警。玩家新指令优先；静音不影响接收与规避。</p>`;
  document.querySelector('#unit-panel').append(panel);const $=s=>panel.querySelector(s);
  const button=document.createElement('button');button.id='rwr-toggle';button.type='button';button.textContent='告警';button.setAttribute('aria-controls','rwr-control');document.querySelector('#panel-controls').append(button);
  button.onclick=()=>{if(document.querySelector('#stage').classList.contains('panels-hidden'))document.querySelector('#toggle-panels').click();panel.open=true;panel.parentElement.scrollTop=panel.offsetTop-panel.parentElement.offsetTop;panel.querySelector('summary').focus({preventScroll:true});};
  const unit=()=>getWorld().units.find(u=>u.id===getSelected());
  function operate(callback){try{beforeCommand();callback();$('#rwr-message').textContent='';onChange();update();}catch(e){$('#rwr-message').textContent=e.message;}}
  const configure=()=>operate(()=>configureDefense(getWorld(),unit(),{mode:$('#rwr-policy').value,lockDelaySec:Number($('#rwr-lock-delay').value),launchDelaySec:Number($('#rwr-launch-delay').value)}));
  for(const id of ['#rwr-policy','#rwr-lock-delay','#rwr-launch-delay'])$(id).onchange=configure;
  panel.addEventListener('click',e=>{if(e.target.dataset.rwrPractice)operate(()=>getWorld().addRwrPracticeEmitter(getSelected(),e.target.dataset.rwrPractice));});
  $('#rwr-clear').onclick=()=>operate(()=>{const w=getWorld();w.rwrPracticeEmitters=w.rwrPracticeEmitters.filter(e=>e.ownerId!==getSelected());w.revision++;});
  function update(){
    const w=getWorld(),u=unit(),r=rwrContext(u,w.time),d=u.rwrDefense;if(!r||!d)return;
    const contacts=r.contacts.slice().sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level]),c=contacts[0];
    $('#rwr-state').textContent=!r.available?'本机无RWR':c?RWR_LABELS[c.level]:'暂无雷达告警';$('#rwr-state').dataset.level=c?.level??'clear';
    $('#rwr-contacts').textContent=contacts.length?contacts.map(c=>`${c.id} · 约${bearingClock(u,c.bearingDeg)}点钟 · ${RWR_LABELS[c.level]} · ${c.ageSec.toFixed(1)}秒前`).join('\n'):'没有接收到可识别的辐射信号';
    for(const [selector,value]of [['#rwr-policy',d.mode],['#rwr-lock-delay',d.lockDelaySec],['#rwr-launch-delay',d.launchDelaySec]]){const el=$(selector);if(document.activeElement!==el)el.value=value;el.disabled=!r.available;}
    const e=d.episode;
    $('#rwr-action').textContent=d.active?`${d.active.manual?'执行玩家指令':'自主自卫'} · ${d.active.maneuver==='notch'?'横切规避':'背向脱离'} · 原任务保留`:d.mode==='report_only'?'只报告，不自主改变航路':e?.playerOverride?'玩家已接管本次告警处置，继续执行玩家任务':e&&c&&c.ageSec<.35?`自主规避等待 ${Math.max(0,e.autoAt-w.time).toFixed(1)} 秒${d.suspended?' · 正在接收玩家指令':''}`:'保持原任务，等待有效告警';
    if(panel.open)draw(u,contacts);
  }
  function draw(u,contacts){
    const canvas=$('#rwr-scope'),ctx=canvas.getContext('2d'),cx=180,cy=126,radius=99;
    ctx.clearRect(0,0,360,260);ctx.fillStyle='#061511';ctx.fillRect(0,0,360,260);ctx.strokeStyle='#29473b';ctx.lineWidth=1;
    for(const k of [.45,.75,1]){ctx.beginPath();ctx.arc(cx,cy,radius*k,0,Math.PI*2);ctx.stroke();}
    ctx.font='13px Consolas,monospace';ctx.fillStyle='#8aa79a';for(const [t,x,y]of [['12',cx-8,15],['3',cx+110,cy+5],['6',cx-4,246],['9',cx-118,cy+5]])ctx.fillText(t,x,y);
    ctx.fillStyle='#b9d9c8';ctx.beginPath();ctx.moveTo(cx,cy-8);ctx.lineTo(cx-5,cy+6);ctx.lineTo(cx+5,cy+6);ctx.closePath();ctx.fill();
    const heading=Math.atan2(u.velocity[0],u.velocity[1]);
    for(const c of contacts){const a=c.bearingDeg*Math.PI/180-heading,r=radius*({search:.88,track:.65,launch:.43})[c.level],x=cx+Math.sin(a)*r,y=cy-Math.cos(a)*r;
      ctx.fillStyle=({search:'#8aa79a',track:'#ffd38c',launch:'#efb68d'})[c.level];ctx.strokeStyle=ctx.fillStyle;ctx.beginPath();ctx.arc(x,y,c.level==='launch'?6:4,0,Math.PI*2);ctx.fill();
      if(c.level!=='search'){ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(x,y);ctx.stroke();ctx.setLineDash([]);}ctx.fillText(c.id,Math.max(6,Math.min(300,x+8)),y-7);
    }
  }
  update();return {update};
}
