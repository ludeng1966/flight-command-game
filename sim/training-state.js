import {FlightTrainingSession} from './training.js';
import {TrainingWalkthrough} from './training-walkthrough.js';
import {TRAINING_MISSIONS} from './training-missions.js';
import {trainingLevel,LEGACY_LEVEL_STEPS} from './training-levels.js';
const copy=(value,omit)=>Object.fromEntries(Object.entries(value).filter(([key])=>!omit.includes(key)));
export function captureTraining(session,walkthrough){
  if(!session)return null;
  return {flight:copy(session,['world','unit','airport']),walkthrough:walkthrough?copy(walkthrough,['world','unit','flight']):null};
}
export function restoreTraining(world,state){
  if(!state)return {session:null,walkthrough:null};
  const data=state.flight,unit=world.units.find(u=>u.id===data?.unitId);
  if(!unit||!['guided','exam'].includes(data.mode)||!['active','passed','failed','invalid'].includes(data.status)||!(data.lastWaypoints instanceof Set)||
    !Number.isFinite(data.lastTime)||data.lastTime>world.time||!data.completed||!data.flags)throw Error('教学进度无效');
  const session=Object.assign(Object.create(FlightTrainingSession.prototype),data,{world,unit,airport:world.airportOps?.airport});
  let walkthrough=null;
  if(state.walkthrough){
    const w=state.walkthrough;
    if(!w.handoffVersion&&LEGACY_LEVEL_STEPS[w.levelId])w.legacyMissionIds??=LEGACY_LEVEL_STEPS[w.levelId];
    const level=trainingLevel(w.levelId),missions=w.legacyMissionIds??level?.missions??TRAINING_MISSIONS;
    if(w.levelId&&!level||!Number.isInteger(w.index)||w.index<0||w.index>missions.length||!['brief','working','success'].includes(w.phase)||!Array.isArray(w.completed))throw Error('教学关卡无效');
    walkthrough=Object.assign(Object.create(TrainingWalkthrough.prototype),w,{world,unit,flight:session});
  }
  return {session,walkthrough};
}
