import {randomBytes,createHash} from 'node:crypto';
import {ApiError,createQwenClient} from './qwen.mjs';
import {readTtsConfig,createInworldTts} from './inworld-tts.mjs';

export const PLAYER_COOKIE='wtacrp_player';
export const QWEN_REGIONS={beijing:'https://dashscope.aliyuncs.com/compatible-mode/v1',singapore:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'};
const TTL=8*60*60*1000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const cookie=req=>(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(PLAYER_COOKIE+'='))?.slice(PLAYER_COOKIE.length+1);
const invalid=()=>{throw new ApiError(400,'密钥、地域、模型或音色配置无效');};
function secret(value,previous,kind){
  if(value===undefined||value==='')return previous??'';
  if(value===null)return '';
  if(typeof value!=='string')invalid();
  const key=value.trim().replace(kind==='qwen'?/^Bearer\s+/i:/^Basic\s+/i,'');
  if(key.length<8||key.length>4096||/[^\x21-\x7e]/.test(key))invalid();
  if(kind==='inworld'&&(!/^[A-Za-z0-9+/]+={0,2}$/.test(key)||key.length%4!==0))invalid();
  return key;
}
export function playerConfig(base,input,previous){
  if(!input||typeof input!=='object'||Array.isArray(input))invalid();
  // Blank fields retain this browser's saved keys, never the owner's .env keys.
  const apiKey=secret(input.qwenKey,previous?.apiKey,'qwen');
  const inworldKey=secret(input.inworldKey,previous?.tts.apiKey,'inworld');
  if(!apiKey&&!inworldKey)throw new ApiError(400,'请至少填写 Qwen 或 Inworld 的 API Key');
  const region=input.qwenRegion??previous?.playerRegion??'beijing';if(!Object.hasOwn(QWEN_REGIONS,region))invalid();
  const model=input.qwenModel??previous?.commandModel??base.commandModel;
  if(typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model))invalid();
  const voices=input.voices??previous?.playerVoices??{};
  if(!voices||typeof voices!=='object'||Array.isArray(voices)||Object.keys(voices).some(k=>!['commander','pilot1','pilot2'].includes(k)))invalid();
  for(const value of Object.values(voices))if(typeof value!=='string'||value.length>256||/[^\x21-\x7e]/.test(value))invalid();
  const localized=input.pilotEnglishLocalized??previous?.tts.pilotEnglishLocalized??false;
  if(typeof localized!=='boolean')invalid();
  const tts=readTtsConfig({INWORLD_API_KEY:inworldKey,INWORLD_VOICE_COMMANDER:voices.commander||'Dennis',INWORLD_VOICE_PILOT_1:voices.pilot1||'Alex',INWORLD_VOICE_PILOT_2:voices.pilot2||'Oliver',INWORLD_PILOT_EN_LOCALIZED:String(localized),INWORLD_RATE_COMMANDER:String(base.tts.commanderRate),INWORLD_TTS_TIMEOUT_MS:String(base.tts.timeoutMs)});
  return {...base,aiProvider:'cloud',apiKey,asrKey:'',baseUrl:QWEN_REGIONS[region],asrBaseUrl:QWEN_REGIONS[region],commandModel:model,pilotModel:model,tts,playerRegion:region,playerVoices:{...voices}};
}
function summary(config,source='player',expiresAt=null){
  return {source,expiresAt,qwenConfigured:!!config.apiKey,inworldConfigured:!!config.tts.apiKey,
    qwenRegion:config.playerRegion??(config.baseUrl===QWEN_REGIONS.singapore?'singapore':'beijing'),qwenModel:config.commandModel,
    voices:config.playerVoices??{},pilotEnglishLocalized:config.playerVoices?config.tts.pilotEnglishLocalized:false};
}

// Credentials live only in this process. Each browser gets its own API clients,
// pilot queues and decision caches; responses contain configuration flags only.
export function createPlayerCredentials(base,makeRuntime,{now=Date.now,maxSessions=32,ttl=TTL}={}){
  const sessions=new Map();
  function prune(){for(const [key,entry]of sessions)if(entry.expiresAt<=now()){entry.runtime.dispose();sessions.delete(key);}}
  const timer=setInterval(prune,60000);timer.unref();
  function get(req){
    prune();const token=cookie(req);if(!token)return null;
    const entry=/^[A-Za-z0-9_-]{43}$/.test(token)?sessions.get(digest(token)):null;
    if(!entry)throw new ApiError(401,'玩家密钥会话已失效，请在设置 → API 接入中重新填写或恢复本机配置');
    return entry;
  }
  function setCookie(res,value,maxAge=ttl/1000){res.setHeader('Set-Cookie',`${PLAYER_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);}
  return {
    status(req){const entry=get(req);return entry?summary(entry.config,'player',entry.expiresAt):summary(base,'local');},
    runtime(req){return get(req)?.runtime;},
    update(req,res,input){
      const previous=get(req),config=playerConfig(base,input,previous?.config);
      if(!previous&&sessions.size>=maxSessions)throw new ApiError(503,'玩家配置会话已满，请稍后重试');
      const token=randomBytes(32).toString('base64url'),expiresAt=now()+ttl;
      const runtime=makeRuntime(config);
      if(previous){previous.runtime.dispose();sessions.delete(digest(cookie(req)));}
      sessions.set(digest(token),{config,runtime,expiresAt});setCookie(res,token);
      return summary(config,'player',expiresAt);
    },
    clear(req,res){const token=cookie(req),entry=token?sessions.get(digest(token)):null;if(entry){entry.runtime.dispose();sessions.delete(digest(token));}setCookie(res,'',0);return summary(base,'local');},
    async test(req,provider,fetchImpl,signal){
      const entry=get(req);if(!entry)throw new ApiError(409,'请先保存本次 API 配置，再测试连接');
      if(provider==='qwen'){
        if(!entry.config.apiKey)throw new ApiError(400,'尚未填写 Qwen API Key');
        await createQwenClient(entry.config,fetchImpl).completePilot([{role:'user',content:'Return the JSON object {"ok":true}.'}],{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},{maxTokens:32,signal});
        return {ok:true,provider,model:entry.config.commandModel};
      }
      if(provider==='inworld')return createInworldTts(entry.config.tts,fetchImpl).synthesizeAudio({speaker:'commander',text:'语音连接正常。',language:'zh-CN'},{signal});
      throw new ApiError(400,'请选择 Qwen 或 Inworld 连接测试');
    },
    close(){clearInterval(timer);for(const entry of sessions.values())entry.runtime.dispose();sessions.clear();}
  };
}
