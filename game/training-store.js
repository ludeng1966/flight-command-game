import {COURSE_VERSION,LESSONS} from './training-course.js';
import {TRAINING_LEVELS} from '../sim/training-levels.js';
export const STORAGE_KEY='flight-training-v'+COURSE_VERSION;
export const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function loadProgress(){
  try{
    const p=JSON.parse(localStorage.getItem(STORAGE_KEY)??'{}');
    return {read:LESSONS.filter(l=>p.read?.includes?.(l.id)).map(l=>l.id),
      answers:Object.fromEntries(LESSONS.filter(l=>Number.isInteger(p.answers?.[l.id])&&p.answers[l.id]>=0&&p.answers[l.id]<l.quiz.options.length).map(l=>[l.id,p.answers[l.id]])),
      levelProgress:Object.fromEntries(TRAINING_LEVELS.filter(l=>p.levelProgress?.[l.id]?.passed===true).map(l=>[l.id,{passed:true,bestScore:Number(p.levelProgress[l.id].bestScore)||0,completedAt:p.levelProgress[l.id].completedAt??null}])),
      results:Array.isArray(p.results)?p.results.filter(r=>r&&['guided','exam'].includes(r.mode)&&['passed','failed','invalid'].includes(r.status)).slice(-10):[]};
  }catch{return {read:[],answers:{},results:[],levelProgress:{}};}
}
export function saveProgress(p){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(p));return true;}catch{return false;}}
export function recordResult(result){const p=loadProgress(),date=new Date().toISOString();p.results.push({...result,date});p.results=p.results.slice(-10);if(result.status==='passed'&&TRAINING_LEVELS.some(l=>l.id===result.levelId))p.levelProgress[result.levelId]={passed:true,bestScore:Math.max(p.levelProgress[result.levelId]?.bestScore??0,result.score??0),completedAt:date};return saveProgress(p);}
