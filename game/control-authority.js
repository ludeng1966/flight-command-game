import {controlAuthority,requestHandoff,CONTROL_NAMES} from '../sim/control-authority.js';
import {escapeHTML as esc} from './training-store.js';
export function initControlAuthority({getWorld,getSelected,onRequest}){
  const panel=document.querySelector('#control-authority');
  const hint=document.createElement('p');hint.id='command-route-hint';document.querySelector('#command-text').before(hint);let last='',error='';
  function request(target){try{const w=getWorld(),u=w.units.find(u=>u.id===getSelected());if(requestHandoff(w,u,target))onRequest(u.id);error='';}catch(e){error=e.message;}last='';update();}
  function update(){
    const w=getWorld(),u=w.units.find(u=>u.id===getSelected());if(!u)return;const c=controlAuthority(w,u),key=JSON.stringify([u.id,c,w.executionMode,error]);if(key===last)return;last=key;
    panel.dataset.phase=c.phase;
    const who=c.owner==='tower'?`${c.airportId}塔台`:'空中指挥',target=c.target??(c.owner==='commander'?'tower':'commander');
    const field=document.querySelector('#command-text'),label=document.querySelector('label[for="command-text"]');if(label)label.textContent=c.owner==='tower'?'塔台任务 · 指挥官AI核对后发令':'指挥任务 · AI下令';field.placeholder=c.owner==='tower'?`塔台，请安排${u.callsign}……`:`空中指挥，让${u.callsign}巡航……`;
    panel.textContent=c.phase==='transferring'?`管制：${CONTROL_NAMES[c.owner]} · 交接${c.progress}/4`:`管制：${CONTROL_NAMES[c.owner]}`;
    panel.title=`当前管制方：${who}；${c.mode==='manual'?'严苛 · 手动交接':'宽松 · 自动交接'}${c.phase==='ready'?`；等待移交${CONTROL_NAMES[c.target]}`:''}`;panel.setAttribute('aria-label',panel.title);
    const text=c.phase==='transferring'?`正在移交${CONTROL_NAMES[c.target]}（${c.progress}/4），确认接管后继续下令。`:c.owner==='tower'?`当前身份：${who}。指挥官AI核对任务后，直接以塔台身份向飞机发令。`:'当前身份：空中指挥。可下达巡航、航向和导航任务。';
    const canRequest=u.alive&&c.mode==='manual'&&c.phase!=='transferring'&&(c.owner==='commander'||c.phase==='ready');
    hint.innerHTML=`<span>${esc(text)}</span>${canRequest?`<button id="authority-request" type="button">${target==='tower'?'返场联系塔台':'请求交接'}</button>`:''}${error?`<span role="status" class="authority-error">${esc(error)}</span>`:''}`;
    const b=hint.querySelector('#authority-request');if(b)b.onclick=()=>request(target);
  }
  update();return {update,request};
}
