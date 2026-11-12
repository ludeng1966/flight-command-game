import test from 'node:test';
import assert from 'node:assert/strict';
import {navPanelModel,navPanelText,formatEta,formatNavDistance,navBearingDeg} from '../game/navigation-panel-model.js';

const unit={id:'blue-1',callsign:'ALPHA 01',position:[0,0,5000],speed:250,completedWaypoints:1,
  waypoints:[[10000,0,6000],[10000,10000,7000]]};
const world={bullseye:{name:'BAY-REF',position:[-18000,0,100]},airspaceContext:()=>({standard:'faa',zones:[{id:'BAY-B'}]})};

test('导航面板：计算下一航点、航段、累计与 ETA',()=>{
  const model=navPanelModel(unit,world);
  assert.equal(model.callsign,'ALPHA 01');
  assert.equal(model.next.number,2);
  assert.equal(model.next.legM,10000);
  assert.equal(model.route[1].legM,10000);
  assert.equal(model.routeTotalM,20000);
  assert.equal(Math.round(model.next.etaSec),40);
  assert.match(navPanelText(model),/下一航点 #2/);
  assert.equal(formatNavDistance(1500),'1.5 km');
  assert.equal(formatEta(125),'2m05s');
});
test('导航面板：无航路/靶眼/空域/罗盘方位',()=>{
  const empty=navPanelModel({...unit,waypoints:[]},world);
  assert.equal(navPanelText(empty),'无航路');
  assert.equal(empty.bullseye.name,'BAY-REF');
  assert.equal(Math.round(empty.bullseye.bearingDeg),90);
  assert.equal(empty.bullseye.rangeM,18000);
  assert.equal(empty.airspace.standard,'faa');
  assert.equal(Math.round(navBearingDeg([0,0],[0,10])),0);
});
