import test from 'node:test';
import assert from 'node:assert/strict';
import {RwrRadio} from '../game/rwr-radio.js';
import {RadioQueue} from '../game/radio-queue.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const unit={id:'blue-1',team:'blue',callsign:'Alpha',alive:true,velocity:[0,200,0],rwrDefense:{controlSequence:4},rwr:{contacts:[{id:'RWR-1',level:'launch',observedAt:20,bearingDeg:90}],events:[]}};return {time:20,playerTeam:'blue',units:[unit]};}
const event=(sequence,type,level,controlSequence=4)=>({sequence,time:20,type,level,bearingDeg:90,controlSequence,text:type+'本次事件'});
test('忙碌时policy/player_control不能遮住有效detected/escalated，较新的事件保持待播',async()=>{
  for(const urgentType of ['detected','escalated'])for(const routineType of ['policy','player_control']){
    const world=fixture(),unit=world.units[0],sent=[];let busy=true;
    unit.rwr.events=[event(1,urgentType,'launch'),event(2,routineType)];
    const bridge=new RwrRadio({getWorld:()=>world,isBusy:()=>busy,radio:{async transmit(message,options){assert(options.isCurrent());sent.push(message);}}});
    bridge.pump();await tick();assert.equal(sent.length,1);assert.equal(sent[0].priority,100);assert.match(sent[0].text,new RegExp(urgentType));assert.equal(bridge.cursor.get(unit.id),1);
    bridge.pump();await tick();assert.equal(sent.length,1,'忙时不重复已播告警，也不播普通策略');
    busy=false;bridge.pump();await tick();assert.equal(sent.length,2);assert.match(sent[1].text,new RegExp(routineType));assert.equal(bridge.cursor.get(unit.id),2);
  }
});
test('忙碌选择跳过旧控制序列事件，并保留后续有效紧急告警',async()=>{
  const world=fixture(),unit=world.units[0],sent=[];
  unit.rwr.events=[event(1,'assessment','launch',3),event(2,'detected','track'),event(3,'policy'),event(4,'escalated','launch')];
  const bridge=new RwrRadio({getWorld:()=>world,isBusy:()=>true,radio:{async transmit(message){sent.push(message);}}});
  bridge.pump();await tick();assert.equal(sent.length,1);assert.match(sent[0].text,/escalated/);assert.equal(bridge.cursor.get(unit.id),4);
});
test('radio.cancel导致AbortError后仍有新鲜威胁，下一pump恢复游标并重试',async()=>{
  const world=fixture(),unit=world.units[0],sent=[],queue=new RadioQueue();let complete;
  unit.rwr.events=[event(1,'detected','launch'),event(2,'policy')];
  const radio={transmit(message){sent.push(message);return queue.enqueue(signal=>new Promise((resolve,reject)=>{complete=resolve;signal.addEventListener('abort',()=>reject(new DOMException('通联已取消','AbortError')),{once:true});}),{priority:message.priority});},cancel(){queue.cancel();}};
  const bridge=new RwrRadio({getWorld:()=>world,isBusy:()=>true,radio});
  bridge.pump();await tick();assert.equal(sent.length,1);radio.cancel();await tick();assert.equal(bridge.active,false);assert.equal(bridge.cursor.get(unit.id),0);
  bridge.pump();await tick();assert.equal(sent.length,2);assert.equal(sent[1].priority,100);complete();await tick();assert.equal(bridge.cursor.get(unit.id),1);
  bridge.pump();await tick();assert.equal(sent.length,2);queue.cancel();
});
