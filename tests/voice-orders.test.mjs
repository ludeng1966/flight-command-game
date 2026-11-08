import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {World} from '../sim/world.js';
import {commandContext,validatePlan,applyPlan} from '../sim/orders.js';
import {encodeWav} from '../game/recorder.js';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {initVoiceCommands} from '../game/voice-command.js';
import {normalizeRadioInstruction,callsignAliases,radioReadback,RADIO_STYLES} from '../sim/radio.js';
import {extendHeadingRoute} from '../sim/navigation.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation,validateMilitaryInterpretation,normalizeMilitaryInterpretation,militarySchemaFor} from '../server/military-planner.mjs';
import {COMMAND_CATALOG} from '../sim/military-commands.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';

const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url)));
const profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const task=(action,extra={})=>({unitId:'blue-1',action,altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false,...extra});
const plan=(...tasks)=>({status:'accepted',summary:'一号机执行指令',tasks});
const military=(...orders)=>({version:'1.0',status:'understood',summary:'已理解军事口令',orders});
const militaryOrder=(intent,parameters={},extra={})=>({id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters},...extra});
const config=()=>({...readConfig({}),apiKey:'test-only-key'});
async function serve(t,c,fetchImpl){
  const server=createGameServer(c,{fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
const request=(w,instruction='一号机八千米六百公里每小时')=>({requestId:'test-17',instruction,context:commandContext(w,'blue-1')});
const post=(url,input)=>fetch(url+'/api/tactical/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});

test('参数指令经气动内核持续执行，不直接改写位置速度',()=>{
  const w=world(),u=w.units[0],position=[...u.position],velocity=[...u.velocity];
  applyPlan(w,plan(task('set_flight',{altitudeM:8000,speedMps:600/3.6})),0);
  assert.deepEqual(u.position,position);assert.deepEqual(u.velocity,velocity);
  for(let i=0;i<600;i++)w.step(1/60);
  assert.equal(u.targetAltitude,8000);assert.equal(u.holdAltitude,8000);assert.equal(u.targetSpeed,600/3.6);
  assert.ok(u.position[2]>position[2]);assert.ok(u.position.every(Number.isFinite));assert.equal(w.units[1].holdAltitude,6500);
});
test('保持航向能转向，手动航点替换该任务，盘旋可清除航路',()=>{
  const w=world();applyPlan(w,plan(task('fly_heading',{headingDeg:90})),0);
  for(let i=0;i<1200;i++)w.step(1/60);
  assert.ok(w.units[0].velocity[0]>30);assert.equal(w.units[0].headingRoute.headingDeg,90);assert.ok(w.units[0].waypoints.length>0);
  w.command('blue-1',[10000,20000,7000]);assert.equal(w.units[0].headingRoute,null);
  applyPlan(w,plan(task('orbit')),w.revision);assert.equal(w.units[0].waypoints.length,0);
});
test('组合航向、高度和速度指令经爬升与能量恢复后达到目标',()=>{
  const w=world();applyPlan(w,plan(task('fly_heading',{headingDeg:90,altitudeM:8000,speedMps:600/3.6})),0);
  for(let i=0;i<240*60;i++)w.step(1/60);
  const u=w.units[0];
  assert.ok(Math.abs(u.position[2]-8000)<50);
  assert.ok(Math.abs(u.speed*3.6-600)<5);
  assert.ok(Math.abs(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI-90)<1);
});
test('中文与英语逐位航向归一化，普通转弯和百十数词保持原意',()=>{
  assert.equal(normalizeRadioInstruction('Alpha，航向两拐洞'),'Alpha,航向270');
  assert.equal(normalizeRadioInstruction('航向洞勾洞'),'航向090');
  assert.equal(normalizeRadioInstruction('航向三六洞'),'航向360');
  assert.equal(normalizeRadioInstruction('Bravo heading zero nine zero'),'Bravo heading 090');
  assert.equal(normalizeRadioInstruction('heading two seven oh'),'heading 270');
  assert.equal(normalizeRadioInstruction('向右拐三十度'),'向右拐三十度');
  assert.equal(normalizeRadioInstruction('航向两百七十'),'航向两百七十');
  assert.deepEqual(RADIO_STYLES,['pla','nato']);
});
test('场景呼号词典明确 Alpha/Bravo 与数字呼号，保持旧二号呼号兼容',()=>{
  const w=world(),context=commandContext(w,'blue-2',null,'nato');
  assert.ok(context.units[0].aliases.includes('Alfa'));assert.ok(context.units[0].aliases.includes('幺洞幺'));
  assert.ok(context.units[1].aliases.includes('Bravo'));assert.ok(context.units[1].aliases.includes('ALPHA 02'));
  assert.ok(!callsignAliases(w.units[0],0).includes('Bravo'));assert.equal(context.radioStyle,'nato');
});
test('航向270生成西向三维航点，保持位置不变，爬升沿航段分配',()=>{
  const w=world(),u=w.units[0],before=[...u.position];
  const result=applyPlan(w,plan(task('fly_heading',{headingDeg:270,altitudeM:8000})),0);
  assert.deepEqual(u.position,before);assert.equal(u.headingTarget,null);assert.equal(u.waypoints.length,4);
  assert.equal(u.headingRoute.continuous,true);assert.ok(u.waypoints[0][0]<before[0]);
  assert.ok(Math.abs(u.waypoints[0][1]-before[1])<.001);
  assert.equal(u.waypoints.at(-1)[2],8000);assert.ok(u.waypoints[0][2]>6500&&u.waypoints[0][2]<8000);
  assert.match(result.summary,/幺洞幺.*航向两拐洞/);assert.match(result.summary,/持续延伸/);
});
test('持续航向自动延伸但不改变指令版本；人工航点终止自动延伸',()=>{
  const w=world(),u=w.units[0];applyPlan(w,plan(task('fly_heading',{headingDeg:270})),0);
  u.waypoints=u.waypoints.slice(-1);const end=[...u.waypoints[0]],revision=w.revision;
  extendHeadingRoute(w,u);assert.equal(w.revision,revision);assert.equal(u.waypoints.length,3);
  assert.ok(u.waypoints.at(-1)[0]<end[0]);
  w.command(u.id,[1000,2000,6500]);extendHeadingRoute(w,u);assert.equal(u.headingRoute,null);assert.equal(u.waypoints.length,1);
});
test('有距离的航向航段不会自动延伸，地图限制也不会被绕过',()=>{
  const w=world(),u=w.units[0];applyPlan(w,plan(task('fly_heading',{headingDeg:270,distanceM:10000})),0);
  assert.equal(u.headingRoute.continuous,false);assert.equal(u.waypoints.length,2);
  assert.ok(Math.abs(u.waypoints.at(-1)[0]-u.position[0]+10000)<.001);
  u.waypoints=u.waypoints.slice(-1);extendHeadingRoute(w,u);assert.equal(u.waypoints.length,1);
  u.headingRoute.continuous=true;w.terrain={checkRoute:()=>({valid:false,reason:'超出地图'})};
  extendHeadingRoute(w,u);assert.equal(u.waypoints.length,1);assert.equal(u.headingRoute.continuous,false);assert.match(u.headingRoute.blockedReason,/超出地图/);
});
test('北约式回执按三位航向逐位复诵，中文风格不会改变任务语义',()=>{
  const w=world(),p=plan(task('fly_heading',{headingDeg:90,distanceM:10000}));
  assert.match(radioReadback(p,w.units,'nato'),/ALPHA 01，ROGER.*HEADING ZERO NINER ZERO/);
  assert.match(radioReadback(p,w.units,'pla'),/幺洞幺，收到.*航向洞勾洞/);
});
test('军事协议覆盖起降、编队、武器与交战，未来任务识别后按能力阻塞',()=>{
  for(const id of ['taxi','takeoff','approach','land','go_around','join_formation','attack','defend','crank','weapons_free','radar_mode','countermeasures'])assert.ok(COMMAND_CATALOG.some(c=>c.id===id),id);
  const w=world(),value=military(militaryOrder('takeoff',{runway:'27',altitudeM:3000}));
  const before=JSON.stringify(w),context={...commandContext(w,'blue-1'),airports:[]},compiled=compileMilitaryInterpretation(value,context);
  assert.equal(compiled.execution.status,'capability_unavailable');assert.ok(compiled.execution.missingCapabilities.some(c=>c.id==='airfields'));
  assert.equal(compiled.plan.tasks.length,0);assert.match(compiled.plan.summary,/起飞.*跑道27/);
  applyPlan(w,compiled.plan,w.revision);assert.equal(JSON.stringify(w),before);
});
test('已支持导航与尚未支持条件防御组成复合任务时，整批保留而不部分执行',()=>{
  const w=world(),value=military(militaryOrder('fly_heading',{headingDeg:270}),militaryOrder('defend',{side:'left'},{id:'order-2',timing:'on_condition',condition:'遭到导弹攻击'}));
  const result=compileMilitaryInterpretation(value,commandContext(w,'blue-1'));
  assert.equal(result.execution.status,'capability_unavailable');assert.equal(result.plan.tasks.length,0);
  assert.ok(result.execution.missingCapabilities.some(c=>c.id==='scheduler'));assert.match(result.plan.summary,/遭到导弹攻击/);
  assert.equal(value.orders[1].timing,'on_condition');assert.equal(result.execution.orderStates.length,2);
});
test('FOX 发射通报和WEAPONS FREE交战规则都不会被当作立即发射',()=>{
  const w=world(),context=commandContext(w,'blue-1');
  const fox=compileMilitaryInterpretation(military(militaryOrder('report_event',{mode:'FOX THREE'},{speechAct:'report'})),context);
  assert.equal(fox.execution.status,'informational');assert.equal(fox.plan.tasks.length,0);
  const free=compileMilitaryInterpretation(military(militaryOrder('weapons_free')),context);
  assert.equal(free.execution.status,'ready');assert.deepEqual(free.plan.tasks.map(t=>[t.action,t.weaponOrder.operation]),[['weapon','free']]);assert.ok(!free.plan.tasks.some(t=>t.weaponOrder?.operation==='launch'));
});
test('保留顺序任务、拒绝伪造单位与缺失条件，并支持只读本机状态报告',()=>{
  const w=world(),context=commandContext(w,'blue-1');
  const sequence=military(militaryOrder('takeoff',{runway:'27R'}),militaryOrder('join_formation',{targetId:'blue-2'},{id:'order-2',timing:'after_previous'}));
  const seq=compileMilitaryInterpretation(sequence,context);assert.match(seq.plan.summary,/前项完成后/);
  assert.throws(()=>validateMilitaryInterpretation(military(militaryOrder('attack',{}, {unitIds:['fake']})),context));
  assert.throws(()=>validateMilitaryInterpretation(military(militaryOrder('defend',{}, {timing:'on_condition'})),context));
  const report=compileMilitaryInterpretation(military(militaryOrder('report_status',{}, {speechAct:'request'})),context);
  const before=JSON.stringify(w);const readback=applyPlan(w,report.plan,w.revision);
  assert.equal(JSON.stringify(w),before);assert.match(readback.summary,/报告.*高度6500米/);
});
test('实体引用在输出 Schema 内限定，任务编号规范化，条件优先于顺序标签',()=>{
  const w=world(),context=commandContext(w,'blue-1'),schema=militarySchemaFor(context);
  assert.deepEqual(schema.properties.orders.items.anyOf[1].properties.unitIds.items.enum,['blue-1','blue-2']);
  assert.equal(schema.properties.orders.items.anyOf[1].properties.unitIds.minItems,1);
  assert.equal(schema.properties.orders.items.anyOf[0].properties.unitIds.maxItems,0);
  const input=military(militaryOrder('approach',{runway:'27'}),militaryOrder('go_around',{}, {id:'order-1',timing:'after_previous',condition:'跑道被占用'}));
  const normalized=normalizeMilitaryInterpretation(input);assert.equal(normalized.orders[1].id,'order-2');assert.equal(normalized.orders[1].timing,'on_condition');
  assert.doesNotThrow(()=>validateMilitaryInterpretation(normalized,context));
});
test('未实现的附加约束保留并阻止部分执行，武器数量也完整保留',()=>{
  const w=world(),context=commandContext(w,'blue-1');
  const constrained=compileMilitaryInterpretation(military(militaryOrder('fly_heading',{headingDeg:270,constraints:'转弯过载不超过2G'})),context);
  assert.equal(constrained.plan.tasks.length,0);assert.ok(constrained.execution.missingCapabilities.some(c=>c.id==='advanced_control'));
  const launch=military(militaryOrder('launch_weapon',{weapon:'雷达导弹',quantity:2,targetRef:'前方匪机'}));
  assert.doesNotThrow(()=>validateMilitaryInterpretation(launch,context));assert.equal(launch.orders[0].parameters.quantity,2);
});
test('不凭空添加顺序或具体防御机动，同时航向和高度合并为一个飞行目标',()=>{
  const w=world(),context=commandContext(w,'blue-1');
  const parsed=normalizeMilitaryInterpretation(military(militaryOrder('fly_heading',{headingDeg:270}),militaryOrder('set_flight',{altitudeM:8000},{id:'order-2',timing:'after_previous'})),{instruction:'Alpha，航向两拐洞，高度八千米'});
  const compiled=compileMilitaryInterpretation(parsed,context);assert.equal(compiled.execution.status,'ready');assert.equal(compiled.plan.tasks.length,1);assert.equal(compiled.plan.tasks[0].altitudeM,8000);
  const defense=normalizeMilitaryInterpretation(military(militaryOrder('notch',{}, {timing:'on_condition',condition:'遭到导弹攻击'})),{instruction:'遭到导弹攻击时向左防御'});
  assert.equal(defense.orders[0].intent,'defend');
  const explicit=normalizeMilitaryInterpretation(military(militaryOrder('notch')),{instruction:'Alpha，NOTCH LEFT'});assert.equal(explicit.orders[0].intent,'notch');
  const radar=normalizeMilitaryInterpretation(military(militaryOrder('search',{mode:'search'})),{instruction:'全体，雷达搜索'});assert.equal(radar.orders[0].intent,'radar_mode');
});
test('飞行执行器中途拒绝时回滚全部航路和参数',()=>{
  const w=world(),original=w.command;let calls=0;
  w.command=function(...args){if(++calls===2)throw Error('实际转弯不可行');return original.apply(this,args);};
  const before=JSON.stringify(w);
  assert.throws(()=>applyPlan(w,plan(task('set_flight',{altitudeM:8000}),task('fly_heading',{headingDeg:270})),w.revision),/实际转弯不可行/);
  assert.equal(JSON.stringify(w),before);
});
test('追加三维航点、多机命令及暂停结果',()=>{
  const w=world();
  const result=applyPlan(w,plan(task('fly_to',{eastM:10000,northM:20000,altitudeM:7000}),task('fly_to',{eastM:15000,northM:25000,altitudeM:8000,append:true}),task('set_flight',{unitId:'blue-2',speedMps:200}),task('pause',{unitId:null})),0);
  assert.equal(w.units[0].waypoints.length,2);assert.deepEqual(w.units[0].waypoints[0].slice(0,3),[10000,20000,7000]);
  assert.equal(w.units[1].targetSpeed,200);assert.equal(result.simulation,'pause');
});
test('非法批次原子拒绝：未知飞机、超范围、伪造动作、不兼容参数',()=>{
  for(const invalid of [task('set_flight',{unitId:'enemy',altitudeM:8000}),task('set_flight',{speedMps:999}),task('set_flight',{altitudeM:8000,headingDeg:90}),task('fire'),task('orbit',{headingDeg:90}),task('fly_to'),task('fly_heading',{headingDeg:NaN})]){
    const w=world(),before=JSON.stringify(w);
    assert.throws(()=>applyPlan(w,plan(task('set_flight',{altitudeM:8000}),invalid),0));assert.equal(JSON.stringify(w),before);
  }
});
test('新操作使旧计划失效，重复应用同一计划也会拒绝',()=>{
  const w=world(),p=plan(task('set_flight',{altitudeM:8000}));
  w.command('blue-1',[10000,10000,7000]);assert.throws(()=>applyPlan(w,p,0),/作废/);
  const revision=w.revision;applyPlan(w,p,revision);assert.throws(()=>applyPlan(w,p,revision),/作废/);
});
test('不支持和澄清结果不改变模拟状态',()=>{
  const w=world(),before=JSON.stringify(w);
  for(const status of ['unsupported','needs_clarification'])applyPlan(w,{status,summary:'尚未支持该战术',tasks:[]},0);
  assert.equal(JSON.stringify(w),before);
  assert.throws(()=>validatePlan({status:'unsupported',summary:'拒绝',tasks:[task('orbit')]},w.units));
});
test('地形不允许的后续航路使整批指令作废，已停机单位也拒绝执行',()=>{
  const w=world();w.terrain={checkRoute:(_from,points)=>({valid:points.every(p=>p[2]>=6000),reason:'航段低于地形'})};
  const before=JSON.stringify(w);
  assert.throws(()=>applyPlan(w,plan(task('set_flight',{speedMps:200}),task('fly_to',{eastM:1000,northM:2000,altitudeM:500})),0),/地形/);
  assert.equal(JSON.stringify(w),before);
  w.units[0].alive=false;assert.throws(()=>applyPlan(w,plan(task('orbit')),0),/停机/);
});
test('PCM WAV 编码保留采样率、单声道和幅值',()=>{
  const wav=Buffer.from(encodeWav([new Float32Array([-1,0,1,.5])],16000));
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);
  assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readInt16LE(44),-32768);assert.equal(wav.readInt16LE(48),32767);
});
test('语音 HTTP → 百炼 ASR → 文字 HTTP → 百炼解析 → 飞机执行闭环（模拟上游）',async t=>{
  const calls=[],expected=plan(task('set_flight',{altitudeM:8000,speedMps:600/3.6}));
  const base=await serve(t,config(),async(url,options)=>{
    const data=JSON.parse(options.body);calls.push(data);
    assert.equal(options.headers.Authorization,'Bearer test-only-key');assert.ok(url.endsWith('/chat/completions'));
    const content=data.model==='qwen3-asr-flash'?'一号机八千米六百公里每小时':JSON.stringify(military(militaryOrder('set_flight',{altitudeM:8000,speedMps:600/3.6})));
    return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  });
  const wav=encodeWav([new Float32Array(16000).fill(.1)],16000);
  const asr=await fetch(base+'/api/voice/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav});
  assert.equal(asr.status,200);const {text}=await asr.json();
  const w=world(),response=await post(base,request(w,text));assert.equal(response.status,200);
  const reply=await response.json();assert.equal(reply.requestId,'test-17');
  assert.equal(reply.command.authority,'player');assert.equal(reply.command.speakerRole,'commander');assert.equal(reply.command.planningOwner,'pilot');
  assert.deepEqual(reply.command.tasks,reply.plan.tasks);applyPlan(w,reply.plan,reply.revision);
  assert.equal(w.units[0].holdAltitude,8000);assert.equal(w.units[0].targetSpeed,600/3.6);
  assert.equal(calls[1].model,'qwen3.7-flash');assert.equal(calls[1].response_format.json_schema.strict,true);
  assert.ok(calls[0].messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));
});
test('缺少密钥时提供错误，静态文件可用，配置和服务文件不暴露',async t=>{
  const base=await serve(t,readConfig({}),()=>{throw Error('不应发起上游请求');});
  assert.equal((await fetch(base+'/game/')).status,200);
  assert.equal((await fetch(base+'/game/audio-capture-worklet.js')).headers.get('content-type'),'text/javascript; charset=utf-8');
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.commandReady,false);assert.ok(!JSON.stringify(health).includes('apiKey'));
  for(const route of ['/.env','/.env.example','/.git/config','/server/qwen.mjs','/tests/voice-orders.test.mjs','/%2eenv','/game/..%5c.env'])assert.equal((await fetch(base+route)).status,404,route);
  const r=await post(base,request(world()));assert.equal(r.status,503);assert.match((await r.json()).error,/DASHSCOPE_API_KEY/);
});
test('上游错误、截断和非法 AI 输出不返回可执行计划',async t=>{
  for(const upstream of [new Response('{}',{status:401}),Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]}),Response.json({choices:[{message:{content:'{"status":"accepted"}'}}]})]){
    const base=await serve(t,config(),async()=>upstream),r=await post(base,request(world()));
    assert.equal(r.status,502);const data=await r.json();assert.ok(data.error);assert.equal(data.plan,undefined);assert.ok(!JSON.stringify(data).includes('test-only-key'));
  }
});
test('偶发结构错误最多修复一次，修复后仍按完整语义校验',async t=>{
  let calls=0;const base=await serve(t,config(),async()=>{
    calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:calls===1?'{}':JSON.stringify(military(militaryOrder('fly_heading',{headingDeg:270})))}}]});
  });
  const r=await post(base,request(world(),'Alpha，航向两拐洞'));assert.equal(r.status,200);assert.equal(calls,2);
  const data=await r.json();assert.equal(data.execution.status,'ready');assert.equal(data.plan.tasks[0].headingDeg,270);
});
test('拒绝跨站调用、无效 JSON、未知上下文、非法录音和过大请求',async t=>{
  let calls=0;const base=await serve(t,config(),async()=>{calls++;throw Error('不应调用');});
  const cross=await fetch(base+'/api/tactical/interpret',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'});assert.equal(cross.status,403);
  const bad=await fetch(base+'/api/tactical/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(bad.status,400);
  const input=request(world());input.context.units[0].position=[null,1,2];assert.equal((await post(base,input)).status,400);
  assert.equal((await fetch(base+'/api/voice/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:'not audio'})).status,400);
  assert.equal((await fetch(base+'/api/tactical/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(70000)})).status,413);
  assert.equal(calls,0);
});

// 不依赖浏览器的界面控制器测试，专门验证异步回包、取消与重复点击。
function installCommandUi(t,onFetch){
  const element=()=>({value:'',checked:true,disabled:false,textContent:'',dataset:{},children:[],style:{setProperty(){}},
    setAttribute(){},addEventListener(){},focus(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},prepend(child){this.children.unshift(child);child.remove=()=>this.children.pop();},get lastElementChild(){return this.children.at(-1);}});
  const elements=new Map();
  const document=Object.assign(new EventTarget(),{querySelector:s=>{if(!elements.has(s))elements.set(s,element());return elements.get(s);},createElement:element});
  const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  globalThis.document=document;globalThis.window=new EventTarget();globalThis.fetch=onFetch;
  t.after(()=>Object.assign(globalThis,previous));return s=>document.querySelector(s);
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const instantRadio=()=>({radio:{transmit:async()=>{},phase(){},cancel(){},clear(){}},pause:async()=>{}});

test('实际指挥通话完成后才发送飞行员规划，飞行员请求不含玩家原文',async t=>{
 const w=world(),events=[];let body;
 installCommandUi(t,async(url,options)=>{
  if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true,pilotAssistant:{commandPlanning:true,enabled:false}});
  const input=JSON.parse(options.body);events.push(url);
  if(url==='/api/tactical/interpret')return Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,plan:plan(task('fly_heading',{headingDeg:90,altitudeM:6096,speedMps:350*1852/3600}))});
  assert.equal(url,'/api/tactical/pilot/plan');body=input;assert.equal(input.instruction,undefined);assert.equal(input.interpretation,undefined);assert.equal(input.commanderMessage.text,'指挥台实际通话：航向90，高度6100米，真空速648公里每小时。');
  return Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,commanderMessageId:input.commanderMessage.id,plan:plan(task('fly_heading',{headingDeg:90,altitudeM:6100,speedMps:648/3.6})),execution:{status:'ready'}});
 });
 const mocks=instantRadio();mocks.radio.transmit=async m=>{events.push(m.speaker);return {id:'heard-command',speechText:'指挥台实际通话：航向90，高度6100米，真空速648公里每小时。',speechLanguage:'zh-CN',text:m.text};};
 const control=initVoiceCommands({...mocks,getState:()=>({world:w,selectedId:'blue-1',mapPoint:null}),onApplied(){},onSimulation(){}});await settle();
 const r=await control.issue('玩家原始输入：Alpha，航向090，高度20000英尺，速度350节。');assert.equal(r.committed,true);assert.ok(events.indexOf('commander')<events.indexOf('/api/tactical/pilot/plan'));assert.equal(w.units[0].holdAltitude,6100);assert.equal(body.commanderMessage.id,'heard-command');assert.equal(w.units[0].pilotExecution.instruction,body.commanderMessage.text);assert.equal(w.units[0].pilotExecution.instructionSource,'commander');control.cancel();
});

test('手动航点成功后通过控制器复诵，指挥AI未就绪也不妨碍播报',async t=>{
  const w=world(),sent=[];let interpretCalls=0;
  installCommandUi(t,async url=>{if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:false});interpretCalls++;throw Error('手动航点不应请求AI');});
  const control=initVoiceCommands({...instantRadio(),radio:{async transmit(message){sent.push(message);},phase(){},cancel(){},clear(){}},getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){},onSimulation(){}});
  try{await settle();
  const point=[10000,10000,7000];w.command('blue-1',point);control.routeChanged('blue-1',{kind:'command',point});
  control.pumpAirportRadio();await settle();assert.equal(sent.length,0);
  await new Promise(resolve=>setTimeout(resolve,380));control.pumpAirportRadio();await settle();
  assert.equal(sent.length,1);assert.equal(sent[0].source,'manual-route');assert.match(sent[0].text,/新航路已接收/);assert.equal(interpretCalls,0);assert.equal(w.units[0].waypoints.length,1);
  }finally{control.cancel();}
});

