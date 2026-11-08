import {applyAtcDecision} from './atc-decisions.js';
export const ATC_INTENTS=['atc_sequence','change_runway','atc_clearance','atc_cancel_clearance','atc_hold','atc_resume'];
export const ATC_PHASES=['taxi','line_up','takeoff','approach','land'];
export const ATC_LANGUAGE_RULES=`塔台实际控制已接入自然语言，使用这些独立意图，不把排序/改跑道变成飞行航向或report_event：
飞行员会在等待点、对正和最后进近报告并请求line_up/takeoff/land。airportTraffic.pendingPilotRequests是已经实际播报、尚待许可的请求。玩家自然回应“批准”“可以了”等且只有一个待许可请求时，使用该请求的unitId、runway和clearance作为atc_clearance.mode，不因选中了另一架而向错误飞机放行；多个请求且无法确定对象时澄清。明确呼号和阶段始终以玩家原话为准。飞行员申请不等于塔台已授权。
atc_sequence调整队列：quantity=名次（第一=1、第二=2）；相对排序用targetId/targetRef指参照机，mode=before/after，quantity=null。先走/下一架用quantity=1；前后排序是现在修改队列，timing=now，不是条件调度。未指定参照或名次才澄清，不要求玩家提供内部优先级。
change_runway是修改已有机场任务的跑道，runway填新完整编号，原任务、推力与进近类型保留；mode仅在明确指定滑行道时填A,A1等实际名称。不能改成新的takeoff/land来重建任务。
atc_clearance签发已有任务的阶段许可，mode只能taxi/line_up/takeoff/approach/land；runway明确给出则保留，未说则可用本机groundRunway。可以起飞/准许起飞/CLEARED FOR TAKEOFF、签发进近许可、准许着陆都用此意图。在lined_up已对正阶段简单说“起飞”也用atc_clearance+mode=takeoff。安排整体离场任务才用takeoff；新滑行目的地用taxi，加入新进近程序用approach。明确只准进近不能追加着陆许可。
atc_cancel_clearance取消许可，mode填对应阶段或all。取消不等于中断已开始的滑跑，中断仍用abort_takeoff。
atc_hold地面原位等待，durationSec有明确时长才填，否则保持到新指令；atc_resume继续按原有效滑行许可滑行。不是空中盘旋，不重建或清空机场任务。
以上意图其余不适用参数保持null、append=false。同一句可以分别给不同飞机排序或许可；speechAct用directive/clearance，不能把玩家的调度请求当成仅记录的通报。严苛逐项许可、宽松整体流程，安全限制不放宽。`;
export const ATC_ORDER_KEYS=['operation','runway','phase','sequenceNumber','targetId','relation','durationSec','taxiways'];
export const ATC_ORDER_SCHEMA={type:'object',additionalProperties:false,required:ATC_ORDER_KEYS,properties:{operation:{enum:['sequence','change_runway','clearance','cancel','hold','resume']},runway:{type:['string','null']},phase:{enum:[null,...ATC_PHASES,'all']},sequenceNumber:{type:['integer','null'],minimum:1,maximum:32},targetId:{type:['string','null']},relation:{enum:[null,'before','after']},durationSec:{type:['number','null'],minimum:1,maximum:3600},taxiways:{type:'array',maxItems:12,items:{type:'string'}}}};
const pending=q=>['pending','waiting','cleared','missed'].includes(q.status);
function queue(world){return world.airportOps.traffic.state.requests.filter(pending).sort((a,b)=>b.priority-a.priority||(a.sequence??Infinity)-(b.sequence??Infinity)||a.requestedAt-b.requestedAt||a.id.localeCompare(b.id));}
export function validateAtcOrder(o,ids){
  if(!o||Object.keys(o).length!==ATC_ORDER_KEYS.length||!ATC_ORDER_KEYS.every(k=>Object.hasOwn(o,k))||!['sequence','change_runway','clearance','cancel','hold','resume'].includes(o.operation)||!(o.runway===null||typeof o.runway==='string'&&/^\d{2}[LRC]?$/.test(o.runway))||!(o.phase===null||[...ATC_PHASES,'all'].includes(o.phase))||!(o.sequenceNumber===null||Number.isInteger(o.sequenceNumber)&&o.sequenceNumber>=1&&o.sequenceNumber<=32)||!(o.targetId===null||ids.includes(o.targetId))||![null,'before','after'].includes(o.relation)||!(o.durationSec===null||Number.isFinite(o.durationSec)&&o.durationSec>=1&&o.durationSec<=3600)||!Array.isArray(o.taxiways)||o.taxiways.length>12||o.taxiways.some(s=>typeof s!=='string'||!s||s.length>16))throw Error('塔台指令参数无效');
  if(o.operation==='sequence'?(o.sequenceNumber===null)===(o.targetId===null)||!!o.targetId!==!!o.relation:o.sequenceNumber!==null||o.targetId!==null||o.relation!==null)throw Error('排序须指定名次，或明确先于/后于哪架飞机');
  if(['clearance','cancel'].includes(o.operation)?!o.phase||o.operation==='clearance'&&o.phase==='all':o.phase!==null)throw Error('请明确许可阶段');
  if(o.operation!=='hold'&&o.durationSec!==null||o.operation!=='change_runway'&&o.taxiways.length)throw Error('本项塔台指令包含不适用的额外要求');
  if(o.operation==='change_runway'&&!o.runway)throw Error('请明确要改用的完整跑道编号');return o;
}
export function atcTaskFor(order,context){
  const p=order.parameters,operation=({atc_sequence:'sequence',change_runway:'change_runway',atc_clearance:'clearance',atc_cancel_clearance:'cancel',atc_hold:'hold',atc_resume:'resume'})[order.intent];
  const allowed=new Set(['runway','airportRef',...(operation==='sequence'?['quantity','mode','targetId','targetRef']:['clearance','cancel'].includes(operation)?['mode']:operation==='hold'?['durationSec']:operation==='change_runway'?['mode']:[])]);
  const extra=Object.entries(p).filter(([k,v])=>v!==null&&v!==false&&!allowed.has(k)).map(([k])=>k);
  if(p.append||extra.length)throw Error('本条塔台安排混入了其他飞行或特殊要求；请保留原话明确的要求，改为适用的任务，不能忽略附加要求后执行');
  if(p.airportRef&&!context.airports?.some(a=>[a.id,a.name].includes(p.airportRef)))throw Error('机场不在当前场景');
  let targetId=p.targetId;
  if(p.targetRef&&!targetId){const ref=p.targetRef.trim().toLowerCase(),matches=context.units.filter(u=>[u.id,u.callsign,...(u.aliases??[])].some(n=>n?.toLowerCase()===ref));if(matches.length!==1)throw Error('排序参照飞机不明确');targetId=matches[0].id;}
  return order.unitIds.map(unitId=>{const u=context.units.find(u=>u.id===unitId),o={operation,runway:p.runway??u.groundRunway??null,phase:['clearance','cancel'].includes(operation)?p.mode:null,sequenceNumber:operation==='sequence'?(p.quantity??(p.mode==='first'||p.mode==='next'?1:p.mode==='last'?context.airportTraffic?.queue.length:null)):null,targetId:operation==='sequence'?targetId:null,relation:operation==='sequence'&&targetId?p.mode:null,durationSec:operation==='hold'?p.durationSec:null,taxiways:operation==='change_runway'&&p.mode?p.mode.split(/[,，\s]+/).filter(Boolean):[]};
    validateAtcOrder(o,context.units.map(u=>u.id));return {unitId,action:'atc',atcOrder:o};});
}
export function validateAtcAssignment(world,u,o){
  validateAtcOrder(o,world.units.map(u=>u.id));const ops=world.airportOps,s=u?.surface;if(!ops||!u?.alive||!s)throw Error('该机尚无机场管制任务');
  if(o.operation==='sequence'){
    const ordered=queue(world),own=ordered.find(q=>q.id===s.atcRequestId);if(!own)throw Error('该机不在进离场队列');if(o.targetId===u.id)throw Error('不能以本机作为排序参照');
    if(o.targetId&&!ordered.some(q=>q.unitId===o.targetId))throw Error('排序参照机不在进离场队列');if(o.sequenceNumber>ordered.length)throw Error('排序名次超过当前进离场飞机数量');return;
  }
  if(o.operation==='change_runway'){if(!s.runway)throw Error('请先安排本机进离场任务，再修改跑道');ops.runway(o.runway);if(s.phase==='lined_up'||s.phase==='takeoff_roll'||s.runwayLocked)throw Error('当前阶段不能改跑道，须先脱离或中断起飞');return;}
  if(o.runway&&o.runway!==s.runway)throw Error('许可跑道与本机任务不一致，请先下达改跑道指令');
  if(['hold','resume'].includes(o.operation)&&(!s.grounded||s.phase==='takeoff_roll'))throw Error('地面等待或继续仅适用于尚未滑跑的地面飞机');
  if(o.operation==='clearance'){
    if(o.phase==='taxi'&&(!s.grounded||s.phase!=='taxi'||!s.route.length))throw Error('请先安排滑行目的地或离场任务');
    if(o.phase==='line_up'&&(!s.grounded||s.phase!=='holding'))throw Error('飞机尚未到跑道外等待点');
    if(o.phase==='takeoff'&&(!s.grounded||s.phase!=='lined_up'))throw Error('飞机尚未进入跑道对正');
    if(['approach','land'].includes(o.phase)&&(s.grounded||!(o.phase==='approach'?['approach','final','missed','arrival_hold']:['approach','final']).includes(s.phase)))throw Error('请先安排进近程序');
  }
  if(o.operation==='cancel'&&['takeoff_roll','rollout'].includes(s.phase))throw Error('已经开始滑跑，请下达中断起飞或其他适用的应急指令');
}
export function applyAtcOrder(world,u,o){
  validateAtcAssignment(world,u,o);const ops=world.airportOps,atc=ops.traffic,s=u.surface;
  if(o.operation==='sequence'){
    const ordered=queue(world),own=ordered.find(q=>q.id===s.atcRequestId),others=ordered.filter(q=>q!==own),index=o.sequenceNumber!==null?o.sequenceNumber-1:others.findIndex(q=>q.unitId===o.targetId)+(o.relation==='after'?1:0);
    const oldIndex=ordered.indexOf(own),crossed=ordered.slice(Math.min(index,oldIndex),Math.max(index,oldIndex)+1);
    if(index!==oldIndex&&crossed.some(q=>['holding','lineup_taxi','lined_up','takeoff_roll','final','rollout'].includes(world.units.find(v=>v.id===q.unitId)?.surface?.phase)))throw Error('已有交通到达等待点、进入跑道或最后进近，无法直接交换顺序；请先安排等待、脱离或分流');
    const emergency=q=>{const v=world.units.find(u=>u.id===q.unitId);return v?.surface?.emergency||v?.fuel?.status==='emergency';};
    if(!emergency(own)&&others.slice(index).some(emergency))throw Error('紧急航空器优先，不能排在其前方');
    if(emergency(own)&&others.slice(0,index).some(q=>!emergency(q)))throw Error('紧急航空器不能被排到普通交通之后');
    others.splice(index,0,own);others.forEach((q,i)=>{q.priority=emergency(q)?100:90-i;q.sequence=i+1;q.playerSequence=true;const member=world.units.find(v=>v.id===q.unitId);if(member?.surface)member.surface.atcGroundOrder=i+1;});
    atc.notice(u,world,`按指示调整排序，本场第${index+1}号`,`TRAFFIC SEQUENCE REVISED. NUMBER ${index+1}.`,s.station??'tower');
  }else if(o.operation==='change_runway')applyAtcDecision(world,{unitId:u.id,action:'change_runway',runway:o.runway,taxiways:o.taxiways,approachType:null,reasonZh:`按指示改用跑道${o.runway}，等待修订许可`,reasonEn:`CHANGE TO RUNWAY ${o.runway}. AWAIT REVISED CLEARANCE.`});
  else if(o.operation==='clearance'){
    if(o.phase==='approach'&&['missed','arrival_hold'].includes(s.phase))ops.apply(u,{intent:'approach',runway:o.runway??s.runway,airportId:ops.airport.id,mode:s.approachType??'ils',taxiways:[],gate:s.arrivalGate??null,altitudeM:null},world);
    atc.authorize(u,o.phase,world);if(o.phase==='taxi')s.atcHoldUntil=0;
  }
  else if(o.operation==='cancel'){
    const phases=o.phase==='all'?ATC_PHASES:[o.phase];for(const type of phases){const c=atc.current(u,type);if(c)atc.cancel(c,world,'按玩家指示取消','CANCELLED AS INSTRUCTED');if(s.playerAuthorizations)delete s.playerAuthorizations[type];if(s.explicitPhaseClearances)delete s.explicitPhaseClearances[type];}
    s.clearanceInhibits??={};for(const phase of phases)s.clearanceInhibits[phase]=true;
    if(phases.includes('taxi'))s.atcHoldUntil=Infinity;if(phases.includes('takeoff'))s.depart=false;if(phases.includes('line_up'))s.lineUp=false;if(phases.includes('land')){s.landingRequested=false;s.landCleared=false;}
    if(phases.includes('approach')&&!s.grounded&&['approach','final'].includes(s.phase))ops.goAround(u,world,'按指示取消进近，执行公布复飞程序');
  }else if(o.operation==='hold'){s.atcHoldUntil=o.durationSec===null?Infinity:world.time+o.durationSec;atc.notice(u,world,'保持原位，等待进一步指令','HOLD POSITION, AWAIT FURTHER INSTRUCTIONS.','ground');}
  else if(o.operation==='resume'){s.atcHoldUntil=0;if(s.phase==='taxi')atc.authorize(u,'taxi',world);atc.notice(u,world,'按有效滑行许可继续，保持跑道外等待','CONTINUE TAXI AS CLEARED. HOLD SHORT OF THE RUNWAY.','ground');}
  s.lastAtcOrder={...structuredClone(o),appliedAt:world.time};atc.state.revision++;
}
export function atcOrderPhrase(o,units=[],en=false){
  const r=o.runway?(en?', RUNWAY ':'，跑道')+o.runway:'',phases={taxi:['滑行','TAXI'],line_up:['进入跑道对正等待','LINE UP AND WAIT'],takeoff:['起飞','TAKEOFF'],approach:['进近','APPROACH'],land:['着陆','LANDING'],all:['所有阶段','ALL PHASES']},phase=phases[o.phase]?.[en?1:0];
  if(o.operation==='sequence'){const target=units.find(u=>u.id===o.targetId)?.callsign??o.targetId;return o.sequenceNumber!==null?(en?`SEQUENCE NUMBER ${o.sequenceNumber}`:`排序第${o.sequenceNumber}位`):(en?`SEQUENCE ${o.relation==='before'?'BEFORE':'AFTER'} ${target}`:`排序在${target}${o.relation==='before'?'之前':'之后'}`);}
  if(o.operation==='change_runway')return (en?'CHANGE TO RUNWAY ':'改用跑道')+o.runway+(o.taxiways.length?(en?', TAXI VIA ':'，经滑行道')+o.taxiways.join(', '):'');
  if(o.operation==='clearance')return (en?`ISSUE ${phase} CLEARANCE`:`签发${phase}许可`)+r;
  if(o.operation==='cancel')return (en?`CANCEL ${phase} CLEARANCE`:`取消${phase}许可`)+r;
  if(o.operation==='hold')return (en?'HOLD POSITION':'保持原位')+(o.durationSec!==null?(en?` FOR ${o.durationSec} SECONDS`:`${o.durationSec}秒`):en?', UNTIL FURTHER INSTRUCTIONS':'，等待进一步指令');
  return en?'CONTINUE TAXI AS CLEARED':'按有效滑行许可继续滑行';
}
