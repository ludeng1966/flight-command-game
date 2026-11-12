import test from 'node:test';
import assert from 'node:assert/strict';
import {tacticalKeyCommand,tacticalInputField} from '../game/tactical-controls.js';

const key=(code,extra={})=>({code,key:code.startsWith('Digit')?code.slice(-1):code,...extra});
test('战术动作与编组键解码明确，不占用语音、摄影和时钟快捷键',()=>{
  for(const [code,action]of Object.entries({KeyQ:'attack',KeyX:'defend',KeyE:'disengage',KeyH:'hold',KeyB:'return_base'}))assert.deepEqual(tacticalKeyCommand(key(code)),{kind:'action',action});
  assert.deepEqual(tacticalKeyCommand(key('Digit3')),{kind:'select',index:3});
  assert.deepEqual(tacticalKeyCommand(key('Digit1',{ctrlKey:true})),{kind:'bind',index:1});
  for(const code of ['KeyF','KeyV','Space','PageUp','PageDown','KeyW','KeyA','KeyS','KeyD','KeyZ'])assert.equal(tacticalKeyCommand(key(code)),null);
});
test('按住说话、输入法组合、输入框、重复键和系统组合键都不能误发命令',()=>{
  const childOfInput={closest:selector=>selector.includes('contenteditable')?{}:null};
  assert(tacticalInputField(childOfInput));
  for(const code of ['KeyQ','KeyX','KeyH','Digit1']){
    assert.equal(tacticalKeyCommand(key(code),{voiceHeld:true}),null);
    for(const extra of [{repeat:true},{isComposing:true},{altKey:true},{metaKey:true},{target:childOfInput}])assert.equal(tacticalKeyCommand(key(code,extra)),null);
  }
  assert.equal(tacticalKeyCommand(key('KeyQ',{ctrlKey:true})),null);
});
test('精细航线编辑保持地图与撤销键控制，不被快捷命令接管',()=>{
  for(const code of ['KeyQ','KeyE','KeyH','KeyX','KeyB','Escape','Digit1'])assert.equal(tacticalKeyCommand(key(code),{routeEditing:true}),null);
  assert.deepEqual(tacticalKeyCommand(key('Escape')),{kind:'cancel'});
});
