import {OFFENSE_POLICIES,DEFENSE_POLICIES,DIRECT_MANEUVERS} from '../sim/tactical-guidance.js';
import {getLanguages,onLanguageChange} from './language.js';
const KEYS={KeyR:'offense',KeyT:'defense',KeyC:'maneuver'};
export const WHEEL_TABLES={offense:OFFENSE_POLICIES,defense:DEFENSE_POLICIES,maneuver:DIRECT_MANEUVERS};
export const WHEEL_CAPACITY=10;
export function wheelPages(category){const entries=Object.entries(WHEEL_TABLES[category]??{});return Array.from({length:Math.ceil(entries.length/WHEEL_CAPACITY)},(_,i)=>entries.slice(i*WHEEL_CAPACITY,(i+1)*WHEEL_CAPACITY));}
export function radialIndex(dx,dy,count,deadZone=34){if(Math.hypot(dx,dy)<deadZone)return -1;return Math.floor((((Math.atan2(dy,dx)+Math.PI/2+Math.PI/count)%(2*Math.PI))+2*Math.PI)%(2*Math.PI)/(2*Math.PI)*count)%count;}
export function initTacticalWheel({stage,getSelectedIds,issue,blocked=()=>false,onOpen=()=>{}}){
  const doc=stage.ownerDocument,win=doc.defaultView,overlay=doc.createElement('div');overlay.id='tactical-wheel';overlay.hidden=true;overlay.dataset.languageSkip='';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');stage.append(overlay);
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('./tactical-wheel.css',import.meta.url).href;doc.head.append(css);
  let active=null,last={x:win.innerWidth/2,y:win.innerHeight/2},selected=-1;const listeners=[];
  const text=(zh,en)=>getLanguages().text==='en'?en:zh;
  const consume=e=>{e.preventDefault();e.stopImmediatePropagation();};
  const typing=e=>e.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const listen=(target,type,fn)=>{target.addEventListener(type,fn,{capture:true,passive:false});listeners.push(()=>target.removeEventListener(type,fn,true));};
  function close(){active=null;selected=-1;overlay.hidden=true;overlay.replaceChildren();stage.classList.remove('tactical-wheel-open');}
  const entries=()=>active?wheelPages(active.category)[active.page]:[];
  function page(delta){if(!active)return;active.page=(active.page+delta+wheelPages(active.category).length)%wheelPages(active.category).length;selected=-1;render();}
  function submit(){const value=active&&entries()[selected]?.[0],request=active;if(!value){close();return;}close();if(blocked())return;void issue({action:request.category==='maneuver'?'maneuver':`${request.category}_policy`,unitIds:request.unitIds,...(request.category==='maneuver'?{maneuver:value}:{value})});}
  function render(){
    if(!active)return;const choices=entries(),count=choices.length,english=getLanguages().text==='en',radius=active.radius;
    overlay.replaceChildren();overlay.style.setProperty('--wheel-x',`${active.x}px`);overlay.style.setProperty('--wheel-y',`${active.y}px`);overlay.style.setProperty('--wheel-size',`${radius*2}px`);
    const ring=doc.createElementNS('http://www.w3.org/2000/svg','svg');ring.setAttribute('viewBox','-160 -160 320 320');ring.classList.add('wheel-sectors');
    for(let i=0;i<count;i++){const a=-Math.PI/2+(i-.5)*2*Math.PI/count,b=a+2*Math.PI/count,p=doc.createElementNS(ring.namespaceURI,'path'),v=(r,t)=>`${r*Math.cos(t)},${r*Math.sin(t)}`;p.setAttribute('d',`M ${v(46,a)} L ${v(158,a)} A 158 158 0 ${count===1?1:0} 1 ${v(158,b)} L ${v(46,b)} A 46 46 0 0 0 ${v(46,a)} Z`);p.dataset.selected=String(selected===i);ring.append(p);}overlay.append(ring);
    choices.forEach(([value,item],i)=>{const angle=-Math.PI/2+i*2*Math.PI/count,button=doc.createElement('button');button.type='button';button.className='wheel-choice';button.dataset.value=value;button.dataset.selected=String(selected===i);button.setAttribute('aria-pressed',String(selected===i));button.textContent=item[english?'en':'zh'];button.title=item.guide??item.en;button.style.left=`${50+Math.cos(angle)*36}%`;button.style.top=`${50+Math.sin(angle)*36}%`;button.onclick=e=>{consume(e);selected=i;submit();};overlay.append(button);});
    const center=doc.createElement('div');center.className='wheel-center';center.textContent=selected<0?text('取消','Cancel'):text('松开发令','Release');overlay.append(center);
    const hint=doc.createElement('div');hint.className='wheel-hint';hint.textContent=({offense:text('R · 进攻方针','R · Offense policy'),defense:text('T · 防御方针','T · Defence policy'),maneuver:text('C · 直接机动','C · Direct manoeuvre')})[active.category]+' · '+text('中心取消 / Esc','Center cancels / Esc');overlay.append(hint);
    overlay.setAttribute('aria-label',hint.textContent);
    const pages=wheelPages(active.category).length;if(pages>1){const controls=doc.createElement('div');controls.className='wheel-pages';for(const [delta,label]of [[-1,'‹'],[1,'›']]){const button=doc.createElement('button');button.type='button';button.textContent=label;button.dataset.wheelPage=String(delta);controls.append(button);}const label=doc.createElement('span');label.textContent=`${active.page+1} / ${pages} · `+text('滚轮 / Tab 换盘','Wheel / Tab');controls.insertBefore(label,controls.lastChild);overlay.append(controls);}
  }
  function open(category,key=null){if(blocked()||!WHEEL_TABLES[category])return;onOpen();const radius=Math.min(Object.keys(WHEEL_TABLES[category]).length>8?230:190,(win.innerWidth-20)/2,(win.innerHeight-100)/2);active={category,key,page:0,radius,unitIds:[...getSelectedIds()],x:Math.max(radius+10,Math.min(win.innerWidth-radius-10,last.x)),y:Math.max(radius+38,Math.min(win.innerHeight-radius-42,last.y))};selected=-1;overlay.hidden=false;stage.classList.add('tactical-wheel-open');render();}
  listen(doc,'keydown',e=>{
    if(active){if(e.code==='Escape'||e.code==='KeyV'||e.ctrlKey||e.altKey||e.metaKey||e.isComposing){close();if(e.code==='Escape')consume(e);return;}consume(e);if(['Tab','PageDown','PageUp'].includes(e.code)){page(e.code==='PageUp'?-1:1);return;}if(/^Digit[0-9]$/.test(e.code)){selected=e.code==='Digit0'?9:Number(e.code.slice(-1))-1;if(selected>=entries().length)selected=-1;render();}return;}
    if(KEYS[e.code]&&!e.repeat&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.isComposing&&!typing(e)&&!blocked()){consume(e);open(KEYS[e.code],e.code);}
  });
  listen(doc,'keyup',e=>{if(active&&e.code===active.key){consume(e);submit();}});
  listen(doc,'pointermove',e=>{last={x:e.clientX,y:e.clientY};if(!active)return;consume(e);if(e.target.closest?.('.wheel-pages'))return;const index=radialIndex(e.clientX-active.x,e.clientY-active.y,entries().length);if(index!==selected){selected=index;render();}});
  listen(doc,'wheel',e=>{if(active){consume(e);if(e.deltaY)page(e.deltaY>0?1:-1);}});
  listen(doc,'pointerdown',e=>{if(active){consume(e);if(e.button===2)close();}});
  listen(doc,'pointerup',e=>{if(active){consume(e);const change=e.target.closest?.('[data-wheel-page]');if(change){page(Number(change.dataset.wheelPage));return;}if(!active.key)submit();}});
  listen(doc,'contextmenu',e=>{if(active)consume(e);});
  listen(win,'blur',close);listen(win,'resize',close);listen(doc,'visibilitychange',()=>{if(doc.hidden)close();});listen(doc,'focusin',e=>{if(typing(e))close();});
  const stopLanguage=onLanguageChange(render);
  return {open,close,get active(){return active;},dispose(){close();for(const stop of listeners)stop();stopLanguage();overlay.remove();css.remove();}};
}
