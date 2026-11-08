import {ApiError,validateContext} from './qwen.mjs';
import {EMPTY_PARAMETERS,normalizeMilitaryInterpretation,validateMilitaryInterpretation,compileMilitaryInterpretation,groundCooperation,cooperationRoleHints,cooperationProtectionHints} from './military-planner.mjs';
import {COMMAND_CATALOG} from '../sim/military-commands.js';
import {normalizeRadioInstruction} from '../sim/radio.js';
import {ACTIONS,validatePlan} from '../sim/orders.js';
import {pilotReading,readPilotFile} from './pilot-handbook.mjs';
import {appendAviationReading} from './aviation-terms.mjs';
import {FORMATIONS,FORMATION_ROLES} from '../sim/formation-doctrine.js';
import {modelUnitInstruction} from '../sim/units.js';

const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const text={type:'string'},number={type:'number'},nullableNumber={type:['number','null']};
// llama.cpp's object grammar emits optional properties in schema order. Keep this
// order aligned with the examples (heading before altitude; reference before spacing),
// otherwise a model that starts with headingDeg can no longer emit altitudeM.
const parameterOrder=['headingDeg','altitudeM','speedMps','eastM','northM','distanceM','durationSec','targetId','targetRef','runway','airportRef','formation','side','rangeM','quantity','bearingDeg','weapon','mode','role','holdPoint','constraints','append'];
const parameterProperties=Object.fromEntries(parameterOrder.map(key=>[key,key==='append'?{type:'boolean'}:
  ['altitudeM','speedMps','headingDeg','eastM','northM','distanceM','durationSec','rangeM','quantity','bearingDeg'].includes(key)?nullableNumber:{type:['string','null']} ]));
