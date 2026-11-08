import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTINGS_KEY,readSettings,writeSettings,initSettingsMemory} from '../game/settings-store.js';
import {createRadioConsole} from '../game/radio-console.js';
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};};
function form(){const doc=new EventTarget(),win=new EventTarget(),elements={
  'command-style':{id:'command-style',value:'pla',type:'select-one'},'command-auto':{id:'command-auto',checked:true,type:'checkbox'},
  'append-waypoint':{id:'append-waypoint',checked:true,type:'checkbox'}};
  doc.getElementById=id=>elements[id];const change=id=>{const e=new Event('change');Object.defineProperty(e,'target',{value:elements[id]});doc.dispatchEvent(e);};return {doc,win,elements,change};}
test('旧进度选项迁移，独立设置优先，并在改变时立即保存',()=>{
  const s=storage(),a=form();writeSettings({'command-style':'nato','radio-audio-enabled':false},s);
  const memory=initSettingsMemory({...a,storage:s,legacyForm:{'command-style':'pla','command-auto':false,'command-text':'不要保存口令草稿'}});
  assert.equal(a.elements['command-style'].value,'nato');assert.equal(a.elements['command-auto'].checked,false);
  a.elements['append-waypoint'].checked=false;a.change('append-waypoint');
  const b=form();initSettingsMemory({...b,storage:s});assert.equal(b.elements['append-waypoint'].checked,false);assert.equal(b.elements['command-auto'].checked,false);
  assert.equal(readSettings(s)['radio-audio-enabled'],false);assert.equal(readSettings(s)['command-text'],undefined);assert.equal(memory.handles('command-text'),false);memory.destroy();
});
test('语音静音跨通联实例保留，服务就绪更新不会把声音重新打开',async()=>{
  const s=storage(),button=()=>({setAttribute(){}}),firstButton=button(),make=b=>createRadioConsole({storage:s,getWorld:()=>({units:[],time:0}),document:{querySelector:id=>id==='#radio-audio'?b:null},speech:{cancel(){},async speak(){throw Error('静音状态不得请求语音合成');}}});
  const first=make(firstButton);assert.equal(first.enabled,true);firstButton.onclick();assert.equal(first.enabled,false);
  const second=make(button());second.configure({provider:'inworld',ready:true});assert.equal(second.enabled,false);
  assert.equal((await second.transmit({speaker:'commander',text:'测试设置',language:'zh-CN'})).delivery,'muted');
});
test('设置存储不可用或损坏时仍可使用控件，非法值不进入恢复状态',()=>{
  const a=form(),denied={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};assert.doesNotThrow(()=>initSettingsMemory({...a,storage:denied}));a.elements['command-auto'].checked=false;assert.doesNotThrow(()=>a.change('command-auto'));
  const s=storage();s.setItem(SETTINGS_KEY,'broken');assert.deepEqual(readSettings(s),{});
  writeSettings({'command-style':'unknown','command-auto':'false','radio-audio-enabled':false,'unrelated-secret':'ignored'},s);assert.deepEqual(readSettings(s),{'radio-audio-enabled':false});
});
