import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmergencyTutorialState,enterEmergencyTutorialStep,advanceEmergencyTutorial,tickEmergencyTutorial,
  currentEmergencyTutorialStep,currentEmergencyChapter,EMERGENCY_TUTORIAL_STEPS,EMERGENCY_TUTORIAL_CHAPTERS
} from '../sim/emergency-tutorial.js';

function makeWorld(){return {time:0,airportOps:{airport:{elevation:100}}};}
function makeUnit(){return {
  position:[0,0,1100],velocity:[0,250,0],surface:{grounded:false,phase:'climb'},
  radar:{mode:'off',phase:'search',targetId:null,contacts:[],config:{azimuthHalfDeg:80,elevationHalfDeg:50,sweepSec:1.5},
    scanHalfDeg:80,scanCenterDeg:0,scanElevationCenterDeg:0,scanElevationHalfDeg:50,twsTrackedIds:[],iffMode:'auto',silent:false,lastLostSequence:0},
  rwr:{contacts:[]}
};}
const contact=(id,extra={})=>({id,observedAt:0,classification:'unknown',...extra});
function passStep(s,u,w){u.radar.contacts=u.radar.contacts.map(c=>({...c,observedAt:w.time}));tickEmergencyTutorial(s,u,w);assert.equal(s.phase,'success',`step ${s.index} ${currentEmergencyTutorialStep(s)?.id}`);assert.equal(advanceEmergencyTutorial(s,u,w),true);}

test('紧急起飞教程完整版：16 步、4 章',()=>{
  assert.equal(EMERGENCY_TUTORIAL_STEPS.length,16);
  assert.deepEqual([...EMERGENCY_TUTORIAL_CHAPTERS.map(c=>c.id)],['launch','search','identify','return']);
  assert.deepEqual([...EMERGENCY_TUTORIAL_STEPS.map(s=>s.id)],['alert','lineup','takeoff','navigate','radarPower','scanSetup','contact','multiTws','iff','lock','lost','modeRelock','nctr','rwr','silence','return']);
  const w=makeWorld(),u=makeUnit(),s=createEmergencyTutorialState();
  enterEmergencyTutorialStep(s,u,w);
  w.time=2;tickEmergencyTutorial(s,u,w);assert.equal(s.phase,'success');advanceEmergencyTutorial(s,u,w);
  assert.equal(currentEmergencyTutorialStep(s).id,'lineup');assert.equal(currentEmergencyChapter(s).chapter.title,'紧急起飞');

  u.surface={grounded:true,phase:'lined_up'};passStep(s,u,w);
  u.surface={grounded:false,phase:'climb'};u.position[2]=500;passStep(s,u,w);
  assert.equal(currentEmergencyTutorialStep(s).id,'navigate');u.position=[...s.interceptPoint];passStep(s,u,w);

  u.radar.mode='pd';passStep(s,u,w);
  u.radar.scanHalfDeg=40;u.radar.scanElevationCenterDeg=10;passStep(s,u,w);
  u.radar.contacts=[contact('tgt-1')];passStep(s,u,w);
  u.radar.contacts=[contact('tgt-1'),contact('tgt-2')];u.radar.twsTrackedIds=['tgt-1','tgt-2'];passStep(s,u,w);
  u.radar.iffMode='manual';u.radar.contacts=[contact('tgt-1'),contact('tgt-2',{classification:'friendly'})];passStep(s,u,w);

  s.hostileId='tgt-1';u.radar.targetId='tgt-1';u.radar.phase='locked';passStep(s,u,w);
  u.radar.lastLostSequence=1;passStep(s,u,w);
  assert.equal(currentEmergencyTutorialStep(s).id,'modeRelock');
  u.radar.mode='pulse';tickEmergencyTutorial(s,u,w);
  u.radar.mode='pd';u.radar.targetId='tgt-1';u.radar.phase='locked';w.time+=1;tickEmergencyTutorial(s,u,w);assert.equal(s.phase,'success');advanceEmergencyTutorial(s,u,w);
  u.radar.contacts=[contact('tgt-1',{identification:{type:'F-16',confidence:.8}})];passStep(s,u,w);
  u.rwr.contacts=[{observedAt:w.time}];passStep(s,u,w);
  u.radar.silent=true;passStep(s,u,w);
  assert.equal(currentEmergencyTutorialStep(s).id,'return');
  u.surface={grounded:true,phase:'rollout'};u.position[2]=102;tickEmergencyTutorial(s,u,w);assert.equal(s.phase,'success');
  assert.equal(advanceEmergencyTutorial(s,u,w),false);assert.equal(s.phase,'done');
});
