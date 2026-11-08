const keep=el=>el.matches('#scene,.ac-labels,#route-cursor-preview');
const windowSelector='[data-floating-window],#settings-panel,.command-panel,#unit-panel,#mission-brief,#training-coach,#selected-aircraft-status';
const visibilityClasses=['panels-hidden','voice-open','report-open','radio-open','training-card-open'];

// 暂时隐藏界面，不关闭窗口、不写入布局存储；退出时还原进入前的窗口状态。
export function initRouteEditFocus({stage=document.querySelector('#stage'),doc=document,win=window}={}){
  const canvas=stage.querySelector('#scene');let snapshot=null;canvas.tabIndex=-1;
  function setEnabled(enabled){
    if(enabled){
      if(snapshot)return;
      snapshot={focus:doc.activeElement,classes:visibilityClasses.map(name=>[name,stage.classList.contains(name)]),
        windows:[...stage.querySelectorAll(windowSelector)].map(el=>({el,hidden:el.hidden,scrollTop:el.scrollTop,scrollLeft:el.scrollLeft})),
        inert:[...stage.children].filter(el=>!keep(el)).map(el=>[el,!!el.inert])};
      stage.classList.add('route-edit-mode');for(const [el]of snapshot.inert)el.inert=true;canvas.focus({preventScroll:true});
      return;
    }
    if(!snapshot)return;const saved=snapshot;snapshot=null;
    for(const [name,on]of saved.classes)stage.classList.toggle(name,on);
    for(const {el,hidden,scrollTop,scrollLeft}of saved.windows){el.hidden=hidden;el.scrollTop=scrollTop;el.scrollLeft=scrollLeft;}
    for(const [el,inert]of saved.inert)el.inert=inert;
    stage.classList.remove('route-edit-mode');
    const previous=saved.focus;
    const target=previous?.isConnected!==false&&previous?.getClientRects?.().length&&!previous.closest?.('[inert]')?previous:stage.querySelector('#route-menu>summary')??canvas;
    target.focus({preventScroll:true});
  }
  const change=e=>setEnabled(e.detail.enabled);stage.addEventListener('route-edit-focus',change);
  win.addEventListener('pagehide',()=>{stage.removeEventListener('route-edit-focus',change);},{once:true});
  return {setEnabled,get active(){return !!snapshot;}};
}
