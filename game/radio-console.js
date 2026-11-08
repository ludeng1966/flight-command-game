import {radioPause} from './command-session.js';
import {createInworldSpeech} from './inworld-speech.js';
import {localizeRadio,onLanguageChange} from './language.js';
import {normalizeAviationSpeech} from '../sim/aviation-speech.js';
import {readSettings,writeSettings,settingsStorage} from './settings-store.js';

export function createRadioConsole({getWorld,document:doc=globalThis.document,synth=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance,provider='inworld',speech=createInworldSpeech(),storage=settingsStorage()}={}){
  const list=doc.querySelector('#radio-transcript'),stage=doc.querySelector('#radio-phase'),audio=doc.querySelector('#radio-audio'),collapse=doc.querySelector('#radio-collapse');
  let enabled=readSettings(storage)['radio-audio-enabled']??true,active=null,sequence=0,ttsReady=null,lastError='',retryCloudAt=0,localFallback=false,pending=0;const rows=[];
  const retry=doc.createElement&&audio?doc.createElement('button'):null;
  if(retry){retry.id='radio-retry-cloud';retry.type='button';retry.textContent='重试Inworld语音';retry.onclick=async()=>{if(pending||!enabled)return;retryCloudAt=0;try{await transmit({speaker:'controller',label:'塔台 · 语音检查',text:'BAY塔台，语音检查。',texts:{zh:'BAY塔台，语音检查。',en:'BAY TOWER. RADIO CHECK.'},language:'zh-CN'});}catch{};};}
  const phase=(id,text)=>{if(stage){stage.dataset.stage=id;stage.textContent=text;}};
  function syncAudio(){if(audio){audio.textContent=!enabled?'通话语音：关':provider==='inworld'?(localFallback?'通话语音：本地 · 云端不可用':ttsReady===false?'Inworld 待配置 · 尝试本地语音':lastError?'语音不可用 · 字幕通联':'通话语音：Inworld Flash'):'通话语音：本地';audio.title=lastError;audio.setAttribute('aria-pressed',String(enabled));if(retry){retry.hidden=provider!=='inworld'||!lastError;retry.disabled=!enabled||pending>0;audio.after(retry);}}}
  function cancel(){active?.();speech.cancel();synth?.cancel();}
  async function speak(message,signal,row){
    if(provider==='inworld'){
      if(!enabled){await radioPause(450,signal);return 'muted';}
      if(ttsReady!==false&&Date.now()>=retryCloudAt){
        lastError='';
        const result=await speech.speak(message,{signal,row,onError:message=>{lastError=message;}});
        if(result!=='unavailable'){localFallback=false;syncAudio();return result;}
        retryCloudAt=/HTTP (?:401|403)/.test(lastError)?Infinity:Date.now()+60000;
      }
      if(signal?.aborted)throw new DOMException('通联已取消','AbortError');
      const result=await speakLocal(message,signal,row);localFallback=result==='spoken';syncAudio();return result;
    }
    return speakLocal(message,signal,row);
  }
  async function speakLocal(message,signal,row){
    if(!enabled||!synth||!Utterance){await radioPause(450,signal);return enabled?'unavailable':'muted';}
    let voices=synth.getVoices();
    if(!voices.length&&synth.addEventListener){
      await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);synth.removeEventListener('voiceschanged',finish);resolve();};const timer=setTimeout(finish,1200);synth.addEventListener('voiceschanged',finish,{once:true});});
      voices=synth.getVoices();
    }
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new DOMException('通联已取消','AbortError'));return;}
      const utterance=new Utterance((message.speechText??message.text).replace(/（[^）]*）|\([^)]*\)/g,''));
      utterance.lang=message.speechLanguage||(/[\u3400-\u9fff]/.test(utterance.text)?'zh-CN':message.language||'zh-CN');
      utterance.text=normalizeAviationSpeech(utterance.text,utterance.lang);
      const candidates=voices.filter(v=>v.lang.toLowerCase().startsWith(utterance.lang.split('-')[0]));
      const local=candidates.filter(v=>v.localService);const choice=local.length?local:candidates;
      utterance.voice=choice[message.speaker==='pilot'&&choice.length>1?1:0]||null;
      utterance.pitch=message.speaker==='commander'?.88:message.speaker==='pilot'?1.12:1;
      utterance.rate=1.08*(message.speechRate??1);utterance.volume=.9;
      let finished=false;
      const done=(state,error)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(active===stop)active=null;if(row)row.dataset.speaking='false';error?reject(error):resolve(state);};
      const stop=(state='cancelled')=>state==='muted'?done('muted'):done('cancelled',new DOMException('通联已取消','AbortError'));
      const abort=()=>{stop();synth.cancel();};
      const timer=setTimeout(()=>{synth.cancel();done('unavailable');},Math.max(6000,Math.min(40000,message.text.length*300+4000)));
      active=stop;signal?.addEventListener('abort',abort,{once:true});
      utterance.onstart=()=>{if(row)row.dataset.speaking='true';};utterance.onend=()=>done('spoken');utterance.onerror=()=>done('unavailable');
      try{synth.speak(utterance);}catch{done('unavailable');}
    });
  }
  async function transmit(message,{signal}={}){
    if(signal?.aborted)throw new DOMException('通联已取消','AbortError');
    const source=message;message=await localizeRadio(message,{signal});
    if(signal?.aborted)throw new DOMException('通联已取消','AbortError');
    const world=getWorld(),record={...message,id:`radio-${++sequence}`,time:message.simTime??world.time,delivery:'queued'};
    const log=world.radioLog??=[];log.push(record);if(log.length>64)log.shift();
    let row;
    if(list){
      row=doc.createElement('li');row.dataset.speaker=message.speaker;row.dataset.messageId=record.id;
      const title=doc.createElement('div'),text=doc.createElement('p');
      const unit=world.units.find(u=>u.id===message.unitId);
      title.className='radio-speaker';title.textContent=message.label??(message.speaker==='commander'?'指挥台 · 玩家':message.speaker==='controller'?'塔台 · BAY':message.speaker==='pilot'?`飞行员 · ${unit?.callsign||message.unitId||'电脑'}${message.checkedByModel?' · AI检查后复述':''}`:'通联提示');
      text.textContent=message.text;row.append(title,text);list.append(row);while(list.children.length>64)list.firstElementChild.remove();
      rows.push({source,record,text});if(rows.length>64)rows.shift();
      if(doc.querySelector('#radio-console')?.dataset?.browsing!=='true')list.scrollTop=list.scrollHeight;
    }
    pending++;syncAudio();
    try{record.delivery=await speak(message,signal,row);if(row)row.dataset.delivery=record.delivery;if(record.delivery==='unavailable'&&audio){if(provider==='inworld')syncAudio();else audio.textContent='语音不可用 · 字幕通联';}return record;}
    catch(e){record.delivery='cancelled';if(row)row.dataset.delivery='cancelled';throw e;}
    finally{pending--;syncAudio();}
  }
  if(audio)audio.onclick=()=>{enabled=!enabled;writeSettings({'radio-audio-enabled':enabled},storage);if(!enabled){active?.('muted');speech.cancel('muted');synth?.cancel();}else{retryCloudAt=0;localFallback=false;}syncAudio();};
  if(collapse)collapse.onclick=()=>{const open=collapse.getAttribute('aria-expanded')!=='false';collapse.setAttribute('aria-expanded',String(!open));if(list)list.hidden=open;collapse.textContent=open?'展开':'收起';};
  syncAudio();phase('idle','等待玩家指令');
  const unsubscribe=onLanguageChange(()=>{for(const item of rows)void localizeRadio(item.source).then(message=>{item.text.textContent=message.text;item.record.text=message.text;item.record.texts=message.texts;}).catch(()=>{});});
  globalThis.addEventListener?.('pagehide',unsubscribe,{once:true});
  return {transmit,phase,cancel,configure(tts){if(!tts)return;if(provider!==tts.provider)cancel();if(provider!==tts.provider||ttsReady!==tts.ready){lastError='';retryCloudAt=0;localFallback=false;}provider=tts.provider==='browser'?'browser':'inworld';ttsReady=tts.ready;if(ttsReady===false)lastError='请在 .env 填写 INWORLD_API_KEY 后重启服务';syncAudio();},clear(){cancel();rows.length=0;list?.replaceChildren();phase('idle','等待玩家指令');},get enabled(){return enabled;}};
}
