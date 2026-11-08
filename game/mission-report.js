import {loadProgress,escapeHTML as esc} from './training-store.js';
import {formatAltitude,formatSpeed,formatDistance} from '../sim/units.js';
import {TRAINING_MISSIONS} from '../sim/training-missions.js';
import {trainingLevel,LEGACY_LEVEL_STEPS} from '../sim/training-levels.js';
import {selectedAircraftStatus} from '../sim/unit-status.js';
const PHASE={parked:'机位待命',taxi:'滑行',holding:'跑道外等待',lined_up:'跑道对正',lineup_taxi:'进入跑道',takeoff_roll:'起飞滑跑',climb:'空中飞行',approach:'进近',final:'最后进近',rollout:'着陆减速',exit:'脱离跑道',missed:'复飞',waiting_gate:'等待机位'};
export function missionBrief(world,selectedId){
  const u=world.units.find(u=>u.id===selectedId)??world.units[0];if(!u)return null;
  const safety=u.profile&&u.velocity?selectedAircraftStatus(u):{alert:null},points=u.waypoints??[],phase=safety.alert?safety.phase:PHASE[u.surface?.phase]??'空中飞行';
  const objective=!u.alive?'飞机损坏，重新安排任务':u.surface?.grounded?(u.surface.phase==='parked'?'在机位等待指挥':u.surface.message??phase):u.headingRoute?`保持航向 ${String(Math.round(u.headingRoute.headingDeg)).padStart(3,'0')}°`:points.length?`飞往航点 ${points[0].number??1}`:u.headingTarget!=null?'保持指定航向':'盘旋待命';
  return {callsign:u.callsign,phase,objective,position:[...u.position],speed:u.speed,remaining:points.length,completed:u.completedWaypoints??0,
    destination:points[0]?points[0].slice(0,3):null,rangeM:points[0]?Math.hypot(...points[0].map((v,i)=>v-u.position[i])):null,
    caution:u.navigationBlocked??(!u.alive?'当前飞机无法继续任务':null),airport:world.airportOps?.airport.name??null,runway:u.surface?.runway??null,
    recent:[...(world.commandLog??[]).map(row=>({time:row.time,summary:row.interpretation?.summary??'指挥任务'})),...(world.airportOps?.airport.events??[]).filter(e=>e.unitId===u.id).map(e=>({time:e.time,summary:e.text}))].sort((a,b)=>b.time-a.time).slice(0,4)};
}
export function initMissionReport({getWorld,getSelected,getTraining,openPanel}){
  const stage=document.querySelector('#stage'),toolbar=document.createElement('div');toolbar.id='mission-toolbar';toolbar.setAttribute('aria-label','指挥电台与任务报表');
  const command=document.querySelector('#voice-toggle');command.textContent='指挥电台';toolbar.append(command);
  const toggle=document.createElement('button');toggle.id='mission-report-toggle';toggle.type='button';toggle.setAttribute('aria-expanded','false');toggle.textContent='任务简报 ▾';toolbar.append(toggle);stage.append(toolbar);
  const panel=document.createElement('section');panel.id='mission-brief';panel.className='utility-panel';panel.hidden=true;panel.setAttribute('aria-label','任务简报与教学报告');
  panel.innerHTML='<div class="panel-heading"><h2>任务简报</h2><button type="button" data-close-panel aria-label="收起任务简报">收起</button></div><div id="mission-brief-live"></div><div class="brief-tools"><button type="button" id="brief-training">打开训练关卡 / 重新练习</button></div><details id="mission-result-details"><summary>已保存的教学与考核报告</summary><div id="mission-results"></div></details>';
  stage.append(panel);let lastKey='',historyKey='',reportKind=new URLSearchParams(location.search).get('training')?'training':'brief';
  toggle.onclick=()=>{
    const teaching=getTraining(),session=teaching?.session;
    if(!panel.hidden||!document.querySelector('#training-coach').hidden)openPanel('close-report');
    else openPanel(reportKind);
    update();
  };
  panel.querySelector('#brief-training').onclick=()=>{getTraining()?.openMenu();reportKind='training';openPanel('training');update();};
  stage.addEventListener('mission-open-brief',()=>{reportKind='brief';openPanel('brief');update();});
  function update(){
    const teaching=getTraining(),session=teaching?.session,walk=teaching?.walkthrough,coach=document.querySelector('#training-coach');
    const expanded=!panel.hidden||!coach.hidden;if(!panel.hidden)reportKind='brief';else if(!coach.hidden)reportKind='training';toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-controls',reportKind==='training'?'training-coach':'mission-brief');
    const state=walk?.status??session?.status;
    const count=walk?.missions.length??16;
    toggle.textContent=reportKind==='training'&&teaching?.showingMenu?`训练关卡 ${expanded?'▴':'▾'}`:reportKind==='training'&&walk?`${walk.level?'第'+walk.level.number+'关':state==='passed'?'教学报告':'教程'} ${Math.min(count,walk.index+1)} / ${count} ${expanded?'▴':'▾'}`:reportKind==='training'&&session?`综合考核 ${Object.keys(session.completed).length} / 4 ${expanded?'▴':'▾'}`:`${reportKind==='training'?'训练关卡':'任务简报'} ${expanded?'▴':'▾'}`;
    if(panel.hidden)return;
    const brief=missionBrief(getWorld(),getSelected()),key=JSON.stringify(brief);if(brief&&key!==lastKey){lastKey=key;
      panel.querySelector('#mission-brief-live').innerHTML=`<span class="brief-kicker">CURRENT TASK / 当前选中机</span><h3>${esc(brief.callsign)}</h3><p class="brief-objective">${esc(brief.objective)}</p><dl><dt>执行阶段</dt><dd>${esc(brief.phase)}</dd><dt>实际海拔</dt><dd>${formatAltitude(brief.position[2])}</dd><dt>实际速度</dt><dd>${formatSpeed(brief.speed)}</dd><dt>剩余 / 已通过</dt><dd>${brief.remaining} / ${brief.completed}</dd>${brief.rangeM!==null?`<dt>距下一点</dt><dd>${formatDistance(brief.rangeM)}</dd>`:''}${brief.runway?`<dt>跑道</dt><dd>${esc(brief.runway)}</dd>`:''}</dl>${brief.caution?`<p class="brief-caution">${esc(brief.caution)}</p>`:''}<h4>最近任务</h4>${brief.recent.length?brief.recent.map(r=>`<p class="brief-event">T+${Math.floor(r.time)}s · ${esc(r.summary)}</p>`).join(''):'<p class="brief-empty">尚未下达新的指挥任务。</p>'}`;
    }
    const results=loadProgress().results.slice().reverse(),resultKey=JSON.stringify(results);if(resultKey!==historyKey){historyKey=resultKey;
      panel.querySelector('#mission-results').innerHTML=results.length?results.map(r=>{
        const level=trainingLevel(r.levelId),legacy=level&&!r.handoffVersion&&LEGACY_LEVEL_STEPS[r.levelId],missions=legacy?level.missions.filter(m=>legacy.includes(m.id)):level?.missions??TRAINING_MISSIONS;
        const date=new Date(r.date),when=Number.isFinite(date.valueOf())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'';
        return `<article class="brief-result"><b>${esc(level?'第'+level.number+'关 · '+level.title:r.mode==='guided'?'逐步教学':'综合独立考核')} · ${r.status==='passed'?'通过':r.status==='failed'?'未通过':'中止'}</b><p>${esc(when)}</p><p>${r.steps?`已完成 ${r.steps.length} / ${r.totalSteps??missions.length} 个步骤 · ${r.score??r.steps.length*10} 分`:`已完成 ${Object.keys(r.completed??{}).length} / 4 项`}</p>${r.reason?`<p>${esc(r.reason)}</p>`:''}<p>${r.levelId==='communications'?'呼号、航空术语与实际状态通联':(r.levelId==='departure'?[['departure','离场'],['cruise','巡航']]:r.levelId==='navigation'?[['cruise','巡航'],['waypoint','航点'],['recovery','回收']]:[['departure','离场'],['cruise','巡航'],['waypoint','航点'],['recovery','回收']]).map(([id,label])=>(r.completed?.[id]?'✓ ':'○ ')+label).join(' · ')+(r.levelId==='departure'?(r.steps?.includes('orbit')?' · ✓ 盘旋':' · ○ 盘旋')+(r.handoffVersion?(r.steps?.includes('departure-handoff')?' · ✓ 离场交接':' · ○ 离场交接'):''):'')}</p>${Array.isArray(r.steps)?`<details><summary>查看本关步骤</summary><ol>${missions.map(m=>`<li>${r.steps.includes(m.id)?'✓':'○'} ${esc(m.title)}</li>`).join('')}</ol></details>`:''}</article>`;
      }).join(''):'<p class="brief-empty">还没有保存的报告。完成教学或结束一轮练习后会保留在这里。</p>';
    }
  }
  return {update};
}
