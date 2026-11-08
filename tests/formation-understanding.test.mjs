import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {COMMAND_CATALOG} from '../sim/military-commands.js';
import {FORMATIONS,COOPERATION_MODES} from '../sim/formation-doctrine.js';
import {pilotReading} from '../server/pilot-handbook.mjs';
import {EMPTY_PARAMETERS,normalizeMilitaryInterpretation,compileMilitaryInterpretation} from '../server/military-planner.mjs';
import {createLocalAiClient} from '../server/local-ai-client.mjs';
import {createQwenClient} from '../server/qwen.mjs';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {pilotObservation} from '../sim/pilot-watch.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const order=(intent,unitIds,parameters={},extra={})=>({id:'order-1',intent,unitIds,speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters},...extra});
const value=(...orders)=>({version:'1.0',status:'understood',summary:'已理解编队任务',orders});
const compile=(w,...orders)=>compileMilitaryInterpretation(normalizeMilitaryInterpretation(value(...orders)),commandContext(w,'blue-1'));

test('队形和合作词触发对应版本手册，普通航向不加载；2B知识控制在700字内',()=>{
  for(const instruction of ['右梯队','双机自由配合','mutual_support','loose_deuce','thach_weave','formation_change','assign_role','Bravo, JOIN UP with Alpha']){
    const full=pilotReading(instruction),small=pilotReading(instruction,{compact:true});
    assert.ok(full.files.some(f=>f.id==='formation'),instruction);assert.ok(!full.files.some(f=>f.id==='formation_compact'));
    assert.ok(small.files.some(f=>f.id==='formation_compact'));assert.ok(!small.files.some(f=>f.id==='formation'));
  }
  assert.ok(!pilotReading('Alpha，航向270').files.some(f=>f.id.startsWith('formation')));
  const small=pilotReading('双机自由配合',{compact:true}).text.split('【参考文件：08_编队协同速记.txt】\n')[1];
  assert.ok(small.length<700,small.length);
});

test('七种队形统一别名；双机队形可装订但不瞬移，四指仍须澄清',()=>{
  for(const f of FORMATIONS){
    const w=world(),input=value(order('formation_change',['blue-1','blue-2'],{formation:f.aliases[0]}));
    const normalized=normalizeMilitaryInterpretation(input);assert.equal(normalized.orders[0].parameters.formation,f.id);
    const result=compileMilitaryInterpretation(normalized,commandContext(w,'blue-1'));
    assert.equal(result.execution.status,f.id==='finger_four'?'needs_clarification':'ready');
    const before=w.units.map(u=>[...u.position]);applyPlan(w,result.plan,w.revision);assert.deepEqual(w.units.map(u=>u.position),before);
  }
  const w=world(),result=compile(w,order('join_formation',['blue-2'],{targetId:'blue-1',formation:'右梯队',side:'右侧',rangeM:2000}));
  assert.match(result.plan.summary,/Alpha.*梯队.*右侧.*2 km/i);assert.equal(result.plan.tasks.length,1);
  assert.equal(compile(w,order('join_formation',['blue-2'],{targetId:'blue-1',formation:'finger_four'})).execution.status,'needs_clarification');
});

test('协同模式与角色保留，四机足够才能构成四指，拒绝自我跟随和无对象保护',()=>{
  for(const mode of COOPERATION_MODES){
    const result=compile(world(),order('cooperate',['blue-1','blue-2'],{mode:mode.aliases[0]}));
    assert.equal(result.execution.status,'capability_unavailable');assert.match(result.plan.summary,new RegExp(mode.label));
  }
  assert.equal(compile(world(),order('cooperate',['blue-1'],{mode:'loose_deuce'})).execution.status,'needs_clarification');
  for(const intent of ['follow_unit','join_formation','cover','escort']){
    assert.equal(compile(world(),order(intent,['blue-1'],{targetId:'blue-1'})).execution.status,'needs_clarification');
    assert.equal(compile(world(),order(intent,['blue-1'])).execution.status,'needs_clarification');
  }
  const w=world(),context=commandContext(w,'blue-1');
  context.units.push(...context.units.map((u,i)=>({...u,id:`blue-${i+3}`,callsign:['Charlie','Delta'][i]})));
  const four=compileMilitaryInterpretation(value(order('formation_change',context.units.map(u=>u.id),{formation:'finger_four'})),context);
  assert.equal(four.execution.status,'needs_clarification');
  const roles=compile(w,order('assign_role',['blue-1'],{role:'交战机'}),order('assign_role',['blue-2'],{role:'自由机'}));
  assert.match(roles.plan.summary,/Alpha.*交战机.*Bravo.*自由机/i);
});

