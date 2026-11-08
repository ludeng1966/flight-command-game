import {altitudeMeters} from '../sim/units.js';
import {pickWaypoint,pickUnit,pickRouteSegment,pointOnPlane,spaceWaypoint,cameraDistanceTo,verticalDragScale,projectLive,previewWaypoint} from '../three3d/scene.js';
import {showSoft,hideSoft} from './ui-motion.js';
import {routeDraft} from './route-replanner.js';
import {RoutePreview,estimateRoute} from './route-preview.js';
import {simplifySketch,snapSketchPoint,pointDistance,continueSketchRoute} from './route-sketch.js';

// 所有地图航路输入只在此处处理；观察模式没有编辑入口。
export function initRouteEditor({canvas,getWorld,getSelected,onChange,onCommitted=()=>{},onPointPreview=()=>{},message,planner,replanner}){
  const stage=canvas.parentNode,modeButton=document.getElementById('route-edit'),toolbar=document.getElementById('waypoint-tools'),info=document.getElementById('placement-info');
  let mode=false,capsHeld=false,gesture=null,selection=null,hover=null,mouse=null,rightStart=null,worldRef=getWorld(),selectedRef=getSelected(),clicks=[];
  const unit=()=>getWorld().units.find(u=>u.id===getSelected());
  const movingRoute=(u,ref,p)=>u.waypoints.map(w=>w===ref||u.routeLoop&&w.loopIndex===ref.loopIndex?p:w.slice(0,3));
  function clearHover(){hover?.forecaster?.stop();hover=null;}
  // 异步提交结束时保留下一次右键按下状态，避免快速连点被上一笔提交清掉。
  function finish(clearQueue=true){gesture?.forecaster?.stop();gesture=null;if(clearQueue){rightStart=null;clicks=[];}previewWaypoint(null);hideSoft(info);}
  function setMode(value){const wasMode=mode;mode=!!value&&!unit().surface?.grounded;if(wasMode!==mode)stage.dispatchEvent(new CustomEvent('route-edit-focus',{detail:{enabled:mode}}));finish();clearHover();selection=null;modeButton.classList.toggle('active',mode);modeButton.setAttribute('aria-pressed',String(mode));modeButton.textContent=mode?'退出航线设置':'航线设置';canvas.classList.toggle('route-editing',mode);stage.classList.toggle('route-edit-mode',mode);canvas.style.cursor=mode?'crosshair':'';hideSoft(toolbar);if(mode&&mouse)mouse.depth=cameraDistanceTo(unit().position);message(mode?'航线设置：从飞机左键拖出手绘路线；右键替换航路；CapsLock＋右键追加；拖动航点可调整，靠近起点可闭环':'观察模式');onChange();}
  function groundAt(p){return getWorld().terrain?.heightAt?.(p[0],p[1])??(getWorld().terrain?null:0);}
  function validPoint(p){const ground=p&&groundAt(p);return p&&ground!==null&&p[2]>ground;}
  function snap(point,{anchor,previous,targets=[]}={}){return snapSketchPoint(point,{anchor,previous,targets,project:projectLive,screen:mouse,tolerance:14});}
  function card(g){
    // 悬停和右键单点不展示设置预览，仅实际手绘/拖动时反馈修改中的航路。
    if(gesture!==g||g.kind==='place'||g.kind==='draw'&&!g.moved||g.kind==='move'&&pointDistance(g.point,g.startPoint)<.5){previewWaypoint(null);return;}
    if(!mouse||!validPoint(g.point)){previewWaypoint(null,null,{immediate:true});return;}
    const u=unit(),ground=groundAt(g.point),check=getWorld().checkRoute(u.id,g.route),valid=check.valid&&g.plan?.valid!==false;
    previewWaypoint(g.point,u.position,{session:g,route:g.route,ground,valid,estimate:g.estimate,forecast:valid?g.plan?.points:undefined,pending:!g.plan,kind:g.kind});
    onPointPreview(g.point);
  }
  function plan(g){
    if(g.kind==='draw'&&!g.moved||g.kind==='move'&&pointDistance(g.point,g.startPoint)<.5){card(g);return;}
    if(g.kind==='draw'&&g.join){
      if(!unit().waypoints.includes(g.segmentEnd)){finish();message('该航段已通过，结束续绘');return;}
      g.route=continueSketchRoute(unit(),g.drawPoints,g);
    }
    if(!validPoint(g.point)){g.forecaster?.clear();g.key=null;card(g);return;}
    const key=JSON.stringify(g.route),now=performance.now(),clock=getWorld().time;let refresh=false;
    if(g.key!==key){g.key=key;g.plan=null;g.estimate=estimateRoute(unit(),g.route);g.flightClock=clock;g.refreshAt=now+700;}
    else if(clock!==g.flightClock&&now>=g.refreshAt&&!g.forecaster?.busy&&!g.forecaster?.pending){g.flightClock=clock;g.refreshAt=now+700;g.estimate=estimateRoute(unit(),g.route);refresh=true;}
    g.forecaster??=new RoutePreview({planner,channel:'edit',getUnit:unit,onResult:result=>{if(gesture===g||hover===g){g.plan=result;card(g);}}});
    card(g);if(getWorld().checkRoute(unit().id,g.route).valid){g.forecaster.update(g.route);if(refresh)g.forecaster.refresh();}else g.forecaster.clear();
  }
  function updateHover(){
    if(!mode||gesture&&gesture.kind!=='place'||!mouse?.inside||unit().surface?.grounded)return;
    const u=unit(),raw=spaceWaypoint(mouse.x,mouse.y,mouse.depth??cameraDistanceTo(u.position));
    const targets=capsHeld&&u.waypoints.length>=3?[u.waypoints[0]]:[],anchor=capsHeld?u.waypoints.at(-1)??u.position:u.position,previous=capsHeld?u.waypoints.at(-2):null;
    const snapped=snap(raw,{anchor,previous,targets}),point=snapped.point;
    hover??={kind:'hover'};Object.assign(hover,{point,snap:snapped.kind,loop:snapped.kind==='point',route:capsHeld?[...u.waypoints,point]:[point]});if(validPoint(point))onPointPreview(point);
  }
  function startMove(e,index,vertical=false){
    clearHover();const u=unit(),w=u.waypoints[index];selection=w;
    gesture={kind:'move',reference:w,index,anchor:w.slice(),startPoint:w.slice(),point:w.slice(),vertical,startY:e.clientY,scale:verticalDragScale(w),route:movingRoute(u,w,w),revision:u.routeRevision??0};
    canvas.setPointerCapture(e.pointerId);plan(gesture);
  }
  function startDraw(e,hit=null){
    clearHover();const u=unit(),point=(hit?.point??u.position).slice();gesture={kind:'draw',point,stroke:[point],drawPoints:[point],prefix:hit?u.waypoints.slice(0,hit.index):[],join:hit?point:null,segmentEnd:hit?u.waypoints[hit.index]:null,samples:[{x:e.clientX,y:e.clientY}],altitude:point[2],route:[],base:[...u.waypoints],revision:u.routeRevision??0,moved:false};canvas.setPointerCapture(e.pointerId);plan(gesture);
  }
  function move(e){
    const g=gesture;if(!g||g.committing)return;mouse={...mouse,x:e.clientX,y:e.clientY,inside:true};
    if(g.kind==='move'){
      const u=unit();if(!u.waypoints.includes(g.reference)){finish();message('该航点已通过，结束编辑');return;}
      const raw=g.vertical?[g.anchor[0],g.anchor[1],g.anchor[2]+(g.startY-e.clientY)*g.scale]:pointOnPlane(e.clientX,e.clientY,g.anchor[2]);if(!raw)return;
      const targets=g.index===u.waypoints.length-1&&u.waypoints.length>=4?[u.waypoints[0]]:[],snapped=g.vertical?{point:raw}:snap(raw,{anchor:u.waypoints[g.index-1]??u.position,previous:u.waypoints[g.index-2],targets});
      g.point=snapped.point;g.snap=snapped.kind;g.loop=snapped.kind==='point';g.route=movingRoute(u,g.reference,g.point);
    }else if(g.kind==='draw'){
      const raw=pointOnPlane(e.clientX,e.clientY,g.altitude);if(!raw)return;
      const last=g.samples.at(-1);if(Math.hypot(e.clientX-last.x,e.clientY-last.y)>5){g.stroke.push(raw);g.samples.push({x:e.clientX,y:e.clientY});g.moved=true;}
      const start=projectLive(g.stroke[0]),length=g.samples.reduce((sum,p,i)=>sum+(i?Math.hypot(p.x-g.samples[i-1].x,p.y-g.samples[i-1].y):0),0);
      g.loop=g.moved&&g.stroke.length>=4&&length>90&&start.visible&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<16;
      const snapped=g.loop?{point:g.stroke[0],kind:'point'}:snap(raw,{anchor:g.stroke.at(-2)??g.stroke[0],previous:g.stroke.at(-3)});g.point=snapped.point;g.snap=snapped.kind;
      let tolerance=Math.max(80,verticalDragScale(g.point)*6),points=simplifySketch([...g.stroke,g.point],tolerance);while(points.length>16){tolerance*=1.6;points=simplifySketch([...g.stroke,g.point],tolerance);}
      g.drawPoints=points;g.route=continueSketchRoute(unit(),points,g);if(g.loop&&g.route.length<3)g.loop=false;
      if(points.length===2&&g.stroke.length>2)g.snap='line';
    }
    plan(g);
  }
  async function commit(){
    const g=gesture;if(!g||g.committing)return;
    if(!validPoint(g.point)||g.kind==='draw'&&!g.moved||g.kind==='move'&&pointDistance(g.point,g.startPoint)<.5){finish(false);processClicks();return;}
    const world=getWorld(),id=getSelected();g.committing=true;g.forecaster?.stop();planner.cancel('edit');card(g);
    try{
      const intent=g.kind==='move'?{kind:'move',reference:g.reference,point:g.point,revision:g.revision}:g.kind==='place'?{kind:g.append?'append':'command',point:g.point,revision:g.revision}:{kind:'replace',draft:routeDraft(unit(),g.route,g.base),revision:g.revision};
      const result=await replanner.apply(id,intent,{isCurrent:()=>gesture===g&&mode&&getWorld()===world&&getSelected()===id});if(!result)return;
      if(g.loop)world.setRouteLoop(id,true);
      onCommitted(id,{kind:g.kind==='draw'?'replace':intent.kind,point:g.kind==='draw'?undefined:g.point,loop:g.loop});onChange();
      message(g.loop?'环形航路已建立，将持续循环飞行':g.kind==='draw'?'手绘航路已生效 · 已自动提取转折航点':'航路已更新');
    }catch(error){if(gesture===g)message(error.message,true);}
    finally{if(gesture===g){if(mouse)mouse.depth=cameraDistanceTo(g.point);clearHover();finish(false);processClicks();}}
  }
  function processClicks(){
    if(!mode||gesture||!clicks.length)return;const next=clicks.shift(),u=unit();if(next.world!==getWorld()||next.id!==u.id){clicks=[];return;}
    if(next.append&&u.waypoints.length>=3){const first=projectLive(u.waypoints[0]),at=projectLive(next.point);if(first.visible&&at.visible&&Math.hypot(first.x-at.x,first.y-at.y)<14){next.point=u.waypoints[0].slice();next.loop=true;}}
    clearHover();gesture={kind:'place',point:next.point,append:next.append,loop:next.loop,route:next.append?[...u.waypoints,next.point]:[next.point],revision:u.routeRevision??0};commit();
  }
  modeButton.textContent='航线设置';modeButton.onclick=()=>setMode(!mode);
  canvas.addEventListener('pointerenter',e=>{mouse={...mouse,x:e.clientX,y:e.clientY,inside:true,depth:mouse?.depth??cameraDistanceTo(unit().position)};});
  canvas.addEventListener('pointerleave',()=>{if(mouse)mouse.inside=false;if(!gesture)previewWaypoint(null);});
  canvas.addEventListener('pointerdown',e=>{
    mouse={...mouse,x:e.clientX,y:e.clientY,inside:true,depth:mouse?.depth??cameraDistanceTo(unit().position)};if(!mode)return;
    if(e.button===2){e.preventDefault();e.stopImmediatePropagation();if(gesture&&gesture.kind!=='place'){finish();return;}rightStart=[e.clientX,e.clientY];return;}
    if(e.button!==0||gesture)return;
    const index=pickWaypoint(e.clientX,e.clientY);if(index!==null)startMove(e,index,e.altKey);else if(pickUnit(e.clientX,e.clientY)===unit().id)startDraw(e);else{const hit=pickRouteSegment(e.clientX,e.clientY);if(!hit)return;startDraw(e,hit);}
    e.preventDefault();e.stopImmediatePropagation();
  },true);
  canvas.addEventListener('pointermove',e=>{mouse={...mouse,x:e.clientX,y:e.clientY,inside:true};if(!mode)return;if(gesture){if(!gesture.committing)gesture.pendingMove={clientX:e.clientX,clientY:e.clientY};e.stopImmediatePropagation();}},true);
  canvas.addEventListener('pointerup',e=>{
    if(!mode)return;
    if(e.button===2){e.preventDefault();e.stopImmediatePropagation();if(rightStart&&Math.hypot(e.clientX-rightStart[0],e.clientY-rightStart[1])<5){updateHover();const point=hover?.point;if(validPoint(point)){if(!capsHeld)clicks=[];clicks.push({point:point.slice(),append:capsHeld,loop:!!hover.loop,world:getWorld(),id:getSelected()});processClicks();}}rightStart=null;return;}
    if(gesture&&e.button===0&&gesture.kind!=='place'){e.stopImmediatePropagation();move(e);commit();}
  },true);
  canvas.addEventListener('pointercancel',()=>{finish();clearHover();},true);
  canvas.addEventListener('wheel',e=>{
    if(!mode||!mouse?.inside)return;e.preventDefault();e.stopImmediatePropagation();
    if(gesture&&!gesture.committing){const g=gesture,direction=Math.sign(-e.deltaY);if(g.kind==='draw')g.altitude+=direction*altitudeMeters(100);else if(g.kind==='move')g.anchor[2]+=direction*altitudeMeters(100);move(mouse);}
    else{mouse.depth=Math.max(300,Math.min(150000,(mouse.depth??cameraDistanceTo(unit().position))*Math.exp(e.deltaY*.0015)));updateHover();}
  },{capture:true,passive:false});
  function remove(){if(!mode)return;const u=unit(),index=u.waypoints.indexOf(selection);if(index<0)return;try{getWorld().replaceRoute(u.id,u.waypoints.filter((_,i)=>i!==index));selection=null;onCommitted(u.id,{kind:'delete'});onChange();}catch(error){message(error.message,true);}}
  toolbar.querySelector('[data-action=height]').addEventListener('pointerdown',e=>{const index=unit().waypoints.indexOf(selection);if(mode&&index>=0){e.preventDefault();e.stopPropagation();startMove(e,index,true);}});toolbar.querySelector('[data-action=delete]').onclick=remove;
  const history=redo=>{if(!mode)return;finish();clearHover();try{if(getWorld().undoRoute(unit().id,redo)){onCommitted(unit().id,{kind:redo?'redo':'undo'});onChange();}}catch(error){message(error.message,true);}};
  document.getElementById('route-undo').onclick=()=>history(false);document.getElementById('route-redo').onclick=()=>history(true);
  document.addEventListener('keydown',e=>{
    if(e.code==='CapsLock'&&mode&&(mouse?.inside||!e.target.matches('input,textarea,select,[contenteditable=true]'))){capsHeld=true;e.preventDefault();return;}
    if(e.target.matches('input,textarea,select,[contenteditable=true]'))return;
    if(!mode)return;if(e.key==='Escape'){setMode(false);e.preventDefault();e.stopImmediatePropagation();}if(e.key==='Delete'){e.preventDefault();remove();}
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyZ'){e.preventDefault();history(e.shiftKey);}if((e.ctrlKey||e.metaKey)&&e.code==='KeyY'){e.preventDefault();history(true);}
  });
  document.addEventListener('keyup',e=>{if(e.code==='CapsLock')capsHeld=false;});window.addEventListener('blur',()=>{capsHeld=false;finish();clearHover();if(mouse)mouse.inside=false;});
  return {get active(){return !!gesture;},get enabled(){return mode;},get previewPoint(){return gesture?.point??hover?.point??null;},cancel(){finish();clearHover();selection=null;},frame(){
    if(worldRef!==getWorld()){worldRef=getWorld();setMode(false);}if(mode&&unit().surface?.grounded)setMode(false);
    if(selectedRef!==getSelected()){selectedRef=getSelected();finish();clearHover();selection=null;if(mouse)mouse.depth=cameraDistanceTo(unit().position);}
    if(gesture?.pendingMove){const event=gesture.pendingMove;gesture.pendingMove=null;move(event);}if(!gesture||gesture.kind==='place')updateHover();else if(gesture.point&&!gesture.committing)plan(gesture);
    const u=unit(),index=u.waypoints.indexOf(selection);u.editWaypoint=mode?index:-1;
    if(mode&&index>=0&&!gesture){const at=projectLive(selection);if(at.visible)showSoft(toolbar);else hideSoft(toolbar);toolbar.style.left=Math.max(10,Math.min(innerWidth-170,at.x+16))+'px';toolbar.style.top=Math.max(75,Math.min(innerHeight-130,at.y-45))+'px';toolbar.querySelector('span').textContent=`WP ${selection.number??index+1}`;}else hideSoft(toolbar);
    document.getElementById('route-undo').disabled=!mode||!u.routeUndo?.length;document.getElementById('route-redo').disabled=!mode||!u.routeRedo?.length;
  }};
}
