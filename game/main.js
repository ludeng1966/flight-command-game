import {initControlAuthority} from './control-authority.js';
import {controlAuthority,requestHandoff} from '../sim/control-authority.js';
import {initLive,renderLive,pickUnit,focusLive,moveLiveCamera,setFollowLive,getFollowLiveId} from '../three3d/scene.js';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {basis} from '../sim/flight.js';
import {initVoiceCommands} from './voice-command.js';
import {initRouteEditor} from './route-editor.js';
import {initClickFly} from './click-fly.js';
import {initRadarTutorial} from './radar-tutorial.js';
import {initEmergencyTutorial} from './emergency-tutorial.js';
import {initAirspaceControl} from './airspace-control.js';
import {initNavigationPanel} from './navigation-panel.js';
import {resolveMap,mapAssetUrls} from './map-catalog.js';
import {initTacticalOverlay} from './tactical-overlay.js';
import {initUnitSelection} from './unit-selection.js';
import {PlannerClient} from './planner-client.js';
import {RouteReplanner} from './route-replanner.js';
import {showSoft,hideSoft} from './ui-motion.js';
import {PilotSupervisor} from './pilot-supervisor.js';
import {TowerSupervisor} from './tower-supervisor.js';
import {RwrPilot} from './rwr-pilot.js';
import {initRwrControl} from './rwr-control.js';
import {RadarPilot} from './radar-pilot.js';
import {AttackPilot} from './attack-pilot.js';
import {formationStatus} from '../sim/formation.js';
import {getUnitSystem,setUnitSystem,unitLabels,altitudeValue,altitudeMeters,formatSpeed,formatAltitude,formatMach} from '../sim/units.js';
import {initAirportControl} from './airport-control.js';
import {initAtcControl} from './atc-control.js';
import {initRadarControl} from './radar-control.js';
import {initRadarCommand} from './radar-command.js';
import {initWeaponControl} from './weapon-control.js';
import {initSettingsMemory} from './settings-store.js';
import {initTrainingCoach} from './training-coach.js';
import {initInterface} from './interface.js';
import {setLiveDisplayOptions,getLiveMapHeading,getLiveMapObstacles} from '../three3d/scene.js';
import {initMapCompass} from './map-compass.js';
import {initMissionReport} from './mission-report.js';
import {initAircraftHud} from './aircraft-hud.js';
import {AutoSave} from './autosave.js';
import {captureWorld,restoreWorld,saveFingerprint} from '../sim/save-state.js';
import {restoreTraining} from '../sim/training-state.js';
import {getLiveView,restoreLiveView} from '../three3d/scene.js';
import {initLanguages} from './language.js';
const $=s=>document.querySelector(s);
try{setUnitSystem(localStorage.getItem('flight-unit-system'));}catch{setUnitSystem('metric');}
const canvas=$('#scene');let world,selectedId,playing=true,rate=1,acc=0,last=0,uiClock=0;
const routeRadio=$('#radio-console');
if(routeRadio)new ResizeObserver(entries=>canvas.parentNode.style.setProperty('--route-radio-height',Math.ceil(entries[0].borderBoxSize?.[0]?.blockSize??entries[0].contentRect.height)+'px')).observe(routeRadio);
let mapPoint=null,voiceControl=null,routeEditor=null,messageTimer=null,planner=null,replanner=null,predictionAt=0,predictionBusy=false,pilotSupervisor=null;
let radarPilot=null,attackPilot=null,rwrPilot=null,rwrControl=null;
const cameraKeys=new Set();
let airportControl=null,atcControl=null,radarControl=null,radarCommand=null,weaponControl=null,trainingCoach=null,missionReport=null,aircraftHud=null,authorityHud=null,clickFly=null,radarTutorial=null,emergencyTutorial=null,airspaceControl=null,navigationPanel=null,tacticalOverlay=null,unitSelection=null;
const cameraCodes=new Set(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','ControlLeft','ControlRight']);
const editing=el=>el?.matches('input,textarea,select,[contenteditable="true"]');
function cameraInput(){
  const has=code=>cameraKeys.has(code)?1:0;
  return {forward:has('KeyW')-has('KeyS'),right:has('KeyD')-has('KeyA'),
    up:Math.max(has('ShiftLeft'),has('ShiftRight'))-Math.max(has('ControlLeft'),has('ControlRight'))};
}
document.addEventListener('keydown',e=>{
  if(!cameraCodes.has(e.code)||editing(e.target))return;
  cameraKeys.add(e.code);e.preventDefault();
});
document.addEventListener('keyup',e=>cameraKeys.delete(e.code));
window.addEventListener('blur',()=>cameraKeys.clear());
document.addEventListener('visibilitychange',()=>{if(document.hidden)cameraKeys.clear();});
document.addEventListener('focusin',e=>{if(editing(e.target))cameraKeys.clear();});
const read=url=>fetch(url).then(r=>{if(!r.ok)throw Error(`${url}: ${r.status}`);return r.json();});
function selected(){return world.units.find(u=>u.id===selectedId);}
function routeMessage(text,error=false){$('#route-message').textContent=text;$('#route-message').dataset.error=String(error);const toast=$('#hud-message');toast.textContent=text;toast.dataset.error=String(error);if(text)showSoft(toast);else hideSoft(toast);clearTimeout(messageTimer);messageTimer=setTimeout(()=>hideSoft(toast),error?6500:3800);}
function endPlacement(){routeEditor?.cancel();}
function syncUnitControls(){
  const system=getUnitSystem();world.unitSystem=system;$('#unit-system').value=system;
}
function select(id){routeEditor?.cancel();endPlacement();if(selectedId!==id){world.prediction={points:[],warnings:[]};predictionAt=0;}selectedId=id;unitSelection?.setPrimary(id);const u=selected();if(getFollowLiveId()!==null&&getFollowLiveId()!==id)setFollowLive(u.alive===false?null:u);syncUnitControls();trainingCoach?.onSelect(id);updateUI();}
function updateUI(){
  $('#stage').dataset.grounded=String(selected().surface?.grounded===true);
  airportControl?.update();
  atcControl?.update();
  radarControl?.update();radarCommand?.update();rwrControl?.update();clickFly?.update();radarTutorial?.update();emergencyTutorial?.update();airspaceControl?.update();navigationPanel?.update();
  weaponControl?.update();
  trainingCoach?.update();
  missionReport?.update();
  aircraftHud?.update();authorityHud?.update();
  for(const id of ['hold','clear','route-edit'])document.getElementById(id).disabled=selected().surface?.grounded===true||controlAuthority(world,selected()).owner!=='commander';
  for(const u of world.units){
    const el=document.getElementById(u.id),metrics=el.querySelector('.metrics');el.classList.toggle('selected',u.id===selectedId);
    const role=u.flightRole?.role,roleText=role==='lead'?'长机':role==='wingman'?'僚机':'未分工';
    el.querySelector('.unit-title span').textContent=`${roleText} · ${u.profile.name}`;
    const html=`<div><small>真空速 · ${formatMach(u.mach??0)}</small>${formatSpeed(u.speed)}</div><div><small>海拔高度</small>${formatAltitude(u.position[2],{group:true})}</div><div><small>过载 / 倾斜</small>${u.loadFactor.toFixed(1)} G / ${Math.round(u.bank*180/Math.PI)}°</div><div><small>${u.afterburner>.03?'加力 '+Math.round(u.afterburner*100)+'%':u.energyMode??'调推'} · 油门</small>${Math.round(u.throttle*100)}%</div>`;
    if(metrics.lastMarkup!==html){metrics.innerHTML=html;metrics.lastMarkup=html;}
  }
  const u=selected();$('#selected-name').textContent=u.callsign;
  const following=getFollowLiveId()!==null,followButton=$('#camera-follow');
  followButton.setAttribute('aria-pressed',String(following));followButton.classList.toggle('active',following);
  followButton.textContent=following?`跟随 ${u.callsign}`:'跟随选中机';followButton.disabled=u.alive===false&&!following;
  $('#hud-readout').textContent=`${u.callsign} · M ${(u.mach??0).toFixed(2)} · ${u.loadFactor.toFixed(1)} G\n${u.navigationBlocked?'航路暂缓':u.maneuverMode} · ${u.energyMode??'调推'}`;
  $('#hud-readout').title=u.energyReason??'';$('#auto-g').title=`${u.energyReason??''} · 载荷保护速度 ${formatSpeed(u.safeManeuverSpeed??0)}`;
  $('#orders').textContent=(u.alive===false?'飞机损毁':u.surface?.grounded?(u.surface.phase==='parked'?'机位停放':'地面运行'):formationStatus(u,world.units)??(u.headingRoute&&u.waypoints.length?`航向航路 ${String(Math.round(u.headingRoute.headingDeg)).padStart(3,'0')}° · 剩余 ${u.waypoints.length} 点`:u.headingTarget!=null?`航向保持 · ${Math.round(u.headingTarget*180/Math.PI)}°`:u.waypoints.length?`飞向航点 ${u.waypoints[0].number??1} · 剩余 ${u.waypoints.length} 个`:'盘旋待命'))+` · 已通过 ${u.completedWaypoints??0} 个 · ${u.headingRoute?.blockedReason||u.maneuverMode}`;
  $('#auto-g').textContent=`需求 ${(u.demandG??1).toFixed(1)} G / 正常上限 ${(u.availableG??1).toFixed(1)} G`;
  const pose=u.alive?basis(u):u.lastPose;
  $('#flight-details').textContent=`航向 ${((Math.atan2(pose.forward[0],pose.forward[1])*180/Math.PI+360)%360).toFixed(0)}° · 俯仰 ${(Math.asin(Math.max(-1,Math.min(1,pose.forward[2])))*180/Math.PI).toFixed(0)}° · 滚转 ${(u.bank*180/Math.PI).toFixed(0)}°`;
  const incident=u.flightState==='destroyed'?'导弹命中 · 飞机损毁':u.flightState==='crashed'?'触地坠毁':u.flightState==='stall-recovery'?'失速 · 自动卸载改出，航路已暂停':u.navigationBlocked||world.prediction?.warnings?.join('、')||u.navigationMessage||u.lastIncident||'';
  $('#flight-alert').textContent=incident;$('#flight-alert').dataset.error=String(u.flightState!=='normal');
  const list=$('#waypoint-list'),key=JSON.stringify([u.id,u.waypoints,getUnitSystem()]);
  if(list.dataset.key!==key&&!list.contains(document.activeElement)){
    list.dataset.key=key;list.dataset.unitId=u.id;
    list.innerHTML=u.waypoints.map((w,i)=>`<label class="waypoint-row"><span>${i===0?'→':'·'} 航点 ${w.number??i+1}</span><input aria-label="航点 ${w.number??i+1} 海拔（${unitLabels().altitude}）" data-waypoint="${w.number??i+1}" type="number" step="100" value="${Math.round(altitudeValue(w[2]))}"><span>${unitLabels().altitude}</span></label>`).join('');
  }
  for(const field of list.querySelectorAll('input[data-waypoint]'))field.disabled=!routeEditor?.enabled;
  $('#clock').textContent=`T+${String(Math.floor(world.time/60)).padStart(2,'0')}:${String(Math.floor(world.time%60)).padStart(2,'0')}`;
  if($('#current-rate').textContent!==rate+'×')$('#current-rate').textContent=rate+'×';
  $('#pause').innerHTML=playing?'暂停 <kbd>SPACE</kbd>':'继续 <kbd>SPACE</kbd>';
  $('#status').textContent=`${playing?'运行':'已暂停'} · ${rate}×`;
}
function toggle(){world.revision++;playing=!playing;acc=0;updateUI();}
async function boot(){
  await initLanguages();
  const [scenario,profiles]=await Promise.all([read('../data/scenarios/demo.json'),read('../data/aircraft.json')]);
const mapCatalog=await read('../terrain/maps.json'),map=resolveMap(mapCatalog,scenario.map),mapUrls=mapAssetUrls(map);
const [terrain,landmask,heightfield]=await Promise.all([read(mapUrls.contours),read(mapUrls.landmask),TerrainHeight.load(mapUrls.heightPrefix)]);
  let spawnMode=scenario.defaultSpawnMode??'stands';try{const saved=localStorage.getItem('flight-spawn-mode');if(['stands','airborne'].includes(saved))spawnMode=saved;}catch{}
  if(new URLSearchParams(location.search).get('tutorial')==='radar')spawnMode='airborne';
  if(new URLSearchParams(location.search).get('tutorial')==='emergency')spawnMode='stands';
  let mode='strict';try{const saved=localStorage.getItem('flight-execution-mode');if(['strict','relaxed'].includes(saved))mode=saved;}catch{}
  world=new World(scenario,profiles,heightfield,{spawnMode,mode});selectedId=world.units[0].id;
  unitSelection=initUnitSelection({getWorld:()=>world,getSelected:()=>selectedId,onChange:updateUI,isRouteEdit:()=>!!routeEditor?.enabled});
  let restoredState=null;
  const formFields=['command-style','command-auto','command-text','append-waypoint','airport-runway','airport-gate','airport-taxiways'];
  const autosave=new AutoSave({storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},fingerprint:saveFingerprint(scenario,profiles),
    capture:()=>({world:captureWorld(world),training:trainingCoach?.snapshot()??null,
      ui:{selectedId,rate,mapPoint,view:getLiveView(),form:Object.fromEntries(formFields.map(id=>{const el=$('#'+id);return [id,el?.type==='checkbox'?el.checked:el?.value??''];}))}}),
    restore:state=>{
      const next=restoreWorld(state.world,scenario,profiles,heightfield);restoreTraining(next,state.training);
      if(!state.ui||!next.units.some(u=>u.id===state.ui.selectedId)||![1,2,4,8].includes(state.ui.rate))throw Error('界面进度无效');
      world=next;selectedId=state.ui.selectedId;spawnMode=world.spawnMode;mode=world.executionMode;rate=state.ui.rate;
      try{const saved=localStorage.getItem('flight-execution-mode');if(['strict','relaxed'].includes(saved))world.executionMode=mode=saved;}catch{}
      playing=false;mapPoint=Array.isArray(state.ui.mapPoint)&&state.ui.mapPoint.length===3&&state.ui.mapPoint.every(Number.isFinite)?state.ui.mapPoint:null;
      let preferredUnits;try{preferredUnits=localStorage.getItem('flight-unit-system');}catch{}
      setUnitSystem(['metric','imperial'].includes(preferredUnits)?preferredUnits:world.unitSystem??getUnitSystem());restoredState=state;
    },onStatus:state=>{
      const el=$('#autosave-status');el.dataset.error=String(state.type==='error');
      el.textContent=state.type==='error'?state.message:`${state.type==='restored'?'已恢复上次进度':'已自动保存'} · ${new Date(state.savedAt).toLocaleTimeString('zh-CN',{hour12:false})} · 本机存档`;
    }});
  const loaded=autosave.load();if(loaded.blocked)playing=false;
  planner=new PlannerClient(heightfield);
  replanner=new RouteReplanner({getWorld:()=>world,planner});
  const configureWorld=()=>{
    world.deferNavigation=u=>{
      const active=world,key=world.routeKey(u);u.navigationPending=true;
      planner.request('nav:'+u.id,u,u.waypoints).then(prepared=>{
        u.navigationPending=false;if(world!==active||world.routeKey(u)!==key||!u.waypoints.length)return;
        if(u.rwrDefense?.active){u.navigationKey=null;return;}
        try{
          if(!prepared){u.navigationKey=null;return;}
          const plan=world.resolvePlan(u,u.waypoints,prepared);
          if(plan.valid)world.installNavigation(u,plan);
          else{u.navigationBlocked=plan.reason;u.navigationMessage='暂缓执行：'+plan.reason;u.navigationRetryAt=world.time+10;u.safetyOrbit??=[u.position[0]+4000,u.position[1]];u.safetyAltitude=Math.max(u.position[2],(heightfield.heightAt(u.position[0],u.position[1])??0)+800);}
        }catch{u.navigationKey=null;}
      });
    };
  };configureWorld();
  const focusSpawn=()=>spawnMode==='stands'?focusLive([{position:[...world.airportOps.airport.center,world.airportOps.airport.elevation]}],.25):focusLive(world.units);
  const restart=()=>{if(radarTutorial||emergencyTutorial){location.reload();return;}trainingCoach?.reset();setFollowLive(null);voiceControl?.reset();pilotSupervisor?.reset();radarPilot?.reset();attackPilot?.reset();endPlacement();mapPoint=null;world=new World(scenario,profiles,heightfield,{spawnMode,mode});configureWorld();playing=true;acc=0;select(world.units[0].id);focusSpawn();autosave.newGame();};
  const runways=(terrain.airfields||[]).filter(r=>['t1_airfield','t2_airfield'].includes(r.name)).map(r=>({x1:r.ends[0][0],y1:r.ends[0][1],x2:r.ends[1][0],y2:r.ends[1][1],altM:r.altM,z1:r.altM,z2:r.altM}));
  initLive(canvas,{terrain,landmask,runways,units:world.units,heightfield,airport:world.airportOps?.airport});
  for(const u of world.units){const el=document.createElement('div');el.id=u.id;el.className='unit';el.tabIndex=0;el.setAttribute('role','button');el.innerHTML=`<div class="unit-title">${u.callsign}<span>${u.profile.name}</span></div><div class="metrics"></div>`;el.onclick=()=>select(u.id);el.onkeydown=e=>{if(e.key==='Enter')select(u.id);};$('#roster').appendChild(el);}
  select(selectedId);
  $('#execution-mode').value=mode;$('#execution-mode').onchange=()=>{mode=$('#execution-mode').value;world.executionMode=mode;world.revision++;voiceControl?.cancel('执行模式已切换，尚未装订的旧指令作废');try{localStorage.setItem('flight-execution-mode',mode);}catch{}};
  $('#unit-system').onchange=()=>{setUnitSystem($('#unit-system').value);try{localStorage.setItem('flight-unit-system',getUnitSystem());}catch{}voiceControl?.unitsChanged();pilotSupervisor?.reset();radarPilot?.reset();attackPilot?.reset();syncUnitControls();updateUI();};
  airportControl=initAirportControl({getWorld:()=>world,getSelected:()=>selectedId,issueCommand:instruction=>{if(voiceControl.busy)return Promise.reject(Error('另一条通联正在进行，请等待。'));endPlacement();interfaceControl.open('voice');$('#command-text').value=instruction;return voiceControl.issue(instruction,{source:'airport'});},onChange:()=>{routeEditor?.cancel();endPlacement();updateUI();},onFocus:a=>focusLive([{position:[...a.center,a.elevation]}],.25),onSpawnMode:mode=>{spawnMode=mode;try{localStorage.setItem('flight-spawn-mode',mode);}catch{}restart();}});
  atcControl=initAtcControl({getWorld:()=>world,getSelected:()=>selectedId,onChange:()=>{voiceControl?.cancel('机场运行条件已更新，旧指令作废');updateUI();}});
  radarControl=initRadarControl({getWorld:()=>world,getSelected:()=>selectedId,onChange:updateUI,beforeCommand:()=>voiceControl?.cancel('演练场景已变化，尚未执行的旧指令作废')});
  radarCommand=initRadarCommand({getWorld:()=>world,getSelected:()=>selectedId,getSelectedIds:()=>unitSelection?.ids()??[selectedId],onChange:updateUI});
  weaponControl=initWeaponControl({getWorld:()=>world,getSelected:()=>selectedId,onChange:updateUI,beforeCommand:()=>voiceControl?.cancel('演练场景已变化，尚未执行的旧指令作废')});
  rwrControl=initRwrControl({getWorld:()=>world,getSelected:()=>selectedId,onChange:updateUI,beforeCommand:()=>voiceControl?.cancel('告警策略已由玩家接管')});
  focusSpawn();
  routeEditor=initRouteEditor({canvas,getWorld:()=>world,getSelected:()=>selectedId,onChange:updateUI,onPointPreview:p=>{mapPoint=p.slice();},onCommitted:(id,change)=>{voiceControl?.routeChanged(id,change);const point=change.point??world.units.find(u=>u.id===id)?.waypoints.at(-1);if(point)trainingCoach?.onWaypoint(point);},message:routeMessage,planner,replanner});
  clickFly=initClickFly({getWorld:()=>world,getSelected:()=>selectedId,getSelectedIds:()=>unitSelection?.ids()??[selectedId],onChange:updateUI,message:routeMessage,isRouteEdit:()=>!!routeEditor?.enabled});
  radarTutorial=initRadarTutorial({getWorld:()=>world,getSelected:()=>selectedId,onSimulation:running=>{playing=running;acc=0;},message:routeMessage});
  emergencyTutorial=initEmergencyTutorial({getWorld:()=>world,getSelected:()=>selectedId,onSimulation:running=>{playing=running;acc=0;},message:routeMessage});
  airspaceControl=initAirspaceControl({getWorld:()=>world,onChange:updateUI});
  navigationPanel=initNavigationPanel({getWorld:()=>world,getSelected:()=>selectedId});
  tacticalOverlay=initTacticalOverlay();
  $('#pause').onclick=toggle;
  const setRoster=visible=>{$('#stage').classList.toggle('panels-hidden',!visible);$('#toggle-panels').classList.toggle('active',visible);$('#toggle-panels').setAttribute('aria-pressed',String(visible));};
  setRoster(false);
  $('#toggle-panels').onclick=()=>{setRoster($('#stage').classList.contains('panels-hidden'));if(matchMedia('(max-width:750px)').matches){$('#stage').classList.remove('voice-open');$('#voice-toggle').setAttribute('aria-expanded','false');}};
  $('#voice-toggle').onclick=()=>{const open=$('#stage').classList.toggle('voice-open');$('#voice-toggle').setAttribute('aria-expanded',String(open));if(open&&matchMedia('(max-width:750px)').matches)setRoster(false);};
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('#controls-help'))$('#controls-help').open=false;});
  for(const b of document.querySelectorAll('[data-rate]'))b.onclick=()=>{rate=Number(b.dataset.rate);document.querySelectorAll('[data-rate]').forEach(el=>el.classList.toggle('active',el===b));updateUI();};
  let waypointHeightTimer;
  const editHeight=(e,delay)=>{
    if(!routeEditor?.enabled)return;
    const field=e.target;if(!field.matches('input[data-waypoint]'))return;clearTimeout(waypointHeightTimer);
    const activeWorld=world,u=world.units.find(u=>u.id===$('#waypoint-list').dataset.unitId),number=Number(field.dataset.waypoint),w=u?.waypoints.find((w,i)=>(w.number??i+1)===number),v=altitudeMeters(Number(field.value)),revision=u?.routeRevision??0;
    if(!w||!field.value||!Number.isFinite(v)||Math.abs(v-w[2])<.5)return;
    waypointHeightTimer=setTimeout(async()=>{
      if(world!==activeWorld)return;
      try{const plan=await replanner.apply(u.id,{kind:'move',reference:w,point:[w[0],w[1],v],revision});if(plan){voiceControl?.routeChanged(u.id,{kind:'move',point:w});routeMessage('航点高度已更新');}}
      catch(error){field.value=Math.round(altitudeValue(w[2]));routeMessage(error.message,true);}updateUI();
    },delay);
  };
  $('#waypoint-list').addEventListener('input',e=>editHeight(e,300));
  $('#waypoint-list').addEventListener('change',e=>editHeight(e,0));
  const hold=()=>{routeEditor.cancel();endPlacement();const u=selected();world.replaceRoute(u.id,[]);u.orbit=[u.position[0],u.position[1]];voiceControl?.routeChanged(u.id,{kind:'clear'});updateUI();};$('#hold').onclick=hold;$('#clear').onclick=hold;
  $('#focus').onclick=()=>{focusLive(world.units);updateUI();};
  const toggleFollow=()=>{setFollowLive(getFollowLiveId()!==null?null:selected());updateUI();};
  $('#camera-follow').onclick=toggleFollow;
  document.addEventListener('keydown',e=>{if(e.code==='KeyF'&&!e.repeat&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!editing(e.target)){e.preventDefault();toggleFollow();}});
  $('#reset').onclick=restart;
  let start;
  canvas.addEventListener('pointerdown',e=>{start=[e.clientX,e.clientY];});
  canvas.addEventListener('pointerup',e=>{if(routeEditor.enabled||e.button!==0||!start||Math.hypot(e.clientX-start[0],e.clientY-start[1])>5)return;const id=pickUnit(e.clientX,e.clientY);if(id)select(id);});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('keydown',e=>{if(editing(e.target))return;if(e.key==='Escape'){endPlacement();$('#controls-help').open=false;$('#stage').classList.remove('voice-open');$('#voice-toggle').setAttribute('aria-expanded','false');return;}if(e.code==='Space'){e.preventDefault();toggle();}if(e.key==='1')select(world.units[0].id);if(e.key==='2')select(world.units[1].id);});
  // 便于外部工具读取当前局；状态和命令均使用同一飞行内核。
  window.ACEGame={get world(){return world;},select,command:(id,p,append)=>world.command(id,p,append),pause:()=>{world.revision++;playing=false;updateUI();},play:()=>{world.revision++;playing=true;updateUI();},get playing(){return playing;},get rate(){return rate;}};
  const settingsMemory=initSettingsMemory({legacyForm:restoredState?.ui.form});
  voiceControl=initVoiceCommands({allowAutomaticHandoff:u=>trainingCoach?.allowsAutomaticHandoff(u.id)??true,getState:()=>({world,selectedId,playing,mapPoint:routeEditor?.previewPoint??mapPoint}),
    onCommandCommitted:({reply,source})=>{
      trainingCoach?.onCommandCommitted(reply.interpretation,{demo:source==='training-demo'});
      const tasks=reply.plan.tasks.filter(t=>['sensor_task','attack_task'].includes(t.action));
      if(tasks.length){select(tasks.find(t=>t.unitId===selectedId)?.unitId??tasks[0].unitId);$(tasks.some(t=>t.action==='attack_task')?'#weapon-toggle':'#radar-toggle').click();}
    },
    onPilotModelChanged:()=>{pilotSupervisor?.reset();radarPilot?.reset();attackPilot?.reset();const element=$('#pilot-assistant-status');if(element)element.hidden=true;},
    onPilotPreview:preview=>{if(preview.count===1)select(preview.unitId);},
    onApplied:()=>select(selectedId),onSimulation:running=>{playing=running;acc=0;updateUI();}});
  pilotSupervisor=new PilotSupervisor({getWorld:()=>world,enabled:()=>voiceControl.pilotAssistantEnabled,isPlaying:()=>playing,getPilotModel:()=>voiceControl.pilotModel,onReport:report=>voiceControl.reportPilotExecution(report),
    onStatus:state=>{const element=$('#pilot-assistant-status');if(element){element.hidden=false;element.textContent=(world.units.find(u=>u.id===state.unitId)?.callsign||'飞行员')+' · '+state.text;}}});
  radarPilot=new RadarPilot({getWorld:()=>world,enabled:()=>voiceControl.pilotAssistantEnabled&&!pilotSupervisor.active&&!attackPilot?.active,isPlaying:()=>playing,getPilotModel:()=>voiceControl.pilotModel});
  attackPilot=new AttackPilot({getWorld:()=>world,enabled:()=>voiceControl.pilotAssistantEnabled&&!pilotSupervisor.active&&!radarPilot.active,isPlaying:()=>playing,getPilotModel:()=>voiceControl.pilotModel});
  rwrPilot=new RwrPilot({getWorld:()=>world,enabled:()=>voiceControl.pilotAssistantEnabled,isPlaying:()=>playing,getPilotModel:()=>voiceControl.pilotModel});
  const towerSupervisor=new TowerSupervisor({getWorld:()=>world,enabled:()=>playing&&!!voiceControl?.pilotAssistantEnabled});
  window.addEventListener('pagehide',()=>{towerSupervisor.reset();rwrPilot.stop();pilotSupervisor.stop();radarPilot.stop();attackPilot.stop();});
  aircraftHud=initAircraftHud({getWorld:()=>world,getSelected:()=>selectedId,onSelect:select});
  trainingCoach=initTrainingCoach({getWorld:()=>world,getPlaying:()=>playing,
    onHandoff:(unitId,target)=>{const u=world.units.find(u=>u.id===unitId);if(requestHandoff(world,u,target))voiceControl.requestHandoff(unitId);},onExecutionMode:value=>{const el=$('#execution-mode');el.value=value;el.dispatchEvent(new Event('change'));},issueCommand:(instruction,options)=>voiceControl.issue(instruction,options),cancelCommand:()=>voiceControl.cancel(),getCommandBusy:()=>voiceControl.busy,
    onSimulation:running=>{playing=running;acc=0;},
    onRate:value=>{rate=value;document.querySelectorAll('[data-rate]').forEach(el=>el.classList.toggle('active',Number(el.dataset.rate)===rate));},
    onStep:(step,u)=>{
      $('#stage').classList.remove('voice-open');$('#voice-toggle').setAttribute('aria-expanded','false');
      if(step?.id==='select'){setRoster(false);$('#aircraft-select-blue-1').focus({preventScroll:true});}
      else setRoster(false);
      if(step?.id==='map'){setFollowLive(null);$('#append-waypoint').checked=false;focusLive([u]);}
      else if(step?.kind==='command'&&step.intent!=='report_status')setFollowLive(u);
    },restartGround:(entry='stands')=>{
    spawnMode=entry;try{localStorage.setItem('flight-spawn-mode',spawnMode);}catch{}
    restart();$('#airport-spawn-mode').value=spawnMode;
    $('#command-text').value='';$('#command-text').dispatchEvent(new Event('input'));
    $('#unit-system').value='imperial';$('#unit-system').dispatchEvent(new Event('change'));
    $('#command-style').value='nato';$('#command-style').dispatchEvent(new Event('change'));
    $('#execution-mode').value='strict';$('#execution-mode').dispatchEvent(new Event('change'));
  }});
  authorityHud=initControlAuthority({getWorld:()=>world,getSelected:()=>selectedId,onRequest:id=>voiceControl.requestHandoff(id)});
  if(restoredState){
    for(const id of formFields){if(settingsMemory.handles(id))continue;const el=$('#'+id),value=restoredState.ui.form?.[id];if(el&&value!==undefined){if(el.type==='checkbox')el.checked=!!value;else el.value=String(value);}}
    trainingCoach.restore(restoredState.training);restoreLiveView(restoredState.ui.view,world.units);
    document.querySelectorAll('[data-rate]').forEach(el=>el.classList.toggle('active',Number(el.dataset.rate)===rate));
    routeMessage('已恢复上次进度，点击“继续”接着飞行');
  }else if(loaded.blocked)routeMessage('上次存档暂时无法恢复，原存档已保留；可在设置中重新开始',true);
  let interfaceControl;
  missionReport=initMissionReport({getWorld:()=>world,getSelected:()=>selectedId,getTraining:()=>trainingCoach,openPanel:name=>interfaceControl.open(name)});
  interfaceControl=initInterface({onDisplayChange:setLiveDisplayOptions,getMapObstacles:getLiveMapObstacles});
  missionReport.update();
  updateUI();autosave.bind(window,document);
  // Flush after controls finish their event handlers, including training and selection.
  document.addEventListener('change',()=>queueMicrotask(()=>autosave.save()));
  document.addEventListener('click',()=>queueMicrotask(()=>autosave.save()));
  if(!loaded.restored&&!loaded.blocked)autosave.save();
  const mapCompass=initMapCompass($('#stage'));
  function predict(ts){
    const u=selected();if(!u.alive||!u.waypoints.length||u.navigationBlocked||u.rwrDefense?.active){if(world.prediction?.points?.length)world.prediction={points:[],warnings:[]};return;}
    if(predictionBusy||ts<predictionAt||routeEditor?.active)return;
    predictionBusy=true;predictionAt=ts+1000;const activeWorld=world,id=selectedId,key=world.routeKey(u);
    planner.request('live',u,u.waypoints,'trace').then(result=>{predictionBusy=false;if(result&&world===activeWorld&&selectedId===id&&world.routeKey(selected())===key)world.prediction=result;});
  }
  const frameSamples=[];let statsAt=0;
  const renderStats=document.createElement('output');renderStats.id='render-stats';$('#controls-help>div').appendChild(renderStats);
  const flightDataLink=document.createElement('a');flightDataLink.href='./flight-data.html';flightDataLink.target='_blank';flightDataLink.rel='noopener';flightDataLink.textContent='飞行与导弹数据';const flightDataEntry=document.createElement('p');flightDataEntry.appendChild(flightDataLink);$('#controls-help>div').appendChild(flightDataEntry);
  function frame(ts){
    const gap=last?ts-last:0,dt=Math.min(gap/1000,.15);last=ts;
    if(gap>0){frameSamples.push(gap);if(frameSamples.length>180)frameSamples.shift();}
    world.playerCommandPending=voiceControl?.playerCommandPending===true;
    moveLiveCamera(cameraInput(),dt);if(playing){acc+=dt*rate;while(acc>=1/60&&playing){world.step(1/60);acc-=1/60;trainingCoach?.tick();}}
    trainingCoach?.tick();routeEditor.frame();predict(ts);towerSupervisor.tick();rwrPilot.tick();pilotSupervisor.tick();radarPilot.tick();attackPilot.tick();renderLive(world.snapshot(selectedId,{forecast:false}),dt);try{tacticalOverlay?.update(world,selectedId,unitSelection?.ids()??[selectedId],clickFly?.getPreview?.(),radarCommand?.getRadarFocus?.());}catch(error){console.error('战术叠加层绘制失败',error);tacticalOverlay=null;}mapCompass.update(getLiveMapHeading());
    voiceControl?.pumpAirportRadio();autosave.tick(world);uiClock+=dt;if(uiClock>.15){updateUI();uiClock=0;}
    if(ts>statsAt&&frameSamples.length){statsAt=ts+1000;const sorted=[...frameSamples].sort((a,b)=>a-b),average=frameSamples.reduce((a,b)=>a+b,0)/frameSamples.length;canvas.dataset.fps=(1000/average).toFixed(1);canvas.dataset.frameP95=sorted[Math.floor(sorted.length*.95)].toFixed(1);renderStats.textContent=`渲染 ${canvas.dataset.fps} FPS · P95 ${canvas.dataset.frameP95} ms`;}
    requestAnimationFrame(frame);
  }
  // 主页面「设置」入口：?panel=settings 打开设置面板
  if(new URLSearchParams(location.search).get('panel')==='settings')queueMicrotask(()=>document.querySelector('#settings-toggle')?.click());
  requestAnimationFrame(frame);
}
boot().catch(e=>{$('#status').textContent='加载失败：'+e.message;console.error(e);});
