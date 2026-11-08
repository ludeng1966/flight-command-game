import {LESSONS,SOURCES,ALPHABET,DIGITS,GLOSSARY} from './training-course.js';
import {navigationGeometry} from '../sim/training.js';
import {loadProgress,saveProgress,escapeHTML as esc} from './training-store.js';
import {initLanguages,getLanguages,translateText} from './language.js';
await initLanguages();
const $=s=>document.querySelector(s);
let progress=loadProgress(),current=0;
const sourceHTML=ids=>ids.map(id=>SOURCES.find(s=>s.id===id)).filter(Boolean).map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join('');
function lessonBody(l){
  return `<div class="lesson-heading"><div class="academy-kicker">${esc(l.tag)}</div><h2>${esc(l.title)}</h2><div class="lesson-meta"><span>建议 ${l.minutes} 分钟</span><span>零基础 / 当前游戏适用</span></div><p class="lesson-goal">${esc(l.goal)}</p></div>`+
    l.sections.map(s=>`<section class="lesson-section"><h3>${esc(s.title)}</h3>${(s.paragraphs??[]).map(p=>`<p>${esc(p)}</p>`).join('')}${s.rows?`<table aria-label="${esc(s.title)}"><tbody>${s.rows.map(row=>`<tr><th scope="row">${esc(row[0])}</th>${row.slice(1).map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:''}</section>`).join('')+
    `<section class="lesson-practice"><h3>动手做一遍</h3><ol>${l.practice.map(p=>`<li>${esc(p)}</li>`).join('')}</ol>${l.commands.map((c,i)=>`<div class="command-example"><code>${esc(c)}</code><button type="button" data-copy="${i}">复制口令</button></div>`).join('')}<p class="lesson-note"><b>看哪里：</b>${esc(l.observe)}</p><p class="lesson-trap"><b>容易卡住：</b>${esc(l.pitfall)}</p></section>`+
    (l.sources.length?`<div class="lesson-sources">公开依据 ${sourceHTML(l.sources)}</div>`:'');
}
function persist(){if(!saveProgress(progress))$('#academy-status').textContent='浏览器未允许保存进度；本次仍可阅读和练习，关闭后不会保留。';}
function renderNav(){
  $('#read-count').textContent=`${progress.read.length} / ${LESSONS.length}`;$('#course-progress').max=LESSONS.length;$('#course-progress').value=progress.read.length;
  $('#course-nav').innerHTML=LESSONS.map((l,i)=>`<li><a href="#${l.id}" ${i===current?'aria-current="page"':''}><span class="lesson-index">${String(i+1).padStart(2,'0')}</span><span>${esc(l.title)}</span><span class="lesson-mark" aria-label="${progress.read.includes(l.id)?'已读':'未读'}">${progress.read.includes(l.id)?'✓':''}</span></a></li>`).join('');
}
function renderLesson(focus=false){
  const l=LESSONS[current],answer=progress.answers[l.id];
  $('#lesson').innerHTML=lessonBody(l)+`<section class="lesson-quiz"><form id="quiz-form"><fieldset><legend>小测 · ${esc(l.quiz.question)}</legend>${l.quiz.options.map((o,i)=>`<label><input type="radio" name="answer" value="${i}" required ${answer===i?'checked':''}>${esc(o)}</label>`).join('')}</fieldset><button type="submit">检查答案</button><p id="quiz-feedback" role="status"></p></form></section><div class="lesson-navigation"><button type="button" id="previous-lesson" ${current===0?'disabled':''}>← 上一课</button><button type="button" id="mark-read" class="mark-read">${progress.read.includes(l.id)?'已读 ✓':'标记已读'}</button><button type="button" id="next-lesson" ${current===LESSONS.length-1?'disabled':''}>下一课 →</button></div><a class="lesson-game-link" href="./?training=${l.id==='checkride'?'exam':'guided'}">打开游戏${l.id==='checkride'?'独立考核':'实操引导'} →</a>`;
  $('#previous-lesson').onclick=()=>go(current-1);$('#next-lesson').onclick=()=>go(current+1);
  $('#mark-read').onclick=()=>{if(!progress.read.includes(l.id))progress.read.push(l.id);persist();renderNav();$('#mark-read').textContent='已读 ✓';};
  const showAnswer=value=>{const correct=value===l.quiz.answer;$('#quiz-feedback').dataset.correct=String(correct);$('#quiz-feedback').textContent=`${correct?'答对了。':'再想一想。'}${l.quiz.explanation}`;};
  $('#quiz-form').onsubmit=e=>{e.preventDefault();const input=new FormData(e.currentTarget).get('answer');if(input===null)return;const value=Number(input);progress.answers[l.id]=value;persist();showAnswer(value);};
  if(Number.isInteger(answer))showAnswer(answer);
  $('#lesson').querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{try{const text=l.commands[Number(b.dataset.copy)];await navigator.clipboard.writeText(getLanguages().text==='en'?await translateText(text,'en'):text);b.textContent='已复制';}catch{b.textContent='请选中文字复制';}});
  renderNav();if(focus){$('#lesson').focus({preventScroll:true});window.scrollTo({top:Math.max(0,$('#academy-main').offsetTop-20),behavior:'instant'});}
}
function go(index){if(index<0||index>=LESSONS.length)return;location.hash=LESSONS[index].id;}
function hashChanged(focus=true){const i=LESSONS.findIndex(l=>'#'+l.id===location.hash);if(i>=0){current=i;renderLesson(focus);}}
window.addEventListener('hashchange',()=>hashChanged());
function renderGlossary(){const q=$('#glossary-search').value.trim().toLocaleLowerCase(),rows=GLOSSARY.filter(r=>r.join(' ').toLocaleLowerCase().includes(q));$('#glossary-list').innerHTML=rows.length?rows.map(([a,b,c])=>`<dt>${esc(a)} · ${esc(b)}</dt><dd>${esc(c)}</dd>`).join(''):'<dd>没有匹配术语，试试中文名称或缩写。</dd>';}
$('#glossary-search').oninput=renderGlossary;renderGlossary();
$('#alphabet-grid').innerHTML=ALPHABET.map((word,i)=>`<span><b>${String.fromCharCode(65+i)}</b>${esc(word)}</span>`).join('');
$('#digit-list').textContent=DIGITS.map((d,i)=>`${i} ${d}`).join(' · ');
$('#course-sources').innerHTML=SOURCES.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>：${esc(s.note)}</li>`).join('');
function renderResults(){
  const rows=progress.results.slice().reverse();
  $('#sortie-results').innerHTML=rows.length?rows.map(r=>{
    const date=new Date(r.date),when=Number.isFinite(date.valueOf())?date.toLocaleString('zh-CN'):'';
    return `<p>${esc(when)} · ${r.mode==='exam'?'独立考核':'引导练习'} · ${r.status==='passed'?'实飞通过':r.status==='failed'?'未通过':'已中止'}${r.reason?' · '+esc(r.reason):''}</p>`;
  }).join(''):'<p>还没有本机实飞记录。进入游戏，在“训练”中开启一轮引导或独立考核。</p>';
}
renderResults();
window.addEventListener('focus',()=>{progress=loadProgress();renderNav();renderResults();});
function updateLab(){
  const bearing=Number($('#lab-bearing').value),range=Number($('#lab-range').value),height=Number($('#lab-height').value),g=navigationGeometry(bearing,range,height);
  const deg=v=>v===null?'未定义':String(Math.round(v)).padStart(3,'0')+'°';
  $('#bearing-value').textContent=deg(bearing);$('#range-value').textContent=range.toFixed(1)+' NM';$('#height-value').textContent=height.toLocaleString('en-US')+' ft';
  $('#lab-readouts').innerHTML=[['从台径向',deg(g.radialDeg)],['沿线向台方向',deg(g.inboundDeg)],['沿线背台方向',deg(g.outboundDeg)],['水平距离',range.toFixed(2)+' NM'],['DME斜距',g.dmeNm.toFixed(2)+' NM'],['东 / 北偏移',`${(g.eastM/1000).toFixed(2)} / ${(g.northM/1000).toFixed(2)} km`]].map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#lab-explanation').textContent=range===0?'飞机在台站正上方，向台与径向方位没有唯一值。相对台高仍形成斜距，DME不必为零。':`从台站看飞机在${deg(g.radialDeg)}方向。无风且沿这条直线向台飞，方向约${deg(g.inboundDeg)}。DME包含高度差，靶眼距离按水平距离读。`;
  const x=180+g.eastM/1852*4,y=180-g.northM/1852*4;
  $('#navigation-diagram').innerHTML=`<title id="diagram-title">${esc(range===0?'台站正上方':`飞机在${deg(g.radialDeg)}径向，水平距离${range}海里`)}</title><g fill="none" stroke="var(--train-border)">${[40,80,120].map(r=>`<circle cx="180" cy="180" r="${r}"/>`).join('')}<path d="M180 38V322M38 180H322"/></g><g fill="var(--train-muted)" font-family="Consolas,monospace" font-size="11" text-anchor="middle"><text x="180" y="26">N / 000</text><text x="180" y="345">S / 180</text><text x="325" y="169">E / 090</text><text x="36" y="169">W / 270</text><text x="200" y="145">10</text><text x="200" y="105">20</text><text x="200" y="65">30</text></g><line x1="180" y1="180" x2="${x}" y2="${y}" stroke="var(--train-blue)" stroke-width="2"/><circle cx="180" cy="180" r="5" fill="var(--train-blue)"/><circle cx="${x}" cy="${y}" r="7" fill="var(--train-accent)"/><text x="172" y="205" text-anchor="end" fill="var(--train-blue)" font-size="11">BAY / 原点</text><text x="${Math.min(305,Math.max(45,x))}" y="${Math.max(48,y-15)}" text-anchor="middle" fill="var(--train-accent)" font-size="11">飞机</text>`;
}
for(const id of ['lab-bearing','lab-range','lab-height'])$('#'+id).oninput=updateLab;
$('#lab-overhead').onclick=()=>{$('#lab-range').value=0;$('#lab-height').value=6000;updateLab();};
$('#lab-reset').onclick=()=>{$('#lab-bearing').value=90;$('#lab-range').value=10;$('#lab-height').value=6000;updateLab();};
updateLab();
$('#print-course').onclick=()=>{
  $('#print-workbook').innerHTML='<h1>飞行指挥完整教程</h1><p>从零基础到独立起降与航点导航 · 2026-11-07</p>'+LESSONS.map(l=>`<article>${lessonBody(l)}<h3>课后小测</h3><p>${esc(l.quiz.question)}</p><ol>${l.quiz.options.map(o=>`<li>${esc(o)}</li>`).join('')}</ol><p>答案：${l.quiz.answer+1}。${esc(l.quiz.explanation)}</p></article>`).join('')+`<article><h2>术语速查</h2>${GLOSSARY.map(([a,b,c])=>`<p><b>${esc(a)} / ${esc(b)}</b>：${esc(c)}</p>`).join('')}<h2>字母与数字</h2><p>${ALPHABET.map((w,i)=>`${String.fromCharCode(65+i)} ${w}`).join(' · ')}</p><p>${DIGITS.map((w,i)=>`${i} ${w}`).join(' · ')}</p><h2>公开资料</h2>${SOURCES.map(s=>`<p>${esc(s.title)}<br>${esc(s.url)}</p>`).join('')}</article>`;
  window.print();
};
renderLesson();hashChanged(false);