test('攻防分工与阶段条件不混淆，整批任务保持不执行',()=>{
  const w=world(),input=normalizeMilitaryInterpretation(value(
    order('attack',['blue-1'],{targetRef:'敌机一号'}),
    order('cover',['blue-2'],{targetId:'blue-1'},{timing:'after_previous'}),
    order('join_formation',['blue-2'],{targetId:'blue-1'},{timing:'on_condition',condition:'威胁解除'})
  ),{instruction:'Alpha攻击敌机一号，Bravo掩护Alpha；如果威胁解除则加入Alpha编队'});
  assert.equal(input.orders[1].timing,'now');assert.equal(input.orders[1].parameters.targetId,'blue-1');assert.equal(input.orders[0].parameters.targetRef,'敌机一号');
  const result=compileMilitaryInterpretation(input,commandContext(w,'blue-1'));
  assert.equal(result.plan.tasks.length,0);assert.match(result.plan.summary,/威胁解除/);
  assert.ok(result.execution.missingCapabilities.some(c=>c.id==='scheduler'));
});

test('Flash完整知识与2B精简知识经过各自真实请求构造，保留队形参数',async()=>{
  const w=world(),context=commandContext(w,'blue-1'),instruction='Bravo加入Alpha右梯队，间隔两公里';
  const params={targetId:'blue-1',formation:'echelon',side:'right',rangeM:2000};
  const cloud=createQwenClient({apiKey:'test',baseUrl:'https://example.invalid/v1',commandModel:'flash',timeoutMs:1000},async(_url,options)=>{
    const body=JSON.parse(options.body),system=body.messages[0].content;
    assert.match(system,/07_编队与协同/);assert.doesNotMatch(system,/08_编队协同速记/);
    assert.ok(body.response_format.json_schema.schema.properties.orders.items.anyOf[1].properties.intent.enum.includes('cooperate'));
    return Response.json({choices:[{message:{content:JSON.stringify(value(order('join_formation',['blue-2'],params)))}}]});
  });
  const local=createLocalAiClient({async complete(role,messages){
    assert.equal(role,'commander');assert.match(messages[0].content,/08_编队协同速记/);assert.doesNotMatch(messages[0].content,/07_编队与协同/);
    assert.equal(messages.length,4); // system + one relevant example + actual input
    return {value:{status:'understood',summary:'Bravo加入Alpha右梯队',orders:[{intent:'join_formation',unitIds:['blue-2'],parameters:params}]},timing:{}};
  }},cloud);
  for(const client of [cloud,local]){
    const reply=await client.interpret({requestId:'formation-test',instruction,context});
    assert.equal(reply.execution.status,'ready');assert.equal(reply.interpretation.orders[0].parameters.rangeM,2000);
  }
});

test('事件2B识别规范协同意图并仅读取速记，结束后卸载',async()=>{
  let stopped=false;
  const assistant=new PilotAssistant('.',{runtimeFactory:()=>({health:()=>({status:'ready',memory:{}}),async start(){},async stop(){stopped=true;},
    async complete(_role,messages,schema){assert.match(messages[0].content,/队形是位置/);assert.doesNotMatch(messages[0].content,/07_编队与协同/);
      assert.deepEqual(schema.properties.decision.enum,['notify_commander']);assert.equal(schema.properties.missingData.maxItems,0);
      return {value:{decision:'notify_commander',message:'已理解双机自由配合，协同执行器尚未接入',missingData:[]},timing:{}};}})});
  const w=world(),u=w.units[0];u.pilotMission={id:'coop-1',intent:'cooperate',timing:'now',condition:null,parameters:{mode:'loose_deuce'},revision:w.revision};
  const reply=await assistant.assess({requestId:'coop-event',context:commandContext(w,u.id),observation:pilotObservation(w,u)});
  assert.equal(reply.modelInvoked,true);assert.ok(reply.knowledgeUsed.some(f=>f.id==='formation_compact'));assert.equal(stopped,true);
  assert.ok(COMMAND_CATALOG.some(c=>c.id==='cooperate'));
});