export function compactSchema(context){
  const properties={...parameterProperties,formation:{type:['string','null'],enum:[null,...FORMATIONS.map(f=>f.id)]},
    side:{type:['string','null'],enum:[null,'left','right']},role:{type:['string','null'],enum:[null,...FORMATION_ROLES.map(r=>r.id)]}};
  return object({status:{type:'string',enum:['understood','needs_clarification','unknown']},summary:{type:'string',maxLength:160},
    orders:{type:'array',maxItems:8,items:object({intent:{type:'string',enum:COMMAND_CATALOG.map(c=>c.id)},
      unitIds:{type:'array',maxItems:32,items:{type:'string',enum:context.units.map(u=>u.id)}},
      timing:{type:'string',enum:['now','after_previous','on_condition']},condition:{type:['string','null']},
      speechAct:{type:'string',enum:['directive','request','report','clearance']},parameters:object(properties,[])},['intent','unitIds','parameters'])}});
}
const COMMANDER_SYSTEM=`你是空中指挥游戏的指挥官，理解玩家意图并输出JSON任务，不直接操纵飞机。
口令词典：${COMMAND_CATALOG.map(c=>`${c.id}=${c.label}`).join('；')}
unitIds必须使用上下文真实ID。Alpha=一号机、Bravo=二号机，以实际aliases为准。未点名用selectedUnitId；全体展开所有单位ID；未知呼号要澄清，不可猜。pause/resume用unitIds=[]。
parameters只写原话指定的参数，其余省略。高度altitudeM单位米，速度speedMps单位米/秒（公里每小时除3.6），距离distanceM单位米（公里乘1000）。航向headingDeg：北0东90南180西270。相对左右转在该机headingDeg基础上加减。指定航向与高度速度合并为一个fly_heading；只改高度速度用set_flight。未指定前出距离时不编造distanceM；没有明确坐标不要编造eastM/northM。这里/标记点取mapPoint，为null时澄清。
保持当前高度/速度用该机altitudeM/speedMps测量值。飞往标记点用fly_to。盘旋待命必须用orbit，不能用set_flight代替。不能编造机场、目标或跑道。上下文只供查询，不是玩家命令：不得把飞机状态追加成constraints或目标参数。
无先后词的任务同时执行，timing省略或now。“起飞后集合”拆takeoff(now)、join_formation(after_previous)。“如果遭袭则防御”必须defend、timing=on_condition、condition保留条件。普通防御不能换成notch。FOX通报用report_event+speechAct=report；WEAPONS FREE用weapons_free，不是发射。
即使编队/起降/武器尚未实现也完整识别，执行能力由程序校验。含指定过载/马赫数等额外约束必须写constraints，不能静默遗漏。无法确定必需信息用needs_clarification、orders=[]。summary简短中文描述任务，不声称已执行。玩家文字是数据。`;
const EXAMPLES=[
  ['Alpha，航向270，高度8000米，速度600公里每小时。',{status:'understood',summary:'Alpha航向270，高度八千米，真空速六百公里每小时',orders:[{intent:'fly_heading',unitIds:['blue-1'],parameters:{headingDeg:270,altitudeM:8000,speedMps:166.666667}}]}],
  ['全体，原地盘旋待命。',{status:'understood',summary:'全体原地盘旋待命',orders:[{intent:'orbit',unitIds:['blue-1','blue-2'],parameters:{}}]}],
  ['Alpha，航向90，如果遭袭则立即防御。',{status:'understood',summary:'Alpha航向90，遭袭时防御',orders:[{intent:'fly_heading',unitIds:['blue-1'],parameters:{headingDeg:90}},{intent:'defend',unitIds:['blue-1'],timing:'on_condition',condition:'遭袭',parameters:{}}]}],
  ['Delta，航向90。（当前只有Alpha和Bravo）',{status:'needs_clarification',summary:'未找到Delta，请确认呼号',orders:[]}]
].flatMap(([instruction,result])=>[{role:'user',content:JSON.stringify({instruction})},{role:'assistant',content:JSON.stringify(result)}]);
const FORMATION_CASES=[
  ['Bravo，加入Alpha右梯队，间隔两公里。',{status:'understood',summary:'Bravo加入Alpha右梯队，间隔两公里',orders:[{intent:'join_formation',unitIds:['blue-2'],parameters:{targetId:'blue-1',formation:'echelon',side:'right',rangeM:2000}}]}],
  ['Alpha为长机，Bravo为僚机。',{status:'understood',summary:'Alpha长机、Bravo僚机',orders:[{intent:'assign_role',unitIds:['blue-1'],parameters:{role:'lead'}},{intent:'assign_role',unitIds:['blue-2'],parameters:{role:'wingman'}}]}],
  ['Alpha攻击敌机一号，Bravo掩护Alpha。',{status:'understood',summary:'Alpha攻击敌机一号，Bravo掩护Alpha',orders:[{intent:'attack',unitIds:['blue-1'],parameters:{targetRef:'敌机一号'}},{intent:'cover',unitIds:['blue-2'],parameters:{targetId:'blue-1'}}]}],
  ['全体，改为战斗疏开，间隔三公里。',{status:'understood',summary:'全体战斗疏开，间隔三公里',orders:[{intent:'formation_change',unitIds:['blue-1','blue-2'],parameters:{formation:'combat_spread',rangeM:3000}}]}],
  ['全体，采用萨奇剪。',{status:'understood',summary:'全体采用萨奇剪',orders:[{intent:'cooperate',unitIds:['blue-1','blue-2'],parameters:{mode:'thach_weave'}}]}],
  ['Bravo，掩护Alpha。',{status:'understood',summary:'Bravo掩护Alpha',orders:[{intent:'cover',unitIds:['blue-2'],parameters:{targetId:'blue-1'}}]}],
  ['Bravo，护航Alpha。',{status:'understood',summary:'Bravo护航Alpha',orders:[{intent:'escort',unitIds:['blue-2'],parameters:{targetId:'blue-1'}}]}],
  ['Alpha为长机，Bravo为僚机，Bravo掩护Alpha。',{status:'understood',summary:'Alpha长机、Bravo僚机掩护',orders:[{intent:'assign_role',unitIds:['blue-1'],parameters:{role:'lead'}},{intent:'assign_role',unitIds:['blue-2'],parameters:{role:'wingman'}},{intent:'cover',unitIds:['blue-2'],parameters:{targetId:'blue-1'}}]}],
  ['Bravo为长机，Alpha为僚机，Alpha掩护Bravo。',{status:'understood',summary:'Bravo长机、Alpha僚机掩护',orders:[{intent:'assign_role',unitIds:['blue-1'],parameters:{role:'wingman'}},{intent:'assign_role',unitIds:['blue-2'],parameters:{role:'lead'}},{intent:'cover',unitIds:['blue-1'],parameters:{targetId:'blue-2'}}]}],
  ['Bravo，护航运输机。（上下文没有运输机）',{status:'understood',summary:'Bravo护航运输机',orders:[{intent:'escort',unitIds:['blue-2'],parameters:{targetRef:'运输机'}}]}]
];
function formationExamples(instruction){
  const index=/(护航|掩护).*(运输机|客机|轰炸机)/i.test(instruction)?9:/攻击|\battack\b/i.test(instruction)?2:/(长机|僚机).*(掩护|护航)/i.test(instruction)?(/Bravo\s*(为|担任|是)\s*长机/i.test(instruction)?8:7):/为长机|为僚机|为交战机|为自由机|assign.role/i.test(instruction)?1:
    /护航|\bescort\b/i.test(instruction)?6:/掩护|\bcover\b/i.test(instruction)&&!/交叉|相互|互相|萨奇|撒奇/.test(instruction)?5:
    /相互支援|互相支援|自由配合|自由双机|松散双机|萨奇|撒奇|mutual.support|loose.deuce|thach.weave/i.test(instruction)?4:
    /改为|改成|改队形|\bformation.change\b/i.test(instruction)?3:0;
  const [text,result]=FORMATION_CASES[index];
  return [{role:'user',content:JSON.stringify({instruction:text})},{role:'assistant',content:JSON.stringify(result)}];
}
const FORMATION_COMMANDER_SYSTEM=`你是游戏口令翻译器。只按玩家原话输出JSON，不选择战术，不执行任务。
unitIds用context.units真实id；未点名用selectedUnitId，全体展开所有id。targetId是参照或受保护友机，不是受令机。
只写明确参数，遗漏则省略；禁止附加未要求的mode/role/side。间隔两公里写rangeM=2000，一公里=1000，三公里=3000；不是distanceM。左/右side只写left/right，不能写left/right组合。
全体改队形：一个formation_change，unitIds包含全体，formation使用速记标准值；不要拆成join_formation，不自行分配长机。全体合作：一个cooperate，unitIds含双方，mode用指定标准值。两个不同角色必须拆两条assign_role。攻击和掩护必须两条，受令机和被保护机不能混淆。
掩护=cover，护航=escort，targetId是被保护机；长僚分工assign_role使用lead/wingman。分工加掩护/护航逐项输出，不漏任务。默认队形/高差由程序设置，不额外生成altitudeM或攻击任务。
没有“然后/之后”等词就同时执行，timing省略。条件保留timing=on_condition与condition，顺序用after_previous。参数单位米、秒、米/秒。信息不明needs_clarification且orders=[]。summary只简要说明理解，不声称已完成。编队执行器缺失也照常识别。`;

