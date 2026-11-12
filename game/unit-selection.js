// 多选：Shift+单击切换单位、Shift+拖拽框选；所有批量指令共用这份选择。
import {pickUnit,projectLive} from '../three3d/scene.js';

export function initUnitSelection({getWorld,getSelected,onChange=()=>{},isRouteEdit=()=>false}){
  const ids=new Set();
  let pending=null,box=null;
  function alive(idsList){const w=getWorld();return idsList.filter((id)=>w?.units.some((u)=>u.id===id&&u.alive!==false));}
  function setPrimary(id){ids.clear();if(id)ids.add(id);onChange();}
  function toggle(id){if(!id)return;if(ids.has(id))ids.delete(id);else ids.add(id);if(!ids.size){const primary=getSelected();if(primary)ids.add(primary);}onChange();}
  function selectMany(list){ids.clear();for(const id of alive(list))ids.add(id);if(!ids.size){const primary=getSelected();if(primary&&alive([primary]).length)ids.add(primary);}onChange();}
  function boxElement(){
    if(box)return box;
    box=document.createElement('div');
    Object.assign(box.style,{position:'fixed',border:'1px solid #9de8bb',background:'rgba(113,207,160,.12)',pointerEvents:'none',zIndex:'700',display:'none'});
    document.body.append(box);return box;
  }
  const canvas=document.querySelector('#scene');
  document.addEventListener('pointerdown',(event)=>{
    if(event.target!==canvas||event.button!==0||!event.shiftKey||isRouteEdit())return;
    if(pickUnit(event.clientX,event.clientY)){pending={x0:event.clientX,y0:event.clientY,start:event.clientX,startY:event.clientY,mode:'click'};}
    else pending={x0:event.clientX,y0:event.clientY,start:event.clientX,startY:event.clientY,mode:'box'};
    event.stopPropagation();event.preventDefault();
  },true);
  document.addEventListener('pointermove',(event)=>{
    if(!pending)return;
    if(pending.mode==='box'&&Math.hypot(event.clientX-pending.x0,event.clientY-pending.y0)>6){
      const el=boxElement(),x=Math.min(pending.x0,event.clientX),y=Math.min(pending.y0,event.clientY);
      Object.assign(el.style,{display:'block',left:`${x}px`,top:`${y}px`,width:`${Math.abs(event.clientX-pending.x0)}px`,height:`${Math.abs(event.clientY-pending.y0)}px`});
      event.stopPropagation();
    }
  },true);
  document.addEventListener('pointerup',(event)=>{
    if(!pending||event.button!==0)return;
    const start=pending;pending=null;
    if(box)box.style.display='none';
    if(start.mode==='click'){
      const id=pickUnit(event.clientX,event.clientY);
      if(id&&Math.hypot(event.clientX-start.x0,event.clientY-start.y0)<6)toggle(id);
      return;
    }
    const left=Math.min(start.x0,event.clientX),right=Math.max(start.x0,event.clientX),top=Math.min(start.y0,event.clientY),bottom=Math.max(start.y0,event.clientY);
    if(right-left<8||bottom-top<8)return;
    const world=getWorld(),picked=[];
    for(const unit of world?.units??[]){
      if(unit.alive===false)continue;
      const point=projectLive(unit.position);
      if(point&&point.x>=left&&point.x<=right&&point.y>=top&&point.y<=bottom)picked.push(unit.id);
    }
    selectMany(picked);
    event.stopPropagation();
  },true);
  // 普通单击只选一架：同步主选择
  document.addEventListener('pointerup',(event)=>{
    if(event.target!==canvas||event.button!==0||event.shiftKey||pending)return;
    const id=pickUnit(event.clientX,event.clientY);
    if(id)setPrimary(id);
  },true);
  const first=getSelected();
  if(first)ids.add(first);
  return {
    ids(){return alive([...ids]);},
    setPrimary,toggle,selectMany,
    get size(){return alive([...ids]).length;}
  };
}
