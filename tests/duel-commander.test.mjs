import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {commandContext} from '../sim/orders.js';import {createDuelCommander} from '../server/duel-commander.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/duel.json',import.meta.url)));
function setup(){const w=new World(scenario,profiles);w.playerTeam='red';return w;}
test('红方指挥仅接收红方飞机和己方观测，不获得蓝方隐藏位置',async()=>{
 const w=setup(),context=commandContext(w,'red-1');let payload;
 const api=createDuelCommander({async completePilot(messages){payload=JSON.parse(messages[1].content);return {value:{reason:'无接触，分头搜索',orders:[{unitId:'red-1',targetId:null,posture:'search'},{unitId:'red-2',targetId:null,posture:'search'}]}};}});
 const reply=await api({requestId:'test',context});assert.equal(reply.modelInvoked,true);assert.deepEqual(payload.own.map(u=>u.id),['red-1','red-2']);assert.deepEqual(payload.contacts,[]);assert.doesNotMatch(JSON.stringify(payload),/blue-1|blue-2|-7000/);
});
test('红方指挥不能凭隐藏目标编号开火，不能向蓝方飞机下令',async()=>{
 const context=commandContext(setup(),'red-1');for(const order of [{unitId:'red-1',targetId:'blue-1',posture:'attack'},{unitId:'blue-1',targetId:null,posture:'search'}]){
  const api=createDuelCommander({async completePilot(){return {value:{reason:'测试',orders:[order]}};}});await assert.rejects(api({requestId:'test',context}),/不符合当前观测/);
 }
});

test('超长说明只规范化截断，不拒绝合法分工或修改模型原始输出',async()=>{
 const context=commandContext(setup(),'red-1'),order={unitId:'red-1',targetId:null,posture:'search'};
 const original={reason:'  保持搜索\n\t'+('依据己方观测分工。'.repeat(30)),orders:[order]},before=structuredClone(original);let system;
 const api=createDuelCommander({async completePilot(messages){system=messages[0].content;return {value:original};}});
 const reply=await api({requestId:'long-reason',context});
 assert.equal(reply.decision.reason.length,160);assert.ok(reply.decision.reason.startsWith('保持搜索 依据'));
 assert.doesNotMatch(reply.decision.reason,/[\n\t]/);assert.deepEqual(reply.decision.orders,[order]);assert.deepEqual(original,before);
 assert.match(system,/reason.*简短.*160字/);
});

test('说明截断不留下半个Unicode字符',async()=>{
 const context=commandContext(setup(),'red-1');
 const api=createDuelCommander({async completePilot(){return {value:{reason:'搜'.repeat(159)+'🚀继续',orders:[{unitId:'red-1',targetId:null,posture:'search'}]}};}});
 const reply=await api({requestId:'unicode',context});assert.equal(reply.decision.reason,'搜'.repeat(159));
});

test('观测内的明确攻击令同样保留，只裁剪说明',async()=>{
 const world=setup(),own=world.units.find(unit=>unit.id==='red-1');
 own.radar.contacts=[{id:'blue-1',callsign:'ALPHA 01',classification:'unknown',source:'radar',observedAt:0,position:[0,15000,6500],velocity:[0,250,0]}];
 const order={unitId:'red-1',targetId:'blue-1',posture:'attack'},context=commandContext(world,own.id);
 const api=createDuelCommander({async completePilot(){return {value:{reason:'依据新鲜观测集中兵力。'.repeat(30),orders:[order]}};}});
 const reply=await api({requestId:'observed-attack',context});assert.deepEqual(reply.decision.orders,[order]);assert.equal(reply.decision.reason.length,160);
});

test('空命令、过多命令和非文本说明仍拒绝，不把格式修复变成战术容错',async()=>{
 const context=commandContext(setup(),'red-1'),order={unitId:'red-1',targetId:null,posture:'search'};
 for(const value of [{reason:'无接触',orders:[]},{reason:'搜索',orders:[order,order,order]},{reason:null,orders:[order]},
   {reason:'搜索',orders:[order],hiddenCommand:'attack'}]){
  const api=createDuelCommander({async completePilot(){return {value};}});
  await assert.rejects(api({requestId:'invalid-shape',context}),error=>error.status===502&&/指挥输出格式错误/.test(error.message));
 }
});

test('超长说明不放松目标可见性、友机控制权、重复分配和命令字段校验',async()=>{
 const context=commandContext(setup(),'red-1'),search={unitId:'red-1',targetId:null,posture:'search'};
 for(const orders of [[{unitId:'red-1',targetId:'blue-1',posture:'attack'}],[{unitId:'blue-1',targetId:null,posture:'search'}],
   [search,search],[null],[{...search,posture:'attack'}],[{...search,posture:'teleport'}],[{...search,secret:'unsupported'}]]){
  const api=createDuelCommander({async completePilot(){return {value:{reason:'解释'.repeat(100),orders}};}});
  await assert.rejects(api({requestId:'strict-orders',context}),error=>error.status===502&&/不符合当前观测/.test(error.message));
 }
});
