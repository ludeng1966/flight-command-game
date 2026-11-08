// One shared transcript: new speech reveals the entire list; Alt reveals history.
export function initRadioOverlay({doc=document,win=window,lingerMs=8000}={}){
  const stage=doc.querySelector('#stage'),panel=doc.querySelector('#radio-console'),list=doc.querySelector('#radio-transcript'),toggle=doc.querySelector('#radio-toggle'),close=doc.querySelector('#radio-collapse');
  let held=false,pinned=false,until=0,timer=null,closed=false;
  panel.setAttribute('aria-label','左侧通联字幕与历史');
  toggle.innerHTML='通联 <kbd>Alt</kbd>';toggle.setAttribute('aria-label','查看通联历史，按住Alt并用滚轮回看');
  close.textContent='收起';close.setAttribute('aria-label','收起通联历史');
  const hint=doc.createElement('span');hint.className='radio-history-hint';hint.textContent='按住 Alt · 滚轮回看';panel.querySelector('.radio-console-header>div').append(hint);
  function speaking(){return !!list.querySelector('[data-speaking="true"]');}
  function sync(){
    clearTimeout(timer);if(closed)return;
    const browsing=held||pinned,visible=!!list.children.length&&(browsing||speaking()||Date.now()<until);
    panel.dataset.visible=String(visible);panel.dataset.browsing=String(browsing);panel.setAttribute('aria-hidden',String(!visible));
    stage.classList.toggle('radio-overlay-visible',visible);toggle.setAttribute('aria-expanded',String(browsing));close.setAttribute('aria-expanded',String(browsing));
    list.hidden=false;
    if(visible&&!browsing&&!speaking())timer=setTimeout(sync,Math.max(1,until-Date.now()));
  }
  function reveal(){until=Date.now()+lingerMs;sync();}
  const observer=new MutationObserver(records=>{
    if(records.some(r=>r.type==='childList'&&r.addedNodes.length)){
      if(!held&&!pinned)list.scrollTop=list.scrollHeight;
      reveal();
    }else if(records.some(r=>r.type==='attributes'))reveal();
    else sync();
  });observer.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['data-speaking','data-delivery']});
  toggle.onclick=()=>{pinned=!pinned;if(pinned)list.scrollTop=list.scrollHeight;reveal();};
  close.onclick=()=>{pinned=false;held=false;until=0;sync();};
  const keydown=e=>{if(e.key==='Alt'&&!e.ctrlKey&&!e.metaKey){if(!held){held=true;sync();}e.preventDefault();}else if(e.key==='Escape'&&pinned){pinned=false;held=false;until=0;sync();}};
  const keyup=e=>{if(e.key==='Alt'){held=false;reveal();}};
  const release=()=>{held=false;pinned=false;sync();};
  const wheel=e=>{if(!e.altKey||e.ctrlKey||e.metaKey)return;held=true;sync();list.scrollTop+=e.deltaY;e.preventDefault();e.stopPropagation();};
  doc.addEventListener('keydown',keydown);doc.addEventListener('keyup',keyup);win.addEventListener('blur',release);win.addEventListener('wheel',wheel,{capture:true,passive:false});
  const layout=new ResizeObserver(()=>stage.style.setProperty('--radio-overlay-height',Math.ceil(panel.getBoundingClientRect().height)+'px'));layout.observe(panel);
  win.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);observer.disconnect();layout.disconnect();doc.removeEventListener('keydown',keydown);doc.removeEventListener('keyup',keyup);win.removeEventListener('blur',release);win.removeEventListener('wheel',wheel,true);});
  if(list.children.length)reveal();else sync();
  return {reveal};
}
