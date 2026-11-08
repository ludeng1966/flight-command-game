import test from 'node:test';
import assert from 'node:assert/strict';
import {initRouteEditFocus} from '../game/route-edit-focus.js';

function fixture(){
  const doc={activeElement:null},win=new EventTarget();
  function node(id,kept=false){return {id,hidden:false,inert:false,isConnected:true,scrollTop:34,scrollLeft:0,layout:{x:120,y:160,width:300,height:240},
    matches:()=>kept,getClientRects(){return this.hidden?[]:[this.layout];},closest:()=>null,focus(){doc.activeElement=this;}};}
  const canvas=node('scene',true),labels=node('labels',true),cursor=node('route-cursor-preview',true),command=node('command'),brief=node('brief'),coach=node('coach'),settings=node('settings'),footer=node('footer'),summary=node('route-summary'),input=node('command-text');
  coach.hidden=true;settings.hidden=true;footer.inert=true;doc.activeElement=input;
  const classes=new Set(['voice-open','report-open','panels-hidden']),stage=Object.assign(new EventTarget(),{children:[canvas,labels,cursor,command,brief,coach,settings,footer],classList:{contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name),toggle(name,on){on?classes.add(name):classes.delete(name);}},querySelector:selector=>selector==='#scene'?canvas:selector==='#route-menu>summary'?summary:null,querySelectorAll:()=>[command,brief,coach,settings]});
  const control=initRouteEditFocus({stage,doc,win});return {control,stage,doc,canvas,labels,cursor,command,brief,coach,settings,footer,input,summary,classes};
}
test('编辑期间隐藏UI但保留窗口布局，飞机、航线和光标保持可交互',()=>{
  const f=fixture(),layout=structuredClone(f.command.layout);f.control.setEnabled(true);
  assert(f.classes.has('route-edit-mode'));assert(f.command.inert&&f.brief.inert&&f.footer.inert);assert(!f.canvas.inert&&!f.labels.inert&&!f.cursor.inert);assert.equal(f.doc.activeElement,f.canvas);
  assert.equal(f.command.hidden,false,'不通过关闭窗口触发重新排版');assert.deepEqual(f.command.layout,layout);
});
test('退出恢复进入前打开的窗口、滚动位置和焦点，不采纳编辑期间的面板切换',()=>{
  const f=fixture(),layout=structuredClone(f.command.layout);f.control.setEnabled(true);f.command.hidden=true;f.command.scrollTop=200;f.brief.hidden=true;f.coach.hidden=false;f.classes.delete('voice-open');f.control.setEnabled(true);f.control.setEnabled(false);
  assert(!f.classes.has('route-edit-mode'));assert(f.classes.has('voice-open'));assert.equal(f.command.hidden,false);assert.equal(f.brief.hidden,false);assert.equal(f.coach.hidden,true);assert.equal(f.command.scrollTop,34);assert.deepEqual(f.command.layout,layout);assert.equal(f.command.inert,false);assert.equal(f.footer.inert,true);assert.equal(f.doc.activeElement,f.input);
});
test('原焦点不可见时返回航路入口，重复退出不改变窗口状态',()=>{
  const f=fixture();f.control.setEnabled(true);f.input.hidden=true;f.control.setEnabled(false);assert.equal(f.doc.activeElement,f.summary);f.command.hidden=true;f.control.setEnabled(false);assert.equal(f.command.hidden,true);
});
