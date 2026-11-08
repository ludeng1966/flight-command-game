import {formatAltitude} from '../sim/units.js';
export function initAirportControl({getWorld,getSelected,onChange,onFocus,onSpawnMode,issueCommand}){
  const phases={parked:'机位停放',waiting_gate:'等待机位',taxi:'地面滑行',holding:'跑道外等待',lineup_taxi:'进入跑道',lined_up:'对正待命',takeoff_roll:'起飞滑跑',climb:'离地爬升',approach:'进近',final:'最后进近',rollout:'着陆减速',exit:'脱离跑道',rejected:'中断起飞',missed:'复飞',airborne:'空中巡航'};
  const panel=document.createElement('details');panel.id='airport-operations';panel.innerHTML='<summary>机场运行 · BAY</summary><p>海湾国际 · 双平行跑道 3600×45m</p><button data-act="focus">观察机场</button><label>跑道<select id="airport-runway"><option>09L</option><option>09R</option><option>27L</option><option>27R</option></select></label><label>指定滑行道（留空自动）<input id="airport-taxiways" placeholder="A,A1"></label><label>机位<select id="airport-gate">'+Array.from({length:6},(_,i)=>`<option>G${i+1}</option>`).join('')+'</select></label><button data-act="spawn">选中机地面出生</button><div class="airport-actions">'+[['taxi','滑行至等待点'],['hold_short','保持等待'],['line_up','进入跑道对正'],['takeoff','离场流程'],['abort_takeoff','中断起飞'],['approach','请求进近'],['land','许可着陆'],['go_around','复飞']].map(([id,name])=>`<button data-act="${id}">${name}</button>`).join('')+'</div><p id="airport-state" role="status"></p><ol id="airport-log"></ol>';
  document.querySelector('aside').append(panel);
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
  function update(){const w=getWorld(),u=w.units.find(u=>u.id===getSelected());panel.querySelector('#airport-state').textContent=`${u.callsign} · ${phases[u.surface?.phase]??'空中巡航'} · ${u.surface?.message??'机场待命'}`;const list=panel.querySelector('#airport-log'),entries=w.airportOps?.airport.events.slice(-6)??[],key=JSON.stringify(entries);if(list.dataset.key!==key){list.dataset.key=key;list.replaceChildren(...entries.map(v=>{const li=document.createElement('li');li.textContent=v.text;return li;}));}}
  const updateState=update;
  return {update(){panel.querySelector('p').textContent=`海湾国际 · 双平行跑道 ${formatAltitude(3600)} × ${formatAltitude(45)}`;updateState();}};
}
