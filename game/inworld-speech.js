// The server owns credentials and voice selection. Only short radio text leaves the browser.
export function createInworldSpeech({fetchImpl=globalThis.fetch,Audio=globalThis.Audio,urlApi=globalThis.URL,timeoutMs=65000}={}){
  let active=null;
  return {
    cancel(state='cancelled'){active?.(state);},
    speak(message,{signal,row,onError=()=>{}}={}){
      if(signal?.aborted)return Promise.reject(new DOMException('通联已取消','AbortError'));
      if(!fetchImpl||!Audio||!urlApi?.createObjectURL){onError('浏览器无法播放 Inworld 音频');return Promise.resolve('unavailable');}
      // A new transmission replaces any old fetch or playback.
      active?.();
      return new Promise((resolve,reject)=>{
        const controller=new AbortController();let player=null,objectUrl=null,finished=false;
        const done=(state,error)=>{
          if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();
          if(player){player.onplaying=player.onended=player.onerror=null;player.pause();player.removeAttribute('src');}
          if(objectUrl)urlApi.revokeObjectURL(objectUrl);
          if(row)row.dataset.speaking='false';if(active===stop)active=null;
          error?reject(error):resolve(state);
        };
        const stop=(state='cancelled')=>state==='muted'?done('muted'):done('cancelled',new DOMException('通联已取消','AbortError'));
        const abort=()=>stop();
        const fail=error=>{if(finished)return;onError(error?.message||'Inworld 语音不可用');done('unavailable');};
        const timer=setTimeout(()=>fail(Error('Inworld 音频播放超时')),timeoutMs);
        active=stop;signal?.addEventListener('abort',abort,{once:true});
        void (async()=>{
          try{
            const text=(message.speechText??message.text).replace(/（[^）]*）|\([^)]*\)/g,'').trim();
            if(!text){done('spoken');return;}
            const response=await fetchImpl('/api/voice/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
              body:JSON.stringify({text,speaker:message.speaker,...(message.unitId!=null?{unitId:message.unitId}:{}),language:message.speechLanguage||(/[\u3400-\u9fff]/.test(text)?'zh-CN':message.language||'zh-CN'),...(message.speechRate!==undefined?{rate:message.speechRate}:{})})});
            if(finished)return;
            if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'Inworld 语音请求失败');}
            const blob=await response.blob();if(finished)return;
            if(!blob.size)throw Error('Inworld 返回空音频');
            objectUrl=urlApi.createObjectURL(blob);player=new Audio(objectUrl);player.volume=.9;
            player.onplaying=()=>{if(row)row.dataset.speaking='true';};
            player.onended=()=>done('spoken');player.onerror=()=>fail(Error('Inworld 音频播放失败'));
            await player.play();
          }catch(error){fail(error);}
        })();
      });
    }
  };
}