test('教学入口原话交给AI，同一流程装订后才观察正确任务',async t=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),walk=new TrainingWalkthrough(w,'blue-1');walk.index=3;
  let original,commits=0;
  installCommandUi(t,async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true});
    assert.equal(url,'/api/tactical/interpret');const input=JSON.parse(options.body);original=input.instruction;
    assert.equal(w.units[0].surface.phase,'parked');assert.equal(walk.status,'active');
    const interpretation=military(militaryOrder('taxi',{runway:'09L'})),compiled=compileMilitaryInterpretation(interpretation,input.context);
    return Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,interpretation,...compiled});
  });
  const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){},onSimulation(){},onCommandCommitted({reply,source}){
    commits++;assert.equal(source,'training');assert.equal(w.units[0].surface.phase,'taxi');walk.observeExecuted(reply.interpretation);
  }});
  await settle();const result=await control.issue('Alpha，到左边09L那条跑道外等我下一步指令');
  assert.equal(original,'Alpha，到左边09L那条跑道外等我下一步指令');assert(result.committed);assert.equal(commits,1);assert.equal(walk.status,'active');assert.equal(walk.phase,'working');control.cancel();
});

test('错误对象也交给AI并实际下令，装订后才判教学失败',async t=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),walk=new TrainingWalkthrough(w,'blue-1');walk.index=3;
  let resolveReply,input;
  installCommandUi(t,async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true});
    input=JSON.parse(options.body);return new Promise(resolve=>resolveReply=resolve);
  });
  const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){},onSimulation(){},onCommandCommitted({reply}){assert.equal(w.units[1].surface.phase,'taxi');walk.observeExecuted(reply.interpretation);}});
  await settle();const pending=control.issue('Bravo，滑行到09L跑道外等候');await settle();
  assert.equal(walk.status,'active');assert.equal(w.units[1].surface.phase,'parked');
  const interpretation=military(militaryOrder('taxi',{runway:'09L'},{unitIds:['blue-2']})),compiled=compileMilitaryInterpretation(interpretation,input.context);
  resolveReply(Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,interpretation,...compiled}));
  await pending;assert.equal(walk.status,'failed');assert.match(walk.result().reason,/已执行.*接令对象错误/);assert.equal(w.units[0].surface.phase,'parked');control.cancel();
});

