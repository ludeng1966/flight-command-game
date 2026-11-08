export const DEFAULT_PILOT_MODEL='flash';
export const PILOT_MODELS=Object.freeze([
  Object.freeze({id:'flash',label:'Flash',model:'qwen3.7-flash',provider:'cloud',available:true,downloadAvailable:false}),
  Object.freeze({id:'2b',label:'2B',model:'Qwen3.5-2B-Q4_K_M',provider:'local',available:false,downloadAvailable:false,downloadUrl:null,message:'2B 模型下载暂未提供，请选择 Flash'})
]);
export const pilotModelInfo=id=>PILOT_MODELS.find(model=>model.id===id);
