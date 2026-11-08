export function encodeWav(chunks,sampleRate){
  const length=chunks.reduce((n,c)=>n+c.length,0),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);
  const text=(offset,s)=>{for(let i=0;i<s.length;i++)view.setUint8(offset+i,s.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,length*2,true);
  let offset=44;
  for(const c of chunks)for(const value of c){const s=Math.max(-1,Math.min(1,value));view.setInt16(offset,Math.round(s*(s<0?32768:32767)),true);offset+=2;}
  return buffer;
}

export class WavRecorder {
  constructor(onLevel=()=>{}){this.onLevel=onLevel;this.chunks=[];this.closed=false;this.power=0;this.frames=0;}
  async start(){
    if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia||!globalThis.AudioWorkletNode)throw Error('当前环境无法录音，请通过 localhost / HTTPS 使用 Chrome 或 Edge');
    try{
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
      if(this.closed){this.stream.getTracks().forEach(t=>t.stop());return;}
      this.context=new AudioContext();
      await this.context.audioWorklet.addModule(new URL('./audio-capture-worklet.js',import.meta.url));
      if(this.closed){await this.context.close();return;}
      this.node=new AudioWorkletNode(this.context,'command-capture');
      this.node.port.onmessage=e=>{
        if(e.data.done){this.flushed?.();return;}
        const samples=e.data.samples;if(!samples)return;
        this.chunks.push(samples);this.frames+=samples.length;
        let power=0;for(const s of samples)power+=s*s;this.power+=power;
        this.onLevel(Math.min(1,Math.sqrt(power/samples.length)*8));
      };
      this.source=this.context.createMediaStreamSource(this.stream);this.mute=this.context.createGain();this.mute.gain.value=0;
      this.source.connect(this.node);this.node.connect(this.mute);this.mute.connect(this.context.destination);
      await this.context.resume();
    }catch(e){this.cancel();throw e;}
  }
  async stop(){
    if(this.closed||!this.node)throw Error('录音尚未就绪');
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('录音设备未能完成收音，请重试')),1500);
        this.flushed=()=>{clearTimeout(timer);resolve();};this.node.port.postMessage('stop');
      });
      const rate=this.context.sampleRate;
      if(this.frames/rate<.3)throw Error('录音太短，请说完指令后再结束');
      if(Math.sqrt(this.power/Math.max(1,this.frames))<.002)throw Error('没有收到清晰声音，请检查麦克风或输入文字');
      return new Blob([encodeWav(this.chunks,rate)],{type:'audio/wav'});
    }finally{this.cancel();}
  }
  cancel(){
    this.closed=true;this.stream?.getTracks().forEach(t=>t.stop());
    this.source?.disconnect();this.node?.disconnect();this.mute?.disconnect();
    if(this.context&&this.context.state!=='closed')void this.context.close().catch(()=>{});
  }
}
