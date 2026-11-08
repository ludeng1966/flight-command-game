import test from 'node:test';
import assert from 'node:assert/strict';
import {constrainWindow,readWindowLayout,initFloatingWindows,WINDOW_LAYOUT_KEY,resizeWindow,windowResizeEdge} from '../game/floating-windows.js';

test('保存位置在当前窗口完整可见，缩小视口后仍能抓到标题栏',()=>{
  assert.deepEqual(constrainWindow({x:200,y:150,width:310,height:400},{width:1280,height:720}),{x:200,y:150,width:310,height:400});
  const small=constrainWindow({x:1100,y:650,width:390,height:500},{width:468,height:604});
  assert(small.x>=8&&small.y>=8);assert(small.x+small.width<=460);assert(small.y+small.height<=532);
  const narrow=constrainWindow({x:-300,y:-50,width:390,height:600},{width:320,height:400});assert.equal(narrow.x,8);assert.equal(narrow.y,8);assert.equal(narrow.width,304);assert.equal(narrow.height,320);
});
test('位置存储损坏或不可用时继续使用默认布局',()=>{
  assert.deepEqual(readWindowLayout({getItem(){throw Error('unavailable');}}),{});
  assert.deepEqual(readWindowLayout({getItem:()=>'{bad'}),{});
  assert.deepEqual(readWindowLayout({getItem:()=>JSON.stringify({command:{x:40,y:60,width:310,height:400},bad:{x:'40',y:60,width:310,height:400}})}),{command:{x:40,y:60,width:310,height:400}});
});
function fixture(storage){
  class Element extends EventTarget{
    constructor(){super();this.dataset={};this.properties={};this.classList={add(){},remove(){}};this.style={setProperty:(k,v)=>this.properties[k]=v,removeProperty:k=>delete this.properties[k]};}
    setAttribute(k,v){this[k]=v;}getAttribute(k){return this[k]??null;}
    append(){}
  }
  const root=new Element(),header=new Element(),tools={append(){}},stage=new Element(),doc=new EventTarget(),win=new EventTarget();
  root.getBoundingClientRect=()=>({left:parseFloat(root.properties['--window-x']??'84'),top:parseFloat(root.properties['--window-y']??'140'),width:parseFloat(root.properties['--window-width']??'310'),height:parseFloat(root.properties['--window-height']??'420')});
  stage.getBoundingClientRect=()=>({left:0,top:0});stage.clientWidth=1280;stage.clientHeight=720;
  root.querySelectorAll=()=>[header];header.closest=selector=>selector.startsWith('.panel-heading')?header:null;header.matches=()=>true;
  root.setPointerCapture=id=>root.pointerId=id;root.hasPointerCapture=id=>root.pointerId===id;root.releasePointerCapture=()=>root.pointerId=null;
  stage.querySelector=selector=>selector==='.command-panel'?root:selector==='#settings-tools'?tools:null;
  doc.createElement=()=>new Element();
  const action=(type,x,y,target=header)=>{const e=new Event(type,{cancelable:true});Object.defineProperty(e,'target',{value:target});Object.assign(e,{pointerId:1,button:0,clientX:x,clientY:y});root.dispatchEvent(e);};
  const manager=initFloatingWindows({stage,doc,win,storage});return {root,header,stage,doc,win,action,manager};
}
test('八方向边缘缩放保留对侧边界，尺寸受屏幕与最小可用范围限制',()=>{
  const r={x:300,y:120,width:310,height:420},bounds={width:1280,height:720};assert.equal(windowResizeEdge(r,302,122),'nw');
  const se=resizeWindow(r,'se',130,-100,bounds);assert.deepEqual(se,{x:300,y:120,width:440,height:320});
  const nw=resizeWindow(r,'nw',-100,-50,bounds);assert.equal(nw.x+nw.width,r.x+r.width);assert.equal(nw.y+nw.height,r.y+r.height);
  const small=resizeWindow(r,'se',-1000,-1000,bounds);assert.equal(small.width,240);assert.equal(small.height,150);
});
test('拖动松开后记住位置，刷新恢复；取消拖动和点击控件不修改位置',t=>{
  const original=globalThis.MutationObserver;globalThis.MutationObserver=class{observe(){}disconnect(){}};t.after(()=>globalThis.MutationObserver=original);
  let saved=null;const storage={getItem:()=>saved,setItem:(key,value)=>{assert.equal(key,WINDOW_LAYOUT_KEY);saved=value;}};
  const first=fixture(storage);first.action('pointerdown',100,150);first.action('pointermove',400,210);assert.equal(saved,null,'拖动过程不写存储');first.action('pointerup',400,210);
  const layout=JSON.parse(saved).command;assert.equal(layout.x,384);assert.equal(layout.y,200);
  first.win.dispatchEvent(new Event('pagehide'));const restored=fixture(storage);assert.equal(restored.root.dataset.windowPosition,'custom');assert.equal(restored.root.getBoundingClientRect().left,384);
  restored.action('pointerdown',400,210);restored.action('pointermove',500,230);restored.action('pointercancel',500,230);assert.equal(restored.root.getBoundingClientRect().left,384);assert.equal(JSON.parse(saved).command.x,384);
  const button={closest:selector=>selector.startsWith('.panel-heading')?restored.header:button};restored.action('pointerdown',400,210,button);restored.action('pointermove',600,210,button);restored.action('pointerup',600,210,button);assert.equal(JSON.parse(saved).command.x,384);
  restored.manager.resetAll();assert.equal(restored.root.dataset.windowPosition,undefined);assert.deepEqual(JSON.parse(saved),{});restored.win.dispatchEvent(new Event('pagehide'));
});
test('从边角缩放后刷新恢复新宽高与原位置',t=>{
  const original=globalThis.MutationObserver;globalThis.MutationObserver=class{observe(){}disconnect(){}};t.after(()=>globalThis.MutationObserver=original);
  let saved=null;const storage={getItem:()=>saved,setItem:(_key,value)=>saved=value},first=fixture(storage);
  first.action('pointerdown',392,558);first.action('pointermove',342,458);first.action('pointerup',342,458);
  const size=JSON.parse(saved).command;assert.equal(size.x,84);assert.equal(size.y,140);assert.equal(size.width,260);assert.equal(size.height,320);first.win.dispatchEvent(new Event('pagehide'));
  const restored=fixture(storage);assert.equal(restored.root.getBoundingClientRect().width,260);assert.equal(restored.root.getBoundingClientRect().height,320);restored.win.dispatchEvent(new Event('pagehide'));
});
