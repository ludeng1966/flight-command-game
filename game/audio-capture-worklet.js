// 在音频线程收集单声道 PCM；不播放麦克风声音。
class CommandCapture extends AudioWorkletProcessor {
  constructor(){
    super();this.buffer=new Float32Array(2048);this.used=0;this.active=true;
    this.port.onmessage=e=>{if(e.data==='stop'){this.flush();this.active=false;this.port.postMessage({done:true});}};
  }
  flush(){
    if(!this.used)return;
    const samples=this.buffer.slice(0,this.used);this.port.postMessage({samples},[samples.buffer]);this.used=0;
  }
  process(inputs){
    if(!this.active)return false;
    const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let sample=0;for(const channel of channels)sample+=channel[i]/channels.length;
      this.buffer[this.used++]=sample;
      if(this.used===this.buffer.length)this.flush();
    }
    return true;
  }
}
registerProcessor('command-capture',CommandCapture);
