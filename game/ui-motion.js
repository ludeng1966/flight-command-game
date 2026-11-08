const pending=new WeakMap(),versions=new WeakMap();
export function showSoft(element){
  clearTimeout(pending.get(element));pending.delete(element);const version=(versions.get(element)??0)+1;versions.set(element,version);
  if(element.hidden){element.hidden=false;element.classList.remove('is-visible');requestAnimationFrame(()=>{if(!element.hidden&&versions.get(element)===version)element.classList.add('is-visible');});}
  else element.classList.add('is-visible');
}
export function hideSoft(element,immediate=false){
  if(!immediate&&(element.hidden||pending.has(element)))return;
  versions.set(element,(versions.get(element)??0)+1);
  clearTimeout(pending.get(element));element.classList.remove('is-visible');
  if(immediate)element.hidden=true;
  else pending.set(element,setTimeout(()=>{element.hidden=true;pending.delete(element);},150));
}
