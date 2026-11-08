// Input is already normalized aviation speech. Keep punctuation and digits in
// place; spans mark pronunciation inside ONE synthesis, never separate calls.
export function splitBilingualSpeech(text){
  const parts=[];let cursor=0,prefix='';
  const add=(value,language)=>{
    if(!value)return;
    if(!/[A-Za-z\u3400-\u9fff]/.test(value)){
      if(parts.length)parts.at(-1).text+=value;else prefix+=value;
      return;
    }
    value=prefix+value;prefix='';
    if(parts.at(-1)?.language===language)parts.at(-1).text+=value;else parts.push({text:value,language});
  };
  const word="[A-Za-z0-9]+(?:[-'.][A-Za-z0-9]+)*";
  const english=new RegExp("[A-Za-z][A-Za-z0-9]*(?:[-'.][A-Za-z0-9]+)*(?:(?:[ \\t]+|[,;:!?，、；：？！][ \\t]*)"+word+")*",'g');
  for(const match of text.matchAll(english)){
    add(text.slice(cursor,match.index),'zh-CN');add(match[0],'en-US');cursor=match.index+match[0].length;
  }
  add(text.slice(cursor),'zh-CN');
  if(prefix)parts.push({text:prefix,language:'zh-CN'});
  return parts;
}

export const PILOT_DELIVERY='[Speak naturally and calmly, like a professional pilot making a concise radio readback. Keep the sentence flowing smoothly.]';
export function bilingualSpeechText(text){
  const escape=value=>value.replace(/[&<>\[\]]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','[':'&#91;',']':'&#93;'}[c]));
  return PILOT_DELIVERY+splitBilingualSpeech(text).map(part=>`<lang lang="${part.language}">${escape(part.text)}</lang>`).join('');
}
