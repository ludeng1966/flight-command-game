import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,createWriteStream} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}

// One model process and one serial queue serve both roles. Never fall back to a paid cloud request.
export class LocalAiRuntime{
  constructor(root,options={}){
    this.root=root;this.options=options;this.status='stopped';this.error=null;this.queue=Promise.resolve();this.pending=0;
    this.memory={dedicatedMiB:null,peakDedicatedMiB:0,sharedMiB:null,samples:0,budgetMiB:1900,method:'Windows GPU Process Memory / DedicatedUsage',sampleIntervalMs:500};
    this.metrics={commander:[],pilot:[]};this.stopping=false;
  }
  health(){return {provider:'local',model:'Qwen3.5-2B-Q4_K_M',status:this.status,error:this.error,pid:this.child?.pid??null,
    sharedModel:true,roles:['commander','pilot'],gpuLayers:this.gpuLayers,contextTokens:4096,parallel:1,memory:{...this.memory},pending:this.pending,
    lastTiming:this.lastTiming??null,roleTimings:Object.fromEntries(Object.entries(this.metrics).map(([role,items])=>[role,items.at(-1)?.inferenceMs??null]))};}
  async start(){
    this.status='loading';this.stopping=false;
    const base=path.join(this.root,'.local-ai'),exe=path.join(base,'runtime','llama-server.exe'),model=path.join(base,'models','Qwen3.5-2B-Q4_K_M.gguf');
    if(!existsSync(exe)||!existsSync(model)){this.status='error';this.error='本地模型尚未安装，请运行 tools/setup-local-ai.ps1 后重启游戏';return;}
    try{
      this.port=await freePort();this.key=randomUUID();this.gpuLayers=this.options.gpuLayers??99;
      const logDir=path.join(this.root,'.game-server');mkdirSync(logDir,{recursive:true});
      const log=createWriteStream(path.join(logDir,'local-ai.log'),{flags:'w'});this.log=log;
      this.child=spawn(exe,['-m',model,'--alias','tactical-2b','--host','127.0.0.1','--port',String(this.port),
        '--api-key',this.key,'--ctx-size','4096','--parallel','1','--gpu-layers',String(this.gpuLayers),
        '--batch-size','128','--ubatch-size','64','--threads','6','--threads-batch','8',
        '--jinja','--reasoning-budget','0','--no-webui','--metrics'],{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});
      // Redact the private loopback API key if the runtime prints its launch options.
      for(const stream of [this.child.stdout,this.child.stderr])stream.on('data',data=>log.write(data.toString().replaceAll(this.key,'[private]')));
      this.child.on('error',error=>this.fail(`本地推理引擎启动失败：${error.message}`));
      this.child.on('exit',code=>{if(!this.stopping&&this.status!=='error')this.fail(`本地推理引擎已退出（${code}），请重启游戏`);log.end();this.monitor?.kill();});
      this.monitor=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(this.root,'tools','monitor-local-ai.ps1'),
        '-ParentId',String(process.pid),'-AiId',String(this.child.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let buffered='';this.monitor.stdout.on('data',chunk=>{
        buffered+=chunk;let end;
        while((end=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,end).trim();buffered=buffered.slice(end+1);try{this.observe(JSON.parse(line));}catch{}}
      });
      this.monitor.on('error',()=>this.fail('无法启动进程显存监控，本地 AI 已停止'));
      this.monitor.on('exit',()=>{if(!this.stopping&&this.status!=='error'&&this.child?.exitCode===null)this.fail('进程显存监控已停止，本地 AI 已停止');});
      for(let i=0;i<180&&!this.stopping&&this.status!=='error';i++){
        try{const response=await fetch(`http://127.0.0.1:${this.port}/health`,{headers:{Authorization:`Bearer ${this.key}`},signal:AbortSignal.timeout(1000)});
          if(response.ok&&this.memory.samples>0&&this.status!=='error'){this.status='ready';return;}
        }catch{}
        await delay(500);
      }
      if(!this.stopping&&this.status!=='error')this.fail('本地模型加载超时，或未取得显存测量数据');
    }catch(error){this.fail(`本地模型加载失败：${error.message}`);}
  }
  observe(sample){
    if(this.stopping)return;
    if(sample.error){this.fail('无法读取本地 AI 的进程显存，本地 AI 已停止');return;}
    if(!Number.isFinite(sample.dedicatedBytes)||sample.dedicatedBytes<0)return;
    const dedicatedMiB=sample.dedicatedBytes/1048576;
    Object.assign(this.memory,{dedicatedMiB,sharedMiB:sample.sharedBytes/1048576,peakDedicatedMiB:Math.max(this.memory.peakDedicatedMiB,dedicatedMiB),samples:this.memory.samples+1});
    if(dedicatedMiB>this.memory.budgetMiB)this.fail('本地 AI 显存超过 1900 MiB 保护线，已停止模型；降低 LOCAL_AI_GPU_LAYERS 后重启');
  }
  fail(message){this.status='error';this.error=message;this.child?.kill();}
  async complete(role,messages,schema,{maxTokens=600,signal}={}){
    if(this.status!=='ready')throw Error(this.error||'本地 2B 模型正在加载，请稍后重试');
    if(this.pending>=4)throw Error('本地模型正在处理其他指令，请稍后重试');
    this.pending++;const queuedAt=performance.now();
    const operation=this.queue.catch(()=>{}).then(async()=>{
      if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
      if(this.status!=='ready')throw Error(this.error||'本地模型不可用');
      const started=performance.now(),timeout=AbortSignal.timeout(60000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
      const response=await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.key}`},
        body:JSON.stringify({model:'tactical-2b',messages,stream:false,temperature:0.1,seed:42,max_tokens:maxTokens,
          chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_schema',json_schema:{name:role,strict:true,schema}}}),signal:combined});
      const data=await response.json();if(!response.ok)throw Error(`本地模型请求失败：${data.error?.message||response.status}`);
      if(data.choices?.[0]?.finish_reason==='length')throw Error('本地模型输出被截断，请简化本次任务');
      const content=data.choices?.[0]?.message?.content;if(typeof content!=='string')throw Error('本地模型返回无效结果');
      const timing={role,queueMs:Math.round(started-queuedAt),inferenceMs:Math.round(performance.now()-started),usage:data.usage,timings:data.timings};
      this.lastTiming=timing;this.metrics[role].push(timing);if(this.metrics[role].length>100)this.metrics[role].shift();
      return {value:JSON.parse(content),timing};
    });
    this.queue=operation;try{return await operation;}finally{this.pending--;}
  }
  async stop(){
    this.stopping=true;this.status='stopped';
    const child=this.child;
    if(child&&child.exitCode===null){const ended=once(child,'close').catch(()=>{});child.kill();await Promise.race([ended,delay(3000)]);}
    this.monitor?.kill();
  }
}
