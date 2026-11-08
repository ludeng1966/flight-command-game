export function initApiSettings({doc=globalThis.document,fetchImpl=globalThis.fetch,Audio=globalThis.Audio,urlApi=globalThis.URL}={}){
  const $=id=>doc.getElementById(id),form=$('api-credentials');if(!form)return null;
  const status=$('api-credentials-status'),summary=$('api-credentials-summary');let busy=false,player=null,audioUrl=null;
  const say=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
  const stopAudio=()=>{if(player){player.onended=player.onerror=null;player.pause();player.removeAttribute('src');player=null;}if(audioUrl){urlApi.revokeObjectURL(audioUrl);audioUrl=null;}};
  const refreshGame=()=>{$('command-cancel')?.click();$('command-connection')?.click();};
  async function request(path,options={}){
    const response=await fetchImpl(path,{cache:'no-store',...options});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||'API 配置请求失败');}
    return response;
  }
  function render(value){
    summary.textContent=`${value.source==='player'?'当前玩家配置':'本机配置'} · Qwen ${value.qwenConfigured?'已填写':'未填写'} · Inworld ${value.inworldConfigured?'已填写':'未填写'}`;
    $('api-qwen-region').value=value.qwenRegion;$('api-qwen-model').value=value.qwenModel;
    for(const [field,key]of [['commander','commander'],['alpha','pilot1'],['bravo','pilot2']])$('api-voice-'+field).value=value.voices?.[key]??'';
    $('api-pilot-localized').checked=value.pilotEnglishLocalized;
    $('api-qwen-key').placeholder=value.source==='player'&&value.qwenConfigured?'已填写，留空保留':'填写自己的百炼 API Key';
    $('api-inworld-key').placeholder=value.source==='player'&&value.inworldConfigured?'已填写，留空保留':'粘贴 Portal 的 Base64 凭据';
  }
  async function save(){
    const input={qwenKey:$('api-qwen-key').value.trim(),inworldKey:$('api-inworld-key').value.trim(),qwenRegion:$('api-qwen-region').value,qwenModel:$('api-qwen-model').value.trim(),
      voices:{commander:$('api-voice-commander').value.trim(),pilot1:$('api-voice-alpha').value.trim(),pilot2:$('api-voice-bravo').value.trim()},pilotEnglishLocalized:$('api-pilot-localized').checked};
    const response=await request('/api/player/credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    render(await response.json());$('api-qwen-key').value='';$('api-inworld-key').value='';refreshGame();
  }
  async function run(action){
    if(busy)return;busy=true;for(const button of form.querySelectorAll('button'))button.disabled=true;
    try{await action();}catch(error){say(error.message||'连接配置失败',true);}
    finally{busy=false;for(const button of form.querySelectorAll('button'))button.disabled=false;}
  }
  form.onsubmit=event=>{event.preventDefault();void run(async()=>{say('正在应用密钥…');await save();say('本会话配置已应用；点击测试可验证实际调用。');});};
  for(const provider of ['qwen','inworld'])$('api-test-'+provider).onclick=()=>void run(async()=>{
    stopAudio();say('正在保存并测试连接…');await save();
    const response=await request('/api/player/credentials/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider})});
    if(provider==='qwen'){await response.json();say('Qwen 实际模型调用成功。');return;}
    audioUrl=urlApi.createObjectURL(await response.blob());player=new Audio(audioUrl);player.onended=stopAudio;player.onerror=()=>{stopAudio();say('语音已生成，但浏览器无法播放。',true);};
    try{await player.play();say('Inworld 合成成功，正在播放测试语音。');}catch{stopAudio();say('语音已生成，浏览器未允许播放；请再次点击试听。',true);}
  });
  $('api-clear').onclick=()=>void run(async()=>{stopAudio();const response=await request('/api/player/credentials',{method:'DELETE'});render(await response.json());$('api-qwen-key').value='';$('api-inworld-key').value='';refreshGame();say('本会话的玩家密钥已清除，恢复使用本机配置。');});
  const ready=request('/api/player/credentials').then(response=>response.json()).then(render).catch(error=>say(error.message,true));
  return {ready,destroy(){stopAudio();}};
}
if(globalThis.document)initApiSettings();
