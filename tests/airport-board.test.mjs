import test from 'node:test';
import assert from 'node:assert/strict';
import {airportBoardModel} from '../game/airport-board-model.js';

const world={
  units:[
    {id:'blue-1',callsign:'ALPHA 01',surface:{node:'G1'}},
    {id:'blue-2',callsign:'BRAVO 02',surface:{node:'G2'}}
  ],
  airportOps:{
    airport:{
      id:'BAY',name:'海湾国际机场',clock:100,closed:[],
      runways:[{designator:'09L',stripId:'RW0'},{designator:'27R',stripId:'RW0'}],
      stands:['G1','G2','G3'],weather:{qnhHpa:1013,wind:{heading:90,speedMps:3}}
    },
    leases:{RW0:'blue-1'},
    traffic:{state:{
      lastUse:{RW0:{at:40}},
      requests:[
        {id:'req-1',unitId:'blue-1',kind:'departure',status:'waiting',runway:'09L',reason:'等待跑道',etaSec:30,priority:1},
        {id:'req-2',unitId:'blue-2',kind:'arrival',status:'completed',runway:'09L'}
      ],
      clearances:[
        {id:'clr-1',unitId:'blue-1',type:'takeoff',status:'delivered',parameters:{runway:'09L'}},
        {id:'clr-2',unitId:'blue-2',type:'land',status:'cancelled',parameters:{runway:'09L'}}
      ]
    }}
  }
};
test('机场调度板：跑道占用、活动队列、有效许可与机位',()=>{
  const board=airportBoardModel(world);
  assert.equal(board.airportId,'BAY');
  assert.equal(board.runways[0].owner,'ALPHA 01');
  assert.equal(board.runways[0].lastUseSec,60);
  assert.equal(board.queue.length,1);
  assert.equal(board.queue[0].callsign,'ALPHA 01');
  assert.equal(board.queue[0].kindLabel,'离场');
  assert.equal(board.clearances.length,1);
  assert.equal(board.clearances[0].typeLabel,'起飞');
  assert.deepEqual(board.stands.map(s=>s.callsign),['ALPHA 01','BRAVO 02',null]);
  assert.equal(board.freeStands,1);
  assert.equal(board.weather.qnhHpa,1013);
});
test('机场调度板：无机场返回 null',()=>{
  assert.equal(airportBoardModel({units:[],airportOps:null}),null);
  assert.equal(airportBoardModel(null),null);
});
