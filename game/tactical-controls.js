import {commandUnits} from '../sim/battle-observation.js';
import {formatAltitude} from '../sim/units.js';
import {getLanguages,onLanguageChange,translateEnglish} from './language.js';
import {ATTACK_METHODS,DEFENSE_METHODS,DEFENSE_SIDES,tacticalOptions} from './tactical-options.js';
import {initTacticalWheel} from './tactical-wheel.js';
import {OFFENSE_POLICIES,DEFENSE_POLICIES} from '../sim/tactical-guidance.js';

const GROUP_KEY='flight-tactical-groups-v1';
const ACTIONS={move:{key:'RMB',zh:'转进',en:'Move',hintZh:'在地图点选空域，沿用指派高度',hintEn:'Choose airspace; retain assigned altitude'},attack:{key:'Q',zh:'授权攻击',en:'Authorize attack',hintZh:'点选可见敌方航迹；主射手最多使用一枚导弹',hintEn:'Choose an observed hostile track; primary shooter, one missile maximum'},defend:{key:'X',zh:'告警规避',en:'Evade threat',hintZh:'按当前有效雷达告警方位立即规避',hintEn:'Evade using a valid radar warning bearing'},disengage:{key:'E',zh:'脱离',en:'Disengage',hintZh:'点选脱离空域，撤销继续攻击授权',hintEn:'Choose escape airspace; cancel further attack authorization'},hold:{key:'H',zh:'停火',en:'Cease fire',hintZh:'停止后续发射；在空导弹无法撤销',hintEn:'Stop further launches; missiles already airborne cannot be recalled'},return_base:{key:'B',zh:'返场',en:'Return to base',hintZh:'向指定基地申请返场，仍按塔台阶段许可执行',hintEn:'Request return to the assigned base; ATC clearances still apply'}};
const STATUS={planning:['校验中','Validating'],queued:['已排队','Queued'],executing:['执行中','Executing'],waiting:['等待条件','Waiting'],completed:['已完成','Completed'],unable:['无法执行','Unable'],superseded:['已被新指令替代','Superseded'],cancelled:['已取消','Cancelled'],idle:['等待指令','Awaiting orders']};
const FIELD_SELECTOR='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';

export const tacticalInputField=target=>!!target?.closest?.(FIELD_SELECTOR);
// This decoder is shared by actual input handling and the input regression tests.
export function tacticalKeyCommand(event,{voiceHeld=false,routeEditing=false}={}){
  if(event.isComposing||event.repeat||voiceHeld||tacticalInputField(event.target)||event.altKey||event.metaKey)return null;
  const digit=/^Digit([1-9])$/.exec(event.code)?.[1]??(/^[1-9]$/.test(event.key??'')?event.key:null);
  if(digit){if(event.ctrlKey)return {kind:'bind',index:Number(digit)};if(!routeEditing)return {kind:'select',index:Number(digit)};return null;}
  if(event.ctrlKey||routeEditing)return null;
  if(event.code==='Escape'||event.key==='Escape')return {kind:'cancel'};
  const action={KeyQ:'attack',KeyX:'defend',KeyE:'disengage',KeyH:'hold',KeyB:'return_base'}[event.code];
  return action?{kind:'action',action}:null;
}

