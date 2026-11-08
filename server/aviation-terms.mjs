import {readFileSync,statSync} from 'node:fs';
import {COMMAND_CATALOG,missingCapabilities} from '../sim/military-commands.js';
const corePath=new URL('../data/aviation/core-terms.json',import.meta.url);
const path=new URL('../data/aviation/reference-terms.json',import.meta.url);
const GUARD='【航空术语简释】词义不是实况或执行许可。先分清命令、请求、许可、通报；以当前能力、单位与坐标规则为准，不编造数据或动作。';
const normalize=text=>String(text??'').normalize('NFKC').toUpperCase().replace(/[‐‑–—_]/g,' ').replace(/\bFOX(ONE|TWO|THREE)\b/g,'FOX $1').replace(/\bNOJOY\b/g,'NO JOY').replace(/([A-Z])(\d)|(\d)([A-Z])/g,(_m,a,b,c,d)=>a?a+' '+b:c+' '+d).replace(/\s+/g,' ').trim();
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ignored=new Set(['A','AN','THE','AND','FOR','TO','IF','OR','IN','AS','ON','OF','BY','AT','IS','IT','NOT','ALL','NONE']);
const validAlias=alias=>alias.length>=2&&!ignored.has(alias);
let cache={mtime:-1,terms:[],sources:[],indexed:[]};
function aliases(term){
 const names=[term.term,term.zh,...(term.aliases??[])];
 if(term.source!=='core'){
  const bare=term.term.replace(/\[[^\]]*\]/g,'').replace(/\s*\[ICAO\]/g,'').replace(/\(S\)/g,'').trim();names.push(bare);
  const acronym=term.term.match(/\(([A-Z][A-Z0-9-]{1,9})\)/)?.[1];if(acronym)names.push(acronym);
 }
 return [...new Set(names.map(normalize).filter(validAlias))];
}
function index(terms){return terms.map(term=>({...term,matchers:aliases(term).map(alias=>({alias,regex:/[\u3400-\u9fff]/.test(alias)?null:new RegExp('(?:^|[^A-Z0-9])'+escape(alias)+'(?=$|[^A-Z0-9])','u')}))}));}
function load(){
 let mtime;try{mtime=statSync(path).mtimeMs;}catch(error){if(error.code!=='ENOENT')throw error;mtime=0;}
 const stamp=mtime+':'+statSync(corePath).mtimeMs;if(stamp===cache.mtime)return cache;
 const data=mtime?JSON.parse(readFileSync(path,'utf8')):{terms:[],sources:[]};
 const core=JSON.parse(readFileSync(corePath,'utf8'));
 const game=COMMAND_CATALOG.map(command=>({id:'intent-'+command.id,term:command.id,zh:command.label,source:'game',intent:command.id,
  aliases:[command.label.split(' / ')[0],...command.label.split(' / ').slice(1).flatMap(t=>t.split(' / '))],
  meaning:'本游戏意图：'+command.label+'。识别口令后保留对象与参数，实际能否执行以当前能力表和程序结果为准。'}));
 const terms=[...core.map(t=>({...t,id:'core-'+t.id,source:'core'})),...game,...data.terms];
 cache={mtime:stamp,terms,sources:data.sources,indexed:index(terms)};return cache;
}
export function aviationTermStats(){const data=load();return {total:data.terms.length,referenceTerms:data.terms.filter(t=>!['core','game'].includes(t.source)).length,
 counts:Object.fromEntries(['core','game','faa','alssa'].map(source=>[source,data.terms.filter(t=>t.source===source).length])),sources:data.sources,loadMode:'on_demand'};}
export function searchAviationTerms(query,{limit=12}={}){
 const text=normalize(query),scored=[];if(!text)return [];
 for(const term of load().indexed){
  let score=0;
  for(const match of term.matchers)if(match.regex?match.regex.test(text):text.includes(match.alias))score=Math.max(score,match.alias.length);
  if(term.id==='core-mach'&&/\bM\s*\d+(?:\.\d+)?\b/.test(text))score=Math.max(score,5);
  if(term.id==='core-fl'&&/\bFL\s*\d{2,3}\b/.test(text))score=Math.max(score,5);
  if(score)scored.push({term,score:score+(term.source==='core'?100:term.source==='game'?30:0)});
 }
 scored.sort((a,b)=>b.score-a.score||a.term.id.localeCompare(b.term.id));
 const found=[],seen=new Set();
 for(const {term}of scored){
  const canonical=normalize(term.term.replace(/\[[^\]]*\]/g,'').replace(/\(S\)/g,'').trim());
  if(seen.has(canonical))continue;seen.add(canonical);
  const {matchers,...entry}=term;
  if(entry.intent){const command=COMMAND_CATALOG.find(c=>c.id===entry.intent);entry.missingCapabilities=missingCapabilities(command);}
  found.push(entry);if(found.length>=Math.max(1,Math.min(40,limit)))break;
 }
 return found;
}
export function aviationReading(query,{compact=false}={}){
 const limit=compact?4:14,maxChars=compact?900:4200,selected=[];let text=GUARD;
 for(const term of searchAviationTerms(query,{limit:40})){
  const line=`\n${term.term}（${term.zh}）：${term.meaning}`;
  if(text.length+line.length>maxChars)continue;
  text+=line;selected.push(term);if(selected.length>=limit)break;
 }
 return {text,terms:selected.map(({id,term,source,url})=>({id,term,source,...(url?{url}:{})})),
  files:[{id:'aviation_terms',file:'13_航空术语速查.txt',title:'航空术语简释（本次相关条目）',termIds:selected.map(t=>t.id)}]};
}
export function appendAviationReading(reading,query,options){
 const extra=aviationReading(query,options);return {text:extra.text+'\n\n'+reading.text,files:[...reading.files,...extra.files],terms:extra.terms};
}
