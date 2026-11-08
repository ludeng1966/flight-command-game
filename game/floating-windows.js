import {chooseWindowPlacement} from './window-placement.js';
export const WINDOW_LAYOUT_KEY='flight-window-layout-v1';
const MARGIN=8,BOTTOM=72,clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export function constrainWindow(rect,bounds){
  const width=clamp(rect.width,Math.min(160,bounds.width-16),Math.max(1,bounds.width-16));
  const height=clamp(rect.height,Math.min(100,bounds.height-BOTTOM-MARGIN),Math.max(1,bounds.height-BOTTOM-MARGIN));
  return {x:clamp(rect.x,MARGIN,Math.max(MARGIN,bounds.width-width-MARGIN)),y:clamp(rect.y,MARGIN,Math.max(MARGIN,bounds.height-height-BOTTOM)),width,height};
}
export function readWindowLayout(storage){
  try{const data=JSON.parse(storage.getItem(WINDOW_LAYOUT_KEY)),valid={};
    for(const [id,r]of Object.entries(data??{}))if(r&&['x','y','width','height'].every(key=>Number.isFinite(r[key]))&&r.width>0&&r.height>0)valid[id]={x:r.x,y:r.y,width:r.width,height:r.height};
    return valid;
  }catch{return {};}
}
export function windowResizeEdge(rect,x,y,grip=7){
  if(x<rect.x||x>rect.x+rect.width||y<rect.y||y>rect.y+rect.height)return '';
  return (y-rect.y<grip?'n':rect.y+rect.height-y<grip?'s':'')+(x-rect.x<grip?'w':rect.x+rect.width-x<grip?'e':'');
}
export function resizeWindow(rect,edge,dx,dy,bounds){
  let {x,y,width,height}=rect;const right=x+width,bottom=y+height,minWidth=Math.min(240,bounds.width-16),minHeight=Math.min(150,bounds.height-80);
  if(edge.includes('e'))width=clamp(width+dx,minWidth,bounds.width-x-8);
  if(edge.includes('s'))height=clamp(height+dy,minHeight,bounds.height-y-72);
  if(edge.includes('w')){x=clamp(x+dx,8,right-minWidth);width=right-x;}
  if(edge.includes('n')){y=clamp(y+dy,8,bottom-minHeight);height=bottom-y;}
  return constrainWindow({x,y,width,height},bounds);
}
export function initFloatingWindows({stage=document.querySelector('#stage'),doc=document,win=window,storage=globalThis.localStorage,getObstacles=()=>[]}={}){
  const positions=readWindowLayout(storage),panes=new Map(),handles='.panel-heading,.coach-topline,.aircraft-status-heading';
  let drag=null,z=60,resizeTarget=null;
  const resizeOverlay=doc.createElement('div');resizeOverlay.className='window-resize-overlay';resizeOverlay.hidden=true;resizeOverlay.setAttribute('aria-hidden','true');
  for(const edge of ['n','s','w','e','nw','ne','sw','se']){const grip=doc.createElement('span');grip.dataset.resizeEdge=edge;resizeOverlay.append(grip);}stage.append(resizeOverlay);
  function syncResizeOverlay(){
    if(stage.classList.contains?.('route-edit-mode')){resizeOverlay.hidden=true;return;}
    if(!resizeTarget){resizeOverlay.hidden=true;return;}const root=resizeTarget.root,rect=measured(root);
    resizeOverlay.hidden=!!root.hidden||!rect.width||!rect.height||root.dataset.collapsed==='true';if(resizeOverlay.hidden)return;
    for(const [key,value]of Object.entries({left:rect.x,top:rect.y,width:rect.width,height:rect.height}))resizeOverlay.style.setProperty(key,value+'px');resizeOverlay.style.setProperty('z-index',String(z+1));
  }
  const bounds=()=>({width:stage.clientWidth,height:stage.clientHeight});
  const save=()=>{try{storage.setItem(WINDOW_LAYOUT_KEY,JSON.stringify(positions));}catch{}};
  function measured(root){const r=root.getBoundingClientRect(),s=stage.getBoundingClientRect();return {x:r.left-s.left,y:r.top-s.top,width:r.width,height:r.height};}
  function apply(root,rect){const next=constrainWindow(rect,bounds());root.dataset.windowPosition='custom';for(const [key,value]of Object.entries(next))root.style.setProperty('--window-'+key,value+'px');if(resizeTarget?.root===root)syncResizeOverlay();return next;}
  function reset(id){const root=panes.get(id);delete positions[id];if(root){delete root.dataset.windowPosition;for(const key of ['x','y','width','height'])root.style.removeProperty('--window-'+key);}save();}
  function finish(commit){
    if(!drag)return;const current=drag;drag=null;
    if(commit&&current.moved){positions[current.id]=current.rect;save();}
    else if(current.moved){if(current.previous)apply(current.root,current.previous);else{delete current.root.dataset.windowPosition;for(const key of ['x','y','width','height'])current.root.style.removeProperty('--window-'+key);}}
    current.root.classList.remove('window-dragging');stage.classList.remove('window-dragging');
    if(current.root.hasPointerCapture?.(current.pointerId))current.root.releasePointerCapture(current.pointerId);
  }
  function decorate(root){for(const header of root.querySelectorAll(handles)){
    header.dataset.windowHandle='true';header.tabIndex=0;header.title='拖动标题栏移动 · 拖动边缘调整大小 · 方向键微调 · 双击复位';
    header.setAttribute('aria-label',(root.getAttribute('aria-label')??'窗口')+'：可拖动标题栏，方向键移动，双击恢复默认位置');
  }}
  for(const [id,selector]of [['command','.command-panel'],['settings','#settings-panel'],['roster','#unit-panel'],['brief','#mission-brief'],['training','#training-coach'],['aircraft','#selected-aircraft-status']]){
    const root=stage.querySelector(selector);if(!root)continue;panes.set(id,root);root.dataset.floatingWindow=id;decorate(root);if(positions[id])apply(root,positions[id]);
    root.addEventListener('focusin',()=>root.style.setProperty('--window-z',String(++z)));
    root.addEventListener('pointerenter',()=>{if(!drag){resizeTarget={id,root};syncResizeOverlay();}});
    root.addEventListener('pointerdown',e=>{
      root.style.setProperty('--window-z',String(++z));
      const initial=measured(root);if(!initial.width||!initial.height)return;
      const edge=id==='aircraft'&&root.dataset.collapsed==='true'?'':windowResizeEdge(initial,e.clientX,e.clientY);
      if(e.button!==0||!edge&&(!e.target.closest(handles)||e.target.closest('button,input,textarea,select,a,summary')))return;
      drag={root,id,edge,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,initial,previous:root.dataset.windowPosition==='custom'?initial:null,moved:false};
      root.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();
    },true);
    root.addEventListener('pointermove',e=>{
      if(!drag){const edge=id==='aircraft'&&root.dataset.collapsed==='true'?'':windowResizeEdge(measured(root),e.clientX,e.clientY);root.style.cursor=edge?edge+'-resize':'';return;}
      if(drag.root!==root||drag.pointerId!==e.pointerId)return;
      const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(!drag.moved&&Math.hypot(dx,dy)<4)return;
      drag.moved=true;root.classList.add('window-dragging');stage.classList.add('window-dragging');
      const initial=drag.initial,height=id==='aircraft'?initial.height:Math.min(initial.height,bounds().height*.72);
      drag.rect=apply(root,drag.edge?resizeWindow(initial,drag.edge,dx,dy,bounds()):{...initial,height,x:initial.x+dx,y:initial.y+dy});e.preventDefault();e.stopPropagation();
    });
    root.addEventListener('pointerup',e=>{if(drag?.root===root&&drag.pointerId===e.pointerId){finish(true);e.preventDefault();e.stopPropagation();}});
    root.addEventListener('pointercancel',()=>{if(drag?.root===root)finish(false);});
    root.addEventListener('lostpointercapture',()=>{if(drag?.root===root)finish(false);});
    root.addEventListener('dblclick',e=>{if(e.target.closest(handles)&&!e.target.closest('button,input,textarea,select,a,summary')){finish(false);reset(id);e.preventDefault();}});
    root.addEventListener('keydown',e=>{
      if(!e.target.matches('[data-window-handle]'))return;
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;
      const current=measured(root),step=e.shiftKey?40:10;
      positions[id]=apply(root,{...current,x:current.x+delta[0]*step,y:current.y+delta[1]*step});save();e.preventDefault();e.stopPropagation();
    });
  }
  resizeOverlay.addEventListener('pointerdown',e=>{
    const edge=e.target.dataset.resizeEdge;if(e.button!==0||!edge||!resizeTarget)return;const {id,root}=resizeTarget,initial=measured(root);root.style.setProperty('--window-z',String(++z));
    drag={root,id,edge,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,initial,previous:root.dataset.windowPosition==='custom'?initial:null,moved:false};root.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();syncResizeOverlay();
  });
  stage.addEventListener('pointermove',e=>{if(!drag&&!e.target.closest('[data-floating-window],.window-resize-overlay')){resizeTarget=null;resizeOverlay.hidden=true;}});
  const visible=new Map();
  function arrange(force=false){if(stage.classList.contains?.('route-edit-mode'))return;const requests=[];for(const [id,root]of panes){const rect=measured(root),shown=!root.hidden&&rect.width>0&&rect.height>0;if(id!=='aircraft'&&shown&&(force||!visible.get(id)&&!positions[id]))requests.push({id,root,rect});visible.set(id,shown);}if(!requests.length)return;const obstacles=getObstacles();for(const {id,root,rect}of requests)if(obstacles.length){const target=chooseWindowPlacement(rect,bounds(),obstacles);if(force||target.x!==rect.x||target.y!==rect.y){const placed=apply(root,target);if(force)positions[id]=placed;}}if(force)save();}
  const observer=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'&&[...r.addedNodes].some(node=>node.nodeType===1)))for(const root of panes.values())decorate(root);if(records.some(r=>r.type==='attributes'&&(r.target===stage||[...panes.values()].includes(r.target)))){arrange();syncResizeOverlay();}});observer.observe(stage,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden']});arrange();
  const aircraft=panes.get('aircraft'),statusResize=aircraft?new ResizeObserver(()=>{if(!drag&&aircraft.dataset.collapsed!=='true'&&positions.aircraft)apply(aircraft,{...positions.aircraft,x:measured(aircraft).x,y:measured(aircraft).y});}):null;
  if(aircraft)statusResize.observe(aircraft);
  const resize=()=>{finish(false);for(const [id,root]of panes)if(positions[id]){const rect=id==='aircraft'?{...positions[id],width:measured(root).width,height:measured(root).height}:positions[id];apply(root,rect);}syncResizeOverlay();};
  win.addEventListener('resize',resize);win.addEventListener('blur',()=>finish(false));
  const escape=e=>{if(e.key==='Escape'&&drag){finish(false);e.preventDefault();e.stopImmediatePropagation();}};doc.addEventListener('keydown',escape,true);
  const resetButton=doc.createElement('button');resetButton.id='reset-window-layout';resetButton.type='button';resetButton.textContent='恢复窗口默认位置';resetButton.onclick=()=>{finish(false);for(const id of panes.keys())reset(id);};stage.querySelector('#settings-tools')?.append(resetButton);
  const arrangeButton=doc.createElement('button');arrangeButton.id='arrange-window-layout';arrangeButton.type='button';arrangeButton.textContent='窗口避让飞机与航路';arrangeButton.onclick=()=>{finish(false);arrange(true);};stage.querySelector('#settings-tools')?.append(arrangeButton);
  win.addEventListener('pagehide',()=>{finish(false);observer.disconnect();statusResize?.disconnect();win.removeEventListener('resize',resize);doc.removeEventListener('keydown',escape,true);},{once:true});
  return {resetAll:()=>resetButton.onclick()};
}
