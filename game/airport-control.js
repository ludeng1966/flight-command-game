import {formatAltitude} from '../sim/units.js';
import {airportBoardModel} from './airport-board-model.js';
export function initAirportControl({getWorld,getSelected,onChange,onFocus,onSpawnMode,issueCommand}){
  const phases={parked:'机位停放',waiting_gate:'等待机位',taxi:'地面滑行',holding:'跑道外等待',lineup_taxi:'进入跑道',lined_up:'对正待命',takeoff_roll:'起飞滑跑',climb:'离地爬升',approach:'进近',final:'最后进近',rollout:'着陆减速',exit:'脱离跑道',rejected:'中断起飞',missed:'复飞',airborne:'空中巡航'};
  const panel=document.createElement('details');panel.id='airport-operations';panel.innerHTML='<summary>机场调度 · BAY</summary><p>海湾国际 · 双平行跑道 3600×45m</p><button data-act="focus">观察机场</button><label>跑道<select id="airport-runway"><option>09L</option><option>09R</option><option>27L</option><option>27R</option></select></label><label>指定滑行道（留空自动）<input id="airport-taxiways" placeholder="A,A1"></label><label>机位<select id="airport-gate">'+Array.from({length:6},(_,i)=>`<option>G${i+1}</option>`).join('')+'</select></label><button data-act="spawn">选中机地面出生</button><div class="airport-actions">'+[['taxi','滑行至等待点'],['hold_short','保持等待'],['line_up','进入跑道对正'],['takeoff','离场流程'],['abort_takeoff','中断起飞'],['approach','请求进近'],['land','许可着陆'],['go_around','复飞']].map(([id,name])=>`<button data-act="${id}">${name}</button>`).join('')+'</div><p id="airport-state" role="status"></p><div id="airport-board" style="margin:6px 0;padding:6px;border:1px solid #2a4054;border-radius:8px;background:#08131d;font-size:11px;line-height:1.5"></div><ol id="airport-log"></ol>';
  document.querySelector('aside').append(panel);
  const boardButton=document.createElement('button');
  boardButton.id='airport-board-toggle';boardButton.type='button';boardButton.textContent='机场';boardButton.title='打开机场调度板';
  boardButton.addEventListener('click',()=>{document.querySelector('#stage')?.classList.remove('panels-hidden');document.querySelector('#toggle-panels')?.setAttribute('aria-pressed','true');panel.open=true;panel.scrollIntoView({block:'nearest'});});
  document.querySelector('#panel-controls')?.append(boardButton);
  panel.querySelector('summary').insertAdjacentHTML('afterend','<label>开局出生方式<select id="airport-spawn-mode"><option value="stands">机场机位</option><option value="airborne">空中巡航</option></select></label>');
  panel.querySelector('#airport-spawn-mode').value=getWorld().spawnMode;
  panel.querySelector('#airport-spawn-mode').onchange=e=>onSpawnMode(e.target.value);
  panel.addEventListener('click',e=>{const act=e.target.dataset.act;if(!act)return;const w=getWorld(),id=getSelected();
    try{if(act==='focus')onFocus(w.airportOps.airport);else if(act==='spawn')w.spawnAtStand(id,panel.querySelector('#airport-gate').value);else {
      const runway=panel.querySelector('#airport-runway').value,taxiways=panel.querySelector('#airport-taxiways').value.split(/[,，\s]+/).filter(Boolean);
      const action={taxi:`${taxiways.length?'沿'+taxiways.join('、'):''}滑行到${runway}跑道外等待`,hold_short:`在${runway}跑道外保持等待`,line_up:`进入${runway}跑道对正等待`,takeoff:`从${runway}跑道起飞`,abort_takeoff:'中断起飞',approach:`加入BAY机场${runway}进近`,land:`在BAY机场${runway}跑道降落`,go_around:'复飞'}[act];
      if(issueCommand){void issueCommand(`塔台，请安排${w.units.find(u=>u.id===id).callsign}${action}。`).catch(error=>{panel.querySelector('#airport-state').textContent=error.message;});return;}
      w.airportCommand(id,{intent:act,runway,taxiways,airportId:'BAY',gate:null,altitudeM:null,mode:null});
    }onChange();update();}
    catch(error){panel.querySelector('#airport-state').textContent=error.message;}
  });
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function renderBoard(w){
    const board=panel.querySelector('#airport-board');if(!board)return;const model=airportBoardModel(w);
    if(!model){board.innerHTML='<span style="color:#7f97a8">本局未配置机场</span>';return;}
    const key=JSON.stringify(model);if(board.dataset.key===key)return;board.dataset.key=key;
    const runwayRows=model.runways.map(r=>`<div style="display:flex;justify-content:space-between;gap:6px"><b style="color:${r.closed?'#f3a6a6':'#9de8bb'};font-weight:500">${esc(r.designator)}</b><span style="color:${r.owner?'#ffd38c':'#7f97a8'}">${r.closed?'关闭':r.owner?`占用 ${esc(r.owner)}`:'空闲'}${r.lastUseSec!=null?` · ${Math.round(r.lastUseSec)}s前`:''}</span></div>`).join('');
    const queueRows=model.queue.length?model.queue.slice(0,6).map(q=>`<div style="display:flex;justify-content:space-between;gap:6px"><span style="color:#cfe3f5">${esc(q.callsign)} · ${esc(q.kindLabel)}</span><span style="color:${q.status==='cleared'?'#9de8bb':q.status==='waiting'?'#ffd38c':'#7f97a8'}">${esc(q.status)}${q.runway?' '+esc(q.runway):''}</span></div>${q.reason?`<div style="color:#7f97a8;font-size:10px;padding-left:6px">${esc(q.reason)}</div>`:''}`).join(''):'<span style="color:#5f7b8e">无等待</span>';
    const clearanceRows=model.clearances.length?model.clearances.slice(0,6).map(c=>`<div style="display:flex;justify-content:space-between;gap:6px"><span>${esc(c.callsign)} · ${esc(c.typeLabel)}</span><span style="color:#9de8bb">${esc(c.status)}${c.runway?' '+esc(c.runway):''}</span></div>`).join(''):'<span style="color:#5f7b8e">无有效许可</span>';
    const standRows=model.stands.map(s=>`<div style="display:inline-block;margin:0 4px 4px 0;padding:1px 5px;border-radius:4px;background:${s.unitId?'#173326':'#101d28'};color:${s.unitId?'#9de8bb':'#7f97a8'}">${esc(s.id)} ${s.unitId?esc(s.callsign):'空'}</div>`).join('');
    board.innerHTML=`<div style="color:#9cdfb7;font-size:10px;letter-spacing:.12em;margin-bottom:3px">运行跑道</div>${runwayRows||'<span style="color:#5f7b8e">无</span>'}
      <div style="color:#9cdfb7;font-size:10px;letter-spacing:.12em;margin:5px 0 3px">放行队列</div>${queueRows}
      <div style="color:#9cdfb7;font-size:10px;letter-spacing:.12em;margin:5px 0 3px">有效许可</div>${clearanceRows}
      <div style="color:#9cdfb7;font-size:10px;letter-spacing:.12em;margin:5px 0 3px">机位 · 空闲 ${model.freeStands}</div>${standRows}
      ${model.weather?`<div style="color:#7f97a8;font-size:10px;margin-top:3px">QNH ${model.weather.qnhHpa??'—'}${model.weather.wind?` · 风 ${model.weather.wind.heading??'—'}°/${Math.round(model.weather.wind.speedMps??0)}m/s`:''}</div>`:''}`;
  }
  function update(){const w=getWorld(),u=w.units.find(u=>u.id===getSelected());renderBoard(w);panel.querySelector('#airport-state').textContent=`${u.callsign} · ${phases[u.surface?.phase]??'空中巡航'} · ${u.surface?.message??'机场待命'}`;const list=panel.querySelector('#airport-log'),entries=w.airportOps?.airport.events.slice(-6)??[],key=JSON.stringify(entries);if(list.dataset.key!==key){list.dataset.key=key;list.replaceChildren(...entries.map(v=>{const li=document.createElement('li');li.textContent=v.text;return li;}));}}
  const updateState=update;
  return {update(){panel.querySelector('p').textContent=`海湾国际 · 双平行跑道 ${formatAltitude(3600)} × ${formatAltitude(45)}`;updateState();}};
}
