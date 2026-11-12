// 2D 战术叠加层：战争迷雾符号 + 套在单位上的 RWR 盘。
// 只读 world 状态并投影到屏幕；不拦截鼠标，不参与仿真。
import {projectLive} from '../three3d/scene.js';
import {airspaceZones,AIRSPACE_STANDARD_LABELS} from '../sim/airspace.js';
import {unitHeadingRad} from '../sim/flight.js';

const LEVEL_RADIUS = {search: .92, track: .66, launch: .44};
const LEVEL_COLOR = {search: '#8fb8d8', track: '#ffd38c', launch: '#ff8f8f'};
const teamOf = (u) => u?.team ?? u?.faction ?? 'blue';

export function initTacticalOverlay() {
  const canvas = document.createElement('canvas');
  canvas.id = 'tactical-overlay';
  Object.assign(canvas.style, {position:'fixed',inset:'0',width:'100vw',height:'100vh',pointerEvents:'none',zIndex:'560'});
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  function onScreen(p, pad = 80) { return p && p.x > -pad && p.x < innerWidth + pad && p.y > -pad && p.y < innerHeight + pad ? p : null; }
  function diamond(x, y, r, stroke, fill = 'rgba(6,20,16,.55)', dash = null) {
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = stroke; ctx.stroke();
    ctx.restore();
  }
  function label(text, x, y, color, size = 11) {
    ctx.font = `${size}px Consolas, "Microsoft YaHei", monospace`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function rcsRadius(rcs) { return rcs == null ? 8 : Math.max(6, Math.min(13, 8 * Math.pow(Math.max(.05, rcs), .25))); }
  function rcsGrade(rcs) { return rcs == null ? '' : rcs < 3 ? '小' : rcs < 15 ? '中' : '大'; }
function drawAirspace(world) {
  const zones=airspaceZones(world.airspaceStandard);
  if(!zones.length)return;
  ctx.save();
  ctx.setLineDash([6,5]);ctx.lineWidth=1;
  ctx.font='10px Consolas,"Microsoft YaHei",monospace';
  for(const zone of zones){
    const points=[];
    let allVisible=true;
    if(zone.radiusM!=null){
      const segments=192;
      for(let i=0;i<segments;i++){
        const a=i/segments*Math.PI*2;
        const p=projectLive([zone.center[0]+Math.cos(a)*zone.radiusM,zone.center[1]+Math.sin(a)*zone.radiusM,0]);
        if(p?.visible)points.push(p);else{points.push(null);allVisible=false;}
      }
    }else if(Array.isArray(zone.polygon)){
      for(const [x,y] of zone.polygon){
        const p=projectLive([x,y,0]);
        if(p?.visible)points.push(p);else{points.push(null);allVisible=false;}
      }
    }
    if(points.filter(Boolean).length<2)continue;
    const color=zone.color??'#8fb8d8';
    ctx.strokeStyle=color;ctx.fillStyle=color+'0c';ctx.lineJoin='round';
    // 只连相邻且都在相机前方的点；被相机平面裁掉的弧段直接断开，避免放大后跨屏连线。
    const strokeRun=(run,close=false)=>{if(run.length<2)return;ctx.beginPath();run.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));if(close)ctx.closePath();ctx.stroke();};
    if(zone.radiusM!=null){
      let run=[];
      for(const p of points){
        if(p)run.push(p);
        else{strokeRun(run);run=[];}
      }
      strokeRun(run);
      if(allVisible){
        ctx.beginPath();
        points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
        ctx.closePath();ctx.fill();
      }
    }else{
      const n=points.length;
      for(let i=0;i<n;i++){const a=points[i],b=points[(i+1)%n];if(a&&b)strokeRun([a,b]);}
      if(allVisible){
        ctx.beginPath();
        points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
        ctx.closePath();ctx.fill();
      }
    }
    const anchor=pointOrNull(zone.radiusM!=null?zone.center:zone.polygon[0]);
    if(anchor){ctx.fillStyle=color;ctx.fillText(`${zone.type} · ${zone.name}`,anchor.x+6,anchor.y-6);}
  }
  ctx.strokeStyle='#7f97a8';ctx.setLineDash([]);ctx.fillStyle='#7f97a8';
  ctx.fillText(`空域标准：${AIRSPACE_STANDARD_LABELS[world.airspaceStandard]??world.airspaceStandard}`,12,24);
  ctx.restore();
}
function pointOrNull(point){
  if(!point)return null;
  const p=projectLive([point[0],point[1],0]);
  return p&&p.visible&&p.x>-50&&p.x<innerWidth+50&&p.y>-50&&p.y<innerHeight+50?p:null;
}
function drawRadarScan(world, selectedId) {
  const unit=world.units.find(u=>u.id===selectedId)??null;
  const r=unit?.radar;
  if(!r?.available||r.mode==='off'||r.silent)return;
  const half=r.scanHalfDeg??r.config.azimuthHalfDeg;
  const center=(unitHeadingRad(unit)*180/Math.PI+(r.scanCenterDeg??0)+360)%360;
  const origin=projectLive(unit.position);
  if(!origin)return;
  // 真实探测距离可能是 60km，近距离视角会大出屏幕；用一个约 150px 的自适应半径画方向/宽度，标签保留真实范围。
  const sample=projectLive([unit.position[0]+Math.sin(center*Math.PI/180)*10000,unit.position[1]+Math.cos(center*Math.PI/180)*10000,unit.position[2]]);
  const pxPerM=sample?Math.hypot(sample.x-origin.x,sample.y-origin.y)/10000:0;
  const visualRange=Math.min(r.config.rangeM,Math.max(2500,150/Math.max(pxPerM,1e-9)));
  const z=unit.position[2],arc=[];
  for(let i=0;i<=28;i++){
    const bearing=(center-half+2*half*i/28)*Math.PI/180;
    const p=projectLive([unit.position[0]+Math.sin(bearing)*visualRange,unit.position[1]+Math.cos(bearing)*visualRange,z]);
    if(p?.visible)arc.push(p);
  }
  if(arc.length<2)return;
  ctx.save();
  ctx.fillStyle='rgba(101,230,255,.07)';ctx.strokeStyle='rgba(101,230,255,.8)';ctx.lineWidth=1.6;
  ctx.beginPath();ctx.moveTo(origin.x,origin.y);for(const p of arc)ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.setLineDash([5,5]);ctx.strokeStyle='rgba(101,230,255,.4)';
  ctx.beginPath();ctx.moveTo(origin.x,origin.y);ctx.lineTo(arc[0].x,arc[0].y);ctx.moveTo(origin.x,origin.y);ctx.lineTo(arc.at(-1).x,arc.at(-1).y);ctx.stroke();
  ctx.setLineDash([]);
  const mid=projectLive([unit.position[0]+Math.sin(center*Math.PI/180)*visualRange,unit.position[1]+Math.cos(center*Math.PI/180)*visualRange,z]);
  if(mid?.visible){ctx.strokeStyle='rgba(101,230,255,.5)';ctx.beginPath();ctx.moveTo(origin.x,origin.y);ctx.lineTo(mid.x,mid.y);ctx.stroke();}
  ctx.fillStyle='#65e6ff';ctx.font='11px Consolas,"Microsoft YaHei",monospace';
  const labelAt=arc[Math.floor(arc.length/2)];
  ctx.fillText(`雷达扫描 ±${Math.round(half)}° · ${(r.config.rangeM/1000).toFixed(0)} km · ${r.mode==='pd'?'PD':'SRC'}`,Math.min(labelAt.x+8,innerWidth-230),Math.max(14,labelAt.y-8));
  ctx.restore();
}
function drawTutorialMarker(world, selectedId) {
  const marker=world.tutorialMarker;
  if(!marker?.position)return;
  const unit=world.units.find(u=>u.id===selectedId)??world.units.find(u=>teamOf(u)==='blue');
  const range=unit?Math.hypot(unit.position[0]-marker.position[0],unit.position[1]-marker.position[1]):null;
  const raw=projectLive(marker.position),pad=46;
  const onscreen=raw.visible&&raw.x>pad&&raw.x<innerWidth-pad&&raw.y>pad&&raw.y<innerHeight-pad;
  if(!onscreen){
    let dx,dy;
    if(raw.visible){dx=raw.x-innerWidth/2;dy=raw.y-innerHeight/2;}
    else if(unit){const bearing=Math.atan2(marker.position[0]-unit.position[0],marker.position[1]-unit.position[1]),rel=bearing-unitHeadingRad(unit);dx=Math.sin(rel);dy=-Math.cos(rel);}
    else{dx=0;dy=-1;}
    const len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
    const cx=innerWidth/2,cy=innerHeight/2;
    const k=Math.min((innerWidth/2-pad)/Math.max(1e-6,Math.abs(nx)),(innerHeight/2-pad)/Math.max(1e-6,Math.abs(ny)));
    const x=cx+nx*k,y=cy+ny*k;
    ctx.save();ctx.fillStyle='#65e6ff';ctx.strokeStyle='#65e6ff';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(x+nx*13,y+ny*13);ctx.lineTo(x-nx*9+ny*7,y-ny*9-nx*7);ctx.lineTo(x-nx*9-ny*7,y-ny*9+nx*7);ctx.closePath();ctx.fill();
    ctx.font='11px Consolas,"Microsoft YaHei",monospace';ctx.fillText(`${marker.label??'拦截点'}${range!=null?` · ${(range/1000).toFixed(1)} km`:''}`,Math.min(x+10,innerWidth-170),Math.max(14,y-10));
    ctx.restore();return;
  }
  const p=raw;
  ctx.save();
  ctx.strokeStyle='#65e6ff';ctx.fillStyle='#65e6ff';ctx.lineWidth=1.8;
  ctx.setLineDash([5,4]);
  const own=unit?onScreen(projectLive(unit.position),80):null;
  if(own){ctx.beginPath();ctx.moveTo(own.x,own.y);ctx.lineTo(p.x,p.y);ctx.stroke();}
  ctx.setLineDash([]);
  const pulse=.5+.5*Math.abs(Math.sin(performance.now()/380));
  ctx.globalAlpha=.55+.35*pulse;ctx.beginPath();ctx.arc(p.x,p.y,15+3*pulse,0,Math.PI*2);ctx.stroke();
  ctx.globalAlpha=1;ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fill();
  ctx.font='11px Consolas,"Microsoft YaHei",monospace';
  ctx.fillText(`${marker.label??'拦截点'}${range!=null?` · ${(range/1000).toFixed(1)} km`:''}`,Math.min(p.x+12,innerWidth-180),p.y-10);
  ctx.restore();
}
function drawKnowledge(world) {
    for (const item of world.knowledge ?? []) {
      const p = onScreen(projectLive(item.position));
      if (!p) continue;
      if (item.state === 'radar') {
        diamond(p.x, p.y, rcsRadius(item.rcs), '#9de8bb');
        label('?', p.x - 3, p.y + 4, '#9de8bb', 11);
        if (item.ageSec > 1) label(`${item.ageSec.toFixed(0)}s`, p.x + 12, p.y - 2, '#7fa6bf', 9);
      } else if (item.state === 'identified') {
        const id = item.identification ?? {};
        diamond(p.x, p.y, rcsRadius(item.rcs), '#9de8bb');
        label(`${id.type ?? id.category ?? '已识别'}${rcsGrade(item.rcs) ? '·RCS'+rcsGrade(item.rcs) : ''}`, p.x + 12, p.y - 2, '#cfe3f5', 10);
        label(`NCTR ${Math.round((id.confidence ?? 0) * 100)}%`, p.x + 12, p.y + 10, '#7fa6bf', 9);
        if (item.rcs != null) label(`RCS ${item.rcs}`, p.x + 12, p.y + 22, '#7fa6bf', 9);
      } else if (item.state === 'ghost') {
        diamond(p.x, p.y, 7, 'rgba(140,165,180,.75)', 'rgba(8,16,22,.35)', [3, 3]);
        label(`最后 ${item.ageSec.toFixed(0)}s`, p.x + 11, p.y + 3, 'rgba(140,165,180,.8)', 9);
      } else if (item.state === 'visual') {
        label(item.callsign ?? item.id, p.x + 12, p.y + 4, '#cfe3f5', 10);
      }
    }
  }

  function rwrRing(unit, radiusPx) {
    const center = projectLive(unit.position);
    if (!center) return null;
    const probe = projectLive([unit.position[0] + 1000, unit.position[1], unit.position[2]]);
    const pxPerM = probe ? Math.hypot(probe.x - center.x, probe.y - center.y) / 1000 : 0;
    if (!(pxPerM > 1e-9)) return null;
    const R = radiusPx / pxPerM;
    const at = (bearingDeg) => {
      const a = bearingDeg * Math.PI / 180;
      return projectLive([unit.position[0] + Math.sin(a) * R, unit.position[1] + Math.cos(a) * R, unit.position[2]]);
    };
    const points = [];
    for (let i = 0; i < 48; i++) points.push(at(i * 7.5));
    const valid = points.filter(Boolean);
    if (valid.length < 8) return null;
    const bottom = valid.reduce((a, b) => (b.y > a.y ? b : a));
    return { center, R, at, points, bottom };
  }

  function drawRwrDial(unit, selected, now, empty = false) {
    const ring = rwrRing(unit, selected ? 72 : 36);
    if (!ring) return;
    const headingDeg = (unitHeadingRad(unit) * 180 / Math.PI + 360) % 360;
    ctx.save();
    ctx.strokeStyle = selected ? 'rgba(113,207,160,.55)' : 'rgba(113,207,160,.32)';
    ctx.lineWidth = selected ? 1.4 : 1;
    ctx.beginPath();
    for (let i = 0; i < ring.points.length; i++) {
      const p = ring.points[i];
      if (!p) continue;
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath(); ctx.stroke();
    const latestEvent = (unit.rwr?.events ?? []).at(-1);
    if (latestEvent && now - latestEvent.time < 1.5 && ['detected', 'escalated', 'assessment'].includes(latestEvent.type)) {
      const alertColor = latestEvent.level === 'launch' ? '#ff8f8f' : latestEvent.level === 'track' ? '#ffd38c' : '#8fb8d8';
      const fade = 1 - (now - latestEvent.time) / 1.5;
      ctx.strokeStyle = alertColor;
      ctx.globalAlpha = .25 + .45 * Math.max(0, fade);
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < ring.points.length; i++) { const p = ring.points[i]; if (!p) continue; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = selected ? 1.4 : 1;
    }
    if (selected) {
      const inner = rwrRing(unit, 48);
      if (inner) {
        ctx.strokeStyle = 'rgba(113,207,160,.25)';
        ctx.beginPath();
        for (let i = 0; i < inner.points.length; i++) { const p = inner.points[i]; if (!p) continue; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
        ctx.closePath(); ctx.stroke();
      }
      const nose = ring.at(headingDeg);
      if (nose) {
        ctx.strokeStyle = 'rgba(157,232,187,.9)';
        ctx.beginPath(); ctx.moveTo(ring.center.x, ring.center.y); ctx.lineTo(nose.x, nose.y); ctx.stroke();
      }
      const status = empty ? (unit.surface?.grounded ? 'RWR · 地面' : 'RWR · 无告警') : 'RWR';
      label(status, ring.bottom.x - 30, ring.bottom.y + 14, '#9cdfb7', 9);
    }
    const fresh = (unit.rwr?.contacts ?? []).filter((c) => now - c.observedAt <= 2.5);
    const precision = unit.rwr?.config?.digitalLevel ?? 'high';
    for (const contact of fresh) {
      const color = LEVEL_COLOR[contact.level] ?? '#8fb8d8';
      const text = contact.level === 'launch' ? '发射' : contact.level === 'track' ? '跟踪' : '搜索';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6;
      const p = ring.at(contact.bearingDeg);
      if (!p) continue;
      if (precision === 'low') {
        const a = ring.at(contact.bearingDeg - 15), b = ring.at(contact.bearingDeg + 15);
        if (a && b) { ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        if (selected) label(`±15° ${text}`, p.x + 7, p.y - 5, color, 9);
        continue;
      }
      if (contact.level === 'search') {
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x + 5, p.y + 3); ctx.lineTo(p.x - 5, p.y + 3); ctx.closePath(); ctx.stroke();
      } else if (contact.level === 'track') {
        diamond(p.x, p.y, 4.5, color, 'transparent');
      } else {
        const pulse = .55 + .45 * Math.abs(Math.sin(now * 6));
        ctx.globalAlpha = pulse;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x + 6, p.y + 4); ctx.lineTo(p.x - 6, p.y + 4); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (selected || precision === 'high') label(`${Math.round(contact.bearingDeg)}° ${text}`, p.x + 7, p.y - 5, color, 9);
    }
    ctx.restore();
  }

  function drawWorld(world, selectedId) {
    const now = world.time;
    // 全局迷雾：所有友机只显示各自真实收到的 RWR 告警；没有告警的友机不画，选中机画空环状态。
    for (const unit of world.units) {
      if (unit.alive === false || teamOf(unit) !== 'blue' || !unit.rwr?.available) continue;
      const fresh = (unit.rwr?.contacts ?? []).some((c) => now - c.observedAt <= 2.5);
      if (!fresh && unit.id !== selectedId) continue;
      drawRwrDial(unit, unit.id === selectedId, now, !fresh);
    }
  }

  function drawSelection(world, selectedIds) {
    for (const id of selectedIds ?? []) {
      const unit = world.units.find((u) => u.id === id && u.alive !== false);
      if (!unit) continue;
      const p = onScreen(projectLive(unit.position), 40);
      if (!p) continue;
      const r = id === selectedIds[0] ? 22 : 18;
      ctx.save();
      ctx.strokeStyle = id === selectedIds[0] ? '#9de8bb' : 'rgba(157,232,187,.65)';
      ctx.lineWidth = 1.6;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(p.x + sx * r, p.y + sy * (r - 8));
        ctx.lineTo(p.x + sx * r, p.y + sy * r);
        ctx.lineTo(p.x + sx * (r - 8), p.y + sy * r);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawPreview(preview) {
    if (!preview?.from || !preview?.to) return;
    const from = onScreen(projectLive(preview.from), 60), to = onScreen(projectLive(preview.to), 60);
    if (!from || !to) return;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(143,216,255,.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(to.x, to.y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '11px Consolas, "Microsoft YaHei", monospace';
    ctx.fillStyle = '#bfe6ff';
    ctx.fillText(preview.label ?? '', Math.min(to.x + 12, innerWidth - 160), Math.max(to.y - 10, 14));
    ctx.restore();
  }

  function drawRadarFocus(world, focus) {
    if (!focus) return;
    const unit = world.units.find((u) => u.id === focus.unitId);
    const radar = unit?.radar;
    if (!radar) return;
    const contact = radar.contacts.find((c) => c.id === (focus.targetId ?? focus.selectedContactId));
    if (!contact) return;
    const ownPoint = projectLive(unit.position), targetPoint = projectLive(contact.position);
    const from = onScreen(ownPoint, 60), to = onScreen(targetPoint, 60);
    const locked = !!focus.targetId;
    const color = locked ? '#ffc97d' : '#9de8bb';
    // 目标在屏幕外时，在屏幕边缘画指向箭头，保证 R（轮换）/K（锁定）在三维视图里始终有反馈。
    if (!to || !from) {
      const dx = targetPoint.x - innerWidth / 2, dy = targetPoint.y - innerHeight / 2;
      const len = Math.max(1, Math.hypot(dx, dy));
      const margin = 48;
      const tEdge = Math.min((innerWidth / 2 - margin) / Math.max(1, Math.abs(dx)), (innerHeight / 2 - margin) / Math.max(1, Math.abs(dy)));
      const x = innerWidth / 2 + dx * tEdge, y = innerHeight / 2 + dy * tEdge;
      const angle = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, 7); ctx.closePath(); ctx.fill();
      ctx.rotate(-angle);
      ctx.font = '11px Consolas, "Microsoft YaHei", monospace';
      ctx.fillText(`${locked ? 'LOCK' : '选中'} ${contact.callsign ?? contact.id} ${Math.round(contact.rangeM / 1000)}km`, x - (dx > 0 ? 110 : -10), y - 14);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = locked ? 2.2 : 1.8;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    const r = locked ? 16 : 13;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(to.x + sx * r, to.y + sy * (r - 6)); ctx.lineTo(to.x + sx * r, to.y + sy * r); ctx.lineTo(to.x + sx * (r - 6), to.y + sy * r); }
    ctx.stroke();
    ctx.font = '11px Consolas, "Microsoft YaHei", monospace';
    ctx.fillStyle = color;
    ctx.fillText(locked ? `LOCK ${contact.callsign ?? contact.id}` : `选中 ${contact.callsign ?? contact.id}`, to.x + r + 4, to.y - r);
    ctx.restore();
  }

  return {
    update(world, selectedId, selectedIds = [selectedId], preview = null, radarFocus = null) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (!world) return;
      if (preview) drawPreview(preview);
      drawAirspace(world);
      drawRadarScan(world, selectedId);
      drawTutorialMarker(world, selectedId);
      drawKnowledge(world);
      drawRadarFocus(world, radarFocus);
      drawSelection(world, selectedIds.filter(Boolean));
      drawWorld(world, selectedId);
    }
  };
}
