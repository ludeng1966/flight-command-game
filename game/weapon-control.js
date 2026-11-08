import {MISSILE_MODELS,GUIDANCE_LABELS,MISSILE_PHASES} from '../sim/missiles.js';
import {formatSpeed,formatDistance,formatAltitude} from '../sim/units.js';
import {F16_LOADOUT,F16_LOADOUT_ID} from '../sim/weapons.js';
const states={searching:'搜索与识别',preparing:'导引头准备',engaging:'截获目标',supporting:'导弹在空 · 维持支持',completed:'命中确认 · 任务完成',aborted:'任务中止',exhausted:'额度用尽 · 未确认摧毁',cancelled:'任务已停止'};
const name=id=>{const m=MISSILE_MODELS.get(id);return m?id.startsWith('us_aim_120')?'AIM-120'+id.slice(10).replace(/_default.*|_switzerland.*/,'').toUpperCase().replaceAll('_','-'):m.familyName:id;};
export function initWeaponControl({getWorld,getSelected,onChange,beforeCommand=()=>{}}){
 const css=document.createElement('link');css.rel='stylesheet';css.href='./weapons.css';document.head.append(css);
 const panel=document.createElement('details');panel.id='weapon-control';panel.open=true;
 panel.innerHTML=`<summary>攻击任务 · 飞行员自主执行</summary><div class="weapon-head"><strong id="weapon-phase">等待攻击任务</strong><span id="weapon-roe"></span></div><p id="attack-target"></p><p id="attack-radar"></p><p id="attack-decision" role="status"></p><div id="weapon-inventory" aria-label="实际挂载与飞行员选弹"></div><p id="weapon-guidance"></p><p id="weapon-message" role="status"></p><ol id="attack-process" aria-label="攻击实际执行过程"></ol><output id="weapon-flight"></output><details class="weapon-practice"><summary>演练场景挂载配置</summary><p>F-16固定挂载4枚AIM-120B和2枚AIM-9M。补弹不替飞行员选弹；有本机导弹在空时不能补弹。</p><label>配置变体<select id="weapon-variant"></select></label><button id="weapon-reload">补充所选导弹</button><button id="weapon-add-target">添加前方练习靶</button></details><p class="weapon-help">只需下达攻击任务。飞行员自主搜索、锁定、选弹并判断发射时机。发射不等于命中，结果由实际导弹仿真确认。</p>`;
 document.querySelector('#unit-panel').append(panel);const $=s=>panel.querySelector(s);
 function configurePractice(w){
  const fixed=w.loadoutId===F16_LOADOUT_ID,key=fixed?F16_LOADOUT_ID:'all',select=$('#weapon-variant');if(select.dataset.loadout===key)return;
  const previous=select.value;select.dataset.loadout=key;
  select.replaceChildren(...[...MISSILE_MODELS.values()].filter(m=>!fixed||Object.hasOwn(F16_LOADOUT,m.id)).map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=name(m.id)+' · '+GUIDANCE_LABELS[m.kind];return o;}));
  if([...select.options].some(o=>o.value===previous))select.value=previous;
 }
 const button=document.createElement('button');button.id='weapon-toggle';button.type='button';button.textContent='攻击';button.setAttribute('aria-controls','weapon-control');document.querySelector('#panel-controls').append(button);button.onclick=()=>{if(document.querySelector('#stage').classList.contains('panels-hidden'))document.querySelector('#toggle-panels').click();panel.open=true;panel.querySelector('summary').focus({preventScroll:true});panel.parentElement.scrollTop=panel.offsetTop-panel.parentElement.offsetTop;};
 const operate=callback=>{try{beforeCommand();$('#weapon-message').textContent=callback()??'';onChange();update();}catch(e){$('#weapon-message').textContent=e.message;}};
 $('#weapon-reload').onclick=()=>operate(()=>{getWorld().reloadPracticeMissile(getSelected(),$('#weapon-variant').value);return '场景弹量已补充，实际选弹由飞行员判断';});
 $('#weapon-add-target').onclick=()=>operate(()=>{getWorld().addRadarPracticeTarget(getSelected());return '练习靶已添加，可下达攻击任务';});let lastUnit=null;
 function update(){const world=getWorld(),own=world.units.find(u=>u.id===getSelected()),w=own.weapons,t=own.attackTask;if(!w)return;
  configurePractice(w);
  if(lastUnit!==own){lastUnit=own;$('#weapon-message').textContent='';}
  $('#weapon-phase').textContent=t?.pending?'飞行员判断中':t?own.surface?.grounded&&t.active?'等待离地':states[t.status]??t.status:'等待攻击任务';$('#weapon-phase').dataset.ready=String(w.ready);$('#weapon-roe').textContent=t?.active?`剩余额度 ${t.shotLimit-t.firedMissileIds.length} 枚`:'未授权自主攻击';
  const contacts=[...(own.radar?.contacts??[]),...w.contacts],target=contacts.find(c=>c.id===(t?.engagedTargetId??t?.targetId??w.targetId));$('#attack-target').textContent='任务目标：'+(target?.callsign??t?.targetRef??t?.targetId??(t?.active?'等待本机搜索发现':'未指定'));
  $('#attack-radar').textContent=`雷达 ${own.radar?.mode?.toUpperCase()??'不可用'} · ${own.radar?.phase==='locked'?'稳定锁定':own.radar?.phase==='acquiring'?'截获中':own.radar?.phase==='coasting'?'丢波外推':own.radar?.phase==='search'?'搜索中':'待机'} · 武器${!t?.selectedModelId?'尚未选弹':w.ready?'就绪':w.reason}`;$('#attack-decision').textContent=t?.lastError??t?.lastDecision?.message??'玩家下达任务，电脑飞行员自主完成操作。';
  const key=JSON.stringify([w.inventory,w.selectedModelId,t?.selectedModelId]);if($('#weapon-inventory').dataset.key!==key){$('#weapon-inventory').dataset.key=key;$('#weapon-inventory').replaceChildren(...Object.entries(w.inventory).map(([id,n])=>{const p=document.createElement('div');p.dataset.selected=String(id===t?.selectedModelId);p.textContent=`${id===t?.selectedModelId?'▸ ':''}${name(id)} · ${n} 枚${id===t?.selectedModelId?' · 当前选择':''}`;return p;}));}
  const m=MISSILE_MODELS.get(t?.selectedModelId);$('#weapon-guidance').textContent=m?GUIDANCE_LABELS[m.kind]+' · '+name(m.id):'由飞行员根据任务选择导弹';const entries=t?.events??[],eventKey=JSON.stringify(entries);if($('#attack-process').dataset.key!==eventKey){$('#attack-process').dataset.key=eventKey;$('#attack-process').replaceChildren(...entries.slice(-8).map(e=>{const li=document.createElement('li');li.textContent=`T+${e.time.toFixed(1)} ${e.text}`;return li;}));}
  $('#weapon-reload').disabled=!own.alive||!own.radar?.available||world.missiles.some(m=>m.alive&&m.ownerId===own.id);const flights=world.missiles.filter(m=>m.ownerId===own.id).slice(-4);$('#weapon-flight').textContent=flights.length?flights.map(f=>`${name(f.modelId)} · ${MISSILE_PHASES[f.phase]??f.phase}\n${formatSpeed(f.speedMps)} · M ${f.mach.toFixed(2)} · ${formatAltitude(f.position[2])} · ${f.loadFactor.toFixed(1)} G\n质量 ${f.massKg.toFixed(1)} kg · 推力 ${Math.round(f.thrustN)} N · 飞行 ${f.ageSec.toFixed(1)} s · 航程 ${formatDistance(f.travelM,{digits:1})}`).join('\n\n'):'尚无本机发射记录';
 }
 update();return {update};
}