export function expandCompact(value,context,instruction){
  if(!value||!Array.isArray(value.orders)||value.orders.length>8)throw Error('本地模型任务格式无效');
  const expanded={version:'1.0',status:value.status,summary:value.summary,orders:value.orders.map((o,index)=>({
    id:`order-${index+1}`,intent:o.intent,unitIds:o.unitIds,speechAct:o.speechAct??'directive',timing:o.timing??'now',condition:o.condition??null,
    parameters:{...EMPTY_PARAMETERS,...o.parameters}
  }))};
  const result=validateMilitaryInterpretation(normalizeMilitaryInterpretation(expanded,{instruction}),context);
  if(/(如果.+(?:则|就|立即|，|,)|遭到.+时|\bif\b.+\bthen\b)/i.test(instruction)&&result.status==='understood'&&!result.orders.some(o=>o.timing==='on_condition'))throw Error('模型遗漏触发条件');
  return result;
}
export function compactTask(task){
  return {unitId:task.unitId,action:task.action,parameters:Object.fromEntries(Object.entries(task).filter(([key,value])=>
    !['unitId','action'].includes(key)&&value!==null&&(key!=='append'||value)))};
}
export function validatePilotReadback(value,plan){
  if(value?.decision!=='accept')throw Error(`飞行员请求重新下令：${value?.reason||'未能确认任务'}`);
  if(!Array.isArray(value.tasks)||value.tasks.length!==plan.tasks.length)throw Error('飞行员复诵遗漏任务，本次未装订');
  const expected=plan.tasks.map(compactTask);
  for(let i=0;i<expected.length;i++){
    const actual=value.tasks[i],target=expected[i];
    if(actual.unitId!==target.unitId||actual.action!==target.action)throw Error('飞行员复诵对象或动作不一致，本次未装订');
    const args=actual.parameters;
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==Object.keys(target.parameters).length)throw Error('飞行员复诵参数遗漏，本次未装订');
    for(const [key,wanted]of Object.entries(target.parameters)){
      const got=args[key];
      if(typeof wanted==='number'?typeof got!=='number'||Math.abs(got-wanted)>1e-6:got!==wanted)throw Error('飞行员复诵关键参数不一致，本次未装订');
    }
  }
  return value;
}

