export const LANGUAGE_STORAGE_KEY='flight-language-v1';
export const SUPPORTED_LANGUAGES=Object.freeze(['zh','en']);
export const languageCode=language=>language==='en'?'en-US':'zh-CN';
export function languagePreferences(value={}){
  return {text:SUPPORTED_LANGUAGES.includes(value?.text)?value.text:'zh',voice:SUPPORTED_LANGUAGES.includes(value?.voice)?value.voice:'zh',rate:[.8,1,1.2].includes(value?.rate)?value.rate:1};
}
export const hasChinese=text=>/[\u3400-\u9fff]/.test(text);
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function createUiDictionary(entries={}){
  const patterns=Object.entries(entries).filter(([s])=>/\{\d+\}/.test(s)).sort((a,b)=>b[0].replace(/\{\d+\}/g,'').length-a[0].replace(/\{\d+\}/g,'').length).map(([source,target])=>{
    const keys=[];let cursor=0,pattern='^';
    for(const m of source.matchAll(/\{\d+\}/g)){pattern+=escape(source.slice(cursor,m.index))+'([\\s\\S]*?)';keys.push(m[0]);cursor=m.index+m[0].length;}
    return {regex:new RegExp(pattern+escape(source.slice(cursor))+'$'),keys,target};
  });
  const fragments=Object.keys(entries).filter(s=>hasChinese(s)&&s.length<150&&!/[{}<>\n]/.test(s)).sort((a,b)=>b.length-a.length);
  const fragmentRegex=fragments.length?new RegExp(fragments.map(escape).join('|'),'g'):null;
  function english(text,depth=0){
    if(!hasChinese(text))return text;
    const trimmed=text.trim();if(Object.hasOwn(entries,trimmed))return text.replace(trimmed,entries[trimmed]);
    if(depth<3)for(const p of patterns){const m=trimmed.match(p.regex);if(!m)continue;
      let target=p.target,valid=true;for(let i=0;i<p.keys.length;i++){const value=english(m[i+1],depth+1);if(value===null){valid=false;break;}target=target.replaceAll(p.keys[i],value);}
      if(!valid)continue;
      if(!hasChinese(target))return target;
    }
    const result=fragmentRegex?text.replace(fragmentRegex,s=>' '+entries[s]+' ').replace(/ {2,}/g,' ').trim():text;
    return hasChinese(result)?null:result.replace(/，/g,', ').replace(/。/g,'. ').replace(/；/g,'; ').replace(/：/g,': ');
  }
  const cache=new Map();
  return {english(text){if(cache.has(text))return cache.get(text);const value=english(text);cache.set(text,value);if(cache.size>2048)cache.delete(cache.keys().next().value);return value;}};
}
export function maskTranslationNumbers(text){
  const values=[];return {text:text.replace(/\d+(?:\.\d+)?/g,value=>{values.push(value);return `{n${values.length-1}}`;}),values};
}
export function unmaskTranslationNumbers(text,values){return text.replace(/\{n(\d+)\}/g,(_,i)=>values[Number(i)]??'');}
