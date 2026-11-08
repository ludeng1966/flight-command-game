import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {verifyReadback,createCommandExchange} from '../sim/radio-procedure.js';
import {runCommandSession} from '../game/command-session.js';
import {createRadioConsole} from '../game/radio-console.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
import {commandContext} from '../sim/orders.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url)));
const profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const task={unitId:'blue-1',action:'fly_heading',altitudeM:8000,speedMps:600/3.6,headingDeg:270,eastM:null,northM:null,distanceM:null,append:false};
const plan={status:'accepted',summary:'Alpha向西飞，高度八千米，速度六百公里每小时',tasks:[task]};
const reply={requestId:'role-test',plan};
const instant=async()=>{};
test('飞行员准备阶段不改动飞机，装订只允许一次且拒绝过期任务',()=>{
  const w=world(),before=JSON.stringify(w),draft=preparePilotPlan(w,plan,0);
  assert.equal(JSON.stringify(w),before);assert.ok(draft.previews[0].points.length>1);
  commitPilotPlan(draft);assert.ok(w.units[0].waypoints.length>1);assert.throws(()=>commitPilotPlan(draft),/已经执行/);
  const stale=preparePilotPlan(w,plan,w.revision);w.revision++;assert.throws(()=>commitPilotPlan(stale),/旧航路已作废/);
});
test('指挥台不规划航点；完成复诵后逐点显示预览，装订后才可执行',async()=>{
  const w=world(),position=[...w.units[0].position],events=[],counts=[];
  const radio={phase(){},async transmit(message){events.push(message.speaker);if(events.length<=2)assert.equal(w.units[0].waypoints.length,0);}};
  const result=await runCommandSession({world:w,reply,expectedRevision:0,radio,pause:instant,
    onPreview(p){counts.push(p.count);assert.equal(w.units[0].waypoints.length,0);assert.equal(events.length,2);},
    onCommitted(){events.push('commit');assert.ok(w.units[0].waypoints.length);assert.equal(w.pilotPreview,null);}});
  assert.deepEqual(events,['commander','pilot','commit','pilot']);assert.deepEqual(counts,[1,2,3,4]);
  assert.equal(result.status,'executing');assert.deepEqual(w.units[0].position,position);assert.equal(w.units[0].headingRoute.headingDeg,270);
  for(let i=0;i<3600;i++)w.step(1/60);
  assert.ok(w.units[0].position[0]<position[0]-1000);assert.equal(w.units[0].alive,true);
});
test('复诵关键参数严格一致，改变航向或高度会拒绝',()=>{
  const x=createCommandExchange(plan,world().units);assert.equal(verifyReadback(plan.tasks,x.pilots[0].tasks),true);
  assert.match(x.commander.text,/航向两拐洞/);assert.doesNotMatch(x.commander.text,/航路已装订|WP/);
  assert.throws(()=>verifyReadback(plan.tasks,[{...task,headingDeg:90}]),/不一致/);
  assert.throws(()=>verifyReadback(plan.tasks,[{...task,altitudeM:7000}]),/不一致/);
  const decimal=createCommandExchange({...plan,tasks:[{...task,distanceM:1500}]},world().units,'nato');
  assert.match(decimal.commander.text,/ONE DECIMAL FIVE KILOMETERS/);
});
test('未配置机场的场景由飞行员报告缺失能力，保留原任务',async()=>{
  const w=world(),before=JSON.stringify(w),messages=[];
  const interpretation={version:'1.0',status:'understood',summary:'Alpha二七跑道起飞',orders:[{id:'order-1',intent:'takeoff',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,runway:'27'}}]};
  const compiled=compileMilitaryInterpretation(interpretation,{...commandContext(w,'blue-1'),airports:[]});
  const result=await runCommandSession({world:w,reply:{...compiled,interpretation},expectedRevision:0,pause:instant,radio:{phase(){},async transmit(m){messages.push(m);}}});
  assert.equal(result.status,'unable');assert.equal(JSON.stringify(w),before);assert.deepEqual(messages.map(m=>m.speaker),['commander','pilot']);
  assert.match(messages[0].text,/起飞.*跑道27/);assert.match(messages[1].text,/无法执行.*尚未具备/);
});
test('本机状态由飞行员报告，不虚构航路也不修改任务版本',async()=>{
  const w=world(),messages=[],reportReply={plan:{status:'accepted',summary:'报告本机',tasks:[{...task,action:'report_status',altitudeM:null,speedMps:null,headingDeg:null}]}};
  const result=await runCommandSession({world:w,reply:reportReply,expectedRevision:0,pause:instant,radio:{phase(){},async transmit(m){messages.push(m);}}});
  assert.equal(result.status,'reported');assert.equal(w.revision,0);assert.equal(w.units[0].waypoints.length,0);assert.equal(messages[1].speaker,'pilot');assert.match(messages[1].text,/航向.*高度/);
});
test('复诵中取消、规划中取消和手动改令都不装订旧任务',async()=>{
  for(const mode of ['readback','plotting','manual']){
    const w=world(),controller=new AbortController();let messages=0;
    const radio={phase(){},async transmit(){if(++messages===2&&mode==='readback')controller.abort();}};
    await assert.rejects(runCommandSession({world:w,reply,expectedRevision:0,radio,signal:controller.signal,pause:instant,
      onPreview(){if(mode==='manual')w.revision++;else controller.abort();}}));
    assert.equal(w.units[0].waypoints.length,0);assert.equal(w.units[0].holdAltitude,6500);assert.equal(w.pilotPreview??null,null);
  }
});
test('规划不可行时飞行员报告UNABLE，已有任务与参数不变',async()=>{
  const w=world(),messages=[];w.terrain={checkPoint:()=>({valid:false,reason:'目标低于安全高度'})};
  await assert.rejects(runCommandSession({world:w,reply,expectedRevision:0,pause:instant,
    radio:{phase(){},async transmit(m){messages.push(m);}}}),/安全高度/);
  assert.match(messages.at(-1).text,/无法执行.*安全高度/);assert.equal(w.units[0].waypoints.length,0);assert.equal(w.units[0].holdAltitude,6500);
});
test('装订后终止通话不会撤销飞机已收到的航路',async()=>{
  const w=world(),controller=new AbortController();
  await assert.rejects(runCommandSession({world:w,reply,expectedRevision:0,pause:instant,signal:controller.signal,
    onCommitted(){controller.abort();},radio:{phase(){},async transmit(_m,{signal}){signal.throwIfAborted();}}}));
  assert.ok(w.units[0].waypoints.length);assert.equal(w.units[0].headingRoute.headingDeg,270);
});
test('未明确的指令由飞行员按航空通联报告UNABLE并请求重发，不改变飞机任务',async()=>{
  const w=world(),before=JSON.stringify(w.units),messages=[];
  const result=await runCommandSession({world:w,reply:{plan:{status:'needs_clarification',summary:'指令不明，无法执行所报机动，请明确转向方向',tasks:[]}},expectedRevision:w.revision,selectedUnitId:w.units[0].id,style:'nato',radio:{phase(){},async transmit(message){messages.push(message);}},pause:async()=>{}});
  assert.equal(result.committed,false);assert.equal(messages[0].speaker,'commander');assert.equal(messages[1].speaker,'pilot');assert.match(messages[1].text,/CONTROL, UNABLE/);assert.match(messages[1].text,/SAY AGAIN/);assert.match(messages[1].text,/MAINTAINING PREVIOUS TASK/);assert.match(messages[1].texts.zh,/指挥台，无法执行/);assert.match(messages[1].texts.zh,/请重发指令/);assert.equal(JSON.stringify(w.units),before);
});
test('本地语音依次读出指挥与飞行员，静音不中断已排定命令',async()=>{
  const w=world(),spoken=[],audio={setAttribute(){}};
  const synth={getVoices:()=>[{lang:'zh-CN',localService:true}],cancel(){},speak(u){spoken.push(u);u.onstart();queueMicrotask(()=>u.onend());}};
  const document={querySelector:s=>s==='#radio-audio'?audio:null};
  const radio=createRadioConsole({getWorld:()=>w,document,synth,provider:'browser',Utterance:class{constructor(text){this.text=text;}}});
  await radio.transmit({speaker:'commander',text:'航向两拐洞'});await radio.transmit({speaker:'pilot',unitId:'blue-1',text:'航向两拐洞，幺洞幺'});
  assert.deepEqual(w.radioLog.map(m=>m.delivery),['spoken','spoken']);assert.notEqual(spoken[0].pitch,spoken[1].pitch);
  synth.speak=()=>{};const pending=radio.transmit({speaker:'pilot',text:'正在执行'});await Promise.resolve();audio.onclick();await pending;
  assert.equal(w.radioLog.at(-1).delivery,'muted');
});
