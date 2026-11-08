import {SAVE_VERSION,encodeState,decodeState} from '../sim/save-state.js';

export const SAVE_KEYS=['flight-autosave-v1-a','flight-autosave-v1-b'];
// Each write replaces only one slot. The other remains a usable previous save.
export class AutoSave{
  constructor({storage,fingerprint,capture,restore,onStatus=()=>{},now=()=>Date.now(),intervalMs=2000}){
    Object.assign(this,{storage,fingerprint,capture,restore,onStatus,now,intervalMs});this.sequence=0;this.lastAt=0;this.lastAttemptAt=-Infinity;this.lastRevision=null;this.ready=false;this.lastError=null;
  }
  load(){
    const candidates=[];let found=false;
    for(const key of SAVE_KEYS){
      try{
        const raw=this.storage.getItem(key);if(!raw)continue;found=true;
        const value=JSON.parse(raw);
        if(value.version!==SAVE_VERSION||value.fingerprint!==this.fingerprint||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isFinite(value.savedAt))continue;
        this.sequence=Math.max(this.sequence,value.sequence);candidates.push(value);
      }catch(error){this.lastError=error;}
    }
    for(const save of candidates.sort((a,b)=>b.sequence-a.sequence)){
      try{const state=decodeState(save.state);this.restore(state);this.ready=true;this.lastError=null;this.lastAt=this.now();this.onStatus({type:'restored',savedAt:save.savedAt});return {restored:true,savedAt:save.savedAt};}
      catch(error){this.lastError=error;}
    }
    // Preserve unreadable saves until the player explicitly starts a new game.
    this.ready=!found;
    if(found)this.onStatus({type:'error',message:'上次存档暂时无法恢复，已保留原存档；点击“重新开始”可建立新存档'});
    return {restored:false,blocked:found};
  }
  save(){
    if(!this.ready)return false;
    this.lastAttemptAt=this.now();
    try{
      const state=this.capture(),savedAt=this.now(),sequence=this.sequence+1;
      const value=JSON.stringify({version:SAVE_VERSION,fingerprint:this.fingerprint,sequence,savedAt,state:encodeState(state)});
      this.storage.setItem(SAVE_KEYS[(sequence-1)%2],value);
      this.sequence=sequence;this.lastAt=savedAt;this.lastRevision=state.world?.revision;this.lastError=null;
      this.onStatus({type:'saved',savedAt});return true;
    }catch(error){this.lastError=error;this.onStatus({type:'error',message:'自动保存失败：请保留游戏页面，检查浏览器本地存储空间'});return false;}
  }
  tick(world){
    const at=this.now();if(!this.ready||at-this.lastAt<250||at-this.lastAttemptAt<(this.lastError?this.intervalMs:250))return;
    if(world.revision!==this.lastRevision||at-this.lastAt>=this.intervalMs)this.save();
  }
  newGame(){this.ready=true;return this.save();}
  bind(window,document){
    const flush=()=>this.save(),visibility=()=>{if(document.hidden)flush();};
    window.addEventListener('pagehide',flush,{capture:true});window.addEventListener('beforeunload',flush,{capture:true});document.addEventListener('visibilitychange',visibility,{capture:true});
    return ()=>{window.removeEventListener('pagehide',flush,{capture:true});window.removeEventListener('beforeunload',flush,{capture:true});document.removeEventListener('visibilitychange',visibility,{capture:true});};
  }
}
