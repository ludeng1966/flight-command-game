import {World} from '../sim/world.js';
import {makeOpponentScenario} from '../sim/opponent.js';
import {installAttackTask} from '../sim/attack-task.js';
import {taskFeedback,taskTimeline} from '../sim/task-feedback.js';
import {AttackPilot} from './attack-pilot.js';
import {RwrPilot} from './rwr-pilot.js';
const $=s=>document.querySelector(s),report={version:1,startedAt:null,clockRate:1,rounds:[]};
const profiles=await(await fetch('../data/aircraft.json')).json();
let world,current,running=false,calls=0;
function log(text){const li=document.createElement('li');li.textContent=`${current?.name??''} · ${text}`;$('#log').prepend(li);$('#log').scrollTop=0;while($('#log').children.length>240)$('#log').lastElementChild.remove();}
function evidence(){ $('#evidence').textContent=JSON.stringify(report,null,2); }
function draw(){if(!world)return;const ctx=$('#map').getContext('2d'),blue=world.units[0],snap=world.snapshot(blue.id,{forecast:false});ctx.clearRect(0,0,760,490);ctx.strokeStyle='#163349';for(let x=0;x<760;x+=38){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,490);ctx.stroke();}for(let y=0;y<490;y+=38){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(760,y);ctx.stroke();}const xy=p=>[380+(p[0]-blue.position[0])*.009,370-(p[1]-blue.position[1])*.009];for(const u of snap.units){const [x,y]=xy(u.position);ctx.fillStyle=u.id===blue.id?'#83d9cd':'#ff9b85';ctx.beginPath();ctx.arc(x,y,8,0,7);ctx.fill();ctx.font='15px system-ui';ctx.fillText(u.callsign,x+13,y+5);}for(const m of snap.missiles.filter(m=>m.alive)){const[x,y]=xy(m.position);ctx.fillStyle='#fff0a3';ctx.fillRect(x-3,y-3,6,6);}const t=blue.attackTask;$('#facts').textContent=`T+${world.time.toFixed(1)}s · 蓝方${blue.alive?'存活':'损毁'} · 攻击阶段 ${t.status} · 实际发射 ${t.firedMissileIds.length} 枚 · 云请求 ${current.requests.length} 次`;const f=taskFeedback(world,blue);$('#feedback').textContent=`界面反馈：${f.phase}。${f.reason??''}；${f.result}；${f.waiting}`;}
async function tracedFetch(url,options){
  if(++calls>72)throw Error('达到本次72次请求上限');
  const sampledWorld=world,body=JSON.parse(options.body),row={endpoint:url,requestedAt:world.time,context:body.context,observation:body.observation,wallStarted:Date.now()};current.requests.push(row);
  $('#status').textContent=`${current.name} · 正在请求真实云模型 · ${url.split('/').at(-1)} · 本轮第${current.requests.length}次`;
  try{const response=await fetch(url,options),data=await response.clone().json();Object.assign(row,{returnedAt:sampledWorld.time,latencySec:(Date.now()-row.wallStarted)/1000,httpStatus:response.status,response:data});log(`T+${sampledWorld.time.toFixed(1)} · ${response.ok?'模型提案（执行另核）':'请求失败'}：${data.originalModelDecision?.message??data.decision?.message??data.error??'无操作'}${data.decision?.operation?' → '+data.decision.operation:''}`);return response;}
  catch(e){row.error=e.message;throw e;}finally{evidence();}
}
const specs=[{id:'head_on',name:'第1轮 · 迎头对抗'},{id:'crossing',name:'第2轮 · 偏置交叉',setup(w){w.units[1].position[0]=10000;}},{id:'unobserved',name:'第3轮 · 目标在搜索范围外',setup(w){w.units[1].position=[0,110000,6500];}},{id:'launch_control',name:'第4轮 · 发射链路控制组（红方不反击）',setup(w){const red=w.units[1];red.opponent.enabled=false;red.headingTarget=Math.PI;red.holdAltitude=6500;red.targetSpeed=250;}}];
async function run(spec){
  current={id:spec.id,name:spec.name,requests:[],events:[],feedback:[],errors:[]};report.rounds.push(current);$('#round').textContent=spec.name;
  world=new World(makeOpponentScenario({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]}),profiles);spec.setup?.(world);
  const blue=world.units[0];installAttackTask(world,blue,{targetId:'red-training-1',targetRef:'RED TRAINER',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
  const attack=new AttackPilot({getWorld:()=>world,fetchImpl:tracedFetch}),rwr=new RwrPilot({getWorld:()=>world,fetchImpl:tracedFetch});
  const seen=new Set();let previousFeedback='',last=performance.now(),acc=0;
  await new Promise(resolve=>{const timer=setInterval(()=>{const now=performance.now();acc+=Math.min(.25,(now-last)/1000);last=now;while(acc>=1/60){world.step(1/60);acc-=1/60;}attack.tick();rwr.tick();for(const e of taskTimeline(world,blue,{limit:192})){if(!seen.has(e.id)){seen.add(e.id);current.events.push(e);if(e.source==='攻击'||e.source==='武器实测')log(`T+${e.time.toFixed(1)} · 程序事实：${e.summary}`);}}const f=taskFeedback(world,blue),key=JSON.stringify(f);if(key!==previousFeedback){current.feedback.push({time:world.time,...f});previousFeedback=key;}if(blue.attackTask.lastError&&!current.errors.includes(blue.attackTask.lastError))current.errors.push(blue.attackTask.lastError);draw();if(world.time>=80||!blue.alive){clearInterval(timer);attack.stop();rwr.stop();resolve();}},50);});
  current.executionEvents=structuredClone(blue.attackTask.events);
  for(const request of current.requests){const d=request.response?.decision;if(!d?.operation)continue;request.execution=current.executionEvents.find(e=>e.operation===d.operation&&e.time>=request.returnedAt-.02&&e.decisionCount===request.response.decisionCount+(e.type==='rejected'?0:1))??{status:'未发现对应执行事实，不作为执行成功'};}
  const hits=world.weaponEvents.filter(e=>e.type==='hit'&&e.ownerId===blue.id),launches=world.weaponEvents.filter(e=>e.type==='launch'&&e.ownerId===blue.id);
  current.consistency={falseHitReports:current.feedback.filter(f=>f.result==='指定目标命中已由导弹仿真确认'&&!hits.length).length,launchCountMatches:launches.reduce((n,e)=>n+e.id.split(',').length,0)===blue.attackTask.firedMissileIds.length,unobservedNoFire:spec.id!=='unobserved'||!launches.length};
  current.outcome={time:world.time,blueAlive:blue.alive,redAlive:world.units[1].alive,attackStatus:blue.attackTask.status,shots:blue.attackTask.firedMissileIds.length,weaponEvents:structuredClone(world.weaponEvents),feedback:taskFeedback(world,blue),modelCalls:current.requests.filter(r=>r.response?.modelInvoked).length,errors:current.errors};
  const p=document.createElement('p');p.textContent=`${spec.name}：蓝方${blue.alive?'存活':'损毁'} / 红方${world.units[1].alive?'存活':'损毁'}；发射 ${current.outcome.shots} 枚；任务 ${current.outcome.attackStatus}；真实模型判断 ${current.outcome.modelCalls} 次；执行错误 ${current.errors.length} 项。`;if(report.rounds.length===1)$('#results').replaceChildren();$('#results').append(p);evidence();
}
$('#start').textContent='开始三轮对抗 + 发射控制组';
async function startRounds(selected){if(running)return;running=true;$('#start').disabled=true;control.disabled=true;report.startedAt=new Date().toISOString();report.testSelection=selected.map(s=>s.id);try{const h=await(await fetch('/api/health')).json();if(!h.commandReady)throw Error('真实云模型未就绪，请先在游戏设置配置API');report.model=h.pilotAssistant?.model??h.commandModel;for(const spec of selected)await run(spec);$('#status').textContent=`${selected.length}轮真实测试完成。控制组红方不反击；可导出每次请求、模型判断、实际事件和反馈证据。`;}catch(e){report.error=e.message;$('#status').textContent='测试停止：'+e.message;}finally{running=false;$('#export').disabled=false;evidence();}}
const control=document.createElement('button');control.textContent='只跑发射链路控制组';control.id='control';$('#start').after(control);
$('#start').onclick=()=>startRounds(specs);control.onclick=()=>startRounds(specs.slice(-1));
$('#export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));a.download='battle-cloud-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
