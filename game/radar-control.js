import {radarView,RADAR_REASONS} from '../sim/radar.js';
import {basis,dot,cross,norm} from '../sim/flight.js';
import {formatDistance,formatSpeed,formatAltitude} from '../sim/units.js';

const phases={off:'关闭',unavailable:'无搜索雷达',standby:'地面待机',search:'扇区搜索',acquiring:'截获中',locked:'已锁定',coasting:'回波丢失 · 航迹外推'};
export function initRadarControl({getWorld,getSelected,onChange,beforeCommand=()=>{}}){
  const css=document.createElement('link');css.rel='stylesheet';css.href='./radar.css';document.head.append(css);
  const panel=document.createElement('details');panel.id='radar-control';panel.open=true;
  panel.innerHTML=`<summary>机载雷达</summary><div class="radar-head"><strong id="radar-phase">关闭</strong><span id="radar-gate">杂波门 ±80 m/s</span></div>
    <canvas id="radar-scope" width="600" height="380" aria-label="雷达方位距离显示"></canvas>
    <p id="radar-task-state" role="status">飞行员自主操作 · 等待搜索或跟踪任务</p>
    <label for="radar-contact">查看本机航迹<select id="radar-contact"><option value="">等待扫描回波</option></select></label>
    <output id="radar-track-data"></output><p id="radar-message" role="status"></p>
    <ol id="radar-operation-log" aria-label="飞行员雷达操作过程"></ol>
    <details class="radar-practice"><summary>雷达演练</summary><p>空中使用，生成前方匀速练习靶机；不赋予敌我判定或开火许可。</p><button id="radar-add-target">添加前方练习靶</button><div class="radar-actions"><button data-aspect="headon">靶机迎头</button><button data-aspect="crossing">靶机横切</button><button id="radar-clear-targets">清除练习靶</button></div></details>
    <p class="radar-help">只需下达“搜索前方空域”或“持续跟踪不明目标”。飞行员自主选择模式与截获对象；这里显示实际操作、回波与结果。灰色为外推航迹。</p>`;
  document.querySelector('#unit-panel').append(panel);
  const $=s=>panel.querySelector(s),contact=$('#radar-contact'),scope=$('#radar-scope');
  const button=document.createElement('button');button.id='radar-toggle';button.type='button';button.textContent='雷达';button.setAttribute('aria-controls','radar-control');
  document.querySelector('#panel-controls').append(button);button.onclick=()=>{if(document.querySelector('#stage').classList.contains('panels-hidden'))document.querySelector('#toggle-panels').click();panel.open=true;panel.scrollIntoView({block:'nearest'});};
  function operate(callback){try{beforeCommand();callback();$('#radar-message').textContent='';onChange();update();}catch(error){$('#radar-message').textContent=error.message;}}
  panel.addEventListener('click',e=>{
    const aspect=e.target.dataset.aspect;
    if(aspect)operate(()=>{const w=getWorld(),selected=w.units.find(u=>u.id===getSelected()),id=selected?.radar?.bindings?.[contact.value]||contact.value||w.radarTargets.filter(t=>t.alive!==false).at(-1)?.id;w.setRadarPracticeAspect(getSelected(),id,aspect);});
  });
  $('#radar-add-target').onclick=()=>operate(()=>getWorld().addRadarPracticeTarget(getSelected()));
  $('#radar-clear-targets').onclick=()=>operate(()=>{const w=getWorld();for(const t of w.radarTargets)t.alive=false;w.revision++;});
  let lastUnit=null,lastModelError=null;
  function update(){
    const w=getWorld(),own=w.units.find(u=>u.id===getSelected()),r=radarView(own,w.time);if(!r)return;
    if(lastUnit!==own){$('#radar-message').textContent='';lastUnit=own;}
    $('#radar-phase').textContent=(r.mode==='pd'?'PD · ':r.mode==='pulse'?'SRC · ':'')+(phases[r.phase]??r.phase)+(r.sensorModelVersion===2?` · 三维 ${r.scanPolicy.barCount}条 · ${r.scanFrameSec.toFixed(1)}秒/轮 · 俯仰${r.scanElevationDeg.toFixed(0)}°${r.coverageLimited?' · 部分覆盖':''}`:'');
    $('#radar-phase').dataset.phase=r.phase;$('#radar-gate').textContent=`杂波门 ±${formatSpeed(r.speedGateHalfWidthMps,{digits:0})}`;
    const task=own.radarTask; const attacking=own.attackTask?.active;
    $('#radar-task-state').textContent=attacking?'攻击任务 · 飞行员自主搜索与跟踪':task?.active?`${task.goal==='search'?'空域搜索':'持续跟踪'} · ${task.pending?'飞行员判断中':task.lastError?'等待重新判断':own.surface?.grounded?'地面待机，等待离地':r.phase==='locked'?'稳定跟踪':r.phase==='coasting'?'丢波后重新判断':r.phase==='standby'?'等待离地':'飞行员自主操作'}${task.targetRef?' · '+task.targetRef:''}`:'飞行员自主操作 · 等待搜索或跟踪任务';
    if(task?.lastError)$('#radar-message').textContent=task.lastError;
    else if(lastModelError&&$('#radar-message').textContent===lastModelError)$('#radar-message').textContent='';
    lastModelError=task?.lastError??null;
    const entries=r.events.slice(-5),log=$('#radar-operation-log'),logKey=JSON.stringify(entries);
    if(log.dataset.key!==logKey){log.dataset.key=logKey;log.replaceChildren(...entries.map(e=>{const li=document.createElement('li');li.textContent=`T+${e.time.toFixed(1)} ${e.text}`;return li;}));}
    const key=JSON.stringify([own.id,r.contacts.map(c=>[c.id,c.callsign])]);
    if(contact.dataset.key!==key){const previous=contact.value;contact.dataset.key=key;
      contact.replaceChildren(...r.contacts.map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.callsign+(c.classification==='friendly'?' · 友机':c.practice?' · 练习靶':' · 未识别');return o;}));
      if(!r.contacts.length){const o=document.createElement('option');o.value='';o.textContent='等待扫描回波';contact.append(o);}else if(r.contacts.some(c=>c.id===previous))contact.value=previous;
    }
    const selected=r.contacts.find(c=>c.id===(r.targetId??contact.value));
    $('#radar-track-data').textContent=selected?`${selected.callsign} · ${formatDistance(selected.rangeM,{digits:1})}\n闭合率 ${formatSpeed(selected.closureMps,{digits:0})} · 杂波速度差 ${formatSpeed(Math.abs(selected.clutterSeparationMps),{digits:0})}\n回波 ${selected.ageSec.toFixed(1)} 秒前${r.phase==='coasting'?` · 外推剩余 ${r.coastRemainingSec.toFixed(1)} 秒`:r.phase==='acquiring'?` · 截获 ${(r.acquireProgress*100).toFixed(0)}%`:''}${selected.uncertainty?'\n'+selected.state+' · 位置误差约 '+formatAltitude(Math.max(...selected.uncertainty.positionSigmaM),{digits:0})+' · 重访 '+Math.max(0,selected.expectedRevisitAt-w.time).toFixed(1)+' 秒':''}${r.lastReason?'\n'+(RADAR_REASONS[r.lastReason]??r.lastReason):''}`:r.lastReason?RADAR_REASONS[r.lastReason]??r.lastReason:'尚无雷达航迹';
    if(panel.open)draw(own,r);
  }
  function draw(own,r){
    const c=scope.getContext('2d'),width=scope.width,height=scope.height,left=70,right=width-18,top=30,bottom=height-40;
    c.clearRect(0,0,width,height);c.fillStyle='#061511';c.fillRect(0,0,width,height);c.font='22px Consolas,monospace';
    c.lineWidth=1;c.strokeStyle='#23483d';c.fillStyle='#83ad9c';
    const x=az=>left+(az+r.azimuthHalfDeg)/(2*r.azimuthHalfDeg)*(right-left),y=range=>bottom-range/r.rangeM*(bottom-top);
    for(let i=0;i<=4;i++){const yy=y(r.rangeM*i/4);c.beginPath();c.moveTo(left,yy);c.lineTo(right,yy);c.stroke();c.fillText(formatDistance(r.rangeM*i/4,{digits:0}),4,yy-4);}
    for(const az of [-60,-30,0,30,60]){c.beginPath();c.moveTo(x(az),top);c.lineTo(x(az),bottom);c.stroke();c.fillText(String(az)+'°',x(az)-15,height-7);}
    if(r.phase==='search'){c.strokeStyle='#71cfa0';c.beginPath();c.moveTo(x(r.scanAzimuthDeg),top);c.lineTo(x(r.scanAzimuthDeg),bottom);c.stroke();}
    const pose=basis(own),rightVector=norm(cross(pose.forward,pose.up));
    for(const t of r.contacts){
      const delta=t.predictedPosition.map((v,i)=>v-own.position[i]),range=Math.hypot(...delta),az=Math.atan2(dot(delta,rightVector),dot(delta,pose.forward))*180/Math.PI;
      if(Math.abs(az)>r.azimuthHalfDeg||range>r.rangeM)continue;
      const xx=x(az),yy=y(range),tracked=t.id===r.targetId;
      c.strokeStyle=(t.sensorModelVersion===2?t.state==='coasting':t.ageSec>.25)?'#8a9b96':tracked?'#ffc97d':t.classification==='friendly'?'#7cbdf1':'#9de8bb';c.lineWidth=tracked?3:2;c.strokeRect(xx-6,yy-6,12,12);
      if(tracked)c.strokeRect(xx-11,yy-11,22,22);c.fillStyle=c.strokeStyle;c.fillText(t.callsign,Math.min(right-110,xx+13),yy+4);
    }
    c.fillStyle='#b5d9c8';c.fillText(r.available?(phases[r.phase]??r.phase):'无搜索雷达',left+6,18);
  }
  contact.onchange=update;update();return {update};
}