export function initTacticalControls({canvas,getWorld,getSelected,select,commands,getRouteEditor=()=>null,onSelectionChange=()=>{},isVoiceRecording=()=>false,picking=null}){
  const doc=canvas.ownerDocument,win=doc.defaultView??globalThis,stage=canvas.parentElement;
  const css=doc.createElement('link');css.rel='stylesheet';css.href=new URL('./tactical-controls.css',import.meta.url).href;doc.head.append(css);
  const panel=doc.createElement('section');panel.id='tactical-commands';panel.dataset.languageSkip='';
  panel.innerHTML='<div class="tactical-heading"><strong id="tactical-title"></strong><span id="tactical-selection"></span><span id="tactical-primary"></span></div><div class="tactical-receivers" role="group"></div><div class="tactical-actions" role="group"></div><div class="tactical-readout"><span id="tactical-target-hint"></span><button id="tactical-cancel-target" type="button" hidden></button></div><p id="tactical-feedback" role="status" aria-live="polite"></p><div class="tactical-missions" aria-live="off"></div><div id="tactical-queue" hidden><span class="tactical-queue-label"></span><ol></ol><button data-tactical-clear-queue type="button"></button></div><p class="tactical-help"></p>';
  const menu=doc.createElement('details');menu.id='tactical-command-menu';menu.dataset.languageSkip='';
  const menuTitle=doc.createElement('summary');menu.append(menuTitle,panel);(doc.querySelector('#panel-controls')??stage).append(menu);
  const settings=doc.createElement('div');settings.className='tactical-methods';panel.querySelector('.tactical-actions').before(settings);
  const launchers=doc.createElement('div');launchers.className='tactical-wheel-launchers';settings.before(launchers);
  const policyStatus=doc.createElement('p');policyStatus.id='tactical-policy-status';settings.before(policyStatus);
  for(const [category,key]of [['offense','R'],['defense','T'],['maneuver','C']]){const button=doc.createElement('button');button.type='button';button.dataset.wheel=category;button.dataset.key=key;button.onclick=()=>{menu.open=false;button.blur();wheel.open(category);};launchers.append(button);}
  let preferences=tacticalOptions();
  try{preferences=tacticalOptions(JSON.parse(win.localStorage?.getItem('flight-tactical-options-v1')??'{}'));}catch{}
  const methodSelects=new Map();
  for(const [key,options]of [['attackMethod',ATTACK_METHODS],['defenseMethod',DEFENSE_METHODS],['defenseSide',DEFENSE_SIDES]]){
    const label=doc.createElement('label'),caption=doc.createElement('span'),select=doc.createElement('select');select.id=`tactical-${key}`;
    for(const value of Object.keys(options)){const option=doc.createElement('option');option.value=value;select.append(option);}
    select.value=preferences[key];label.append(caption,select);settings.append(label);methodSelects.set(key,{select,caption,options});
    select.onchange=()=>{preferences=tacticalOptions({...preferences,[key]:select.value});try{win.localStorage?.setItem('flight-tactical-options-v1',JSON.stringify(preferences));}catch{}select.blur();renderKey='';update();};
  }
  const $=selector=>panel.querySelector(selector),listeners=[];
  let scene=picking,disposed=false,voiceHeld=false,pointer=null,armed=null,selection=[getSelected()],external=getSelected(),worldRef=getWorld(),serial=0,renderKey='',feedback=null,synchronizing=false;
  const groups=new Map(),buttons=new Map();
  try{for(const [key,ids]of Object.entries(JSON.parse(win.localStorage?.getItem(GROUP_KEY)||'{}')))if(/^[1-9]$/.test(key)&&Array.isArray(ids))groups.set(Number(key),ids.filter(id=>typeof id==='string').slice(0,32));}catch{}
  if(!scene)void import('../three3d/scene.js').then(module=>{if(!disposed)scene=module;}).catch(()=>{});
  const en=()=>getLanguages().text==='en',text=(zh,english)=>en()?english:zh;
  const actionName=action=>ACTIONS[action]?.[en()?'en':'zh']??text('任务','Task');
  const statusName=status=>(STATUS[status]??STATUS.waiting)[en()?1:0];
  const recording=()=>voiceHeld||isVoiceRecording()||doc.querySelector('#command-mic')?.getAttribute('aria-pressed')==='true';
  const editable=()=>!!getRouteEditor()?.enabled;
  const consume=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const own=()=>commandUnits(getWorld());
  const unit=id=>getWorld().units.find(u=>u.id===id);
  const chosen=()=>selection.map(unit).filter(Boolean);
  function listen(target,name,fn,options){target.addEventListener(name,fn,options);listeners.push(()=>target.removeEventListener(name,fn,options));}
  function message(zh,english,status='waiting'){feedback={zh,en:english,status};renderKey='';update();}
  function cancelTarget(){armed=null;pointer=null;stage.classList.remove('tactical-targeting');renderKey='';}
  function choose(ids){
    const allowed=new Set(own().map(u=>u.id)),next=[...new Set(ids)].filter(id=>allowed.has(id));if(!next.length)return;
    cancelTarget();selection=next;external=next[0];synchronizing=true;
    try{if(getSelected()!==external)select(external);onSelectionChange([...selection]);}finally{synchronizing=false;}
    renderKey='';update();
  }
  function ready(action){
    if(!chosen().some(u=>u.alive!==false))return false;
    if(editable())return false;
    if(action==='hold')return true;
    if(action==='return_base')return chosen().every(u=>u.alive!==false&&!u.surface?.grounded&&u.controlAuthority?.phase!=='transferring');
    return chosen().every(u=>u.alive!==false&&!u.surface?.grounded&&(u.controlAuthority?.owner??'commander')==='commander'&&u.controlAuthority?.phase!=='transferring');
  }
  function begin(action,{append=false}={}){
    if(recording())return;
    if(!ready(action)){message('当前受令机或飞行阶段不能执行该命令，请检查管制权和航线编辑状态。','This command is unavailable. Check the selected aircraft, flight phase, control authority and route editor.','unable');return;}
    cancelTarget();
    menu.open=false;
    if(['move','attack','disengage'].includes(action)){armed={action,unitIds:[...selection],append:!!append,...preferences};stage.classList.add('tactical-targeting');renderKey='';update();}
    else void issue({action,unitIds:[...selection],append:false,...preferences});
  }
  function receiptText(receipt){
    const english=receipt.summaryEn??receipt.texts?.en??receipt.en;
    const chinese=receipt.summary??receipt.texts?.zh??receipt.zh;
    if(!en())return chinese??statusName(receipt.status);
    if(english)return english;
    if(chinese&&!/[\u3400-\u9fff]/.test(chinese))return chinese;
    return chinese&&translateEnglish(chinese)||`${actionName(receipt.action)} · ${statusName(receipt.status)}`;
  }
  async function issue(request){
    const id=`quick-${Date.now()}-${++serial}`,ids=[...request.unitIds];
    feedback={zh:'已接令，正在校验。',en:'Order received. Validating.',status:'planning'};renderKey='';update();
    try{
      const receipt=await commands.issue({...request,unitIds:ids,commandId:id});
      if(disposed||getWorld()!==worldRef)return;
      feedback=receipt??{zh:'指令已提交。',en:'Order submitted.',status:'waiting'};
    }catch(error){
      const reason=String(error?.message??error),english=/[\u3400-\u9fff]/.test(reason)?translateEnglish(reason)||'Unable to execute. Check control authority, target and flight state.':reason;
      feedback={zh:reason,en:english,status:'unable'};
    }
    renderKey='';update();
  }
  function mapPick(event){return (scene?.pickContact??scene?.pickUnit)?.(event.clientX,event.clientY)??null;}
  function mapPoint(event,ids){
    const u=unit(ids[0]),altitude=u?.targetAltitude??u?.holdAltitude??u?.position?.[2];
    if(!scene||!Number.isFinite(altitude))return null;
    const point=scene.pointOnPlane(event.clientX,event.clientY,altitude);return point?.every(Number.isFinite)?point:null;
  }
  function targetAt(event){
    const request=armed;if(!request)return;
    const picked=mapPick(event),friendly=own().some(u=>u.id===picked);
    if(request.action==='attack'){
      if(!picked||friendly){message('请选择当前可见的敌方航迹；友机不能作为攻击目标。','Select a currently observed hostile track. Friendly aircraft cannot be attacked.','unable');return;}
      cancelTarget();void issue({...request,targetId:picked,append:request.append||event.shiftKey});
    }else{
      if(picked&&!friendly){message('该位置是目标航迹。转进或脱离请点选空域。','That is a contact. Choose clear airspace for movement or disengagement.','unable');return;}
      const point=mapPoint(event,request.unitIds);
      if(!point){message('此视角无法确定目标空域，请调整视角后重试。','Cannot resolve airspace from this view. Adjust the camera and try again.','unable');return;}
      cancelTarget();void issue({...request,point,append:request.append||event.shiftKey});
    }
  }
  for(const [action,definition]of Object.entries(ACTIONS)){
    const button=doc.createElement('button');button.type='button';button.dataset.tacticalAction=action;button.innerHTML='<kbd></kbd><span></span>';
    button.querySelector('kbd').textContent=definition.key;
    button.onclick=event=>{begin(action,{append:event.shiftKey});button.blur();};$('.tactical-actions').append(button);buttons.set(action,button);
  }
  $('#tactical-cancel-target').onclick=()=>{cancelTarget();update();};
  $('[data-tactical-clear-queue]').onclick=()=>{
    if(typeof commands.clearQueued!=='function')return;
    for(const id of selection)commands.clearQueued(id);
    message('已清除后续队列，当前已装订任务继续执行。','Queued tasks cleared. The current committed task continues.','completed');
  };
  function keydown(event){
    if(wheel.active)return;
    if(event.code==='KeyV'&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!tacticalInputField(event.target)&&!event.isComposing){voiceHeld=true;cancelTarget();update();return;}
    const decoded=tacticalKeyCommand(event,{voiceHeld:recording(),routeEditing:editable()});if(!decoded)return;
    if(decoded.kind==='cancel'){if(armed){consume(event);cancelTarget();update();}return;}
    consume(event);
    if(decoded.kind==='bind'){
      groups.set(decoded.index,[...selection]);try{win.localStorage?.setItem(GROUP_KEY,JSON.stringify(Object.fromEntries(groups)));}catch{}
      message(`编组 ${decoded.index} 已保存：${chosen().map(u=>u.callsign).join('、')}`,`Group ${decoded.index} assigned: ${chosen().map(u=>u.callsign).join(', ')}`,'completed');return;
    }
    if(decoded.kind==='select'){
      const group=groups.get(decoded.index),units=own();
      if(group)choose(group);else if(decoded.index===3)choose(units.filter(u=>u.alive!==false).map(u=>u.id));else if(units[decoded.index-1])choose([units[decoded.index-1].id]);
      return;
    }
    begin(decoded.action,{append:event.shiftKey});
  }
  function pointerdown(event){
    if(editable()||recording()||event.ctrlKey||event.altKey||event.metaKey){pointer=null;return;}
    if(event.button!==0&&event.button!==2)return;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,button:event.button,armed:!!armed};
    if(armed||event.button===2)consume(event);
  }
  function pointerup(event){
    const start=pointer;pointer=null;
    if(!start||editable()||recording()||event.pointerId!==start.id||event.button!==start.button)return;
    if(start.armed||event.button===2)consume(event);
    if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>6)return;
    if(start.armed){if(event.button===0)targetAt(event);else{cancelTarget();update();}return;}
    const picked=mapPick(event),friendly=own().some(u=>u.id===picked);
    if(event.button===0&&picked){
      consume(event);if(friendly)choose(event.shiftKey?[...selection,picked]:[picked]);else message(`已标记航迹 ${picked}；按 Q 授权攻击，当前受令机不变。`,`Track ${picked} marked. Press Q to authorize an attack; command recipient unchanged.`);return;
    }
    if(event.button!==2)return;
    if(picked&&!friendly){message(`已标记航迹 ${picked}；没有下达攻击命令。`,`Track ${picked} marked. No attack order issued.`);return;}
    if(!ready('move')){begin('move');return;}
    const point=mapPoint(event,selection);
    if(point)void issue({action:'move',unitIds:[...selection],point,append:event.shiftKey});
    else message('此视角无法确定目标空域，请调整视角后重试。','Cannot resolve airspace from this view. Adjust the camera and try again.','unable');
  }
  const clearInput=()=>{voiceHeld=false;cancelTarget();update();};
  listen(doc,'keydown',keydown,true);listen(doc,'keyup',event=>{if(event.code==='KeyV')voiceHeld=false;},true);
  listen(canvas,'pointerdown',pointerdown,true);listen(canvas,'pointerup',pointerup,true);
  listen(canvas,'pointercancel',()=>{pointer=null;},true);
  listen(canvas,'contextmenu',event=>{if(!editable())consume(event);},true);
  listen(win,'blur',clearInput);listen(doc,'visibilitychange',()=>{if(doc.hidden)clearInput();});
  listen(doc,'focusin',event=>{if(tacticalInputField(event.target))clearInput();});
  const stopLanguage=onLanguageChange(()=>{renderKey='';update();});
  const resize=null;
  const wheel=initTacticalWheel({stage,getSelectedIds:()=>selection,issue,blocked:()=>disposed||recording()||editable(),onOpen:()=>{cancelTarget();menu.open=false;}});
  function update(){
    if(disposed||synchronizing)return;
    const world=getWorld();if(world!==worldRef){worldRef=world;selection=[getSelected()];external=getSelected();feedback=null;cancelTarget();}
    if(getSelected()!==external){external=getSelected();selection=[external];cancelTarget();}
    const allowed=new Set(own().map(u=>u.id));selection=selection.filter(id=>allowed.has(id));
    if(!selection.length&&own().length){selection=[own()[0].id];external=selection[0];}
    if(editable()&&armed)cancelTarget();
    const units=chosen(),snapshot=commands.snapshot?.(selection)??{units:[]},queues=(snapshot.units??[]).flatMap(u=>(u.queue??[]).map(record=>({...record,ownerId:u.unitId})));
    const records=(snapshot.units??[]).map(u=>({unitId:u.unitId,action:u.current?.action,status:u.current?.status??u.status,reason:u.reason,current:u.current}));
    const key=JSON.stringify([en(),preferences,selection,snapshot.units?.map(u=>u.guidance),units.map(u=>[u.callsign,u.alive,u.surface?.grounded,u.controlAuthority?.owner,u.controlAuthority?.phase,u.targetAltitude]),armed,editable(),feedback,records,queues,own().map(u=>[u.id,u.callsign,u.alive])]);
    if(key===renderKey)return;renderKey=key;
    panel.setAttribute('aria-label',text('战术快捷指挥','Tactical quick commands'));
    menuTitle.textContent=armed?text('命令 · 点选目标','Orders · select target'):text('命令','Orders');
    for(const button of launchers.children)button.textContent=`${button.dataset.key} · `+({offense:text('进攻方针','Offense'),defense:text('防御方针','Defence'),maneuver:text('直接机动','Manoeuvre')})[button.dataset.wheel];
    policyStatus.textContent=(snapshot.units??[]).map(s=>{const g=s.guidance;if(!g)return '';return `${unit(s.unitId)?.callsign??s.unitId} · ${OFFENSE_POLICIES[g.offense][en()?'en':'zh']} / ${DEFENSE_POLICIES[g.defense][en()?'en':'zh']}${g.direct?' · '+({planning:text('机动规划中','Planning'),executing:text('机动执行中','Executing'),recovering:text('复位中','Recovering'),completed:text('已复位','Resumed'),unable:text('无法执行','Unable'),cancelled:text('已取消','Cancelled')})[g.direct.phase]:''}`;}).join(' | ');
    for(const [key,{select,caption,options}]of methodSelects){
      caption.textContent={attackMethod:text('武器限制','Weapon restriction'),defenseMethod:text('快捷规避动作','Quick evasion'),defenseSide:text('横切转向','Beam turn')}[key];
      for(const option of select.options)option.textContent=options[option.value][en()?'en':'zh'];
      select.disabled=key==='defenseSide'&&preferences.defenseMethod==='extend';
    }
    $('#tactical-title').textContent=text('战术指挥','TACTICAL COMMAND');
    $('#tactical-selection').textContent=units.map(u=>u.callsign).join(' + ')||text('未选中飞机','No aircraft selected');
    $('#tactical-primary').textContent=selection.length>1?text(`主射手 ${units[0]?.callsign??''} · 1 枚`,`Primary: ${units[0]?.callsign??''} · 1 missile`):text('攻击额度 1 枚','Attack limit: 1 missile');
    const receiver=$('.tactical-receivers');receiver.setAttribute('aria-label',text('选择受令飞机','Choose command recipients'));receiver.replaceChildren();
    for(const [index,u]of own().entries()){
      const b=doc.createElement('button');b.type='button';b.dataset.tacticalSelect=u.id;b.setAttribute('aria-pressed',String(selection.includes(u.id)));b.textContent=`${index+1}  ${u.callsign}`;b.title=text('选中此飞机；Shift 点击加入编组选择','Select this aircraft; Shift-click to add to selection');b.onclick=e=>{choose(e.shiftKey?[...selection,u.id]:[u.id]);b.blur();};receiver.append(b);
    }
    const all=doc.createElement('button');all.type='button';all.dataset.tacticalSelect='all';all.textContent=text('3  全编组','3  Flight');all.setAttribute('aria-pressed',String(selection.length>1));all.onclick=()=>{choose(own().filter(u=>u.alive!==false).map(u=>u.id));all.blur();};receiver.append(all);
    for(const [action,button]of buttons){const definition=ACTIONS[action];button.querySelector('span').textContent=actionName(action);button.title=definition[en()?'hintEn':'hintZh'];button.disabled=!ready(action);button.setAttribute('aria-pressed',String(armed?.action===action));}
    $('.tactical-actions').setAttribute('aria-label',text('快捷命令','Quick orders'));
    const primary=units[0],altitude=primary?.targetAltitude??primary?.holdAltitude??primary?.position?.[2];
    $('#tactical-target-hint').textContent=editable()?text('航线编辑中 · 快捷落点已让出控制','Route editor active · map quick orders disabled'):armed?`${ACTIONS[armed.action][en()?'hintEn':'hintZh']}${armed.action!=='attack'&&Number.isFinite(altitude)?` · ${formatAltitude(altitude)}`:''}${armed.append?text(' · 排队',' · Queue'):''}`:text('右键空域转进 · Q 点航迹授权攻击','Right-click airspace to move · Q + track to authorize attack');
    const cancel=$('#tactical-cancel-target');cancel.hidden=!armed;cancel.textContent=text('取消 Esc','Cancel Esc');
    const output=$('#tactical-feedback');output.textContent=feedback?receiptText(feedback):text('准备接令 · 飞行员持续执行当前任务','Ready · pilots continue their current tasks');output.dataset.status=feedback?.status??'idle';
    const missions=$('.tactical-missions');missions.replaceChildren();
    for(const record of records){
      if(!record.current)continue;const line=doc.createElement('span'),method=record.action==='attack'?ATTACK_METHODS[record.current.attackMethod]:record.action==='defend'?DEFENSE_METHODS[record.current.defenseMethod]:null;line.textContent=`${unit(record.unitId)?.callsign??record.unitId} · ${method?.[en()?'en':'zh']??actionName(record.action)} · ${statusName(record.status)}`;missions.append(line);
    }
    const queue=$('#tactical-queue');queue.hidden=!queues.length;queue.querySelector('.tactical-queue-label').textContent=text(`后续 ${queues.length}`,`Queued ${queues.length}`);const ol=queue.querySelector('ol');ol.replaceChildren();
    for(const record of queues){const li=doc.createElement('li');li.textContent=`${unit(record.ownerId)?.callsign??record.ownerId} · ${actionName(record.action)}`;ol.append(li);}
    const clear=queue.querySelector('button');clear.textContent=text('清除后续','Clear queue');clear.disabled=typeof commands.clearQueued!=='function';
    $('.tactical-help').textContent=text('按住 R 进攻方针 · T 防御方针 · C 直接机动，指向后松键提交；中心 / Esc 取消。Shift 追加 · V 说话','Hold R: offense · T: defence · C: manoeuvre. Point and release; center / Esc cancels. Shift: queue · V: talk');
  }
  update();
  return {update,wheel,reset(){wheel.close();selection=[getSelected()];external=getSelected();feedback=null;voiceHeld=false;cancelTarget();renderKey='';update();},get selectedIds(){return [...selection];},get primaryId(){return selection[0]??null;},get targeting(){return armed?{...armed,unitIds:[...armed.unitIds]}:null;},dispose(){wheel.dispose();disposed=true;for(const remove of listeners)remove();stopLanguage();resize?.disconnect();menu.remove();css.remove();stage.classList.remove('tactical-active','tactical-targeting');stage.style.removeProperty('--tactical-dock-height');}};
}
