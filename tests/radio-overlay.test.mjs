import test from 'node:test';
import assert from 'node:assert/strict';
import {initRadioOverlay} from '../game/radio-overlay.js';

test('新通联整组显示后隐藏，Alt滚动历史，松开后消失且记录保留',async t=>{
  const previous={MutationObserver:globalThis.MutationObserver,ResizeObserver:globalThis.ResizeObserver};let mutation;
  globalThis.MutationObserver=class{constructor(callback){mutation=callback;}observe(){}disconnect(){}};
  globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;}observe(){this.callback();}disconnect(){}};
  t.after(()=>Object.assign(globalThis,previous));
  function element(){const classes=new Set();return {dataset:{},children:[],style:{setProperty(){}},classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}},setAttribute(name,value){this[name]=value;},getBoundingClientRect(){return {height:170};},append(){},scrollTop:100,scrollHeight:900};}
  const stage=element(),panel=element(),list=element(),toggle=element(),close=element(),header=element();let speaking=false;
  list.querySelector=()=>speaking?{}:null;panel.querySelector=()=>header;
  const elements={'#stage':stage,'#radio-console':panel,'#radio-transcript':list,'#radio-toggle':toggle,'#radio-collapse':close};
  const doc=Object.assign(new EventTarget(),{querySelector:id=>elements[id],createElement:element}),win=new EventTarget();
  initRadioOverlay({doc,win,lingerMs:35});assert.equal(panel.dataset.visible,'false');
  list.children.push({text:'第一条'},{text:'第二条'});mutation([{type:'childList',addedNodes:list.children}]);assert.equal(panel.dataset.visible,'true');assert.equal(list.scrollTop,900);
  await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'false');assert.equal(list.children.length,2);
  const key=(type)=>{const e=new Event(type,{cancelable:true});e.key='Alt';doc.dispatchEvent(e);return e;};
  assert(key('keydown').defaultPrevented);assert.equal(panel.dataset.visible,'true');assert.equal(panel.dataset.browsing,'true');
  const wheel=new Event('wheel',{cancelable:true});Object.assign(wheel,{altKey:true,deltaY:-120});win.dispatchEvent(wheel);assert(wheel.defaultPrevented);assert.equal(list.scrollTop,780);
  list.children.push({text:'第三条'});mutation([{type:'childList',addedNodes:[list.children[2]]}]);assert.equal(list.scrollTop,780,'查看历史时新消息不抢滚动位置');
  await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'true','按住Alt时不淡出');
  key('keyup');await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'false');assert.equal(list.children.length,3);
  const normalWheel=new Event('wheel',{cancelable:true});Object.assign(normalWheel,{altKey:false,deltaY:120});win.dispatchEvent(normalWheel);assert.equal(normalWheel.defaultPrevented,false);assert.equal(list.scrollTop,780);
  speaking=true;mutation([{type:'attributes'}]);await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'true','语音播放中保持字幕');
  speaking=false;mutation([{type:'attributes'}]);await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'false');
  toggle.onclick();await new Promise(resolve=>setTimeout(resolve,55));assert.equal(panel.dataset.visible,'true','点击通联可固定查看历史');close.onclick();assert.equal(panel.dataset.visible,'false');win.dispatchEvent(new Event('pagehide'));
});
