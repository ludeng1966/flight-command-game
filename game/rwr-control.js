import {rwrContext} from '../sim/rwr.js';
import {configureDefense} from '../sim/rwr-defense.js';
import {rwrDisplayContacts} from '../sim/rwr-display.js';
import {assessThreats} from '../sim/threat-assessment.js';
export function initRwrControl({getWorld,getSelected,onChange,beforeCommand=()=>{}}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='./rwr.css';document.head.append(css);
  const panel=document.createElement('details');panel.id='rwr-control';panel.open=true;
  panel.innerHTML=`<summary>雷达告警接收器 · RWR</summary><div class="rwr-head"><strong id="rwr-state" role="status">暂无告警</strong><span>被动接收</span></div>
    <canvas id="rwr-scope" width="360" height="260" aria-label="雷达告警方位，圆环不代表距离"></canvas>
    <p class="rwr-legend">搜：搜索辐射 · 锁：跟踪 / 疑似锁定 · 弹：发射级信号</p>
    <output id="rwr-contacts"></output><p id="rwr-action" role="status"></p>
    <label>告警处置<select id="rwr-policy"><option value="auto">威胁下立即自主规避</option><option value="report_only">只报告，按玩家指令飞行</option></select></label>
    <p>规避与明确的飞行指令冲突时，优先执行指令。</p>
    <p id="rwr-message" role="status"></p><details class="rwr-practice"><summary>告警演练</summary><p>生成持续120秒的定向辐射源，不产生导弹。用于检查告警与立即规避流程。</p><div class="rwr-buttons"><button data-rwr-practice="search">搜索辐射</button><button data-rwr-practice="track">跟踪照射</button><button data-rwr-practice="illumination">发射照射</button><button data-rwr-practice="active">主动导引头</button><button id="rwr-clear">清除演练源</button></div></details>
    <p class="rwr-help">方位弧线与圆环都不代表距离。跟踪信号只说明收到持续照射，不能确认敌机正在锁定谁；航迹关联是推测。信号消失后逐渐淡出，不代表威胁解除。被动红外弹不触发RWR发射告警。</p>`;
  document.querySelector('#unit-panel').append(panel);const $=s=>panel.querySelector(s);
  const button=document.createElement('button');button.id='rwr-toggle';button.type='button';button.textContent='告警';button.setAttribute('aria-controls','rwr-control');document.querySelector('#panel-controls').append(button);
  button.onclick=()=>{if(document.querySelector('#stage').classList.contains('panels-hidden'))document.querySelector('#toggle-panels').click();panel.open=true;panel.parentElement.scrollTop=panel.offsetTop-panel.parentElement.offsetTop;panel.querySelector('summary').focus({preventScroll:true});};
  const unit=()=>getWorld().units.find(u=>u.id===getSelected());
  function operate(callback){try{beforeCommand();callback();$('#rwr-message').textContent='';onChange();update();}catch(e){$('#rwr-message').textContent=e.message;}}
  const configure=()=>operate(()=>configureDefense(getWorld(),unit(),{mode:$('#rwr-policy').value}));
  $('#rwr-policy').onchange=configure;
  panel.addEventListener('click',e=>{if(e.target.dataset.rwrPractice)operate(()=>getWorld().addRwrPracticeEmitter(getSelected(),e.target.dataset.rwrPractice));});
  $('#rwr-clear').onclick=()=>operate(()=>{const w=getWorld();w.rwrPracticeEmitters=w.rwrPracticeEmitters.filter(e=>e.ownerId!==getSelected());w.revision++;});
  function update(){
    const w=getWorld(),u=unit(),r=rwrContext(u,w.time),d=u.rwrDefense;if(!r||!d)return;
    const contacts=rwrDisplayContacts(u,w.time,assessThreats(u,w.time)),c=contacts[0];
    $('#rwr-state').textContent=!r.available?'本机无RWR':!r.enabled?'RWR已关闭':c?`${c.memory?'信号记忆 · ':''}${c.label}`:'暂无雷达告警';$('#rwr-state').dataset.level=c?.level??'clear';
    button.dataset.level=c?.level??'clear';button.dataset.memory=String(c?.memory??false);button.title=c?`${c.label} · 约${c.clock}点钟 · ${c.stateText}`:'查看雷达告警方位与信号记忆';
    $('#rwr-contacts').textContent=contacts.length?contacts.map(c=>`${c.id} · ${c.label}\n${c.sourceModelLabel}\n约${c.clock}点钟 / 方位${c.bearingDeg}° · ${c.ageSec.toFixed(1)}秒前 · ${c.stateText}\n${c.associationText}\n${c.meaning}`).join('\n\n'):'没有接收到可识别的辐射信号；这不代表周围没有威胁';
    const policy=$('#rwr-policy');if(document.activeElement!==policy)policy.value=d.mode;policy.disabled=!r.available;
    const e=d.episode;
    $('#rwr-action').textContent=d.active?`${d.active.manual?'执行玩家指令':'自主自卫'} · ${d.active.maneuver==='notch'?'横切规避':'背向脱离'} · 原任务保留`:d.mode==='report_only'?'只报告，不自主改变航路':e?.playerOverride?'规避与明确飞行指令冲突，优先执行指令':e&&c&&c.ageSec<.35?'威胁下立即自主规避':'保持原任务，等待有效告警';
    if(panel.open)draw(u,contacts);
  }
  function draw(u,contacts){
    const canvas=$('#rwr-scope'),ctx=canvas.getContext('2d'),cx=180,cy=126,radius=99;
    ctx.clearRect(0,0,360,260);ctx.fillStyle='#061511';ctx.fillRect(0,0,360,260);ctx.strokeStyle='#29473b';ctx.lineWidth=1;
    for(const k of [.45,.75,1]){ctx.beginPath();ctx.arc(cx,cy,radius*k,0,Math.PI*2);ctx.stroke();}
    ctx.font='13px Consolas,monospace';ctx.fillStyle='#8aa79a';for(const [t,x,y]of [['12',cx-8,15],['3',cx+110,cy+5],['6',cx-4,246],['9',cx-118,cy+5]])ctx.fillText(t,x,y);
    ctx.fillStyle='#b9d9c8';ctx.beginPath();ctx.moveTo(cx,cy-8);ctx.lineTo(cx-5,cy+6);ctx.lineTo(cx+5,cy+6);ctx.closePath();ctx.fill();
    const heading=Math.atan2(u.velocity[0],u.velocity[1]);
    for(const c of contacts){const a=c.bearingDeg*Math.PI/180-heading,r=radius*.8,x=cx+Math.sin(a)*r,y=cy-Math.cos(a)*r;
      ctx.globalAlpha=c.opacity;ctx.fillStyle=c.color;ctx.strokeStyle=c.color;
      ctx.beginPath();ctx.arc(cx,cy,r,a-Math.PI/2-Math.PI/24,a-Math.PI/2+Math.PI/24);ctx.stroke();
      ctx.beginPath();ctx.arc(x,y,c.level==='launch'?6:4,0,Math.PI*2);c.memory?ctx.stroke():ctx.fill();
      ctx.fillText(({search:'搜',track:'锁',launch:'弹'})[c.level]+' '+c.id,Math.max(6,Math.min(265,x+8)),y-7);
    }
    ctx.globalAlpha=1;
  }
  update();return {update};
}
