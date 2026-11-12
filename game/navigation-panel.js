import {navPanelModel,formatNavDistance,formatEta} from './navigation-panel-model.js';

export function initNavigationPanel({getWorld,getSelected}){
  const button=document.createElement('button');
  button.id='nav-toggle';button.type='button';button.textContent='导航';button.setAttribute('aria-controls','nav-panel');button.setAttribute('aria-expanded','false');
  document.querySelector('#panel-controls')?.append(button);
  const panel=document.createElement('aside');
  panel.id='nav-panel';panel.hidden=true;
  Object.assign(panel.style,{position:'fixed',right:'16px',left:'auto',top:'96px',zIndex:'910',width:'min(92vw,320px)',maxHeight:'46vh',overflow:'auto',
    padding:'10px 12px',border:'1px solid #2a4054',borderRadius:'10px',background:'rgba(7,16,25,.94)',backdropFilter:'blur(8px)',
    font:'12px/1.55 "Microsoft YaHei",Consolas,monospace',color:'#cfe3f5',boxShadow:'0 12px 32px rgba(0,0,0,.45)'});
  document.body.append(panel);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)update();});
  function render(model){
    if(!model){panel.innerHTML='<p style="color:#7f97a8;margin:0">未选择飞机</p>';return;}
    const rows=model.route.slice(0,8).map((w,i)=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid #142433"><span style="color:${i===0?'#9de8bb':'#8aa9bd'}">#${w.number} ${formatNavDistance(w.legM)}</span><span style="color:#7f97a8">${formatEta(w.etaSec)} · ${Math.round(w.altitudeM??0)}m</span></div>`).join('')
      +(model.route.length>8?`<p style="color:#5f7b8e;font-size:10px;margin:4px 0 0">还有 ${model.route.length-8} 个航点…</p>`:'');
    panel.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px"><b style="color:#9de8bb;font-weight:500">导航 · ${esc(model.callsign)}</b><span style="color:#7f97a8;font-size:10px">${model.completed} 个已完成</span></div>
      <p style="margin:0 0 6px;color:#adc3d4">${model.route.length?`下一航点 #${model.next.number} · ${formatNavDistance(model.next.legM)} · ETA ${formatEta(model.next.etaSec)}`:'无航路'}</p>
      ${model.blocked?`<p style="color:#f3a6a6;font-size:11px;margin:0 0 6px">暂缓：${esc(model.blocked)}</p>`:''}
      <div style="margin-bottom:6px">${rows||'<span style="color:#7f97a8">未规划航路</span>'}</div>
      ${model.bullseye?`<p style="margin:4px 0;color:#8fb8d8;font-size:11px">靶眼 ${esc(model.bullseye.name)} · 方位 ${Math.round(model.bullseye.bearingDeg)}° · ${formatNavDistance(model.bullseye.rangeM)}</p>`:''}
      ${model.airspace?`<p style="margin:4px 0;color:#9cdfb7;font-size:11px">空域 ${esc(model.airspace.standard)}${model.airspace.zones.length?' · '+model.airspace.zones.map(z=>esc(z.type)).join(' / '):' · 无'}</p>`:''}
      <p style="margin:4px 0 0;color:#5f7b8e;font-size:10px">只读显示；航路编辑用“航线设置”。</p>`;
  }
  function update(){
    if(panel.hidden)return;
    const world=getWorld(),unit=world?.units.find(u=>u.id===getSelected());
    render(navPanelModel(unit,world));
  }
  return {update};
}
