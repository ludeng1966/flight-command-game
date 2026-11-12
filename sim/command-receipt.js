import {inspectCommandResult} from './pilot-result.js';
import {englishResultReadback} from './result-language.js';

// The flight computer already owns these facts. A model is not needed to announce
// installation, progress or failure, and cannot turn a launch into a confirmed hit.
export function commandReceipt({requestId,context,plan,interpretation,result}){
  const facts=inspectCommandResult(context,plan,interpretation,result);
  const checks=facts.map(fact=>{
    const state={executing:result.clockRunning===false?'已装订，模拟暂停，等待继续':'已装订，正在执行，尚未达到目标',reached:'采样时已达到目标',blocked:'无法执行',mismatch:'装订设置不一致',reported:'状态已核实'}[fact.expectedVerdict];
    const detail=fact.expectedVerdict==='blocked'&&fact.modelFacts.reason?`，原因：${fact.modelFacts.reason}`:'';
    const zh=`${fact.requiredReadback}，${state}${detail}`;
    return {unitId:fact.unitId,verdict:fact.expectedVerdict,readbackText:zh,readbackTexts:{zh,en:englishResultReadback(fact,plan,context,interpretation)},sampledAt:context.simTimeSec};
  });
  return {requestId,revision:context.revision,simTimeSec:context.simTimeSec,checkedBy:'flight-computer',verification:'simulation_facts',checks};
}
