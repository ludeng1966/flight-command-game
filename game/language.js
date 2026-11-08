import {LANGUAGE_STORAGE_KEY,languagePreferences,languageCode,createUiDictionary,hasChinese,maskTranslationNumbers,unmaskTranslationNumbers} from '../sim/language.js';
let preferences=languagePreferences(),dictionary=createUiDictionary(),initialized=false;
try{preferences=languagePreferences(JSON.parse(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)||'{}'));}catch{}
const listeners=new Set(),cache=new Map(),pending=new Map();let queueTimer=null,running=false;
export const getLanguages=()=>({...preferences});
export const onLanguageChange=listener=>{listeners.add(listener);return ()=>listeners.delete(listener);};
export function setLanguages(value){
  preferences=languagePreferences({...preferences,...value});try{globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY,JSON.stringify(preferences));}catch{}
  for(const listener of listeners)listener(getLanguages());return getLanguages();
}
export function translateEnglish(text){return dictionary.english(text);}
async function flush(){
  queueTimer=null;if(running)return;running=true;
  try{while(pending.size){
    const jobs=[...pending.values()].slice(0,24),source=jobs[0].source,target=jobs[0].target,batch=jobs.filter(j=>j.source===source&&j.target===target);
    for(const job of batch)pending.delete(job.key);
    try{
      const response=await fetch('/api/language/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,target,texts:batch.map(j=>j.text)}),signal:AbortSignal.timeout(35000)});
      const data=await response.json();if(!response.ok||data.texts?.length!==batch.length)throw Error('Translation unavailable');
      batch.forEach((job,i)=>{cache.set(job.key,data.texts[i]);job.resolve(data.texts[i]);});
    }catch(error){for(const job of batch)job.reject(error);}
  }}finally{running=false;}
}
export async function translateText(text,target,{source=hasChinese(text)?'zh':'en',signal}={}){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  if(source===target||!text.trim())return text;
  if(target==='en'){const local=dictionary.english(text);if(local!==null)return local;}
  const masked=maskTranslationNumbers(text),key=JSON.stringify([source,target,masked.text]);
  let value=cache.get(key);
  if(!value){value=new Promise((resolve,reject)=>pending.set(key,{key,text:masked.text,source,target,resolve,reject}));cache.set(key,value);if(!running&&!queueTimer)queueTimer=setTimeout(()=>void flush(),30);}
  const result=unmaskTranslationNumbers(await value,masked.values);if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return result;
}
export async function localizeRadio(message,{signal}={}){
  const settings=getLanguages(),texts={...(message.texts??{})},source=hasChinese(message.text)?'zh':'en';texts[source]??=message.text;
  for(const target of new Set([settings.text,settings.voice]))texts[target]??=await translateText(message.text,target,{source,signal});
  if((settings.text==='en'||settings.voice==='en')&&hasChinese(texts.en))texts.en=await translateText(texts.en,'en',{source:'zh',signal});
  const current=getLanguages();if(current.text!==settings.text||current.voice!==settings.voice)return localizeRadio({...message,texts},{signal});
  return {...message,text:texts[settings.text],speechText:texts[settings.voice],language:languageCode(settings.voice),speechLanguage:languageCode(settings.voice),speechRate:settings.rate,texts};
}
export async function initLanguages({doc=document}={}){
  if(initialized)return;initialized=true;
  try{const response=await fetch('../data/locales/en.json');if(response.ok)dictionary=createUiDictionary(await response.json());}catch{}
  const sourceNodes=new WeakMap(),attributes=new WeakMap();
  const allowed=node=>!node.parentElement?.closest('script,style,textarea,[contenteditable=true],[data-language-skip]');
  function renderText(node){
    if(!allowed(node))return;
    const previous=sourceNodes.get(node);if(previous&&node.nodeValue===previous.rendered&&previous.target===preferences.text)return;
    const source=previous&&node.nodeValue===previous.rendered?previous.source:node.nodeValue;
    if(!source?.trim())return;
    const state={source,rendered:source,target:preferences.text};sourceNodes.set(node,state);
    if(preferences.text==='zh'||!hasChinese(source)){if(node.nodeValue!==source)node.nodeValue=source;return;}
    const translated=dictionary.english(source);state.rendered=translated??'Translating…';if(node.nodeValue!==state.rendered)node.nodeValue=state.rendered;
    if(translated===null)void translateText(source,'en').then(text=>{if(sourceNodes.get(node)===state&&preferences.text==='en'){state.rendered=text;node.nodeValue=text;}}).catch(()=>{if(sourceNodes.get(node)===state&&preferences.text==='en'){state.rendered='Translation unavailable';node.nodeValue=state.rendered;}});
  }
  function renderAttributes(el){
    if(!el.getAttribute||el.matches?.('script,style,[data-language-skip]'))return;
    const previous=attributes.get(el)??{};attributes.set(el,previous);
    for(const name of ['title','placeholder','aria-label']){
      const value=el.getAttribute(name);if(!value)continue;
      const item=previous[name];if(item?.rendered===value&&item.target===preferences.text)continue;
      const source=item&&item.rendered===value?item.source:value;
      const translated=preferences.text==='en'&&hasChinese(source)?dictionary.english(source):source;
      previous[name]={source,rendered:translated??'Translating…',target:preferences.text};if(value!==previous[name].rendered)el.setAttribute(name,previous[name].rendered);
      if(translated===null)void translateText(source,'en').then(text=>{if(previous[name].source===source&&preferences.text==='en'){previous[name].rendered=text;el.setAttribute(name,text);}}).catch(()=>{if(preferences.text==='en'){previous[name].rendered='Translation unavailable';el.setAttribute(name,previous[name].rendered);}});
    }
  }
  function walk(root){
    if(root.nodeType===3){renderText(root);return;}renderAttributes(root);
    const walker=doc.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);let node;while(node=walker.nextNode()){if(node.nodeType===3)renderText(node);else renderAttributes(node);}
  }
  const observer=new MutationObserver(records=>{
    const roots=new Set();for(const r of records){if(r.type==='characterData')roots.add(r.target);else if(r.type==='attributes')renderAttributes(r.target);else for(const n of r.addedNodes)roots.add(n);}
    for(const root of roots)walk(root);
  });observer.observe(doc.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label']});
  const sync=()=>{doc.documentElement.lang=languageCode(preferences.text);walk(doc.documentElement);};onLanguageChange(sync);
  for(const [id,key]of [['text-language','text'],['voice-language','voice'],['speech-rate','rate']]){
    const el=doc.querySelector('#'+id);if(!el)continue;el.value=String(preferences[key]);el.onchange=()=>setLanguages({[key]:key==='rate'?Number(el.value):el.value});
  }
  sync();globalThis.addEventListener?.('pagehide',()=>observer.disconnect(),{once:true});
}