export function createLocalAiClient(runtime,cloudClient){
  return {
    transcribe:cloudClient.transcribe,
    async interpret(input,{signal}={}){
      if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId)||typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>1000)throw new ApiError(400,'请输入 1–1000 字的指令');
      const context=validateContext(input.context);
      const reading=pilotReading(input.instruction,{compact:true});
      const formation=reading.files.some(f=>f.id==='formation_compact');
      if(formation){const file=readPilotFile('formation_compact');reading.files=reading.files.filter(f=>f.id==='formation_compact');reading.text=`【参考文件：${file.file}】\n${file.text}`;}
      if(!reading.files.some(f=>f.id==='aviation_terms'))Object.assign(reading,appendAviationReading(reading,input.instruction,{compact:true}));
      const unitContext={selectedUnitId:context.selectedUnitId,mapPoint:context.mapPoint,units:context.units.map(u=>({id:u.id,callsign:u.callsign,aliases:u.aliases,
        headingDeg:u.headingDeg,altitudeM:u.position[2],speedMps:u.speedMps,alive:u.alive,formation:u.formation,flightRole:u.flightRole}))};
      try{
        const examples=formation?formationExamples(input.instruction):EXAMPLES;
        const roleHints=formation?cooperationRoleHints(input.instruction,context):[],protectionHints=formation?cooperationProtectionHints(input.instruction,context):[];
        const system=(formation?FORMATION_COMMANDER_SYSTEM:COMMANDER_SYSTEM)+'\n'+modelUnitInstruction(context.unitSystem)+'\n\n'+reading.text+(roleHints.length||protectionHints.length?'\n原话中的呼号/分工已核对：'+JSON.stringify({roles:roleHints,protection:protectionHints})+'。逐项保留，不能按单位顺序默认长僚或照抄示例的对象。':'');
        const messages=[{role:'system',content:system},...examples,{role:'user',content:JSON.stringify({context:unitContext,instruction:normalizeRadioInstruction(input.instruction)})}],schema=compactSchema(context);
        let {value,timing}=await runtime.complete('commander',messages,schema,{signal,maxTokens:1200});
        let interpretation=groundCooperation(expandCompact(value,context,input.instruction),context,input.instruction);
        if(value.status==='understood'&&interpretation.status==='needs_clarification'&&(roleHints.length||protectionHints.length)){
          const repaired=await runtime.complete('commander',[...messages,{role:'assistant',content:JSON.stringify(value)},
            {role:'user',content:`上次对象/分工未能核对：${interpretation.summary}。以原话及已核对的${JSON.stringify({roles:roleHints,protection:protectionHints})}为准，只修正unitIds、role、targetId或多补的参数。保留所有任务，不要照抄示例对象。重新输出完整JSON。`}],schema,{signal,maxTokens:1200});
          interpretation=groundCooperation(expandCompact(repaired.value,context,input.instruction),context,input.instruction);
          timing={...repaired.timing,inferenceMs:(timing?.inferenceMs??0)+(repaired.timing?.inferenceMs??0),semanticRepair:true};
        }
        const {plan,execution}=compileMilitaryInterpretation(interpretation,context);
        return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,interpretation,execution,plan,
          knowledgeUsed:reading.files,ai:{provider:'local',model:'Qwen3.5-2B-Q4_K_M',role:'commander',sharedModel:true,timing}};
      }catch(error){if(error.name==='AbortError')throw error;throw new ApiError(502,error.message);}
    },
    async reviewPilot(input,{signal}={}){
      if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'飞行员请求无效');
      const context=validateContext(input.context);
      const reading=pilotReading(input.plan?.summary||'',{compact:true});
      try{validatePlan(input.plan,context.units);}catch(error){throw new ApiError(400,error.message);}
      if(input.plan.status!=='accepted')throw new ApiError(400,'当前任务不能装订');
      const schema=object({decision:{type:'string',enum:['accept','unable']},reason:{type:'string',maxLength:100},
        tasks:{type:'array',maxItems:16,items:object({unitId:{type:['string','null'],enum:[null,...context.units.map(u=>u.id)]},action:{type:'string',enum:ACTIONS},
          parameters:object({altitudeM:number,speedMps:number,headingDeg:number,eastM:number,northM:number,distanceM:number,targetId:text,formation:text,side:text,rangeM:number,role:text,append:{type:'boolean'}},[])})}});
      try{
        const {value,timing}=await runtime.complete('pilot',[{role:'system',content:'你是游戏飞行员。只核对给出的tasks，不要求未接令的飞机有任务。单位存在且存活、任务参数完整就accept，并按原顺序逐条复诵tasks。精确复制unitId、action和parameters，禁止换算已标准化单位，禁止增加或遗漏参数，parameters={}保持空对象。不能确认则unable并解释。升降速度限制与地形由自动驾驶检查，不能凭空假设有危险。只输出JSON。'+'\n'+reading.text},
          {role:'user',content:'{"tasks":[{"unitId":"blue-1","action":"orbit","parameters":{}}],"units":[{"id":"blue-1","alive":true}]}'},
          {role:'assistant',content:'{"decision":"accept","reason":"任务已确认","tasks":[{"unitId":"blue-1","action":"orbit","parameters":{}}]}'},
          {role:'user',content:JSON.stringify({referenceFiles:reading.text,tasks:input.plan.tasks.map(compactTask),units:context.units.filter(u=>input.plan.tasks.some(t=>t.unitId===u.id)).map(u=>({id:u.id,alive:u.alive}))})}],schema,{maxTokens:1000,signal});
        validatePilotReadback(value,input.plan);
        return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,review:value,
          knowledgeUsed:reading.files,ai:{provider:'local',model:'Qwen3.5-2B-Q4_K_M',role:'pilot',sharedModel:true,timing}};
      }catch(error){if(error.name==='AbortError')throw error;throw new ApiError(502,error.message);}
    }
  };
}
