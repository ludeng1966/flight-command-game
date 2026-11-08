// Export the same player-facing course as an offline, printable UTF-8 text manual.
import fs from 'node:fs';
import {LESSONS,SOURCES,GLOSSARY,ALPHABET,DIGITS} from '../game/training-course.js';
const lines=['飞行指挥完整教程','从零基础到独立命令飞机起降与到达航点','资料核对：2026-11-08','',
  '打开游戏：http://127.0.0.1:8000/game/','在线课程：http://127.0.0.1:8000/game/training.html',
  '游戏内“训练关卡”提供3大关、52个短步骤：认识呼号与地面通联、起飞盘旋与离场交接、导航与返场交接。每关可单独开始与重练；每屏只教一个目标。',
  '本文件为备用阅读材料。首选在实际游戏中看示范、下命令、观察结果，再进入下一关。',
  'TACAN当前提供课堂几何实验，不含真正的调谐接收机。公开资料与游戏设定分别注明。',''];
for(const l of LESSONS){
  lines.push('='.repeat(56),l.tag+'  '+l.title,`建议时长：${l.minutes}分钟`,`目标：${l.goal}`,'');
  for(const s of l.sections){lines.push(s.title);for(const p of s.paragraphs??[])lines.push(p,'');for(const r of s.rows??[])lines.push(r.join(' | '));lines.push('');}
  lines.push('动手做一遍',...l.practice.map((p,i)=>`${i+1}. ${p}`),'',...l.commands.map(c=>'口令：'+c),'看哪里：'+l.observe,'容易卡住：'+l.pitfall,'','小测：'+l.quiz.question,...l.quiz.options.map((o,i)=>`${i+1}. ${o}`),`答案：${l.quiz.answer+1}。${l.quiz.explanation}`,'');
  for(const id of l.sources){const s=SOURCES.find(s=>s.id===id);lines.push('公开依据：'+s.title+' '+s.url);}
  lines.push('');
}
lines.push('='.repeat(56),'字母与数字拼读',...ALPHABET.map((w,i)=>`${String.fromCharCode(65+i)}  ${w}`),DIGITS.map((w,i)=>`${i} ${w}`).join(' · '),'','术语速查',...GLOSSARY.map(([a,b,c])=>`${a} / ${b}：${c}`),'','公开资料',...SOURCES.flatMap(s=>[s.title,s.url,s.note,'']),
  '本地实现依据：game/README.md、server/airport-design.md、server/military-commands.md、sim/command-planning.js、sim/airport.js、sim/units.js。',
  '实操巡航阈值：海拔>=1500m、实际速度120–230m/s、高度误差<=150m、速度误差<=15m/s、综合考核坡度<15度，第三关空中待命起点允许稳定转弯坡度<45度，连续10秒模拟时间。属于游戏教学阈值。',
  '考核按真实仿真状态记录离场、稳定巡航、明确航点通过、着陆滑跑、脱离和回机位。地面出生与重开不能替代正常完成。',
  '游戏不模拟完整北约机构、ATO/ACO计划、真实TACAN、ILS、动态风场、现实机型仪表程序。本教程不将FAA民航资料称为完整北约军事条令。','');
const output=new URL('../game/飞行指挥完整教程.txt',import.meta.url);fs.writeFileSync(output,lines.join('\n'),'utf8');
console.log(`Exported ${LESSONS.length} lessons, ${GLOSSARY.length} terms to ${output.pathname}`);
