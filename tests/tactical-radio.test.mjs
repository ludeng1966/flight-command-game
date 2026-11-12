import test from 'node:test';
import assert from 'node:assert/strict';
import {tacticalReceiptMessages} from '../game/tactical-radio.js';
const world={time:15,units:[{id:'blue-1',callsign:'ALPHA 01'},{id:'blue-2',callsign:'BRAVO 02'}]};

test('玩家选定的攻击和规避方式进入双语复诵',()=>{
  const [attack]=tacticalReceiptMessages(world,{status:'executing',committed:true,action:'attack',attackMethod:'infrared',unitIds:['blue-1']});
  assert.match(attack.texts.zh,/红外弹/);assert.match(attack.texts.en,/INFRARED/);
  const [defense]=tacticalReceiptMessages(world,{status:'executing',committed:true,action:'defend',defenseMethod:'notch',defenseSide:'left',unitIds:['blue-1']});
  assert.match(defense.texts.zh,/左转/);assert.match(defense.texts.en,/TURN LEFT/);
});

test('快捷攻击回执只报告主射手和一枚授权，不把接令写成发射或命中',()=>{
  const messages=tacticalReceiptMessages(world,{status:'committed',action:'attack',unitIds:['blue-1'],commandId:'quick-1'});
  assert.equal(messages.length,1);assert.equal(messages[0].unitId,'blue-1');assert.equal(messages[0].commandId,'quick-1');
  assert.match(messages[0].texts.zh,/最多一枚/);assert.match(messages[0].texts.en,/ONE MISSILE MAXIMUM/);
  assert(!/FOX|SPLASH|命中|已发射/.test(messages[0].text));assert.equal(messages[0].simTime,15);
});

test('待规划或排队不伪装为正在执行，拒绝以双语航空无法执行报告',()=>{
  for(const status of ['planning','queued','cancelled','superseded'])assert.deepEqual(tacticalReceiptMessages(world,{status,action:'move',unitIds:['blue-1']}),[]);
  const [unable]=tacticalReceiptMessages(world,{status:'unable',action:'defend',unitIds:['blue-2'],reason:'当前没有有效告警方位'});
  assert.match(unable.texts.zh,/无法执行.*有效告警方位/);assert.match(unable.texts.en,/UNABLE TO COMPLY/);assert(!/[\u3400-\u9fff]/.test(unable.texts.en));
});

test('停火回执说明在空导弹仍存在，返场回执保留管制程序',()=>{
  const [hold]=tacticalReceiptMessages(world,{status:'committed',action:'hold',unitIds:['blue-1']});
  assert.match(hold.texts.en,/ALREADY IN FLIGHT REMAIN ACTIVE/);
  const [recovery]=tacticalReceiptMessages(world,{status:'committed',action:'return_base',unitIds:['blue-1']});
  assert.match(recovery.texts.en,/ATC CLEARANCES/);
});

test('实际停火完成回执发无线电，排队与规划阶段不播报执行',()=>{
  const [hold]=tacticalReceiptMessages(world,{status:'completed',committed:true,action:'hold',unitIds:['blue-1']});
  assert.match(hold.texts.zh,/停止继续发射/);
  for(const status of ['accepted','planning','queued'])assert.deepEqual(tacticalReceiptMessages(world,{status,committed:false,action:'attack',unitIds:['blue-1']}),[]);
});

test('抵达返场等待空域报告申请许可，普通任务完成不重复复诵接令',()=>{
  const [holding]=tacticalReceiptMessages(world,{status:'waiting',committed:true,action:'return_base',unitIds:['blue-1']});
  assert.match(holding.texts.en,/HOLDING FOR ARRIVAL/);
  assert.deepEqual(tacticalReceiptMessages(world,{status:'completed',committed:true,action:'move',unitIds:['blue-1']}),[]);
});
