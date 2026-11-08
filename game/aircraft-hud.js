import {aircraftPortraits} from '../three3d/aircraft-portrait.js';
import {AIRCRAFT_MODELS,aircraftModelId} from '../three3d/aircraft-catalog.js';
import {selectedAircraftStatus} from '../sim/unit-status.js';
import {groundStatusReport} from '../sim/ground-radio.js';
import {formatAltitude,formatSpeed,formatMach} from '../sim/units.js';
import {escapeHTML as esc} from './training-store.js';
export function initAircraftHud({getWorld,getSelected,onSelect}){
  const stage=document.querySelector('#stage'),rail=document.createElement('nav');rail.id='aircraft-rail';rail.setAttribute('aria-label','编队飞机选择');
  rail.innerHTML='<span class="aircraft-rail-title">编队</span>';
  const buttons=new Map(),units=getWorld().units;
  for(const [index,unit]of units.entries()){
    const button=document.createElement('button');button.id='aircraft-select-'+unit.id;button.className='aircraft-choice';button.type='button';button.style.setProperty('--aircraft-color',unit.color);button.setAttribute('aria-label','选择 '+unit.callsign);button.setAttribute('aria-pressed','false');button.title=unit.callsign+' · '+unit.profile.name;
    button.innerHTML=`<span class="aircraft-portrait"><span class="portrait-fallback">${String(index+1).padStart(2,'0')}</span><img alt="" hidden><span class="portrait-damage" aria-hidden="true">×</span></span><span class="aircraft-callsign">${esc(unit.callsign)}</span>`;
    button.onclick=()=>onSelect(unit.id);
    button.onkeydown=e=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?units.length-1:(index+(e.key==='ArrowDown'?1:-1)+units.length)%units.length;const target=units[next];onSelect(target.id);buttons.get(target.id).focus({preventScroll:true});};
    rail.append(button);buttons.set(unit.id,button);
  }
  stage.append(rail);
  const panel=document.createElement('section');panel.id='selected-aircraft-status';panel.setAttribute('aria-label','选中飞机状态');panel.setAttribute('aria-live','off');stage.append(panel);stage.classList.add('aircraft-hud-ready');let key='',collapsed=false;
  try{collapsed=localStorage.getItem('flight-aircraft-status-collapsed')==='true';}catch{}
  panel.innerHTML='<div class="aircraft-status-heading"><h2></h2><span class="aircraft-phase"></span><button type="button" id="aircraft-status-toggle" aria-controls="selected-aircraft-details"></button></div><div id="selected-aircraft-details"><p class="aircraft-model"></p><div class="aircraft-status-metrics"><div><small>航向</small><strong data-metric="heading"></strong></div><div><small>真空速</small><strong data-metric="speed"></strong></div><div><small>海拔</small><strong data-metric="altitude"></strong></div><div><small>马赫</small><strong data-metric="mach"></strong></div></div><p class="aircraft-status-target"><span data-metric="target"></span><span data-metric="waypoints"></span></p></div>';
  const subline=document.createElement('div');subline.className='aircraft-status-subline';
  const model=panel.querySelector('.aircraft-model'),authority=document.createElement('span');authority.id='control-authority';authority.setAttribute('aria-label','管制状态');model.before(subline);subline.append(model,authority);
  const statusToggle=panel.querySelector('#aircraft-status-toggle');
  function expandStatus(){panel.dataset.collapsed=String(collapsed);panel.querySelector('#selected-aircraft-details').hidden=collapsed;statusToggle.setAttribute('aria-expanded',String(!collapsed));statusToggle.setAttribute('aria-label',(collapsed?'展开':'收起')+'选中飞机状态');statusToggle.title=collapsed?'展开选中飞机状态':'收起选中飞机状态';statusToggle.textContent=collapsed?(panel.dataset.alert?'警告 ▾':'状态 ▾'):'收起 ▴';}
  statusToggle.onclick=()=>{collapsed=!collapsed;try{localStorage.setItem('flight-aircraft-status-collapsed',String(collapsed));}catch{}expandStatus();};expandStatus();
  const layout=new ResizeObserver(()=>stage.style.setProperty('--selected-status-bottom',Math.ceil(panel.getBoundingClientRect().bottom-stage.getBoundingClientRect().top)+'px'));layout.observe(panel);
  let portraitsKey='';
  function refreshPortraits(current){
    const next=JSON.stringify(current.map(u=>[u.id,aircraftModelId(u),u.color]));if(next===portraitsKey)return;portraitsKey=next;
    try{const images=aircraftPortraits(current);for(const u of current){const button=buttons.get(u.id);if(!button)continue;const img=button.querySelector('img');img.src=images.get(u.id);img.hidden=false;button.querySelector('.portrait-fallback').hidden=true;button.title=u.callsign+' · '+AIRCRAFT_MODELS[aircraftModelId(u)].name;}}
    catch{rail.title='飞机缩略图暂不可用，仍可通过编号选择飞机';}
  }
  function update(){
    const world=getWorld(),selected=getSelected(),unit=world.units.find(u=>u.id===selected);if(!unit)return;
    refreshPortraits(world.units);
    for(const u of world.units){const b=buttons.get(u.id);if(!b)continue;b.setAttribute('aria-pressed',String(u.id===selected));b.classList.toggle('damaged',u.alive===false);}
    const state=selectedAircraftStatus(unit),ground=groundStatusReport(unit),exterior=AIRCRAFT_MODELS[aircraftModelId(unit)].name,next=JSON.stringify([state,ground,exterior,formatSpeed(state.speed),formatAltitude(state.altitudeM),formatAltitude(state.targetAltitudeM),formatSpeed(state.targetSpeed)]);if(next===key)return;key=next;
    panel.style.setProperty('--aircraft-color',state.color);panel.dataset.unitId=unit.id;panel.dataset.alert=state.alert??'';
    if(collapsed){statusToggle.textContent=state.alert?'警告 ▾':'状态 ▾';statusToggle.title=(state.alert?state.phase+'，':'')+'展开选中飞机状态';}
    panel.querySelector('h2').textContent=state.callsign;panel.querySelector('.aircraft-phase').textContent=state.phase;panel.querySelector('.aircraft-model').textContent=exterior+' · '+state.role;
    const metrics={heading:String(Math.round(state.headingDeg)%360).padStart(3,'0')+'°',speed:formatSpeed(state.speed),altitude:formatAltitude(state.altitudeM),mach:formatMach(state.mach),target:`目标 ${formatAltitude(state.targetAltitudeM)} / ${formatSpeed(state.targetSpeed)}`,waypoints:`航点 ${state.remaining} 待飞 · ${state.completed} 已通过`};
    if(ground){metrics.target=ground;metrics.waypoints='地面移动按当前阶段许可执行';}
    for(const [name,text]of Object.entries(metrics))panel.querySelector(`[data-metric="${name}"]`).textContent=text;
  }
  update();window.addEventListener('pagehide',()=>layout.disconnect());
  return {update};
}
