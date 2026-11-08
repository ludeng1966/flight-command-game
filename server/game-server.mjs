import http from 'node:http';
import {createFlightDataApi} from './flight-data.mjs';
import {createRadarPilot} from './radar-pilot.mjs';
import {createRwrPilot} from './rwr-pilot.mjs';
import {createAttackPilot} from './attack-pilot.mjs';
import {createTowerAssistant} from './tower-assistant.mjs';
import {readFile,stat,realpath} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createQwenClient,ApiError} from './qwen.mjs';
import {readTtsConfig,createInworldTts} from './inworld-tts.mjs';
import {LocalAiRuntime} from './local-ai-runtime.mjs';
import {createLocalAiClient} from './local-ai-client.mjs';
import {HANDBOOK,readPilotFile} from './pilot-handbook.mjs';
import {aviationTermStats,searchAviationTerms} from './aviation-terms.mjs';
import {PilotAssistant} from './pilot-assistant.mjs';
import {createCloudPilotRuntime} from './cloud-pilot-runtime.mjs';
import {createTextTranslator} from './text-translator.mjs';
import {createPlayerCredentials} from './player-credentials.mjs';
import {DEFAULT_PILOT_MODEL,PILOT_MODELS,pilotModelInfo} from '../sim/pilot-models.js';
import {COMMAND_CATALOG,CAPABILITIES,MILITARY_PROTOCOL_VERSION} from '../sim/military-commands.js';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function loadEnv(filename,env=process.env){
  if(!existsSync(filename))return;
  for(const line of readFileSync(filename,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(!match||env[match[1]]!==undefined)continue;
    let value=match[2];
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    else value=value.replace(/\s+#.*$/,'');
    env[match[1]]=value;
  }
}
export function readConfig(env=process.env){
  const baseUrl=env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const config={aiProvider:env.AI_PROVIDER||'cloud',localGpuLayers:Number(env.LOCAL_AI_GPU_LAYERS||99),apiKey:env.DASHSCOPE_API_KEY||'',asrKey:env.QWEN_ASR_API_KEY||'',baseUrl,
    asrBaseUrl:env.QWEN_ASR_BASE_URL||baseUrl,commandModel:env.QWEN_COMMAND_MODEL||'qwen3.7-flash',pilotModel:env.QWEN_PILOT_MODEL||'qwen3.7-flash',
    asrModel:env.QWEN_ASR_MODEL||'qwen3-asr-flash',timeoutMs:Number(env.QWEN_TIMEOUT_MS||30000),port:Number(env.GAME_PORT||8000),tts:readTtsConfig(env)};
  for(const address of [config.baseUrl,config.asrBaseUrl]){
    const u=new URL(address);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('QWEN 接口地址必须是无密钥、无查询参数的 HTTPS 地址');
  }
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535||!Number.isFinite(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>120000)throw new Error('端口或 API 超时配置无效');
  if(!['cloud','local','hybrid'].includes(config.aiProvider)||!Number.isInteger(config.localGpuLayers)||config.localGpuLayers<1||config.localGpuLayers>99)throw new Error('本地模型配置无效');
  return config;
}
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.csv':'text/csv; charset=utf-8',
  '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.bin':'application/octet-stream','.f32':'application/octet-stream','.woff2':'font/woff2','.ico':'image/x-icon'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req,max){
  if(Number(req.headers['content-length'])>max){req.resume();throw new ApiError(413,'请求内容过大');}
  const parts=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)throw new ApiError(413,'请求内容过大');parts.push(chunk);}
  return Buffer.concat(parts);
}
export function createGameServer(config,{fetchImpl=fetch,root=ROOT,localRuntime=null,pilotAssistant=null,playerCredentials=true}={}){
  const flightDataApi=createFlightDataApi(root);
  const cloudClient=createQwenClient(config,fetchImpl),client=config.aiProvider==='local'?createLocalAiClient(localRuntime,cloudClient):cloudClient,tts=createInworldTts(config.tts,fetchImpl);let active=0,activeTts=0;
  const translator=createTextTranslator(cloudClient);let activeTranslations=0;
  const radarPilot=createRadarPilot(cloudClient);
  const rwrPilot=createRwrPilot(cloudClient);
  const attackPilot=createAttackPilot(cloudClient);
  const towerAssistant=createTowerAssistant(cloudClient);
  pilotAssistant??=new PilotAssistant(root,{model:config.pilotModel||'qwen3.7-flash',provider:'cloud',runtimeFactory:()=>createCloudPilotRuntime(cloudClient)});
  const players=playerCredentials?createPlayerCredentials(config,playerConfig=>{
    const child=createGameServer(playerConfig,{fetchImpl,root,playerCredentials:false});
    return {dispatch:child.listeners('request')[0],dispose:()=>child.emit('close')};
  }):null;
  const pilotModels=PILOT_MODELS.map(item=>item.id==='flash'?{...item,model:config.pilotModel||item.model}:item);
  const validatePilotModel=input=>{
    const id=input?.pilotModel??DEFAULT_PILOT_MODEL,model=pilotModelInfo(id);
    if(!model)throw new ApiError(400,'飞行员模型无效，请选择 Flash 或 2B');
    if(!model.available)throw new ApiError(409,model.message);
  };
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))throw new ApiError(403,'仅允许本机访问');
      const url=new URL(req.url,`http://${host}`);
      if(url.pathname.startsWith('/api/')&&(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!==`http://${host}`))throw new ApiError(403,'请从游戏页面配置密钥或下达指令');
      if(players&&['/api/player/credentials','/api/player/credentials/test'].includes(url.pathname)){
        if(url.pathname==='/api/player/credentials'&&req.method==='GET')return json(res,200,players.status(req));
        if(url.pathname==='/api/player/credentials'&&req.method==='DELETE')return json(res,200,players.clear(req,res));
        if(req.method!=='POST')throw new ApiError(405,'不支持该请求方法');
        if((req.headers['content-type']||'').split(';')[0]!=='application/json')throw new ApiError(415,'请使用 JSON 配置');
        const raw=await body(req,16*1024);let input;try{input=JSON.parse(raw.toString('utf8'));}catch{throw new ApiError(400,'配置 JSON 无效');}
        if(url.pathname==='/api/player/credentials')return json(res,200,players.update(req,res,input));
        // Connection tests make one small, billable request using saved player keys.
        if(active>=2)throw new ApiError(429,'正在测试连接，请稍后重试');active++;
        const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        try{
          const result=await players.test(req,input?.provider,fetchImpl,controller.signal);
          if(result.audio){res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.audio.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(result.audio);return;}
          return json(res,200,result);
        }finally{active--;}
      }
      if(players&&url.pathname.startsWith('/api/')){const runtime=players.runtime(req);if(runtime)return await runtime.dispatch(req,res);}
      if(url.pathname==='/api/health'&&req.method==='GET'){
        const local=config.aiProvider==='local',ai=local?localRuntime?.health():null;
        return json(res,200,{service:'tactical-voice',version:1,provider:config.aiProvider||'cloud',commandReady:local?ai?.status==='ready':!!config.apiKey,voiceReady:!!(config.asrKey||config.apiKey),
          commandModel:local?'Qwen3.5-2B-Q4_K_M':config.commandModel,asrModel:config.asrModel,tts:tts.health(),ai,pilotAssistant:pilotAssistant.health(),pilotReady:!!config.apiKey,defaultPilotModel:DEFAULT_PILOT_MODEL,pilotModels});
      }
      if(url.pathname==='/api/tactical/pilot/models'&&req.method==='GET')return json(res,200,{defaultModel:DEFAULT_PILOT_MODEL,models:pilotModels});
      if(url.pathname==='/api/tactical/catalog'&&req.method==='GET')return json(res,200,{version:MILITARY_PROTOCOL_VERSION,commands:COMMAND_CATALOG,capabilities:CAPABILITIES});
      if(req.method==='GET'&&url.pathname.startsWith('/api/flight-data/')){const result=flightDataApi(url);return json(res,result.status,result.data);}
      if(url.pathname==='/api/tactical/terms'&&req.method==='GET'){
        const query=url.searchParams.get('q')??'',limit=Number(url.searchParams.get('limit')??12);
        if(query.length>1000||!Number.isInteger(limit)||limit<1||limit>40)throw new ApiError(400,'术语查询或数量无效');
        return json(res,200,{...aviationTermStats(),query,terms:searchAviationTerms(query,{limit})});
      }
      if(url.pathname==='/api/tactical/handbook'&&req.method==='GET'){
        const id=url.searchParams.get('id');
        if(!id)return json(res,200,{files:HANDBOOK});
        if(!HANDBOOK.some(item=>item.id===id))throw new ApiError(404,'没有这份飞行员手册');
        return json(res,200,readPilotFile(id));
      }
      if(url.pathname.startsWith('/api/')){
        if(req.method!=='POST')throw new ApiError(405,'此接口只接受 POST');
        if(req.headers.origin&&req.headers.origin!==`http://${host}`)throw new ApiError(403,'请从游戏页面下达指令');
        const isTts=url.pathname==='/api/voice/synthesize';
        const isTranslation=url.pathname==='/api/language/translate';
        if((isTts?activeTts:isTranslation?activeTranslations:active)>=2){req.resume();throw new ApiError(429,'正在处理指令或通联，请稍后重试');}
        if(!['/api/atc/assess','/api/tactical/interpret','/api/tactical/pilot','/api/tactical/pilot/plan','/api/tactical/pilot/radar','/api/tactical/pilot/rwr','/api/tactical/pilot/attack','/api/tactical/pilot/assess','/api/tactical/pilot/result','/api/tactical/pilot/plan-departure','/api/voice/transcribe','/api/voice/synthesize','/api/language/translate'].includes(url.pathname))throw new ApiError(404,'接口不存在');
        if(isTts)activeTts++;else if(isTranslation)activeTranslations++;else active++;
        try{
          if(url.pathname==='/api/voice/transcribe'){
            if((req.headers['content-type']||'').split(';')[0]!=='audio/wav')throw new ApiError(415,'请上传 WAV 录音');
            return json(res,200,await client.transcribe(await body(req,4*1024*1024)));
          }
          if((req.headers['content-type']||'').split(';')[0]!=='application/json')throw new ApiError(415,'请使用 JSON 指令');
          const raw=await body(req,64*1024);let input;
          try{input=JSON.parse(raw.toString('utf8'));}catch{throw new ApiError(400,'指令 JSON 无效');}
          const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
          if(isTranslation)return json(res,200,await translator.translate(input,{signal:controller.signal}));
          if(isTts){
            const {audio,contentType}=await tts.synthesizeAudio(input,{signal:controller.signal});
            res.writeHead(200,{'Content-Type':contentType,'Content-Length':audio.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(audio);return;
          }
          if(url.pathname.startsWith('/api/tactical/pilot'))validatePilotModel(input);
          if(url.pathname==='/api/atc/assess')return json(res,200,await towerAssistant(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/plan')return json(res,200,await pilotAssistant.planCommand(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/rwr')return json(res,200,await rwrPilot(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/radar')return json(res,200,await radarPilot(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/attack')return json(res,200,await attackPilot(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/plan-departure')return json(res,200,await pilotAssistant.planDeparture(input,{signal:controller.signal}));
          if(url.pathname==='/api/tactical/pilot/result'){
            return json(res,200,await pilotAssistant.checkResult(input,{signal:controller.signal}));
          }
          if(url.pathname==='/api/tactical/pilot/assess'){
            if(!pilotAssistant)throw new ApiError(400,'当前服务未启用事件飞行员');
            return json(res,200,await pilotAssistant.assess(input,{signal:controller.signal}));
          }
          if(url.pathname==='/api/tactical/pilot'){
            if(!client.reviewPilot)throw new ApiError(400,'当前服务未启用本地飞行员模型');
            return json(res,200,await client.reviewPilot(input,{signal:controller.signal}));
          }
          return json(res,200,await client.interpret(input,{signal:controller.signal}));
        }finally{if(isTts)activeTts--;else if(isTranslation)activeTranslations--;else active--;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError(405,'不支持该请求方法');
      const pathname=decodeURIComponent(url.pathname);
      if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(p=>p.startsWith('.'))||/^\/(server|tests|tools)\//.test(pathname))throw new ApiError(404,'文件不存在');
      let filename=path.resolve(root,`.${pathname}`);
      if(!filename.startsWith(path.resolve(root)+path.sep)&&filename!==path.resolve(root))throw new ApiError(404,'文件不存在');
      let info=await stat(filename);
      if(info.isDirectory()){filename=path.join(filename,'index.html');info=await stat(filename);}
      const actual=await realpath(filename);
      if(!actual.startsWith(path.resolve(root)+path.sep)||!info.isFile()||!MIME[path.extname(filename)])throw new ApiError(404,'文件不存在');
      const data=await readFile(actual);
      res.writeHead(200,{'Content-Type':MIME[path.extname(filename)],'Content-Length':data.length,
        'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});
      res.end(req.method==='HEAD'?undefined:data);
    }catch(e){
      if(!res.headersSent)json(res,e.status||(e.code==='ENOENT'||e.code==='ENOTDIR'?404:500),{error:e instanceof ApiError?e.message:'请求未能完成'});
      else res.end();
    }
  });
  server.once('close',()=>{players?.close();void pilotAssistant.stop?.();});
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  loadEnv(path.join(ROOT,'.env'));
  const config=readConfig();const runtime=config.aiProvider==='local'?new LocalAiRuntime(ROOT,{gpuLayers:config.localGpuLayers}):null;
  const server=createGameServer(config,{localRuntime:runtime});
  if(runtime)void runtime.start();
  const stop=()=>{void runtime?.stop();server.closeAllConnections();server.close(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',()=>{runtime?.child?.kill();});
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('error',()=>{console.error('服务启动失败，请检查端口是否被占用');process.exitCode=1;});
  server.listen(config.port,'127.0.0.1',()=>{
    console.log(`空中指挥：http://127.0.0.1:${config.port}/game/`);
    console.log(`指令模型：${runtime?'本地 Qwen3.5-2B（自动加载，共享指挥官/飞行员）':config.commandModel}；语音模型：${config.asrModel}`);
    console.log(`飞行员：Flash（${config.pilotModel}），检查执行结果并按需判断事件；2B 下载暂未提供`);
    console.log(`通联语音：${config.tts.provider==='inworld'?config.tts.model+(config.tts.apiKey?'':'（待配置 INWORLD_API_KEY）'):'浏览器本地语音'}`);
  });
}
