import {ApiError} from './qwen.mjs';
import {normalizeAviationSpeech} from '../sim/aviation-speech.js';
import {bilingualSpeechText} from './bilingual-speech.mjs';

export const INWORLD_TTS_MODEL='inworld-tts-2-flash';
export const INWORLD_BILINGUAL_MODEL='inworld-tts-2';
// Preserve the spelling of English callsigns/terms in Chinese radio text.
// A forced Chinese locale also biases embedded English; let Flash detect mixed speech.
export function inworldSpeechLanguage(text,requested){
  const english=/[A-Za-z]/.test(text),chinese=/[\u3400-\u9fff]/.test(text);
  if(english&&chinese)return undefined;
  if(english)return 'en-US';
  return requested;
}
export function readTtsConfig(env={}){
  const config={provider:env.TTS_PROVIDER||'inworld',apiKey:(env.INWORLD_API_KEY||'').trim().replace(/^Basic\s+/i,''),
    model:INWORLD_TTS_MODEL,timeoutMs:Number(env.INWORLD_TTS_TIMEOUT_MS||15000),commanderRate:Number(env.INWORLD_RATE_COMMANDER||1.12),pilotEnglishLocalized:env.INWORLD_PILOT_EN_LOCALIZED==='true',
    voices:{commander:env.INWORLD_VOICE_COMMANDER||'Dennis',controller:env.INWORLD_VOICE_CONTROLLER||'Oliver',pilot:env.INWORLD_VOICE_PILOT||'Alex',system:env.INWORLD_VOICE_COMMANDER||'Dennis'},
    controllerVoices:{zh:env.INWORLD_VOICE_CONTROLLER_ZH||env.INWORLD_VOICE_CONTROLLER||'Yichen',en:env.INWORLD_VOICE_CONTROLLER_EN||env.INWORLD_VOICE_CONTROLLER||'Oliver'},
    pilotVoices:{'blue-1':env.INWORLD_VOICE_PILOT_1||env.INWORLD_VOICE_PILOT||'Alex','blue-2':env.INWORLD_VOICE_PILOT_2||env.INWORLD_VOICE_PILOT||'Alex'}};
  if(!['inworld','browser'].includes(config.provider)||!Number.isInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>60000)throw new Error('TTS 语音来源或超时配置无效');
  if(!Number.isFinite(config.commanderRate)||config.commanderRate<.5||config.commanderRate>1.5)throw new Error('Inworld 指挥员语速应在 0.5–1.5 之间');
  if(/[\r\n]/.test(config.apiKey)||[...Object.values(config.voices),...Object.values(config.pilotVoices),...Object.values(config.controllerVoices)].some(v=>typeof v!=='string'||!v.trim()||v.length>256||/[\r\n]/.test(v)))throw new Error('Inworld 密钥或音色配置无效');
  return config;
}
export function createInworldTts(config=readTtsConfig(),fetchImpl=fetch){
  async function synthesizeAudio(input,{signal}={}){
      if(!input||typeof input.text!=='string'||!input.text.trim()||input.text.length>2000||!Object.hasOwn(config.voices,input.speaker)||
        (input.rate!==undefined&&(!Number.isFinite(input.rate)||input.rate<.5||input.rate>1.5))||
        (input.unitId!==undefined&&(typeof input.unitId!=='string'||!input.unitId.trim()||input.unitId.length>64||/[\r\n]/.test(input.unitId)))||
        (input.language!==undefined&&(typeof input.language!=='string'||!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(input.language)||input.language.length>40)))throw new ApiError(400,'通联文本、发话角色、飞机或语言无效（最多 2000 字符）');
      if(config.provider!=='inworld')throw new ApiError(409,'当前语音来源为浏览器本地语音');
      if(!config.apiKey)throw new ApiError(503,'尚未配置 Inworld，请在 .env 填写 INWORLD_API_KEY 后重启服务');
      const timeout=AbortSignal.timeout(config.timeoutMs),job=new AbortController();
      const requestSignal=AbortSignal.any([...(signal?[signal]:[]),timeout,job.signal]);
      const voiceId=input.speaker==='controller'?config.controllerVoices?.[/^en/i.test(input.language??'')?'en':'zh']??config.voices.controller:input.speaker==='pilot'&&Object.hasOwn(config.pilotVoices,input.unitId)?config.pilotVoices[input.unitId]:config.voices[input.speaker];
      const spokenText=normalizeAviationSpeech(input.text.trim(),input.language);
      const language=inworldSpeechLanguage(spokenText,input.language);
      const bilingual=config.pilotEnglishLocalized&&input.speaker==='pilot'&&Object.hasOwn(config.pilotVoices,input.unitId)&&/[A-Za-z]/.test(spokenText)&&/[\u3400-\u9fff]/.test(spokenText);
      // One utterance preserves breath, pitch and timing across language switches.
      // TTS-2 supports language tags; Flash cannot provide this control.
      const text=bilingual?bilingualSpeechText(spokenText):spokenText;
      if(text.length>2000)throw new ApiError(400,'规范后的通联文本超过 Inworld 2000 字符限制，请缩短通联');
      const rate=Math.max(.5,Math.min(1.5,(input.speaker==='commander'?config.commanderRate:1.08)*(input.rate??1)));
      async function request(){
        requestSignal.throwIfAborted();
        const response=await fetchImpl('https://api.inworld.ai/tts/v1/voice',{
          method:'POST',headers:{Authorization:`Basic ${config.apiKey}`,'Content-Type':'application/json'},redirect:'error',signal:requestSignal,
          body:JSON.stringify({text,voiceId,modelId:bilingual?INWORLD_BILINGUAL_MODEL:config.model,
            ...(bilingual?{language:'en-US',deliveryMode:'STABLE'}:language?{language}:{}),audioConfig:{audioEncoding:'MP3',speakingRate:rate}})
        });
        if(!response.ok){
          const message=response.status===401?'API Key 无效':response.status===402?'计费或可用额度受限':response.status===403?'没有模型调用权限':response.status===429?'额度或调用频率受限':response.status===400||response.status===404?'文本、语言或音色不可用':'语音服务暂时不可用';
          throw new ApiError(502,`Inworld：${message}（HTTP ${response.status}）`);
        }
        const data=await response.json(),encoded=data?.audioContent;
        if(typeof encoded!=='string'||!encoded.length||encoded.length>16*1024*1024||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new ApiError(502,'Inworld 未返回有效音频');
        const audio=Buffer.from(encoded,'base64');
        if(!audio.length)throw new ApiError(502,'Inworld 返回空音频');
        return audio;
      }
      try{
        return {audio:await request(),contentType:'audio/mpeg'};
      }catch(error){
        job.abort();
        if(signal?.aborted)throw new DOMException('通联已取消','AbortError');
        if(error instanceof ApiError)throw error;
        const timedOut=timeout.aborted;
        throw new ApiError(timedOut?504:502,timedOut?'Inworld 语音请求超时':'无法连接 Inworld 语音接口或音频响应无效');
      }
  }
  return {
    health(){return {provider:config.provider,model:config.provider==='inworld'?config.model:null,...(config.provider==='inworld'&&config.pilotEnglishLocalized?{bilingualPilotModel:INWORLD_BILINGUAL_MODEL}:{}),ready:config.provider==='browser'||!!config.apiKey};},
    synthesizeAudio,
    async synthesize(input,options){return (await synthesizeAudio(input,options)).audio;}
  };
}
