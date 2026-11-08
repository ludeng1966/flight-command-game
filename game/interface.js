import {displayPreferences} from './display-preferences.js';
import {initRadioOverlay} from './radio-overlay.js';
import {initFloatingWindows} from './floating-windows.js';
import {initRouteEditFocus} from './route-edit-focus.js';

// 保留式整理：沿用控件ID和事件，只搬动真实节点；默认地图、单个抽屉、紧凑时间栏。
export function initInterface({onDisplayChange,getMapObstacles=()=>[]}){
  const $=s=>document.querySelector(s),stage=$('#stage'),settings=$('#settings-panel'),coach=$('#training-coach');
  let panel=null,report=null;const wasTrainingOpen=coach&&!coach.hidden;
  const brief=$('#mission-brief'),narrow=matchMedia('(max-width:850px)');
  const move=(selector,target)=>{const el=$(selector);if(el)$(target).append(el);};
  // 选择框连同标签一起移动，保留关联、监听器和当前值。
  for(const id of ['unit-system','execution-mode']){
    const field=$('#'+id),label=document.querySelector('label[for="'+id+'"]');if(label&&field){label.append(field);$('#settings-general').append(label);}
  }
  const spawn=$('#airport-spawn-mode');if(spawn)$('#settings-scenario').append(spawn.closest('label'));
  for(const selector of ['label[for="command-style"]','.command-auto'])move(selector,'#settings-radio');
  for(const selector of ['label[for="pilot-model"]','#pilot-model-download'])move(selector,'#settings-pilot');
  move('#radio-audio','#settings-radio');move('#radio-retry-cloud','#settings-radio');move('#reset','#settings-scenario');
  move('#training-toggle','#settings-tools');move('#controls-help','#settings-tools');
  for(const selector of ['#command-connection','.command-model','#command-ai-resource','#pilot-assistant-status'])move(selector,'#settings-service');
  move('#camera-follow','#view-menu-content');move('#focus','#view-menu-content');move('#route-controls','#route-menu-content');
  const append=$('#append-waypoint');if(append)$('#route-menu-content').append(append.closest('label'));
  move('#rates','#speed-menu-content');
  function heading(root,title,label){
    const h=document.createElement('div');h.className='panel-heading';const text=document.createElement('h2');text.textContent=title;
    const close=document.createElement('button');close.type='button';close.textContent='关闭';close.dataset.closePanel='';close.setAttribute('aria-label',label);h.append(text,close);root.prepend(h);
  }
  heading($('#unit-panel'),'编队与指挥','关闭编队面板');heading($('.command-panel'),'指挥电台','关闭指挥电台');
  const references=document.createElement('details');references.className='command-references';const summary=document.createElement('summary');summary.textContent='口令参考与最近记录';references.append(summary);
  for(const selector of ['#command-help','.command-handbook','#command-history']){const el=$(selector);if(el)references.append(el);}$('.command-panel').append(references);
  const closeMenus=()=>document.querySelectorAll('.dock-menu').forEach(el=>el.open=false);
  function open(name,{focus=false}={}){
    if(stage.classList.contains('route-edit-mode'))return;
    if(name==='refresh'&&stage.classList.contains('training-active')&&coach?.dataset.mission==='select'&&coach.dataset.phase==='brief')panel='roster';
    if(name==='training'||name==='brief'){report=name;if(panel==='settings'||narrow.matches&&panel==='voice')panel=null;}
    else if(name==='close-report')report=null;
    else if(name==='close-primary')panel=null;
    else if(name!=='refresh'){panel=name;if(name===null)report=null;}
    const reportsVisible=panel!=='settings'&&!(panel==='voice'&&narrow.matches),shownReport=reportsVisible?report:null;
    closeMenus();stage.classList.toggle('panels-hidden',panel!=='roster');stage.classList.toggle('voice-open',panel==='voice');stage.classList.toggle('radio-open',panel==='radio');stage.classList.toggle('report-open',!!shownReport);
    settings.hidden=panel!=='settings';if(coach)coach.hidden=shownReport!=='training';if(brief)brief.hidden=shownReport!=='brief';
    for(const [id,key]of [['toggle-panels','roster'],['voice-toggle','voice'],['settings-toggle','settings'],['training-toggle','training']]){
      const button=$('#'+id);if(!button)continue;const active=key==='training'?shownReport==='training':panel===key;button.setAttribute(id==='toggle-panels'?'aria-pressed':'aria-expanded',String(active));button.classList.toggle('active',active);
    }
    if(focus){const target=name==='settings'?settings:name==='roster'?$('#unit-panel'):name==='voice'?$('.command-panel'):null;target?.querySelector('button,select,textarea')?.focus({preventScroll:true});}
  }
  for(const [id,key]of [['toggle-panels','roster'],['voice-toggle','voice'],['settings-toggle','settings']])$('#'+id).onclick=()=>open(panel===key?'close-primary':key,{focus:true});
  stage.addEventListener('mission-open-command',()=>{open('voice');$('#command-text').focus({preventScroll:true});});
  stage.addEventListener('training-command-issued',()=>{if(narrow.matches)open('training');});
  document.querySelectorAll('[data-close-panel]').forEach(button=>button.onclick=()=>{if(button.closest('#mission-brief')){open('close-report');$('#mission-report-toggle').focus({preventScroll:true});return;}const from=panel;open('close-primary');$('#'+({settings:'settings-toggle',voice:'voice-toggle',roster:'toggle-panels'}[from]??'settings-toggle')).focus({preventScroll:true});});
  $('#training-toggle')?.addEventListener('click',()=>open(coach?.hidden?'close-report':'training'));
  coach?.addEventListener('click',e=>{if(e.target.closest('#coach-close')){open('close-report');$('#mission-report-toggle').focus({preventScroll:true});}});
  const menus=[...document.querySelectorAll('.dock-menu')];menus.forEach(menu=>menu.addEventListener('toggle',()=>{if(menu.open)menus.filter(other=>other!==menu).forEach(other=>other.open=false);}));
  for(const button of document.querySelectorAll('#view-menu-content button,#route-controls button'))button.addEventListener('click',closeMenus);
  for(const button of document.querySelectorAll('[data-rate]'))button.addEventListener('click',()=>{$('#current-rate').textContent=button.textContent;closeMenus();});
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.dock-menu'))closeMenus();if(panel==='settings'&&!e.target.closest('#settings-panel,#settings-toggle'))open('close-primary');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){open(null);$('#controls-help').open=false;}});
  // 兼容训练提示等现有功能直接打开指挥面板的行为。
  const stageObserver=new MutationObserver(()=>{
    if(stage.classList.contains('route-edit-mode'))return;
    if(!stage.classList.contains('voice-open')&&!stage.classList.contains('panels-hidden')&&panel!=='roster')open('roster');
    else if(stage.classList.contains('voice-open')&&panel!=='voice')open('voice');
    else if(!stage.classList.contains('voice-open')&&panel==='voice')open('close-primary');
    else if(!stage.classList.contains('panels-hidden')&&panel!=='roster')open('roster');
    else if(stage.classList.contains('panels-hidden')&&panel==='roster')open('close-primary');
  });
  stageObserver.observe(stage,{attributes:true,attributeFilter:['class']});
  const radioOverlay=initRadioOverlay();
  const mic=$('#command-mic'),micObserver=new MutationObserver(()=>{const recording=mic.dataset.recording==='true';$('#voice-toggle').dataset.recording=String(recording);$('#voice-toggle').textContent=recording?'录音中':'指挥电台';});micObserver.observe(mic,{attributes:true,attributeFilter:['data-recording']});
  const modes=[['route-edit','#route-menu>summary','航线设置中','航路'],['camera-follow','#view-menu>summary','跟随中','视图']];
  const modeObserver=new MutationObserver(()=>{for(const [id,selector,active,idle]of modes){const enabled=$('#'+id).getAttribute('aria-pressed')==='true',label=$(selector),text=enabled?active:idle;if(label.textContent!==text)label.textContent=text;label.classList.toggle('active',enabled);}});
  for(const [id]of modes)modeObserver.observe($('#'+id),{attributes:true,attributeFilter:['aria-pressed']});
  let display;try{display=displayPreferences(JSON.parse(localStorage.getItem('flight-display-preferences')));}catch{display=displayPreferences();}
  const fields={airportLabels:$('#display-airport-labels'),trails:$('#display-trails'),waypointLabels:$('#display-waypoints')};
  for(const [key,field]of Object.entries(fields)){field.value=display[key];field.onchange=()=>{display=displayPreferences(Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value])));onDisplayChange(display);try{localStorage.setItem('flight-display-preferences',JSON.stringify(display));}catch{}};}
  onDisplayChange(display);open(wasTrainingOpen?'training':null);stage.dataset.interfaceReady='true';
  initFloatingWindows({stage,getObstacles:getMapObstacles});
  initRouteEditFocus({stage});
  narrow.addEventListener('change',()=>open('refresh'));
  window.addEventListener('pagehide',()=>{stageObserver.disconnect();micObserver.disconnect();modeObserver.disconnect();});
  return {open};
}