test('AI澄清与连接失败不判教学失败，也不退回关键词执行',async t=>{
  const w=new World(scenario,profiles,null,{spawnMode:'stands'}),walk=new TrainingWalkthrough(w,'blue-1');walk.index=3;let mode='clarify',commits=0;
  installCommandUi(t,async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true});
    if(mode==='offline')throw Error('网络不可用');
    const input=JSON.parse(options.body);return Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,interpretation:{status:'needs_clarification',orders:[]},plan:{status:'needs_clarification',summary:'请明确跑道',tasks:[]}});
  });
  const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){},onSimulation(){},onCommandCommitted(){commits++;}});
  await settle();assert.equal((await control.issue('Alpha，到跑道等着')).committed,false);
  mode='offline';await assert.rejects(control.issue('Alpha，滑行到09L跑道外等待'),/无法连接/);
  assert.equal(commits,0);assert.equal(walk.status,'active');assert.equal(w.units[0].surface.phase,'parked');control.cancel();
});
test('飞行员默认Flash；选2B显示不可下载并阻止下令，切回恢复',async t=>{
  const w=world();let calls=0;
  const $=installCommandUi(t,async url=>{if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true});calls++;throw Error('不应下令');});
  const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){},onSimulation(){}});
  await settle();assert.equal($('#pilot-model').value,'flash');assert.equal(control.pilotModel,'flash');assert.equal($('#pilot-model-download').hidden,true);
  $('#command-text').value='Alpha报告状态';$('#command-text').oninput();assert.equal($('#command-send').disabled,false);
  $('#pilot-model').value='2b';$('#pilot-model').onchange();await settle();assert.equal($('#pilot-model-download').hidden,false);assert.equal($('#command-send').disabled,true);assert.equal($('#command-mic').disabled,true);assert.equal(control.pilotAssistantEnabled,false);
  $('#command-send').onclick();assert.equal(calls,0);
  $('#pilot-model').value='flash';$('#pilot-model').onchange();await settle();assert.equal($('#pilot-model-download').hidden,true);assert.equal($('#command-send').disabled,false);window.dispatchEvent(new Event('pagehide'));
});
test('模型切换中止分析请求，旧回复不装订飞机任务',async t=>{
  const w=world();let resolveReply,input,signal,applied=0;
  const $=installCommandUi(t,async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true});
    input=JSON.parse(options.body);signal=options.signal;return new Promise(resolve=>{resolveReply=resolve;});
  });
  initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1'}),onApplied(){applied++;},onSimulation(){}});
  await settle();$('#command-text').value='Alpha八千米';$('#command-send').onclick();$('#pilot-model').value='2b';$('#pilot-model').onchange();assert.equal(signal.aborted,true);
  resolveReply(Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,plan:plan(task('set_flight',{altitudeM:8000}))}));
  await settle();assert.equal(applied,0);assert.equal(w.units[0].holdAltitude,6500);window.dispatchEvent(new Event('pagehide'));
});
test('前端重复点击只发送一次，分析期间切换选择不改变命令对象',async t=>{
  let resolveReply,input,count=0;const w=world();let selectedId='blue-1';
  const $=installCommandUi(t,async(url,options)=>{
    if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true});
    count++;input=JSON.parse(options.body);return new Promise(resolve=>{resolveReply=resolve;});
  });
  let applied=0;const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId,mapPoint:null}),onApplied:()=>applied++,onSimulation(){}});
  await settle();$('#command-text').value='一号机八千米';const pending=$('#command-send').onclick();$('#command-send').onclick();
  selectedId='blue-2';assert.equal(count,1);
  resolveReply(Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,plan:plan(task('set_flight',{altitudeM:8000}))}));
  await pending;await settle();assert.equal(applied,1);assert.equal(w.units[0].holdAltitude,8000);assert.equal(w.units[1].holdAltitude,6500);control.cancel();
});
test('前端取消或手动操作后，迟到的 AI 响应不会覆盖玩家命令',async t=>{
  for(const mode of ['cancel','manual']){
    let resolveReply,input;const w=world();const $=installCommandUi(t,async(url,options)=>{
      if(url==='/api/health')return Response.json({service:'tactical-voice',commandReady:true,voiceReady:true});
      input=JSON.parse(options.body);return new Promise(resolve=>{resolveReply=resolve;});
    });
    let applied=0;const control=initVoiceCommands({...instantRadio(),getState:()=>({world:w,selectedId:'blue-1',mapPoint:null}),onApplied:()=>applied++,onSimulation(){}});
    await settle();$('#command-text').value='一号机八千米';const pending=$('#command-send').onclick();
    if(mode==='cancel')control.cancel();else w.command('blue-1',[10000,10000,7000]);
    resolveReply(Response.json({requestId:input.requestId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,plan:plan(task('set_flight',{altitudeM:8000}))}));
    await pending;await settle();assert.equal(applied,0);assert.equal(w.units[0].holdAltitude,6500);assert.equal($('#command-send').disabled,false);control.cancel();
  }
});
