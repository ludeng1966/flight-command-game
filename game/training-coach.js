import {controlAuthority,HANDOFF_STEPS,CONTROL_NAMES} from '../sim/control-authority.js';
import {FlightTrainingSession,TRAINING_STAGES,navigationGeometry} from '../sim/training.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';
import {TRAINING_LEVELS,trainingLevel} from '../sim/training-levels.js';
import {recordResult,loadProgress,escapeHTML as esc} from './training-store.js';
import {formatAltitude,formatSpeed,formatDistance} from '../sim/units.js';
import {selectedAircraftStatus} from '../sim/unit-status.js';
import {groundStatusReport} from '../sim/ground-radio.js';
import {captureTraining,restoreTraining} from '../sim/training-state.js';
const EXAM_LABELS={departure:'离场',cruise:'稳定巡航',waypoint:'实际到达目的航点',recovery:'着陆回机位'};
const PHASES={parked:'机位停放',taxi:'地面滑行',holding:'跑道外等待',lineup_taxi:'进入跑道',lined_up:'对正待命',takeoff_roll:'起飞滑跑',climb:'离地爬升',approach:'进近',final:'最后进近',rollout:'着陆滑跑',exit:'脱离跑道',missed:'复飞',waiting_gate:'等待机位'};
export function trainingDiagram(kind){
  if(kind==='tacan')return '<svg viewBox="0 0 340 150" role="img" aria-label="飞机在台站东侧090径向线上"><path d="M60 78H285" class="diagram-line"/><path d="M60 69V87M285 69V87" class="diagram-line"/><circle cx="60" cy="78" r="6" class="diagram-station"/><path d="m267 78 16 -7 -4 7 4 7z" class="diagram-plane"/><text x="60" y="111">BAY 台站</text><text x="267" y="111">飞机</text><text x="170" y="45">090 径向 · 台的东侧</text><text x="170" y="138">W 西 ← 地图 → 东 E</text></svg>';
  if(kind==='dme')return `<svg viewBox="0 0 340 170" role="img" aria-label="飞机在台站正上方6000英尺，水平距离零，斜距未知"><path d="M50 140H290M170 44V140" class="diagram-line"/><circle cx="170" cy="140" r="6" class="diagram-station"/><path d="m155 40 30 -6 -9 8 9 7z" class="diagram-plane"/><text x="170" y="24">飞机</text><text x="170" y="164">BAY 台站</text><text x="248" y="88">6000 ft</text><text x="87" y="88">DME ?</text></svg><span class="coach-sr" data-dme="${navigationGeometry(90,0,6000).dmeNm.toFixed(2)}">请根据图选择距离</span>`;
  return '';
}
export function initTrainingCoach({getWorld,restartGround,issueCommand,cancelCommand=()=>{},getCommandBusy=()=>false,onSimulation=()=>{},getPlaying=()=>true,onRate=()=>{},onStep=()=>{},onHandoff=()=>{},onExecutionMode=()=>{}}){
  const $=s=>document.querySelector(s),stage=$('#stage');
  const button=document.createElement('button');button.type='button';button.id='training-toggle';button.textContent='指挥教学';button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','training-coach');$('#panel-controls').insertBefore(button,$('#controls-help'));
  const panel=document.createElement('section');panel.id='training-coach';panel.className='walkthrough';panel.hidden=true;panel.setAttribute('aria-label','逐步指挥教学');stage.append(panel);
  const sceneLayout=new ResizeObserver(()=>{stage.classList.toggle('training-card-open',!panel.hidden);stage.style.setProperty('--training-coach-height',Math.ceil(panel.getBoundingClientRect().height)+'px');});sceneLayout.observe(panel);
  let session=null,walkthrough=null,saved=false,lastKey='',hintShown=false,commandError='',pendingFocus=false,demoPending=false,submission=0,menuOpen=true;
  const $p=s=>panel.querySelector(s);
  const status=()=>walkthrough?.status??session?.status??'idle';
  const result=()=>walkthrough?walkthrough.result():session?.result();
  function highlight(selector){document.querySelectorAll('[data-training-focus]').forEach(el=>el.removeAttribute('data-training-focus'));if(selector)$(selector)?.setAttribute('data-training-focus','true');}
  function pause(){onSimulation(false);}
  function visible(open){panel.hidden=!open;button.setAttribute('aria-expanded',String(open));if(open){if(matchMedia('(max-width:750px)').matches){stage.classList.remove('voice-open');$('#voice-toggle').setAttribute('aria-expanded','false');}update();}}
  button.onclick=()=>visible(panel.hidden||stage.classList.contains('voice-open'));
  function save(){if(saved||!session||status()==='active')return;saved=true;if(!recordResult(result()))commandError='浏览器没有允许保存结果；本次练习仍有效。';}
  function reset(reason='模拟已重新开始，本轮训练结束'){
    submission++;if(demoPending)cancelCommand();demoPending=false;
    if(session&&status()==='active'){if(walkthrough)walkthrough.invalidate(reason);else session.invalidate(reason);save();}
    highlight();stage.classList.remove('training-active');lastKey='';
  }
  function start(mode,levelId='communications'){
    reset('开始新一轮训练');session=null;walkthrough=null;menuOpen=false;
    try{
      const level=mode==='guided'?trainingLevel(levelId):null;if(mode==='guided'&&!level)throw Error('没有这个教学关卡');
      restartGround(level?.entry??'stands');const world=getWorld(),unit=world.units[0];
      if(level){walkthrough=new TrainingWalkthrough(world,unit.id,{levelId:level.id});session=walkthrough.flight;}else session=new FlightTrainingSession(world,unit.id,{mode:'exam'});
      saved=false;lastKey='';commandError='';hintShown=false;stage.classList.add('training-active');onRate(1);
      if(walkthrough)enterStep();else{onSimulation(true);highlight();}update();
    }catch(error){commandError=error.message;menuOpen=!session;lastKey='';update();}
  }
  function enterStep(){hintShown=false;commandError='';lastKey='';highlight(walkthrough.step?.target);onStep(walkthrough.step,walkthrough.unit);pendingFocus=true;}
  function next(){if(walkthrough?.next()){if(walkthrough.status==='passed'){save();highlight();stage.classList.remove('training-active');}else enterStep();}update();}
  async function demonstrate(instruction){
    if(demoPending)return;const current=session,token=++submission;commandError='';demoPending=true;lastKey='';update();
    try{const receipt=await issueCommand(instruction,{source:'training-demo',onStatus:message=>{if(token===submission&&$p('#coach-radio-log'))$p('#coach-radio-log').textContent=message;}});if(token!==submission||session!==current)return;update(receipt?.summary??'请等待飞行员回复。',instruction,true);}
    catch(error){if(token===submission){commandError=error.message;lastKey='';update();}}
    finally{if(token===submission){demoPending=false;lastKey='';update();}}
  }
  function conceptHTML(step){return step.learn?`<div class="coach-concept"><span>先认识 · ${esc(step.learn.term)}</span><p>${esc(step.learn.meaning)}</p>${step.learn.example?`<p class="coach-concept-example">例如：${esc(step.learn.example)}</p>`:''}</div>`:'';}
  function commandForm({example=null,demo=false}={}){
    if(demo)return `<div class="coach-example-tokens">${walkthrough.step.tokens.map(([a,b])=>`<span><b>${esc(a)}</b><small>${esc(b)}</small></span>`).join('')}</div><button type="button" class="coach-primary" id="coach-demo" ${demoPending?'disabled':''}>${demoPending?'AI 正在示范…':'看教官演示'}</button><p class="coach-error" role="status">${esc(commandError)}</p><div id="coach-radio-log" role="log"></div>`;
    return `<div class="coach-command-entry"><p class="coach-small">打开右上“指挥电台”，打字或按住 V 说话。先叫谁，再说要做什么；AI会理解你的表达。</p><div class="coach-send-row"><button class="coach-primary" type="button" id="coach-open-radio">打开指挥电台</button>${example?'<button id="coach-hint" type="button">看一句示例</button>':''}</div></div>${example?`<div id="coach-example" ${hintShown?'':'hidden'}><code>${esc(example)}</code><button type="button" id="coach-fill">填入指挥电台</button></div>`:''}<div id="coach-radio-log" role="log"></div>`;
  }
  function choiceHTML(step){
    if(step.kind==='compass'||step.kind==='bullseye')return `<div class="coach-compass" aria-label="${step.kind==='bullseye'?'点击靶眼周围的位置':'点击方向'}"><span class="coach-compass-center">${step.kind==='bullseye'?'BAY-REF<br>公共靶眼':'地图北<br>↑'}</span>${step.choices.map(([value,label])=>`<button type="button" data-answer="${value}" class="compass-${value}">${esc(label)}</button>`).join('')}</div>`;
    return trainingDiagram(step.kind)+`<div class="coach-choices">${step.choices.map(([value,label])=>`<button type="button" data-answer="${esc(value)}">${esc(label)}</button>`).join('')}</div>`;
  }
  function menuHTML(){
    const progress=loadProgress().levelProgress??{};
    return `<div class="coach-label">零基础训练 / 3个关卡</div><h2>从叫对飞机，到把它带回来</h2><p>按第1、2、3关学习，每次只做一个小练习。每关都能单独进入、反复练习。</p>${session&&status()==='active'?'<button class="coach-primary" type="button" id="coach-resume">继续当前练习</button>':''}<div class="coach-levels">${TRAINING_LEVELS.map(l=>`<article class="coach-level-card" data-training-level="${l.id}"><div class="coach-level-number">第 ${l.number} 关 <span>${progress[l.id]?.passed?'✓ 已通过':'可开始'}</span></div><h3>${esc(l.title)}</h3><p class="coach-level-subtitle">${esc(l.subtitle)}</p><p>${esc(l.summary)}</p><p class="coach-small">${l.missions.length} 个短步骤 · ${l.entry==='airborne'?'空中场景开始':'从机位开始'}</p><button type="button" data-start="guided" data-level="${l.id}">${walkthrough?.levelId===l.id&&status()==='active'?'继续第'+l.number+'关':progress[l.id]?.passed?'重新练习第'+l.number+'关':'进入第'+l.number+'关'}</button></article>`).join('')}</div><details class="coach-exam-entry"><summary>三关学会后：综合独立考核</summary><p>从机位出发，由你独立决定顺序，完成起飞、巡航、到达航点与着陆回机位。</p><button type="button" data-start="exam">开始综合考核</button></details>${commandError?`<p class="coach-error">${esc(commandError)}</p>`:''}`;
  }
  function contentHTML(){
    const state=status(),step=walkthrough?.step,level=walkthrough?.level,missions=walkthrough?.missions;
    if(!session||menuOpen)return menuHTML();
    if(['failed','invalid'].includes(state))return `<div class="coach-label">${level?'第'+level.number+'关 / ':''}本轮已结束</div><h2>${state==='failed'?'本轮任务失败':'从这里重新出发'}</h2><p>${esc(result()?.reason??'本轮未完成')}</p>${walkthrough?`<p>已完成 ${walkthrough.completed.length} / ${missions.length} 个步骤 · ${walkthrough.score} 分</p>`:''}<button type="button" class="coach-primary" data-start="guided" data-level="${level?.id??'communications'}">${level?'重试第'+level.number+'关':'从第1关开始学习'}</button><button type="button" id="coach-back-menu">回到关卡目录</button>`;
    if(state==='passed'){
      const following=level?TRAINING_LEVELS[level.number]:null;
      return `<div class="coach-label">${level?'第'+level.number+'关通过':'考核通过'} / MISSION COMPLETE</div><h2>${esc(level?.title??(walkthrough?'完整飞行教学完成':'你独立带它回来了'))}</h2><p>${esc(level?.completion??'起飞、稳定巡航、到达目的航点、着陆回机位，均已实际完成。')}</p>${walkthrough?`<p class="coach-score">${walkthrough.score} 分 · ${walkthrough.completed.length} 个步骤完成</p>`:''}${following?`<button type="button" class="coach-primary" data-start="guided" data-level="${following.id}">进入第${following.number}关 · ${esc(following.title)}</button>`:'<button type="button" class="coach-primary" data-start="exam">开始综合独立考核</button>'}${level?`<button type="button" data-start="guided" data-level="${level.id}">重新练习本关</button>`:''}`;
    }
    if(walkthrough){
      const done=walkthrough.phase==='success',working=walkthrough.phase==='working';
      const task=working?`<p id="coach-feedback" role="status" class="coach-feedback">${esc(walkthrough.feedback)}</p><div id="coach-radio-log" role="log"></div>`:`${conceptHTML(step)}<div class="coach-task"><span>${step.assessment?'自己完成 · 本关考核':'现在试一下'}</span><p>${esc(step.text)}</p></div>${step.kind==='handoff-mode'?`<div class="coach-choices">${step.modes.map(([value,label])=>`<button type="button" data-control-mode="${value}">${esc(label)}</button>`).join('')}</div>`:step.kind==='handoff'?`<button class="coach-primary" type="button" id="coach-handoff">${getWorld().executionMode==='relaxed'?'观察自动交接':step.targetOwner==='tower'?'请求塔台接管':'请求移交空中指挥'}</button>`:step.choices?choiceHTML(step):step.kind==='demo'?commandForm({demo:true}):step.kind==='command'?commandForm({example:step.assessment?null:step.sample}):step.kind==='observe'?'<button type="button" class="coach-primary" id="coach-observe">开始观察飞机</button>':step.kind==='map'?'<div class="coach-map-steps"><span>从飞机左键拖线 → 松开提交 → Esc返回</span><button class="coach-primary" type="button" id="coach-open-route">打开航线设置</button></div>':''}<p id="coach-feedback" role="status" class="coach-feedback">${esc(walkthrough.feedback)}</p>`;
      return `<div class="coach-mission-head"><span class="coach-label">${level?'第'+level.number+'关 · '+esc(level.title):esc(step.chapter)}</span><span>步骤 ${walkthrough.index+1} / ${missions.length}</span></div><progress max="${missions.length}" value="${walkthrough.completed.length}" aria-label="本关步骤进度"></progress><h2>${done?'✓ ':''}${esc(step.title)}</h2>${done?`<p class="coach-success">${esc(walkthrough.feedback)}</p><button type="button" class="coach-primary" id="coach-next">${walkthrough.index===missions.length-1?'完成本关 →':'下一步 →'}</button>`:task}${!done&&step.observe?`<p class="coach-look"><b>看哪里：</b>${esc(step.observe)}</p>`:''}<div id="coach-live" class="coach-live" aria-live="off"></div>${working?'<div class="coach-observation"><span>观察实际执行</span><button type="button" data-observe="1">1×</button><button type="button" data-observe="4">4×</button><button type="button" data-observe="8">8× 快进</button></div>':''}`;
    }
    return `<div class="coach-label">综合独立考核 / 不展示逐句口令</div><h2>独立指挥 Alpha</h2><p>从机位出发，建立稳定巡航，通过一个明确航点，再返场回机位。你来决定下令顺序。</p><ol class="coach-exam-list">${TRAINING_STAGES.map(s=>`<li data-stage="${s}">${session.completed[s]?'✓':'○'} ${EXAM_LABELS[s]}</li>`).join('')}</ol>${commandForm()}<div id="coach-live" class="coach-live"></div><div class="coach-observation"><button type="button" data-observe="1">1×</button><button type="button" data-observe="4">4×</button><button type="button" data-observe="8">8× 快进</button></div>`;
  }
  function showMenu(){menuOpen=true;pause();highlight();lastKey='';update();}
  function resume(){menuOpen=false;lastKey='';if(walkthrough?.phase==='working'||!walkthrough)onSimulation(true);update();}
  function render(){
    const state=status(),step=walkthrough?.step;
    panel.dataset.mission=menuOpen?'levels':step?.id??(session?'exam':'levels');panel.dataset.phase=walkthrough?.phase??state;panel.dataset.kind=step?.kind??'report';panel.dataset.level=walkthrough?.levelId??'';
    panel.innerHTML=`<div class="coach-topline"><span>FLIGHT SCHOOL</span><button type="button" id="coach-close" aria-label="收起指挥教学">收起</button></div>${contentHTML()}<div class="coach-bottom">${session&&!menuOpen?'<button type="button" id="coach-menu">关卡目录</button>':''}<a href="./training-reference.html" target="_blank" rel="noopener">查手册 ↗</a><button type="button" id="coach-brief">任务简报 / 已存报告</button>${session&&state==='active'?'<button type="button" id="coach-end">结束本轮</button>':''}</div>`;
    $p('#coach-close').onclick=()=>{visible(false);button.focus();};$p('#coach-brief').onclick=()=>stage.dispatchEvent(new Event('mission-open-brief'));
    if($p('#coach-menu'))$p('#coach-menu').onclick=showMenu;if($p('#coach-back-menu'))$p('#coach-back-menu').onclick=showMenu;if($p('#coach-resume'))$p('#coach-resume').onclick=resume;
    panel.querySelectorAll('[data-start]').forEach(b=>b.onclick=()=>{if(b.dataset.level===walkthrough?.levelId&&status()==='active'&&menuOpen)resume();else start(b.dataset.start,b.dataset.level);});
    if($p('#coach-end'))$p('#coach-end').onclick=()=>{reset('玩家结束本轮训练');pause();update();};
    if($p('#coach-next')){const busy=getCommandBusy()||demoPending;$p('#coach-next').disabled=busy;if(busy)$p('#coach-next').textContent='正在通联，请等待复述…';$p('#coach-next').onclick=next;}
    if($p('#coach-demo'))$p('#coach-demo').onclick=()=>void demonstrate(step.sample);
    if($p('#coach-observe'))$p('#coach-observe').onclick=()=>{if(walkthrough.observe()){onSimulation(true);lastKey='';update();}};
    const openRadio=()=>stage.dispatchEvent(new Event('mission-open-command'));
    if($p('#coach-open-radio'))$p('#coach-open-radio').onclick=openRadio;
    panel.querySelectorAll('[data-control-mode]').forEach(b=>b.onclick=()=>{if(walkthrough.chooseControlMode(b.dataset.controlMode)){onExecutionMode(b.dataset.controlMode);pause();lastKey='';update();}});
    if($p('#coach-handoff'))$p('#coach-handoff').onclick=()=>{if(walkthrough.handoff()){if(getWorld().executionMode==='strict')onHandoff(walkthrough.unit.id,step.targetOwner);onSimulation(true);lastKey='';update();}};
    if($p('#coach-open-route'))$p('#coach-open-route').onclick=()=>$('#route-edit').click();
    panel.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>{walkthrough.answer(b.dataset.answer);if(walkthrough.phase==='success'){pause();highlight();lastKey='';pendingFocus=true;update();}else $p('#coach-feedback').textContent=walkthrough.feedback;});
    if($p('#coach-hint'))$p('#coach-hint').onclick=()=>{hintShown=true;$p('#coach-example').hidden=false;};
    if($p('#coach-fill'))$p('#coach-fill').onclick=()=>{$('#command-text').value=step.sample;$('#command-text').dispatchEvent(new Event('input'));openRadio();};
    panel.querySelectorAll('[data-observe]').forEach(b=>b.onclick=()=>{onRate(Number(b.dataset.observe));onSimulation(true);update();});
    if(walkthrough&&!menuOpen&&status()==='active'&&walkthrough.phase!=='success')highlight(walkthrough.step?.target);
    if(pendingFocus){pendingFocus=false;($p('#coach-next')??$p('#coach-demo')??$p('#coach-open-radio')??$p('#coach-observe'))?.focus({preventScroll:true});}
  }
  function update(readback=null,instruction=null,demo=false){
    save();if(panel.hidden)return;
    const key=[!!session,!!walkthrough,status(),walkthrough?.levelId,walkthrough?.index,walkthrough?.phase,menuOpen,demoPending,getCommandBusy(),session?Object.keys(session.completed).join(','):''].join(':');
    if(key!==lastKey){lastKey=key;render();}
    if(readback&&$p('#coach-radio-log')){const p=document.createElement('p');p.className='coach-transmission';p.textContent=(demo?'教官示范：':'你：')+instruction+'\n飞行员：'+readback;$p('#coach-radio-log').replaceChildren(p);}
    const live=$p('#coach-live');if(live&&session){
      const u=getWorld().units.find(u=>u.id===walkthrough?.step?.requiredUnitId)??session.unit,safety=selectedAircraftStatus(u),phase=safety.alert?safety.phase:u.surface?.phase==='climb'&&session.completed.cruise?'空中飞行':PHASES[u.surface?.phase]??'空中飞行';
      let text=`${u.callsign} · ${phase}\n实际海拔 ${formatAltitude(u.position[2])} · 实际速度 ${formatSpeed(u.speed)}`;
      if(walkthrough?.levelId==='communications'&&u.surface?.grounded)text=`${u.callsign} · ${groundStatusReport(u)}\n机位准备交流不会授予滑行或起飞许可；数值可在左上状态栏查看。`;
      if(walkthrough?.step?.kind==='handoff'){const c=controlAuthority(getWorld(),u);text=`${u.callsign} · 当前管制：${CONTROL_NAMES[c.owner]}\n${getWorld().executionMode==='strict'?'严苛模式 · 手动交接':'宽松模式 · 自动交接'}\n`+HANDOFF_STEPS.map((label,i)=>`${c.phase==='owned'&&c.transfers||i<c.progress?'✓':'○'} ${label}`).join('\n');}
      if(walkthrough?.step?.intent==='cruise'&&walkthrough.phase==='working')text+=`\n稳定保持 ${Math.min(10,walkthrough.stableSeconds).toFixed(1)} / 10 秒`;
      if(walkthrough?.step?.intent==='orbit'&&walkthrough.phase==='working')text+=`\n实际盘旋 ${Math.min(360,Math.abs(walkthrough.issued?.angle??0)*180/Math.PI).toFixed(0)}° / 360°`;
      if(walkthrough?.step?.intent==='fly_heading'&&walkthrough.phase==='working')text+=`\n航向稳定 ${Math.min(8,walkthrough.stableSeconds).toFixed(1)} / 8 秒`;
      if(u.waypoints.length)text+='\n距下一点 '+formatDistance(Math.hypot(...u.waypoints[0].map((v,i)=>v-u.position[i])));
      if(walkthrough?.phase==='working'&&!getPlaying())text+='\n已暂停 · 点击下方倍率继续观察';
      if(u.navigationBlocked)text+='\n航路暂缓：'+u.navigationBlocked;
      live.textContent=text;
    }
  }
  function tick(){
    if(!session||status()!=='active')return;const before=walkthrough?.phase;
    if(walkthrough)walkthrough.tick(getWorld());else session.tick(getWorld());
    if(walkthrough?.phase==='brief'&&before==='working'){lastKey='';}
    if(walkthrough?.phase==='success'&&before!=='success'){highlight();lastKey='';pendingFocus=true;}
    if(['passed','failed','invalid'].includes(status())){save();highlight();lastKey='';}
  }
  function onSelect(id){if(!walkthrough||status()!=='active'||menuOpen)return;const before=walkthrough.phase;walkthrough.select(id);if(walkthrough.phase==='success'&&before!=='success'){highlight();lastKey='';pendingFocus=true;update();}}
  function onWaypoint(point){if(!menuOpen&&walkthrough?.waypoint(point)){commandError='';lastKey='';update();}}
  function onCommandCommitted(interpretation,{demo=false}={}){
    if(!session||status()!=='active')return;
    if(walkthrough)walkthrough.observeExecuted(interpretation,{demo});else if(interpretation?.orders?.some(o=>o.speechAct==='directive'&&!['pause','resume','report_status'].includes(o.intent)&&(o.unitIds.length!==1||o.unitIds[0]!==session.unitId)))session.fail('已向其他飞机下达操作，本轮应独立指挥 Alpha。');
    // Training observes the command; only explicit player controls change the simulation clock.
    menuOpen=false;if(walkthrough?.phase==='success'||status()!=='active'){pendingFocus=true;highlight();}
    lastKey='';update();stage.dispatchEvent(new Event('training-command-issued'));
  }
  if(['guided','exam'].includes(new URLSearchParams(location.search).get('training')))visible(true);
  window.addEventListener('pagehide',()=>sceneLayout.disconnect());
  return {tick,update,reset,onSelect,onWaypoint,onCommandCommitted,openMenu:showMenu,allowsAutomaticHandoff(id){return !walkthrough||status()!=='active'||!!walkthrough.legacyMissionIds||walkthrough.unit.id!==id||walkthrough.step.kind==='handoff'&&walkthrough.phase==='working';},get showingMenu(){return menuOpen||!session;},
    snapshot(){return session?.world===getWorld()?{...captureTraining(session,walkthrough),saved,hintShown,open:!panel.hidden,menuOpen}:null;},
    restore(state){({session,walkthrough}=restoreTraining(getWorld(),state));saved=!!state?.saved;hintShown=!!state?.hintShown;menuOpen=state?.menuOpen??!session;lastKey='';commandError='';if(session){stage.classList.toggle('training-active',status()==='active');highlight(status()==='active'&&walkthrough?.phase!=='success'?walkthrough?.step?.target:null);visible(!!state.open);update();}},
    get session(){return session;},get walkthrough(){return walkthrough;}};
}
